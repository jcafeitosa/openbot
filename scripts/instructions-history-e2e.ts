// Runs the agent instruction history on the real modules: a fake agent turn writes the workspace's
// AGENTS.md through the save path, which keeps the text it replaces; a restore by that text's hash
// rewrites the file and keeps what it replaces; a text that holds a registered secret is never kept;
// and the newest 50 snapshots of the file survive a longer run of writes. The database is a migrated
// temporary file and no provider is used. `bun scripts/instructions-history-e2e.ts`. Writes
// .openbot-build/instructions-history-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import {
  InstructionsSnapshotMissing,
  restoreAgentInstructionsSnapshot,
  saveAgentInstructionsFile,
} from "../src/backend/agent/workspace-instructions";
import { INSTRUCTIONS_SNAPSHOT_LIMIT, instructionsTextSha256 } from "../src/backend/instructions-history-store";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const OUT = resolve(import.meta.dirname, "../.openbot-build/instructions-history-e2e");
const AGENT = "agent-1";
const FILE_NAME = "AGENTS.md";
const OLD_TEXT = "# Rules\n- Reply in one short paragraph.\n";
const NEW_TEXT = "# Rules\n- Reply in one short paragraph.\n- Ask before deleting files.\n";
const SECRET = "e2e-secret-value-7f3a9c";
const SECRET_TEXT = `${OLD_TEXT}- Use token ${SECRET} for the staging site.\n`;
const CLEAN_TEXT = "# Rules\n- Reply in one short paragraph.\n- Never post secrets.\n";
const LONG_RUN_WRITES = 55;

interface Check {
  name: string;
  status: "passed" | "failed";
  detail?: string;
}

const checks: Check[] = [];
const root = await mkdtemp(join(tmpdir(), "openbot-instructions-history-e2e-"));
const workspace = join(root, "workspace");
const file = join(workspace, FILE_NAME);
const db = new DatabaseSync(join(root, "openbot.db"));

async function check(name: string, run: () => unknown): Promise<void> {
  try {
    const detail = await run();
    checks.push({ name, status: "passed", ...(typeof detail === "string" ? { detail } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: "failed", detail: redactText(message) });
    throw error;
  }
}

/** The result of an effect, or its typed failure as the thrown value. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(result)) return result.success;
  throw result.failure;
}

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result), "the effect should have failed");
  return result.failure;
}

/** The first row of a query, narrowed at runtime: a SQLite row is not trusted to have a shape. */
function queryRow(sql: string, ...params: string[]): DynamicRecord {
  const row = db.prepare(sql).get(...params);
  if (!isDynamicRecord(row)) throw new Error("the query returned no row");
  return row;
}

function countOf(row: DynamicRecord): number {
  const value = row.count;
  if (!isNumber(value)) throw new Error("the count is not a number");
  return value;
}

function textOf(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`the column ${key} is not text`);
  return value;
}

function snapshotCount(): number {
  return countOf(queryRow("SELECT COUNT(*) AS count FROM agent_instructions_snapshots"));
}

function newestSnapshotText(): string {
  return textOf(
    queryRow(
      `SELECT text FROM agent_instructions_snapshots WHERE agent_id = ? AND file_path = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      AGENT,
      FILE_NAME,
    ),
    "text",
  );
}

await mkdir(workspace, { recursive: true });
await writeFile(file, OLD_TEXT, { mode: 0o600 });
db.exec("PRAGMA foreign_keys = ON");
migrateOpenBotDatabase(db);
db.prepare(
  `INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
   VALUES (?, NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 1)`,
).run(AGENT);
const history = { agentId: AGENT, database: db };

try {
  await check("a fake agent turn writes AGENTS.md with new text", async () => {
    await run(saveAgentInstructionsFile(workspace, NEW_TEXT, OLD_TEXT, history));
    assert.equal(await readFile(file, "utf8"), NEW_TEXT);
  });

  await check("the snapshot holds the previous text and its hash", () => {
    assert.equal(snapshotCount(), 1);
    const row = queryRow("SELECT text, sha256, created_at FROM agent_instructions_snapshots WHERE agent_id = ?", AGENT);
    assert.equal(textOf(row, "text"), OLD_TEXT);
    assert.equal(textOf(row, "sha256"), instructionsTextSha256(OLD_TEXT));
    assert.ok(!Number.isNaN(Date.parse(textOf(row, "created_at"))), "created_at is an ISO time");
    return `sha256=${instructionsTextSha256(OLD_TEXT)}`;
  });

  await check("restore by hash rewrites the file, and the file hash matches", async () => {
    await run(
      restoreAgentInstructionsSnapshot(
        workspace,
        instructionsTextSha256(OLD_TEXT),
        history,
        instructionsTextSha256(NEW_TEXT),
      ),
    );
    const restored = await readFile(file, "utf8");
    assert.equal(restored, OLD_TEXT);
    assert.equal(instructionsTextSha256(restored), instructionsTextSha256(OLD_TEXT));
  });

  await check("the restore is recorded as a new snapshot of the text it replaced", () => {
    assert.equal(snapshotCount(), 2);
    assert.equal(newestSnapshotText(), NEW_TEXT);
  });

  await check("a restore by an unknown hash changes nothing", async () => {
    const failure = await failureOf(
      restoreAgentInstructionsSnapshot(workspace, "0".repeat(64), history, instructionsTextSha256(OLD_TEXT)),
    );
    assert.ok(failure instanceof InstructionsSnapshotMissing, "the failure names the missing snapshot");
    assert.equal(await readFile(file, "utf8"), OLD_TEXT);
    assert.equal(snapshotCount(), 2);
  });

  await check("a text with a registered secret is never kept, and the write still lands", async () => {
    registerSecretValue(SECRET);
    await run(saveAgentInstructionsFile(workspace, SECRET_TEXT, OLD_TEXT, history));
    assert.equal(snapshotCount(), 3, "the text that the secret write replaced is kept");
    await run(saveAgentInstructionsFile(workspace, CLEAN_TEXT, SECRET_TEXT, history));
    assert.equal(await readFile(file, "utf8"), CLEAN_TEXT);
    assert.equal(snapshotCount(), 3, "the text with the secret is refused, so nothing is added");
    assert.equal(
      countOf(queryRow("SELECT COUNT(*) AS count FROM agent_instructions_snapshots WHERE text LIKE ?", `%${SECRET}%`)),
      0,
    );
  });

  await check(`pruning keeps ${INSTRUCTIONS_SNAPSHOT_LIMIT} rows after ${LONG_RUN_WRITES} more writes`, async () => {
    let current = CLEAN_TEXT;
    for (let index = 0; index < LONG_RUN_WRITES; index += 1) {
      const next = `# Rules\n- Write number ${index}.\n`;
      await run(saveAgentInstructionsFile(workspace, next, current, history));
      current = next;
    }
    assert.equal(snapshotCount(), INSTRUCTIONS_SNAPSHOT_LIMIT);
    assert.equal(newestSnapshotText(), `# Rules\n- Write number ${LONG_RUN_WRITES - 2}.\n`);
    return `rows=${snapshotCount()}`;
  });

  const report = {
    status: "passed",
    generatedAt: new Date().toISOString(),
    agent: AGENT,
    file: FILE_NAME,
    limit: INSTRUCTIONS_SNAPSHOT_LIMIT,
    checks,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`instructions-history-e2e: ${checks.length} checks passed; report at ${OUT}/report.json\n`);
} catch (error) {
  const report = { status: "failed", generatedAt: new Date().toISOString(), checks };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
  process.stderr.write(`instructions-history-e2e failed: ${redactText(String(error))}\n`);
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
