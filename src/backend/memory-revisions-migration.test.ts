// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade from version 61 loses or rewrites a memory, its source or its selection; the revisions
// table is missing or differs from the latest schema; a revision outlives its memory; the table accepts a row that no
// writer makes, or a revision of a memory that does not exist.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database at version 61, built by the real migrations, as an install on that version has it. */
function databaseAtVersion61(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > 61
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 62 failed");
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

interface MemoryFixture {
  memoryId: string;
  origin: "automatic" | "manual";
  sourceKind: string;
  sourceThreadId: string | null;
}

const MEMORIES: readonly MemoryFixture[] = [
  { memoryId: "turn", origin: "automatic", sourceKind: "turn", sourceThreadId: null },
  { memoryId: "review", origin: "automatic", sourceKind: "review", sourceThreadId: "thread-1" },
  { memoryId: "manual", origin: "manual", sourceKind: "manual", sourceThreadId: null },
];

function seed(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence,
     source_kind, source_thread_id)
    VALUES (?, 'chief', ?, ?, ?, NULL, '2026-01-01', '2026-01-01', ?, ?, ?)`);
  for (const [index, memory] of MEMORIES.entries()) {
    insert.run(
      memory.memoryId,
      `Memory ${memory.memoryId}`,
      `memory ${memory.memoryId}`,
      memory.origin,
      index + 1,
      memory.sourceKind,
      memory.sourceThreadId,
    );
  }
}

/** Every column of every memory, which migration 62 must leave as it was. */
const MEMORY_ROWS_SQL = `SELECT memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at,
  updated_at, last_event_sequence, source_kind, source_thread_id FROM projection_agent_memories ORDER BY memory_id`;
const SELECTIONS_SQL = `SELECT memory_id, inclusion, user_controlled, revision FROM agent_memory_selections
  ORDER BY memory_id`;
const REVISION_COUNT_SQL = "SELECT COUNT(*) AS count FROM agent_memory_revisions";

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 63 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("memory revisions migration", () => {
  it("keeps every memory, its source and its selection, and adds an empty revisions table", () => {
    const db = databaseAtVersion61();
    seed(db);
    const memories = db.prepare(MEMORY_ROWS_SQL).all();
    const selections = db.prepare(SELECTIONS_SQL).all();
    expect(memories).toHaveLength(MEMORIES.length);

    migrateOpenBotDatabase(db);

    expect(db.prepare(MEMORY_ROWS_SQL).all()).toEqual(memories);
    expect(db.prepare(SELECTIONS_SQL).all()).toEqual(selections);
    expect(
      db
        .prepare("PRAGMA table_info(agent_memory_revisions)")
        .all()
        .map((column) => column.name),
    ).toEqual(["memory_id", "seq", "text", "origin", "source_kind", "source_thread_id", "reason", "created_at"]);
    expect(db.prepare(REVISION_COUNT_SQL).get()).toEqual({ count: 0 });
    expectHealthy(db);
  });

  it("removes a revision with its memory, and leaves the revisions of the other memories", () => {
    const db = databaseAtVersion61();
    seed(db);
    migrateOpenBotDatabase(db);
    const insertRevision = db.prepare(`INSERT INTO agent_memory_revisions
      (memory_id, seq, text, origin, source_kind, source_thread_id, reason, created_at)
      VALUES (?, ?, ?, 'automatic', 'turn', NULL, 'automatic-turn', '2026-02-01')`);
    insertRevision.run("turn", 1, "Earlier turn text");
    insertRevision.run("turn", 2, "Earlier turn text again");
    insertRevision.run("review", 1, "Earlier review text");

    db.exec("DELETE FROM projection_agent_memories WHERE memory_id = 'turn'");

    expect(db.prepare("SELECT memory_id, seq FROM agent_memory_revisions ORDER BY memory_id, seq").all()).toEqual([
      { memory_id: "review", seq: 1 },
    ]);
    expectHealthy(db);
  });

  it("refuses a revision that no writer makes, and a revision of a memory that does not exist", () => {
    const db = databaseAtVersion61();
    seed(db);
    migrateOpenBotDatabase(db);
    db.exec("PRAGMA foreign_keys = ON");
    const insertRevision = db.prepare(`INSERT INTO agent_memory_revisions
      (memory_id, seq, text, origin, source_kind, source_thread_id, reason, created_at)
      VALUES (?, ?, 'Earlier text', ?, 'turn', NULL, ?, '2026-02-01')`);

    expect(() => insertRevision.run("turn", 0, "automatic", "automatic-turn")).toThrow("CHECK constraint failed");
    expect(() => insertRevision.run("turn", 1, "user", "automatic-turn")).toThrow("CHECK constraint failed");
    expect(() => insertRevision.run("turn", 1, "automatic", "")).toThrow("CHECK constraint failed");
    expect(() => insertRevision.run("missing", 1, "automatic", "automatic-turn")).toThrow(
      "FOREIGN KEY constraint failed",
    );
    insertRevision.run("turn", 1, "automatic", "automatic-turn");
    expect(() => insertRevision.run("turn", 1, "automatic", "automatic-turn")).toThrow("UNIQUE constraint failed");
    expect(db.prepare(REVISION_COUNT_SQL).get()).toEqual({ count: 1 });
  });

  it("replays migration 62 over the latest schema without changing a memory", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    seed(db);
    const memories = db.prepare(MEMORY_ROWS_SQL).all();
    db.exec("DELETE FROM schema_migrations WHERE version IN (62, 63)");

    expect(() => migrateOpenBotDatabase(db)).not.toThrow();

    expect(db.prepare(MEMORY_ROWS_SQL).all()).toEqual(memories);
    expect(db.prepare(REVISION_COUNT_SQL).get()).toEqual({ count: 0 });
    expectHealthy(db);
  });
});
