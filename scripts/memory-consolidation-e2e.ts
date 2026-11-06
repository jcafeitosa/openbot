// Checks the daily consolidation of an agent's memory on a real database in a temporary folder. The generation is
// a fake, not a provider: no account or network is used. Checks:
//   1. A run applies the generation's add and records the day as done, with the turn it read up to.
//   2. A second attempt for the same agent and day is skipped and generates nothing.
//   3. A manual memory that the generation updates or forgets is neither changed nor removed. The generation
//      reads only the chat after the turn the last done run read, and only redacted text.
//   4. Undo restores the prior text of an updated memory and marks the run undone. A second undo changes nothing.
//   5. A generation error leaves the run failed and changes no memory.
//   6. A prior text that holds a registered secret is replaced by a marker in the applied list, and the secret is
//      not stored there. The secret is registered while the generation runs, after the memory was read.
//      Undo then restores nothing for it and counts it.
//   7. A run due while the agent has a turn running is postponed: it records no run and generates nothing. The
//      same day runs once the turn ends.
//   8. A run row left `running` by a stopped attempt, older than ten minutes, is marked failed and taken over once:
//      the day applies once, and a second attempt is skipped.
//   9. A stale row that is already attempt 2 is marked failed and never retried: nothing generates for it.
//  10. Production path: MemoryReview's turn-end hook runs the day's consolidation once, through the real
//      `MemoryReview.answer` with the background model. Only the provider's profile client is replaced by a canned
//      reply, because no provider is used. A second turn end the same day generates nothing.
// Run: `bun scripts/memory-consolidation-e2e.ts`. Writes .openbot-build/memory-consolidation-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { AgentMemories } from "../src/backend/agent/agent-memories";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import {
  type AppliedMemoryChange,
  type ConsolidationGenerator,
  type ConsolidationOutcome,
  MemoryConsolidation,
  SECRET_PRIOR_TEXT_MARKER,
} from "../src/backend/agent/memory-consolidation";
import { MemoryReview } from "../src/backend/agent/memory-review";
import type { MemoryReviewOperation } from "../src/backend/agent/memory-review-prompt";
import { ProfileClients } from "../src/backend/agent/profile-clients";
import type { AgentClient } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import {
  databaseRow,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/memory-consolidation-e2e");
const SECRET = "openbot-e2e-consolidation-secret-4c9b7d21";
const PATTERN_SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const DAY = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07"] as const;

interface StepReport {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

type Answer = Effect.Effect<{ readonly operations: readonly MemoryReviewOperation[] }, unknown>;

const steps: StepReport[] = [];
const report: { passed: boolean; steps: StepReport[] } = { passed: false, steps: [] };
const prompts: string[] = [];
const errors: string[] = [];
let chat: ConversationMessage[] = [];
let turnActive = false;
let answer: () => Answer = () => Effect.succeed({ operations: [] });

/**
 * The provider's profile client is the only part replaced: `run` answers with a canned reply instead of a generation
 * on a provider. The production generation, its prompt and its checks run unchanged.
 */
class CannedProfileClients extends ProfileClients {
  generations = 0;
  reply = "";

  override run<A, E, R>(
    _client: AgentClient,
    _generate: (cancelled: () => boolean) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    this.generations += 1;
    // The production reply is text; the generic result type is fixed by `run`'s signature.
    return Effect.succeed(JSON.parse(JSON.stringify(this.reply)));
  }
}

async function step(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  process.stdout.write(`- ${name}\n`);
  try {
    const detail = await run();
    steps.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function message(id: string, turnId: string, author: "user" | "assistant", text: string): ConversationMessage {
  return { id, turnId, author, text, createdAt: "2026-03-01T10:00:00.000Z", status: "completed", source: author };
}

const root = await mkdtemp(join(tmpdir(), "openbot-memory-consolidation-"));
const database = new OpenBotDatabase(join(root, "state"));
const reviews: { current: MemoryReview | null } = { current: null };

try {
  await runCauseEffect(database.initialize());
  const store = new AgentStore(join(root, "state"), join(root, "home"), database);
  const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agent = await runCauseEffect(
    store.createAgent({
      name: "Consolidation fixture",
      description: "Synthetic agent for the consolidation check",
      avatarSeed: "memory-consolidation",
      avatarHue: null,
    }),
  );
  const AGENT = agent.id;
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => store.list(),
  );
  const memories = new AgentMemories({
    store,
    conversation,
    emit: () => undefined,
    emitError: (code, error) => errors.push(`${code}: ${error instanceof Error ? error.message : String(error)}`),
  });
  const consolidation = new MemoryConsolidation({
    database,
    memories,
    chat: () => chat,
    turnActive: () => turnActive,
    redact: redactText,
  });
  const generator: ConsolidationGenerator = (_agent, prompt) => {
    prompts.push(prompt);
    return answer();
  };

  const runDay = (day: string): Promise<ConsolidationOutcome> =>
    runCauseEffect(consolidation.run(agent, day, generator));
  const setAnswer = (operations: MemoryReviewOperation[]): void => {
    answer = () => Effect.succeed({ operations });
  };
  const texts = (): string[] => memories.list(AGENT).map((memory) => memory.text);
  const idOf = (text: string): string => {
    const memory = memories.list(AGENT).find((candidate) => candidate.text === text);
    if (!memory) throw new Error(`no memory with the text "${text}"`);
    return memory.id;
  };
  const runRow = (day: string) => {
    const row = databaseRow(
      database.connection
        .prepare(
          "SELECT status, cursor_turn_id, applied_json, attempts FROM memory_consolidation_runs WHERE agent_id = ? AND run_day = ?",
        )
        .get(AGENT, day),
    );
    if (!row) return null;
    return {
      status: requiredStringColumn(row, "status"),
      cursorTurnId: optionalStringColumn(row, "cursor_turn_id"),
      appliedJson: requiredStringColumn(row, "applied_json"),
      attempts: requiredNumberColumn(row, "attempts"),
    };
  };
  const insertStaleRun = (day: string, attempts: 1 | 2): void => {
    database.connection
      .prepare(
        `INSERT INTO memory_consolidation_runs
           (agent_id, run_day, status, cursor_turn_id, applied_json, created_at, finished_at, attempts)
         VALUES (?, ?, 'running', NULL, '[]', '2020-01-01T00:00:00.000Z', NULL, ?)`,
      )
      .run(AGENT, day, attempts);
  };
  const countRuns = (): number => {
    const row = databaseRow(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM memory_consolidation_runs WHERE agent_id = ?")
        .get(AGENT),
    );
    return row ? requiredNumberColumn(row, "count") : 0;
  };
  /** The status of the agent's latest run day, or `none` before any run. */
  const latestRunStatus = (): string => {
    const latest = databaseRow(
      database.connection
        .prepare("SELECT run_day FROM memory_consolidation_runs WHERE agent_id = ? ORDER BY run_day DESC LIMIT 1")
        .get(AGENT),
    );
    const day = latest ? requiredStringColumn(latest, "run_day") : null;
    return (day ? runRow(day)?.status : undefined) ?? "none";
  };
  const appliedOf = (outcome: ConsolidationOutcome): readonly AppliedMemoryChange[] => {
    if (outcome.status !== "done") throw new Error(`expected a done run, got ${outcome.status}`);
    return outcome.applied;
  };

  await step("A run applies the generation's add and records the day as done", async () => {
    chat = [
      message("m1", "turn-1", "user", "Keep replies brief, please."),
      message("m2", "turn-1", "assistant", "Noted."),
    ];
    setAnswer([{ type: "add", text: "The user prefers short answers.", inclusion: "searchable" }]);
    const applied = appliedOf(await runDay(DAY[0]));
    assert.deepEqual(
      applied.map((change) => change.kind),
      ["add"],
    );
    assert.ok(texts().includes("The user prefers short answers."));
    assert.ok(prompts.at(-1)?.includes("Keep replies brief, please."), "the generation reads the chat");
    const row = runRow(DAY[0]);
    assert.equal(row?.status, "done");
    assert.equal(row?.cursorTurnId, "turn-1");
    return { applied };
  });

  await step("A second attempt for the same day is skipped and generates nothing", async () => {
    const generated = prompts.length;
    const before = texts();
    setAnswer([{ type: "add", text: "Something else entirely.", inclusion: "searchable" }]);
    const outcome = await runDay(DAY[0]);
    assert.equal(outcome.status, "skipped");
    assert.equal(prompts.length, generated, "no generation for the skipped day");
    assert.deepEqual(texts(), before);
    return { outcome: outcome.status };
  });

  await step(
    "A manual memory is neither updated nor forgotten, and the generation reads only new redacted turns",
    async () => {
      const lisbon = memories.create({ agentId: AGENT, text: "The user lives in Lisbon." });
      chat = [
        ...chat,
        message("m3", "turn-2", "user", `My key is ${PATTERN_SECRET}; use it for the deploy.`),
        message("m4", "turn-2", "user", "Make the answers very short from now on."),
        message("m5", "turn-2", "assistant", "Understood."),
      ];
      const shortId = idOf("The user prefers short answers.");
      setAnswer([
        { type: "update", memoryId: shortId, text: "The user prefers very short answers." },
        { type: "update", memoryId: lisbon.id, text: "The user lives in Porto." },
        { type: "forget", memoryId: lisbon.id },
      ]);
      const applied = appliedOf(await runDay(DAY[1]));
      const prompt = prompts.at(-1) ?? "";
      assert.ok(!prompt.includes("Keep replies brief, please."), "the chat before the last done run is not read");
      assert.ok(
        prompt.includes("Make the answers very short from now on."),
        "the chat after the last done run is read",
      );
      assert.ok(!prompt.includes(PATTERN_SECRET), "a secret in the chat is not in the prompt");
      assert.deepEqual(
        applied.map((change) => [change.kind, change.memoryId]),
        [["update", shortId]],
      );
      assert.ok(texts().includes("The user lives in Lisbon."), "the manual memory is not changed or removed");
      assert.ok(texts().includes("The user prefers very short answers."));
      return { applied };
    },
  );

  await step("Undo restores the prior text and marks the run undone", async () => {
    const undo = consolidation.undo(AGENT, DAY[1]);
    assert.equal(undo.status, "undone");
    if (undo.status !== "undone") throw new Error("undo did not run");
    assert.equal(undo.unrestorable, 0);
    assert.ok(texts().includes("The user prefers short answers."), "the prior text is back");
    assert.ok(!texts().includes("The user prefers very short answers."));
    assert.equal(runRow(DAY[1])?.status, "undone");
    const again = consolidation.undo(AGENT, DAY[1]);
    assert.deepEqual(again, { status: "not-done", current: "undone" });
    return { changes: undo.changes.map((change) => change.action) };
  });

  await step("A generation error leaves the run failed and changes no memory", async () => {
    chat = [...chat, message("m6", "turn-3", "user", "Plan the release for Friday.")];
    const before = texts();
    answer = () => Effect.fail(new Error("fake generator failure"));
    const outcome = await runDay(DAY[2]);
    assert.equal(outcome.status, "failed");
    assert.deepEqual(texts(), before);
    assert.equal(runRow(DAY[2])?.status, "failed");
    assert.equal(runRow(DAY[2])?.appliedJson, "[]");
    return { outcome: outcome.status };
  });

  await step("A prior text that holds a registered secret is stored as a marker, not as the secret", async () => {
    // Stored before the secret is registered, so the write is not refused.
    memories.applyReview(
      AGENT,
      memories.reviewBase(AGENT),
      [{ type: "add", text: `The staging deploy token is ${SECRET}.`, inclusion: "searchable" }],
      "seed-secret-turn",
      { kind: "manual", threadId: null, turnId: null },
    );
    const secretId = idOf(`The staging deploy token is ${SECRET}.`);
    chat = [...chat, message("m7", "turn-4", "user", "The deploy token rotates every month.")];
    answer = () => {
      // Registered during the generation: the memory was read before the secret was known.
      registerSecretValue(SECRET);
      return Effect.succeed({
        operations: [{ type: "update", memoryId: secretId, text: "The staging deploy token rotates monthly." }],
      });
    };
    const applied = appliedOf(await runDay(DAY[3]));
    assert.deepEqual(applied, [
      { memoryId: secretId, kind: "update", priorText: SECRET_PRIOR_TEXT_MARKER, restorable: false },
    ]);
    const appliedJson = runRow(DAY[3])?.appliedJson ?? "";
    assert.ok(!appliedJson.includes(SECRET), "the secret is not stored in applied_json");
    assert.ok(texts().includes("The staging deploy token rotates monthly."));
    const undo = consolidation.undo(AGENT, DAY[3]);
    assert.equal(undo.status, "undone");
    if (undo.status !== "undone") throw new Error("undo did not run");
    assert.equal(undo.unrestorable, 1);
    assert.ok(texts().includes("The staging deploy token rotates monthly."), "the unrestorable update stays");
    return { applied, unrestorable: undo.unrestorable };
  });

  await step("A run due during a turn is postponed, then runs once the turn ends", async () => {
    chat = [...chat, message("m8", "turn-5", "user", "Start the billing project.")];
    setAnswer([{ type: "add", text: "Works on the billing project.", inclusion: "searchable" }]);
    const generated = prompts.length;
    turnActive = true;
    const postponed = await runDay(DAY[4]);
    assert.equal(postponed.status, "postponed");
    assert.equal(runRow(DAY[4]), null, "a postponed run records nothing");
    assert.equal(prompts.length, generated, "a postponed run generates nothing");
    turnActive = false;
    const applied = appliedOf(await runDay(DAY[4]));
    assert.equal(applied.length, 1);
    assert.equal(runRow(DAY[4])?.status, "done");
    return { postponed: postponed.status, applied: applied.length };
  });

  await step("A stale running row is marked failed and taken over once, so the day applies once", async () => {
    insertStaleRun(DAY[5], 1);
    chat = [...chat, message("m9", "turn-6", "user", "Ask for the billing review on Monday.")];
    setAnswer([{ type: "add", text: "Billing review is on Monday.", inclusion: "searchable" }]);
    const applied = appliedOf(await runDay(DAY[5]));
    assert.equal(applied.length, 1);
    assert.equal(runRow(DAY[5])?.status, "done");
    assert.equal(runRow(DAY[5])?.attempts, 2, "the takeover is the retry");
    const again = await runDay(DAY[5]);
    assert.equal(again.status, "skipped");
    assert.equal(
      texts().filter((text) => text === "Billing review is on Monday.").length,
      1,
      "the day's change is applied once",
    );
    return { applied: applied.length, attempts: 2 };
  });

  await step("A stale running row that already used its retry is marked failed and not retried", async () => {
    insertStaleRun(DAY[6], 2);
    const generated = prompts.length;
    const outcome = await runDay(DAY[6]);
    assert.equal(outcome.status, "skipped");
    assert.equal(prompts.length, generated, "no generation for a row past its retry");
    assert.equal(runRow(DAY[6])?.status, "failed");
    return { outcome: outcome.status };
  });

  await step(
    "The production turn-end hook runs the day's consolidation once, through MemoryReview.answer",
    async () => {
      const profileClients = new CannedProfileClients();
      profileClients.reply = JSON.stringify({
        operations: [{ type: "add", text: "Ships the billing project on Friday.", inclusion: "searchable" }],
      });
      chat = [...chat, message("m10", "turn-7", "user", "Ship the billing project on Friday.")];
      const review = new MemoryReview({
        memories,
        profileClients,
        listAgents: () => store.list(),
        models: (listed) =>
          Effect.succeed([
            {
              provider: listed.provider,
              id: listed.model,
              name: "Fixture model",
              description: "Fixture",
              defaultReasoningEffort: listed.reasoningEffort,
              supportedReasoningEfforts: [listed.reasoningEffort],
              reasoningEffortSupported: true,
            },
          ]),
        createProfileClient: () => JSON.parse("{}"),
        usageObserver: () => () => undefined,
        chat: () => chat,
        turnActive: () => turnActive,
        appendSystemMessage: () => undefined,
        redact: redactText,
        stopping: () => false,
        consolidation,
      });
      reviews.current = review;
      const rowsBefore = countRuns();
      await runCauseEffect(review.turnEnded(AGENT, null, true, false));
      // The hook forks the run: wait until it has written its row and that row has left `running`.
      let status = "running";
      for (let attempt = 0; attempt < 200 && (countRuns() === rowsBefore || status === "running"); attempt += 1) {
        await Bun.sleep(50);
        status = latestRunStatus();
      }
      assert.equal(status, "done");
      assert.equal(profileClients.generations, 1, "the production generation ran once");
      assert.ok(texts().includes("Ships the billing project on Friday."), "the production answer was applied");
      await runCauseEffect(review.turnEnded(AGENT, null, true, false));
      await Bun.sleep(300);
      assert.equal(profileClients.generations, 1, "a second turn end the same day generates nothing");
      return { generations: profileClients.generations };
    },
  );

  assert.deepEqual(errors, [], "no memory commit failed");
  report.passed = true;
} catch (error) {
  if (steps.every((entry) => entry.passed)) {
    steps.push({ name: "run", passed: false, error: error instanceof Error ? error.message : String(error) });
  }
} finally {
  if (reviews.current) await runCauseEffect(reviews.current.dispose()).catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  report.steps = steps;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
