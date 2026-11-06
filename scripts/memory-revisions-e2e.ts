// Checks the revisions of agent memories: each change to a memory's text keeps the text it replaces, with the
// source it had and the reason for the change, and the revisions leave with their memory. The scenarios drive
// `AgentMemoryStore` on a real database in a temporary folder. No provider, account or network is started.
// Checks:
//   1. An edit keeps the previous text, its origin, its source and the reason "manual-edit". A later automatic
//      update keeps the text it replaces with the reason "automatic-review".
//   2. Forgetting a memory leaves no revision of it.
//   3. Clearing an agent's memories leaves no revision of them, and the revisions of another agent stay.
//   4. A secret the user registered is not stored in any revision, even after a later edit would keep it. A known
//      secret pattern is masked before a revision keeps the text it is in.
//   5. Deleting an agent removes the revisions of its memories. Run: `bun scripts/memory-revisions-e2e.ts`.
// Writes .openbot-build/memory-revisions-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSecretValue } from "@openbot/logging";
import { AgentMemoryStore } from "../src/backend/agent-memory-store";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "memory-revisions-e2e");
const AGENT = "revisions-agent";
const CLEARED_AGENT = "revisions-cleared-agent";
const REGISTERED_SECRET = "openbot-e2e-registered-secret-7f3a9c2b";
const PATTERN_SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

interface StepReport {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

interface RevisionView {
  seq: number;
  text: string;
  origin: string;
  sourceKind: string | null;
  reason: string;
}

const steps: StepReport[] = [];
const report: { passed: boolean; steps: StepReport[] } = { passed: false, steps: [] };

async function step(name: string, run: () => unknown): Promise<void> {
  process.stdout.write(`- ${name}\n`);
  try {
    const detail = await run();
    steps.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-memory-revisions-"));
const database = new OpenBotDatabase(root);

try {
  await runCauseEffect(database.initialize());
  registerSecretValue(REGISTERED_SECRET);
  const memories = new AgentMemoryStore(database);

  /** The revisions of one memory, in the order they were kept. */
  function revisionsOf(memoryId: string): RevisionView[] {
    return databaseRows(
      database.connection
        .prepare(
          `SELECT seq, text, origin, source_kind, reason FROM agent_memory_revisions
           WHERE memory_id = ? ORDER BY seq`,
        )
        .all(memoryId),
    ).map((row) => ({
      seq: requiredNumberColumn(row, "seq"),
      text: requiredStringColumn(row, "text"),
      origin: requiredStringColumn(row, "origin"),
      sourceKind: optionalStringColumn(row, "source_kind"),
      reason: requiredStringColumn(row, "reason"),
    }));
  }

  /** A count the SQL returns as `count`. */
  function count(sql: string, ...parameters: string[]): number {
    return Number(databaseRow(database.connection.prepare(sql).get(...parameters))?.count ?? 0);
  }

  await step("An edit keeps the previous text, its origin, its source and the reason of the change", () => {
    const memory = memories.createManual(AGENT, "Alpha text");
    memories.updateManual(AGENT, memory.id, "Beta text");
    const updated = memories.saveAutomatic({
      agentId: AGENT,
      memoryId: memory.id,
      text: "Gamma text",
      sourceTurnId: "review:thread-1:turn-2",
      sourceKind: "review",
      sourceThreadId: "thread-1",
    });
    assert.ok(updated, "the automatic update was saved");
    const revisions = revisionsOf(memory.id);
    assert.deepEqual(revisions, [
      { seq: 1, text: "Alpha text", origin: "manual", sourceKind: "manual", reason: "manual-edit" },
      { seq: 2, text: "Beta text", origin: "manual", sourceKind: "manual", reason: "automatic-review" },
    ]);
    return { memoryId: memory.id, revisions };
  });

  await step("Forgetting a memory leaves no revision of it", () => {
    const memory = memories.createManual(AGENT, "Forgotten draft");
    memories.updateManual(AGENT, memory.id, "Forgotten final");
    assert.equal(count("SELECT COUNT(*) AS count FROM agent_memory_revisions WHERE memory_id = ?", memory.id), 1);
    assert.equal(memories.delete(AGENT, memory.id), true);
    assert.equal(count("SELECT COUNT(*) AS count FROM agent_memory_revisions WHERE memory_id = ?", memory.id), 0);
  });

  await step("Clearing an agent's memories leaves no revision of them, and keeps another agent's", () => {
    const keptBefore = count(
      `SELECT COUNT(*) AS count FROM agent_memory_revisions r
       JOIN projection_agent_memories m ON m.memory_id = r.memory_id WHERE m.agent_id = ?`,
      AGENT,
    );
    assert.ok(keptBefore > 0, "the other agent has revisions to keep");
    for (const text of ["One", "Two"]) {
      const memory = memories.createManual(CLEARED_AGENT, text);
      memories.updateManual(CLEARED_AGENT, memory.id, `${text} edited`);
    }
    assert.equal(
      count(
        `SELECT COUNT(*) AS count FROM agent_memory_revisions r
         JOIN projection_agent_memories m ON m.memory_id = r.memory_id WHERE m.agent_id = ?`,
        CLEARED_AGENT,
      ),
      2,
    );
    assert.equal(memories.clear(CLEARED_AGENT), 2);
    assert.equal(
      count(
        `SELECT COUNT(*) AS count FROM agent_memory_revisions r
         JOIN projection_agent_memories m ON m.memory_id = r.memory_id WHERE m.agent_id = ?`,
        CLEARED_AGENT,
      ),
      0,
    );
    const keptAfter = count(
      `SELECT COUNT(*) AS count FROM agent_memory_revisions r
       JOIN projection_agent_memories m ON m.memory_id = r.memory_id WHERE m.agent_id = ?`,
      AGENT,
    );
    assert.equal(keptAfter, keptBefore);
    return { keptBefore, keptAfter };
  });

  await step("A registered secret is not stored in any revision, and a known pattern is masked", () => {
    const memory = memories.createManual(AGENT, "Plain note");
    // The manual edit keeps its text, so the secret is in the memory from here on.
    memories.updateManual(AGENT, memory.id, `Note with ${REGISTERED_SECRET}`);
    // This edit would keep the text with the secret: the revision is refused.
    memories.updateManual(AGENT, memory.id, "Clean note");
    memories.updateManual(AGENT, memory.id, `Pattern ${PATTERN_SECRET}`);
    // This edit keeps the text with the known pattern, masked.
    memories.updateManual(AGENT, memory.id, "Last note");
    const texts = revisionsOf(memory.id).map((revision) => revision.text);
    assert.deepEqual(texts.slice(0, 2), ["Plain note", "Clean note"]);
    assert.equal(texts.length, 3, "the revision of the secret text is not kept");
    const masked = texts[2] ?? "";
    assert.ok(masked.startsWith("Pattern "), "the masked revision keeps the rest of its text");
    assert.ok(!masked.includes(PATTERN_SECRET), "the known pattern is masked in the revision");
    assert.equal(
      count("SELECT COUNT(*) AS count FROM agent_memory_revisions WHERE instr(text, ?) > 0", REGISTERED_SECRET),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS count FROM agent_memory_revisions WHERE instr(text, ?) > 0", PATTERN_SECRET),
      0,
    );
    return { texts };
  });

  await step("Deleting an agent removes the revisions of its memories", () => {
    const before = count("SELECT COUNT(*) AS count FROM agent_memory_revisions");
    assert.ok(before > 0, "the agent has revisions before its deletion");
    // The statement that database/agent-roster.ts runs when it hard-deletes an agent.
    database.connection.prepare("DELETE FROM projection_agent_memories WHERE agent_id = ?").run(AGENT);
    const after = count("SELECT COUNT(*) AS count FROM agent_memory_revisions");
    assert.equal(after, 0);
    return { before, after };
  });

  report.passed = true;
} catch (error) {
  if (steps.every((entry) => entry.passed)) {
    steps.push({ name: "run", passed: false, error: error instanceof Error ? error.message : String(error) });
  }
} finally {
  database.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  report.steps = steps;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
