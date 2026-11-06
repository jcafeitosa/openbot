// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Failure modes: the upgrade from schema 65 changes or loses a row of an existing table; the new table
// accepts a status outside its check, a second run for the same agent and day, an applied list that is
// not JSON, or more than one retry of a stopped run. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** A memory that the upgrade must keep, with the text and origin it had at schema 65. */
function seedMemory(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'The user prefers short answers.', 'the user prefers short answers.', 'automatic',
      'turn-1', '2026-01-01', '2026-01-01', 2)`).run();
}

/** Every row of the memory table, as the upgrade reads it. */
function memoryRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      `SELECT memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at,
         last_event_sequence FROM projection_agent_memories ORDER BY memory_id`,
    )
    .all();
}

function insertRun(
  db: DatabaseSync,
  values: { agentId?: string; day?: string; status?: string; applied?: string; attempts?: number } = {},
) {
  db.prepare(`INSERT INTO memory_consolidation_runs
    (agent_id, run_day, status, cursor_turn_id, applied_json, created_at, finished_at, attempts)
    VALUES (?, ?, ?, 'turn-1', ?, '2026-01-02T10:00:00.000Z', NULL, ?)`).run(
    values.agentId ?? "chief",
    values.day ?? "2026-01-02",
    values.status ?? "running",
    values.applied ?? "[]",
    values.attempts ?? 1,
  );
}

describe("memory consolidation migration", () => {
  it("upgrades a schema 65 database to 66 and keeps every row", () => {
    const db = databaseAt(65);
    seedMemory(db);
    const before = memoryRows(db);

    migrateOpenBotDatabase(db);

    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 66 });
    expect(memoryRows(db)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_consolidation_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("rejects a status outside the check, and accepts undone", () => {
    const db = databaseAt(65);
    migrateOpenBotDatabase(db);

    expect(() => insertRun(db, { status: "bogus" })).toThrow(/CHECK constraint failed/);
    insertRun(db, { status: "undone" });
    expect(db.prepare("SELECT status FROM memory_consolidation_runs").get()).toEqual({ status: "undone" });
  });

  it("keeps one run per agent and day", () => {
    const db = databaseAt(65);
    migrateOpenBotDatabase(db);
    insertRun(db, { status: "done" });

    expect(() => insertRun(db, { status: "running" })).toThrow(/UNIQUE constraint failed/);
    insertRun(db, { agentId: "chief", day: "2026-01-03" });
    insertRun(db, { agentId: "scout", day: "2026-01-02" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_consolidation_runs").get()).toEqual({ count: 3 });
  });

  it("rejects an applied list that is not JSON", () => {
    const db = databaseAt(65);
    migrateOpenBotDatabase(db);

    expect(() => insertRun(db, { applied: "not json" })).toThrow(/CHECK constraint failed/);
  });

  it("allows one retry of a stopped run and no more", () => {
    const db = databaseAt(65);
    migrateOpenBotDatabase(db);

    expect(() => insertRun(db, { attempts: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertRun(db, { attempts: 3 })).toThrow(/CHECK constraint failed/);
    insertRun(db, { attempts: 2 });
    expect(db.prepare("SELECT attempts FROM memory_consolidation_runs").get()).toEqual({ attempts: 2 });
  });
});
