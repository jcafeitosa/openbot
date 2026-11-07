// Checks the expiry and the predicate of an open wait on the real SQLite store and the real `AgentWaits` wake path.
// A predicate that names routine A wakes only for a run of A; a wait whose expiry has passed closes at the next
// wake check and does not wake; a wait with neither still wakes as before. The clock is controlled through the
// store's `now`, so no test waits for real time. The predicate and the expiry are set only through the store API:
// the `await_event` tool does not set them. Refused values are checked too: an expiry not after the wait opens,
// an expiry past 7 days, a predicate that names a run status, and a predicate with an unknown key.
// No provider, account or network is started.
// Run: `bun scripts/agent-waits-ttl-e2e.ts`.
// Writes .openbot-build/agent-waits-ttl-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { AgentStore } from "../src/backend/agent-store";
import {
  AGENT_WAIT_MAX_TTL_MS,
  type AgentWaitPredicate,
  AgentWaitStore,
} from "../src/backend/agent-waits/agent-wait-store";
import { AgentWaits } from "../src/backend/agent-waits/agent-waits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "agent-waits-ttl-e2e");
const HOUR_MS = 60 * 60 * 1000;

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; notes: string[]; steps: Step[] } = {
  passed: false,
  notes: [
    "The expiry and the predicate are set through AgentWaitStore.open only. The await_event tool does not set them.",
    "A run status in a predicate is refused: a run wakes its waits when it is queued, before its outcome is known.",
  ],
  steps: [],
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-agent-waits-ttl-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
const events: AgentEvent[] = [];
let clock = new Date("2026-03-01T10:00:00.000Z");
const waitStore = new AgentWaitStore({ database, now: () => clock });
const waits = new AgentWaits({
  store: waitStore,
  mailbox,
  hooks: {
    emit: (event) => events.push(event),
    ownsRoutine: () => true,
    hasRoutine: () => true,
    requireKnownAgent: () => {},
    routineForDelivery: () => null,
  },
});

/** Opens a wait for an agent on the request of a synthetic delivery. */
function open(
  agentId: string,
  note: string,
  options: { expiresAt?: Date | null; predicate?: AgentWaitPredicate | null } = {},
) {
  return waitStore.open({
    agentId,
    requestMessageId: `delivery-request-${agentId}`,
    requestText: "The user's request.",
    note,
    routineId: null,
    ...options,
  });
}

/** The wake-related columns that the store keeps for a wait, read from the row itself. */
function storedColumns(waitId: string): { expires_at: unknown; predicate_json: unknown } {
  const row = database.connection
    .prepare("SELECT expires_at, predicate_json FROM agent_waits WHERE wait_id = ?")
    .get(waitId);
  assert.ok(row, "The wait row exists.");
  return { expires_at: row.expires_at, predicate_json: row.predicate_json };
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());

  await step("The store refuses an expiry that is not after the wait opens", async () => {
    const refusals: string[] = [];
    for (const expiresAt of [clock, new Date(clock.getTime() - 60_000)]) {
      assert.throws(
        () => open("agent-refused", "Too early", { expiresAt }),
        /cannot expire before it opens/,
        "An expiry at or before the opening is refused.",
      );
      refusals.push(expiresAt.toISOString());
    }
    assert.throws(() => open("agent-refused", "Too early", { expiresAt: new Date(Number.NaN) }), /not a valid date/);
    assert.equal(waitStore.list("agent-refused").length, 0, "A refused wait is not stored.");
    return { refusedExpiries: refusals };
  });

  await step("The store refuses an expiry past 7 days and accepts exactly 7 days", async () => {
    assert.throws(
      () =>
        open("agent-cap", "Too long", {
          expiresAt: new Date(clock.getTime() + AGENT_WAIT_MAX_TTL_MS + 1),
        }),
      /more than 7 days/,
    );
    const atCap = open("agent-cap", "Exactly the cap", {
      expiresAt: new Date(clock.getTime() + AGENT_WAIT_MAX_TTL_MS),
    });
    assert.ok(atCap.id);
    assert.equal(waitStore.list("agent-cap").length, 1, "Only the wait at the cap is stored.");
    return { capMs: AGENT_WAIT_MAX_TTL_MS };
  });

  await step("The store refuses a predicate that names a run status or an unknown key", async () => {
    // Data from outside the typed API: parsed, so no assertion is needed, and the store refuses both keys.
    const withStatus: AgentWaitPredicate = JSON.parse('{"routineId":"routine-a","status":"completed"}');
    const withUnknownKey: AgentWaitPredicate = JSON.parse('{"routineId":"routine-a","extra":true}');
    assert.throws(() => open("agent-predicate", "Status", { predicate: withStatus }), /run status/);
    assert.throws(() => open("agent-predicate", "Unknown key", { predicate: withUnknownKey }));
    assert.equal(waitStore.list("agent-predicate").length, 0, "A refused predicate is not stored.");
    return { refusedKeys: ["status", "extra"] };
  });

  // (1) and (2): a predicate for routine A.
  const named = await step("A predicate for routine A does not wake on a run of routine B", async () => {
    const predicated = open("agent-a", "Deploy", { predicate: { routineId: "routine-a" } });
    waits.wakeForRun({ agentId: "agent-a", routineId: "routine-b" }, "delivery-b-1", null);
    waits.wakeForRun({ agentId: "agent-a", routineId: "routine-b" }, "delivery-b-2", predicated.id);
    const after = waitStore.get("agent-a", predicated.id);
    assert.ok(after, "The wait stays open.");
    assert.equal(after.wakeDeliveryId, null, "A run of routine B does not wake it, not even by name.");
    assert.deepEqual(storedColumns(predicated.id).predicate_json, JSON.stringify({ routineId: "routine-a" }));
    return { waitId: predicated.id };
  });

  await step("The same wait wakes on a run of routine A", async () => {
    waits.wakeForRun({ agentId: "agent-a", routineId: "routine-a" }, "delivery-a-1", null);
    const woken = waits.wokenBy("delivery-a-1");
    assert.deepEqual(
      woken.map((wait) => wait.id),
      [named.waitId],
      "A run of routine A wakes the wait.",
    );
    return { woken: woken.map((wait) => wait.id) };
  });

  await step("A wait whose expiry has passed closes at the next wake check and does not wake", async () => {
    const expiring = open("agent-b", "Expires soon", { expiresAt: new Date(clock.getTime() + HOUR_MS) });
    const second = open("agent-b", "Also expires soon", { expiresAt: new Date(clock.getTime() + HOUR_MS) });
    const plain = open("agent-b", "No expiry");
    clock = new Date(clock.getTime() + 2 * HOUR_MS);
    const before = events.length;
    waits.wakeForRun({ agentId: "agent-b", routineId: "routine-x" }, "delivery-expired", null);
    assert.equal(waitStore.get("agent-b", expiring.id), null, "The expired wait is closed.");
    assert.equal(waitStore.get("agent-b", second.id), null, "Every expired wait is closed.");
    assert.deepEqual(
      waits.wokenBy("delivery-expired").map((wait) => wait.id),
      [plain.id],
      "Only the wait without an expiry wakes.",
    );
    assert.ok(
      events.slice(before).some((event) => event.type === "waits-changed" && event.snapshot.agentId === "agent-b"),
      "The chat is told the waits changed.",
    );
    return { closed: [expiring.id, second.id], woken: [plain.id] };
  });

  await step("A named script event does not wake a wait whose expiry has passed", async () => {
    const expired = open("agent-c", "Expired by name", { expiresAt: new Date(clock.getTime() + HOUR_MS) });
    clock = new Date(clock.getTime() + 2 * HOUR_MS);
    waits.wakeForRun({ agentId: "agent-c", routineId: "routine-y" }, "delivery-named-expired", expired.id);
    assert.equal(waitStore.get("agent-c", expired.id), null, "The named expired wait is closed.");
    assert.deepEqual(waits.wokenBy("delivery-named-expired"), []);
    return { closed: expired.id };
  });

  await step("A wait without a predicate or an expiry wakes as before", async () => {
    const anyRun = open("agent-d", "Any run");
    waits.wakeForRun({ agentId: "agent-d", routineId: "routine-other" }, "delivery-plain", null);
    assert.deepEqual(
      waits.wokenBy("delivery-plain").map((wait) => wait.id),
      [anyRun.id],
      "An unscoped wait wakes on any run of its agent.",
    );
    assert.deepEqual(storedColumns(anyRun.id), { expires_at: null, predicate_json: null });
    return { woken: [anyRun.id] };
  });

  await step("A named script event from routine B does not wake a wait bound to routine A", async () => {
    // A wait's routine column references a routine row, so routine A is written first.
    const now = clock.toISOString();
    database.connection
      .prepare(
        `INSERT INTO projection_agent_routines (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
         VALUES (?, ?, ?, ?, 1, 'UTC', ?, ?, 0)`,
      )
      .run("routine-a", "agent-e", "Routine A", "Run routine A.", now, now);
    const bound = waitStore.open({
      agentId: "agent-e",
      requestMessageId: "delivery-request-agent-e",
      requestText: "The user's request.",
      note: "Bound to routine A",
      routineId: "routine-a",
    });
    waits.wakeForRun({ agentId: "agent-e", routineId: "routine-b" }, "delivery-e-named-b", bound.id);
    const after = waitStore.get("agent-e", bound.id);
    assert.ok(after, "The wait stays open.");
    assert.equal(after.wakeDeliveryId, null, "A named event from routine B does not wake a wait bound to routine A.");
    assert.deepEqual(waits.wokenBy("delivery-e-named-b"), []);
    waits.wakeForRun({ agentId: "agent-e", routineId: "routine-a" }, "delivery-e-named-a", bound.id);
    assert.deepEqual(
      waits.wokenBy("delivery-e-named-a").map((wait) => wait.id),
      [bound.id],
      "A named event from routine A wakes the wait bound to it.",
    );
    return { waitId: bound.id };
  });

  report.passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
