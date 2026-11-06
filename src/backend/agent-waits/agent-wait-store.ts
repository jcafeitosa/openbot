/**
 * The open waits of every agent. Rows are written directly, not through `database.dispatch`: a wait
 * holds a copy of the user's request, and the event log is never deleted from. A closed, cancelled or
 * expired wait is deleted. It owns no events: the runtime says when something changed.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentWait } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { z } from "zod";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** A refusal the agent reads: the text is already a sentence for it. */
export class AgentWaitError extends Error {}

/** The agent already has the most open waits it may have. */
export class AgentWaitLimitError extends AgentWaitError {}

/** The longest a wait may stay open, counted from the moment it opens. */
export const AGENT_WAIT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which runs wake a wait, beyond the routine column of the row. A run wakes the wait only when its
 * routine is the one named here. Stored as a JSON object in `predicate_json`.
 */
export const agentWaitPredicateSchema = z.strictObject({
  routineId: z.string().trim().min(1).max(INPUT_LIMITS.identifier).optional(),
});

export type AgentWaitPredicate = z.infer<typeof agentWaitPredicateSchema>;

/**
 * A predicate row names the routine a run must have. A row without one, or with no predicate, matches any run.
 * The `?` is the routine id of the run.
 */
const PREDICATE_ALLOWS_ROUTINE = `(predicate_json IS NULL OR json_extract(predicate_json, '$.routineId') IS NULL
  OR json_extract(predicate_json, '$.routineId') = ?)`;

export interface AgentWaitStoreOptions {
  database: OpenBotDatabase;
  createId?: () => string;
  now?: () => Date;
}

export interface OpenAgentWaitInput {
  agentId: string;
  requestMessageId: string;
  requestText: string;
  note: string;
  routineId: string | null;
  /** When the wait expires, at most 7 days after it opens. Absent or null: it stays open until closed. */
  expiresAt?: Date | null;
  /** Which runs wake it. Absent or null: any run that the routine column allows. */
  predicate?: AgentWaitPredicate | null;
}

export class AgentWaitStore {
  readonly #database: OpenBotDatabase;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: AgentWaitStoreOptions) {
    this.#database = options.database;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  list(agentId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE agent_id = ? ORDER BY created_at, wait_id")
        .all(agentId),
    ).map(toWait);
  }

  get(agentId: string, waitId: string): AgentWait | null {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE agent_id = ? AND wait_id = ?")
        .get(agentId, waitId),
    );
    return row ? toWait(row) : null;
  }

  /** One statement, so two tool calls at once cannot both pass the limit. */
  open(input: OpenAgentWaitInput): AgentWait {
    const waitId = this.#createId();
    const createdAt = this.#now();
    const expiresAt = input.expiresAt ? expiryText(input.expiresAt, createdAt) : null;
    const predicateJson = predicateText(input.predicate ?? null);
    const inserted = this.#database.connection
      .prepare(
        `INSERT INTO agent_waits (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at,
           expires_at, predicate_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM agent_waits WHERE agent_id = ?) < ?`,
      )
      .run(
        waitId,
        input.agentId,
        input.requestMessageId,
        input.requestText,
        input.note,
        input.routineId,
        createdAt.toISOString(),
        expiresAt,
        predicateJson,
        input.agentId,
        INPUT_LIMITS.agentWaits,
      );
    if (inserted.changes === 0)
      throw new AgentWaitLimitError(sourceText("error.backend.agentWaitLimit", { count: INPUT_LIMITS.agentWaits }));
    const wait = this.get(input.agentId, waitId);
    if (!wait) throw new Error("The new wait is missing.");
    return wait;
  }

  count(agentId: string): number {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT COUNT(*) AS waits FROM agent_waits WHERE agent_id = ?").get(agentId),
    );
    return row ? requiredNumberColumn(row, "waits") : 0;
  }

  /** The number of open waits of each agent that has one. */
  countByAgent(): Map<string, number> {
    const rows = databaseRows(
      this.#database.connection.prepare("SELECT agent_id, COUNT(*) AS waits FROM agent_waits GROUP BY agent_id").all(),
    );
    return new Map(rows.map((row) => [requiredStringColumn(row, "agent_id"), requiredNumberColumn(row, "waits")]));
  }

  /** Closes or cancels a wait. False when it was not open. */
  delete(agentId: string, waitId: string): boolean {
    return (
      this.#database.connection
        .prepare("DELETE FROM agent_waits WHERE agent_id = ? AND wait_id = ?")
        .run(agentId, waitId).changes > 0
    );
  }

  /** Closes the waits of this agent whose expiry has passed. True when it closed any. */
  closeExpired(agentId: string): boolean {
    return (
      this.#database.connection
        .prepare("DELETE FROM agent_waits WHERE agent_id = ? AND expires_at IS NOT NULL AND expires_at <= ?")
        .run(agentId, this.#now().toISOString()).changes > 0
    );
  }

  /** The waits a run of this routine wakes, when no event names one wait. */
  forRoutineRun(agentId: string, routineId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `SELECT * FROM agent_waits WHERE agent_id = ? AND (routine_id IS NULL OR routine_id = ?)
           AND ${PREDICATE_ALLOWS_ROUTINE}
           ORDER BY created_at, wait_id`,
        )
        .all(agentId, routineId, routineId),
    ).map(toWait);
  }

  /**
   * The wait that a script event names, when a run of this routine may wake it. The routine column and the
   * predicate both still apply, as for an unnamed run: a wait bound to routine A is not woken by a run of B.
   */
  forNamedRun(agentId: string, waitId: string, routineId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `SELECT * FROM agent_waits WHERE agent_id = ? AND wait_id = ? AND (routine_id IS NULL OR routine_id = ?)
           AND ${PREDICATE_ALLOWS_ROUTINE}`,
        )
        .all(agentId, waitId, routineId, routineId),
    ).map(toWait);
  }

  markWoken(agentId: string, waitIds: readonly string[], deliveryId: string): void {
    if (waitIds.length === 0) return;
    this.#database.connection
      .prepare(
        `UPDATE agent_waits SET woken_at = ?, wake_delivery_id = ?
         WHERE agent_id = ? AND wait_id IN (${waitIds.map(() => "?").join(", ")})`,
      )
      .run(this.#now().toISOString(), deliveryId, agentId, ...waitIds);
  }

  /** The open waits that this delivery woke. A wait cancelled since then is not in the list. */
  wokenBy(deliveryId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE wake_delivery_id = ? ORDER BY created_at, wait_id")
        .all(deliveryId),
    ).map(toWait);
  }
}

/** The expiry as the column stores it, or the refusal when it is not a moment after the wait opens within the cap. */
function expiryText(expiresAt: Date, openedAt: Date): string {
  const remaining = expiresAt.getTime() - openedAt.getTime();
  if (Number.isNaN(remaining)) throw new Error("A wait's expiry is not a valid date.");
  if (remaining <= 0) throw new Error("A wait cannot expire before it opens.");
  if (remaining > AGENT_WAIT_MAX_TTL_MS) throw new Error("A wait cannot stay open for more than 7 days.");
  return expiresAt.toISOString();
}

/**
 * The predicate as the column stores it. Validated before it is written, so an unknown key is refused
 * here rather than matched as if it were absent. A run status is refused: a run wakes its waits when it is
 * queued, so its outcome is not known yet.
 */
function predicateText(predicate: unknown): string | null {
  if (predicate === null) return null;
  if (isDynamicRecord(predicate) && "status" in predicate)
    throw new Error("A wait's predicate cannot name a run status: a run wakes its waits when it is queued.");
  const parsed = agentWaitPredicateSchema.safeParse(predicate);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return Object.keys(parsed.data).length === 0 ? null : JSON.stringify(parsed.data);
}

function toWait(row: DynamicRecord): AgentWait {
  return {
    id: requiredStringColumn(row, "wait_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    note: requiredStringColumn(row, "note"),
    requestMessageId: requiredStringColumn(row, "request_delivery_id"),
    requestText: requiredStringColumn(row, "request_text"),
    routineId: optionalStringColumn(row, "routine_id"),
    createdAt: requiredStringColumn(row, "created_at"),
    wokenAt: optionalStringColumn(row, "woken_at"),
    wakeDeliveryId: optionalStringColumn(row, "wake_delivery_id"),
  };
}
