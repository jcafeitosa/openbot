import { randomUUID } from "node:crypto";
import type { AgentSummary, ConversationMemoryChange, ConversationMessage } from "@openbot/contracts/ipc";
import { isContextResetMarker } from "@openbot/contracts/ipc";
import { containsRegisteredSecret, createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import {
  checkedColumn,
  databaseRow,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { MemorySource } from "../memory-store";
import type { OpenBotDatabase } from "../openbot-database";
import type { AgentMemories, MemoryReviewBase } from "./agent-memories";
import { redactedBase } from "./memory-review";
import { type MemoryReviewOperation, memoryReviewPrompt } from "./memory-review-prompt";

/** What an applied change keeps in place of a prior text that holds a registered secret. It is never restored. */
export const SECRET_PRIOR_TEXT_MARKER = "[secret removed]";

/** A run still `running` after this long has stopped: the next attempt marks it failed and retries it once. */
const RUN_STALE_MS = 10 * 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The first line of every consolidation prompt. A review prompt never has it, so a generation can tell them apart. */
export const CONSOLIDATION_PROMPT_MARKER = "You consolidate the long-term memory of the agent for one local day.";
const MEMORY_CONSOLIDATION_STATUSES = ["running", "done", "failed", "undone"] as const;
const logger = createOpenBotLogger("memory-consolidation");

export type MemoryConsolidationStatus = (typeof MEMORY_CONSOLIDATION_STATUSES)[number];

/** One memory change that a consolidation applied, with what an undo needs to reverse it. */
export type AppliedMemoryChange =
  | { memoryId: string; kind: "add" }
  | { memoryId: string; kind: "update"; priorText: string; restorable: boolean }
  | {
      memoryId: string;
      kind: "forget";
      priorText: string;
      inclusion: "essential" | "searchable";
      restorable: boolean;
    };

/** The applied list as the run row keeps it. The column is written only by this module. */
const AppliedMemoryChangeSchema = Schema.Union([
  Schema.Struct({ memoryId: Schema.String, kind: Schema.Literal("add") }),
  Schema.Struct({
    memoryId: Schema.String,
    kind: Schema.Literal("update"),
    priorText: Schema.String,
    restorable: Schema.Boolean,
  }),
  Schema.Struct({
    memoryId: Schema.String,
    kind: Schema.Literal("forget"),
    priorText: Schema.String,
    inclusion: Schema.Literals(["essential", "searchable"]),
    restorable: Schema.Boolean,
  }),
]);
const decodeAppliedChanges = Schema.decodeUnknownSync(Schema.Array(AppliedMemoryChangeSchema));

export type ConsolidationOutcome =
  // The agent has a turn running. No run is recorded, so the run is due again and is not dropped.
  | { status: "postponed" }
  // The day already has a run in any state, or another attempt of it is running, so this attempt changes nothing.
  | { status: "skipped" }
  | { status: "done"; applied: readonly AppliedMemoryChange[] }
  | { status: "failed" };

export type ConsolidationUndoOutcome =
  | { status: "undone"; changes: readonly ConversationMemoryChange[]; unrestorable: number }
  // The day has no run, or its run is not `done`, so there is nothing to undo.
  | { status: "not-done"; current: MemoryConsolidationStatus | null };

/**
 * The generation without tools that answers the review prompt. Production passes `MemoryReview.answer` with the
 * agent's background model; a test passes a fake.
 */
export type ConsolidationGenerator = (
  agent: AgentSummary,
  prompt: string,
) => Effect.Effect<{ readonly operations: readonly MemoryReviewOperation[] }, unknown>;

export interface MemoryConsolidationOptions {
  database: OpenBotDatabase;
  memories: Pick<AgentMemories, "reviewBase" | "applyReview">;
  /** The agent's own chat, the latest messages, oldest first. */
  chat(agentId: string): readonly ConversationMessage[];
  /** Whether a turn of the agent runs. A run that is due waits for it. */
  turnActive(agentId: string): boolean;
  redact(text: string): string;
}

interface ConsolidatedChat {
  cursor: string | null;
  applied: readonly AppliedMemoryChange[];
}

interface RunRow {
  status: MemoryConsolidationStatus;
  createdAt: string;
  attempts: number;
  applied: readonly AppliedMemoryChange[];
}

/**
 * Consolidates an agent's memories once per local day. A run reads the agent's chat since the turn that its last
 * `done` run read, asks the generation for operations, and commits them through the review apply path, so manual
 * and user-controlled memories keep their protections. Each run is a row of `memory_consolidation_runs`, created
 * before the generation: its primary key makes a second attempt on the same day a no-op, and that row is also the
 * single-flight guard. A row left `running` for more than ten minutes by a run that stopped is marked failed, and
 * the next attempt retries it once; the `attempts` column bounds that. The row keeps the changes it applied with
 * the text each replaced, so `undo` can restore them.
 *
 * It never imports the agent service facade. Triggering is the caller's (`MemoryReview` in production).
 */
export class MemoryConsolidation {
  readonly #options: MemoryConsolidationOptions;
  /** Runs that this process is generating now. A stale-looking row of one of them is not taken over. */
  readonly #inFlight = new Set<string>();

  constructor(options: MemoryConsolidationOptions) {
    this.#options = options;
  }

  /** Whether `day` has no run for the agent yet, or only one that a later attempt may take over. */
  isDue(agentId: string, day: string): boolean {
    assertDay(day);
    if (this.#inFlight.has(runKey(agentId, day))) return false;
    const row = this.#rowOf(agentId, day);
    if (!row) return true;
    return row.status === "running" && row.attempts === 1 && isStale(row.createdAt, new Date());
  }

  /** Runs the agent's consolidation for `day` (`YYYY-MM-DD`, local), generating with `generate`. */
  readonly run = Effect.fn("MemoryConsolidation.run")(function* (
    this: MemoryConsolidation,
    agent: AgentSummary,
    day: string,
    generate: ConsolidationGenerator,
  ): Effect.fn.Return<ConsolidationOutcome> {
    assertDay(day);
    if (this.#options.turnActive(agent.id)) return { status: "postponed" };
    const key = runKey(agent.id, day);
    if (this.#inFlight.has(key) || !this.#claim(agent.id, day)) return { status: "skipped" };
    this.#inFlight.add(key);
    const cursor = this.#cursor(agent.id);
    return yield* this.#consolidate(agent, cursor, generate).pipe(
      Effect.map((result) => this.#done(agent.id, day, result)),
      Effect.catch((error) => Effect.sync(() => this.#failed(agent.id, day, error))),
      Effect.ensuring(Effect.sync(() => this.#inFlight.delete(key))),
    );
  }).bind(this);

  /**
   * Reverses a `done` run: restores the text each update replaced, restores each forgotten memory and forgets
   * each memory it saved. A memory that changed since the run, or that the user now controls, is left as it is,
   * by the same checks as the apply path. Changes that hold a registered secret cannot be restored and are counted.
   */
  undo(agentId: string, day: string): ConsolidationUndoOutcome {
    assertDay(day);
    const row = this.#rowOf(agentId, day);
    if (row?.status !== "done") return { status: "not-done", current: row?.status ?? null };
    const operations: MemoryReviewOperation[] = [];
    let unrestorable = 0;
    for (const change of row.applied) {
      if (change.kind === "add") {
        operations.push({ type: "forget", memoryId: change.memoryId });
      } else if (!change.restorable) {
        unrestorable += 1;
      } else if (change.kind === "update") {
        operations.push({ type: "update", memoryId: change.memoryId, text: change.priorText });
      } else {
        operations.push({ type: "add", text: change.priorText, inclusion: change.inclusion });
      }
    }
    const source: MemorySource = { kind: "review", threadId: null, turnId: null };
    const changes =
      operations.length === 0
        ? []
        : this.#options.memories.applyReview(
            agentId,
            this.#options.memories.reviewBase(agentId),
            operations,
            `memory-consolidation-undo-${randomUUID()}`,
            source,
          );
    this.#setStatus(agentId, day, "undone");
    return { status: "undone", changes, unrestorable };
  }

  readonly #consolidate = Effect.fn("MemoryConsolidation.consolidate")(function* (
    this: MemoryConsolidation,
    agent: AgentSummary,
    cursor: string | null,
    generate: ConsolidationGenerator,
  ) {
    const options = this.#options;
    const messages = yield* Effect.try(() => options.chat(agent.id));
    const excerpt = unreadMessages(messages, cursor);
    const lastTurn = excerpt.findLast((message) => message.turnId)?.turnId ?? cursor;
    const consolidated: ConsolidatedChat = { cursor: lastTurn, applied: [] };
    if (!excerpt.some((message) => message.author === "user")) return consolidated;
    const base = yield* Effect.try(() => options.memories.reviewBase(agent.id));
    const redacted = redactedBase(base, options.redact);
    const prompt = [
      CONSOLIDATION_PROMPT_MARKER,
      memoryReviewPrompt(
        agent,
        redacted.base,
        excerpt.map((message) => ({ ...message, text: options.redact(message.text) })),
      ),
    ].join("\n");
    const result = yield* generate(agent, prompt);
    const operations = result.operations.filter(
      (operation) => operation.type === "add" || !redacted.hidden.has(operation.memoryId),
    );
    if (operations.length === 0) return consolidated;
    const source: MemorySource = { kind: "review", threadId: null, turnId: lastTurn };
    const changes = yield* Effect.try(() =>
      options.memories.applyReview(agent.id, base, operations, `memory-consolidation-${randomUUID()}`, source),
    );
    consolidated.applied = this.#applied(changes, base);
    return consolidated;
  }).bind(this);

  #done(agentId: string, day: string, result: ConsolidatedChat): ConsolidationOutcome {
    this.#finish(agentId, day, "done", result.cursor, result.applied);
    return { status: "done", applied: result.applied };
  }

  #failed(agentId: string, day: string, error: unknown): ConsolidationOutcome {
    logger.warn("Could not consolidate the agent's memories.", { error });
    this.#finish(agentId, day, "failed", null, []);
    return { status: "failed" };
  }

  /** The changes that the apply committed, with the text each one replaced, read from the base they changed. */
  #applied(changes: readonly ConversationMemoryChange[], base: MemoryReviewBase): AppliedMemoryChange[] {
    const applied: AppliedMemoryChange[] = [];
    for (const change of changes) {
      const entry = base.memories.find((candidate) => candidate.memory.id === change.memoryId);
      if (change.action === "saved") {
        applied.push({ memoryId: change.memoryId, kind: "add" });
      } else if (change.action === "updated") {
        applied.push({
          memoryId: change.memoryId,
          kind: "update",
          ...this.#prior(change.previousText ?? entry?.memory.text ?? ""),
        });
      } else if (change.action === "forgotten") {
        applied.push({
          memoryId: change.memoryId,
          kind: "forget",
          inclusion: entry?.inclusion ?? "searchable",
          ...this.#prior(entry?.memory.text ?? change.text),
        });
      }
    }
    return applied;
  }

  /** A prior text is kept only when it holds no registered secret; otherwise the marker takes its place. */
  #prior(text: string): { priorText: string; restorable: boolean } {
    if (containsRegisteredSecret(text) || this.#options.redact(text) !== text) {
      return { priorText: SECRET_PRIOR_TEXT_MARKER, restorable: false };
    }
    return { priorText: text, restorable: true };
  }

  /**
   * Creates the day's row as `running`. When the day already has one, a row that a stopped run left `running` is
   * marked failed and taken over once as its retry (attempt 2). Any other existing row claims nothing.
   */
  #claim(agentId: string, day: string): boolean {
    const connection = this.#options.database.connection;
    const now = new Date();
    const inserted = connection
      .prepare(
        `INSERT OR IGNORE INTO memory_consolidation_runs
           (agent_id, run_day, status, cursor_turn_id, applied_json, created_at, finished_at, attempts)
         VALUES (?, ?, 'running', NULL, '[]', ?, NULL, 1)`,
      )
      .run(agentId, day, now.toISOString());
    if (inserted.changes === 1) return true;
    const row = this.#rowOf(agentId, day);
    if (!row || row.status !== "running" || !isStale(row.createdAt, now)) return false;
    connection
      .prepare(
        `UPDATE memory_consolidation_runs SET status = 'failed', finished_at = ?
         WHERE agent_id = ? AND run_day = ? AND status = 'running' AND created_at = ?`,
      )
      .run(now.toISOString(), agentId, day, row.createdAt);
    if (row.attempts !== 1) return false;
    const retried = connection
      .prepare(
        `UPDATE memory_consolidation_runs
         SET status = 'running', attempts = 2, created_at = ?, finished_at = NULL
         WHERE agent_id = ? AND run_day = ? AND status = 'failed' AND attempts = 1`,
      )
      .run(now.toISOString(), agentId, day);
    return retried.changes === 1;
  }

  /** The turn that the agent's latest `done` run read up to, or null before any run. */
  #cursor(agentId: string): string | null {
    const row = databaseRow(
      this.#options.database.connection
        .prepare(
          `SELECT cursor_turn_id FROM memory_consolidation_runs
           WHERE agent_id = ? AND status = 'done' ORDER BY run_day DESC LIMIT 1`,
        )
        .get(agentId),
    );
    return row ? optionalStringColumn(row, "cursor_turn_id") : null;
  }

  #finish(
    agentId: string,
    day: string,
    status: "done" | "failed",
    cursor: string | null,
    applied: readonly AppliedMemoryChange[],
  ): void {
    this.#options.database.connection
      .prepare(
        `UPDATE memory_consolidation_runs
         SET status = ?, cursor_turn_id = ?, applied_json = ?, finished_at = ?
         WHERE agent_id = ? AND run_day = ?`,
      )
      .run(status, cursor, JSON.stringify(applied), new Date().toISOString(), agentId, day);
  }

  #setStatus(agentId: string, day: string, status: "undone"): void {
    this.#options.database.connection
      .prepare("UPDATE memory_consolidation_runs SET status = ? WHERE agent_id = ? AND run_day = ?")
      .run(status, agentId, day);
  }

  #rowOf(agentId: string, day: string): RunRow | null {
    const row = databaseRow(
      this.#options.database.connection
        .prepare(
          `SELECT status, created_at, attempts, applied_json FROM memory_consolidation_runs
           WHERE agent_id = ? AND run_day = ?`,
        )
        .get(agentId, day),
    );
    if (!row) return null;
    return {
      status: checkedColumn(row, "status", MEMORY_CONSOLIDATION_STATUSES),
      createdAt: requiredStringColumn(row, "created_at"),
      attempts: requiredNumberColumn(row, "attempts"),
      // The column is written only by this module, as the JSON of `AppliedMemoryChange[]`.
      applied: decodeAppliedChanges(JSON.parse(requiredStringColumn(row, "applied_json"))),
    };
  }
}

function runKey(agentId: string, day: string): string {
  return `${agentId}\u0000${day}`;
}

function isStale(createdAt: string, now: Date): boolean {
  return createdAt < new Date(now.getTime() - RUN_STALE_MS).toISOString();
}

function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day)) throw new Error("A memory consolidation day is YYYY-MM-DD.");
}

/**
 * The chat after the last turn that the cursor names, and after the last context reset. Without a cursor, or when
 * the cursor is no longer in the chat, the whole chat is read. Trailing context resets are not read.
 */
function unreadMessages(messages: readonly ConversationMessage[], cursor: string | null): ConversationMessage[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || !isContextResetMarker(message)) break;
    end -= 1;
  }
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && ((cursor !== null && message.turnId === cursor) || isContextResetMarker(message))) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start, end);
}
