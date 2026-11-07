// Checks that a roster write never gives a thread to a second agent. The thread keeps its owner, the write is refused
// with a ThreadOwnerConflict, and the roster and its event log stay as they were. A write that keeps every owner still
// succeeds. Boots the real agent store on a temporary profile; no app, provider, account or network is started.
//
// Run: bun scripts/roster-thread-owner-e2e.ts
// Writes .openbot-build/roster-thread-owner-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentStore } from "../src/backend/agent-store";
import { ThreadOwnerConflict } from "../src/backend/database/agent-roster";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/roster-thread-owner-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-roster-thread-owner-"));
const userData = join(root, "user-data");
const home = join(root, "home");

const report: { checks: { name: string; passed: boolean }[]; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
}

const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);

try {
  await runCauseEffect(store.initialize());
  const first = await runCauseEffect(
    store.createAgent({ name: "First", description: "", avatarSeed: "seed-1", avatarHue: null }),
  );
  const second = await runCauseEffect(
    store.createAgent({ name: "Second", description: "", avatarSeed: "seed-2", avatarHue: null }),
  );
  const entry = (id: string) => {
    const found = database.listAgents().find((agent) => agent.id === id);
    if (!found) throw new Error(`${id} is not listed.`);
    return found;
  };
  // The agent service gives an agent its thread when it opens one. Here a roster write does, through the same
  // projection (`ensureThreadProjection`) that the service's writes use.
  database.replaceAgents(
    "roster-thread-owner-e2e:threads",
    database.listAgents().map((agent) => ({ ...agent, threadId: agent.threadId ?? randomUUID() })),
    "agents.updated",
  );
  const firstThread = entry(first.id).threadId;
  const secondThread = entry(second.id).threadId;
  if (!firstThread || !secondThread) throw new Error("An agent has no thread.");
  const ownerOf = (threadId: string) =>
    database.connection.prepare("SELECT agent_id FROM projection_threads WHERE thread_id = ?").get(threadId)?.agent_id;
  const eventCount = () =>
    Number(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_type = 'agents'")
        .get()?.count ?? 0,
    );

  pass(
    "Each agent's thread is owned by that agent before the conflicting write",
    ownerOf(firstThread) === first.id && ownerOf(secondThread) === second.id,
    { first: ownerOf(firstThread), second: ownerOf(secondThread) },
  );
  const eventsBefore = eventCount();

  // The write gives the second agent the first agent's thread, as a duplicated thread id would.
  const duplicated = store
    .list()
    .map((agent) => (agent.id === second.id ? { ...agent, threadId: firstThread } : agent));
  let refusal: unknown = null;
  try {
    database.replaceAgents("roster-thread-owner-e2e:duplicate-thread", duplicated, "agents.updated");
  } catch (error) {
    refusal = error;
  }
  pass(
    "A roster write that gives a thread to a second agent throws a typed ThreadOwnerConflict",
    refusal instanceof ThreadOwnerConflict &&
      refusal.threadId === firstThread &&
      refusal.ownerAgentId === first.id &&
      refusal.requestedAgentId === second.id,
    { error: String(refusal) },
  );
  pass("The thread keeps its existing owner", ownerOf(firstThread) === first.id);
  pass("The refused write keeps the second agent's own thread", entry(second.id).threadId === secondThread);
  pass("The refused write leaves no roster event", eventCount() === eventsBefore, {
    before: eventsBefore,
    after: eventCount(),
  });

  // A write that keeps every thread with its agent is not refused.
  database.replaceAgents("roster-thread-owner-e2e:same-owners", database.listAgents(), "agents.updated");
  pass(
    "A roster write that keeps each thread with its agent succeeds",
    ownerOf(firstThread) === first.id && ownerOf(secondThread) === second.id,
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
