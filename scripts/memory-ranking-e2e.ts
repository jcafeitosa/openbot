// Checks the order of `AgentMemoryStore.search`: FTS5 bm25 relevance first, then recency
// (`updated_at`), then origin (manual above automatic). Every scenario first checks its bm25
// precondition with the same query, so the order assertion tests the ranking and nothing else.
// No provider, account or network is started.
// Run: `bun scripts/memory-ranking-e2e.ts`.
// Writes .openbot-build/memory-ranking-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentMemoryStore } from "../src/backend/agent-memory-store";
import { databaseRows, requiredNumberColumn, requiredStringColumn } from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "memory-ranking-e2e");

interface SeedMemory {
  text: string;
  origin: "manual" | "automatic";
  updatedAt: string;
}

interface Scenario {
  name: string;
  query: string;
  /** `equal`: every matching memory has the same bm25 score. `first-stronger`: expected[0] scores better. */
  relevance: "equal" | "first-stronger";
  /** Each agent gets the same seeds, so a tie-break that is only lucky on one run cannot pass. */
  agentIds: readonly string[];
  /** Inserted in this order, with `updated_at` then pinned explicitly, so insertion order proves nothing. */
  seeds: readonly SeedMemory[];
  expected: readonly string[];
}

interface StepReport {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "Relevance beats recency",
    query: "kestrel",
    relevance: "first-stronger",
    agentIds: ["ranking-relevance"],
    seeds: [
      {
        text: "Kestrel migration notes for the release team on Friday",
        origin: "manual",
        updatedAt: "2026-03-01T09:00:00.000Z",
      },
      { text: "Kestrel kestrel kestrel", origin: "manual", updatedAt: "2026-01-01T09:00:00.000Z" },
    ],
    expected: ["Kestrel kestrel kestrel", "Kestrel migration notes for the release team on Friday"],
  },
  {
    name: "Equal relevance: newer wins",
    query: "ferret",
    relevance: "equal",
    agentIds: ["ranking-recency"],
    seeds: [
      { text: "Ferret checklist bravo", origin: "manual", updatedAt: "2026-03-01T09:00:00.000Z" },
      { text: "Ferret checklist alpha", origin: "manual", updatedAt: "2026-01-01T09:00:00.000Z" },
    ],
    expected: ["Ferret checklist bravo", "Ferret checklist alpha"],
  },
  {
    name: "Equal relevance and recency: manual wins",
    query: "lynx",
    relevance: "equal",
    // Four agents: with the same tie on each, a memory-id tie-break would pass only by chance.
    agentIds: ["ranking-origin-1", "ranking-origin-2", "ranking-origin-3", "ranking-origin-4"],
    seeds: [
      { text: "Lynx protocol bravo", origin: "automatic", updatedAt: "2026-02-01T09:00:00.000Z" },
      { text: "Lynx protocol alpha", origin: "manual", updatedAt: "2026-02-01T09:00:00.000Z" },
    ],
    expected: ["Lynx protocol alpha", "Lynx protocol bravo"],
  },
];

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

const root = await mkdtemp(join(tmpdir(), "openbot-memory-ranking-"));
const database = new OpenBotDatabase(root);

try {
  await runCauseEffect(database.initialize());
  const memories = new AgentMemoryStore(database);

  /** Saves each seed, then pins its `updated_at`, which the store otherwise stamps with the clock. */
  function seed(agentId: string, seeds: readonly SeedMemory[]): void {
    for (const entry of seeds) {
      const memory =
        entry.origin === "manual"
          ? memories.createManual(agentId, entry.text)
          : memories.saveAutomatic({ agentId, text: entry.text, sourceTurnId: "turn-memory-ranking-e2e" });
      assert.ok(memory, `seed "${entry.text}" was not saved`);
      database.connection
        .prepare("UPDATE projection_agent_memories SET updated_at = ? WHERE memory_id = ?")
        .run(entry.updatedAt, memory.id);
    }
  }

  /** The bm25 score of every memory matching the exact query term, as FTS5 reports it. */
  function bm25Scores(agentId: string, query: string): Map<string, number> {
    return new Map(
      databaseRows(
        database.connection
          .prepare(
            `SELECT m.text AS text, bm25(agent_memory_search) AS score
             FROM agent_memory_search JOIN projection_agent_memories m ON m.rowid = agent_memory_search.rowid
             WHERE agent_memory_search MATCH ? AND m.agent_id = ?`,
          )
          .all(`"${query}"`, agentId),
      ).map((row) => [requiredStringColumn(row, "text"), requiredNumberColumn(row, "score")] as const),
    );
  }

  for (const scenario of SCENARIOS) {
    await step(scenario.name, () => {
      const runs = scenario.agentIds.map((agentId) => {
        seed(agentId, scenario.seeds);
        const scores = bm25Scores(agentId, scenario.query);
        assert.deepEqual(
          [...scores.keys()].sort(),
          [...scenario.expected].sort(),
          `${scenario.name}: the query "${scenario.query}" must match exactly the expected memories`,
        );
        if (scenario.relevance === "equal") {
          assert.equal(new Set(scores.values()).size, 1, `${scenario.name}: bm25 scores must be equal`);
        } else {
          const [first = "", second = ""] = scenario.expected;
          assert.ok(
            (scores.get(first) ?? Number.NaN) < (scores.get(second) ?? Number.NaN),
            `${scenario.name}: the first expected memory must have the better bm25 score`,
          );
        }
        const actual = memories.search(agentId, scenario.query).memories.map((memory) => memory.text);
        assert.deepEqual(actual, scenario.expected, `${scenario.name} (${agentId})`);
        return { agentId, actual };
      });
      return { query: scenario.query, relevance: scenario.relevance, runs };
    });
  }

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

if (!report.passed) {
  process.exitCode = 1;
}
