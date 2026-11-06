// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade loses or rewrites a memory or its source turn id; the backfill names the wrong kind for
// a row; the upgrade adds one to a selection revision through the update trigger; the column accepts a kind that no
// migration names. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database at version 60, built by the real migrations, as an install on that version has it. */
function databaseAtVersion60(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > 60
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 61 failed");
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

interface MemoryFixture {
  memoryId: string;
  origin: "automatic" | "manual";
  sourceTurnId: string | null;
  expectedKind: string;
}

const MEMORIES: readonly MemoryFixture[] = [
  { memoryId: "turn", origin: "automatic", sourceTurnId: "turn-1", expectedKind: "turn" },
  { memoryId: "review", origin: "automatic", sourceTurnId: "review:thread-1:turn-2", expectedKind: "review" },
  {
    memoryId: "reflection",
    origin: "automatic",
    sourceTurnId: "reflection:thread-1:turn-3",
    expectedKind: "reflection",
  },
  { memoryId: "manual", origin: "manual", sourceTurnId: null, expectedKind: "manual" },
  { memoryId: "manual-with-turn", origin: "manual", sourceTurnId: "turn-4", expectedKind: "manual" },
  { memoryId: "automatic-without-turn", origin: "automatic", sourceTurnId: null, expectedKind: "turn" },
  { memoryId: "lookalike-prefix", origin: "automatic", sourceTurnId: "reviewer:turn-6", expectedKind: "turn" },
  { memoryId: "prefix-inside", origin: "automatic", sourceTurnId: "turn-7 review:thread-1", expectedKind: "turn" },
];

function seed(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES (?, 'chief', ?, ?, ?, ?, '2026-01-01', '2026-01-01', ?)`);
  for (const [index, memory] of MEMORIES.entries()) {
    insert.run(
      memory.memoryId,
      `Memory ${memory.memoryId}`,
      `memory ${memory.memoryId}`,
      memory.origin,
      memory.sourceTurnId,
      index + 1,
    );
  }
}

/** Every column that migration 61 must leave as it was, for every memory. */
const MEMORY_COLUMNS_SQL = `SELECT memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at,
  updated_at, last_event_sequence FROM projection_agent_memories ORDER BY memory_id`;
const SELECTION_REVISIONS_SQL = "SELECT memory_id, revision FROM agent_memory_selections ORDER BY memory_id";
const SOURCE_KINDS_SQL = "SELECT memory_id, source_kind FROM projection_agent_memories";

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 64 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("memory provenance migration", () => {
  it("keeps every memory and source turn id, and backfills the source kind from the prefix and then the origin", () => {
    const db = databaseAtVersion60();
    seed(db);
    // An update through the trigger gives one selection a non-zero revision, so the check below can see a bump.
    db.exec("UPDATE projection_agent_memories SET text = text WHERE memory_id = 'turn'");
    const columns = db.prepare(MEMORY_COLUMNS_SQL).all();
    const revisions = db.prepare(SELECTION_REVISIONS_SQL).all();

    migrateOpenBotDatabase(db);

    expect(db.prepare(MEMORY_COLUMNS_SQL).all()).toEqual(columns);
    expect(db.prepare(SELECTION_REVISIONS_SQL).all()).toEqual(revisions);
    const kinds = Object.fromEntries(
      db
        .prepare(SOURCE_KINDS_SQL)
        .all()
        .map((row) => [row.memory_id, row.source_kind]),
    );
    expect(kinds).toEqual(Object.fromEntries(MEMORIES.map((memory) => [memory.memoryId, memory.expectedKind])));
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_memory_update'")
        .get(),
    ).toEqual({ count: 1 });
    expectHealthy(db);
    // Rows written before migration 61 have no thread, and the migration gives every one of them NULL.
    const threads = db.prepare("SELECT memory_id, source_thread_id FROM projection_agent_memories").all();
    expect(Object.fromEntries(threads.map((row) => [row.memory_id, row.source_thread_id]))).toEqual(
      Object.fromEntries(MEMORIES.map((memory) => [memory.memoryId, null])),
    );
  });

  it("refuses a source kind that no migration names and accepts an absent one", () => {
    const db = databaseAtVersion60();
    seed(db);
    migrateOpenBotDatabase(db);

    expect(() =>
      db.exec("UPDATE projection_agent_memories SET source_kind = 'bogus' WHERE memory_id = 'turn'"),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      db.exec(`INSERT INTO projection_agent_memories
        (memory_id, agent_id, text, normalized_text, origin, created_at, updated_at, last_event_sequence, source_kind)
        VALUES ('bad', 'chief', 'bad', 'bad', 'manual', '2026-01-01', '2026-01-01', 99, 'user')`),
    ).toThrow("CHECK constraint failed");
    db.exec("UPDATE projection_agent_memories SET source_kind = NULL WHERE memory_id = 'turn'");
    db.exec("UPDATE projection_agent_memories SET source_thread_id = 'thread-1' WHERE memory_id = 'review'");
    expect(
      db
        .prepare(
          "SELECT memory_id, source_thread_id FROM projection_agent_memories WHERE memory_id IN ('review', 'turn') ORDER BY memory_id",
        )
        .all(),
    ).toEqual([
      { memory_id: "review", source_thread_id: "thread-1" },
      { memory_id: "turn", source_thread_id: null },
    ]);
    expect(db.prepare("SELECT source_kind FROM projection_agent_memories WHERE memory_id = 'turn'").get()).toEqual({
      source_kind: null,
    });
    expectHealthy(db);
  });

  it("migrates a released schema that already has the source kind column, and keeps every row", () => {
    const db = databaseAtVersion60();
    seed(db);
    db.exec(
      "ALTER TABLE projection_agent_memories ADD COLUMN source_kind TEXT CHECK(source_kind IN ('turn', 'review', 'reflection', 'manual'))",
    );
    db.exec("UPDATE projection_agent_memories SET source_kind = 'review' WHERE memory_id = 'turn'");
    const columns = db.prepare(MEMORY_COLUMNS_SQL).all();
    const kinds = db.prepare("SELECT memory_id, source_kind FROM projection_agent_memories ORDER BY memory_id").all();

    expect(() => migrateOpenBotDatabase(db)).not.toThrow();

    expect(db.prepare(MEMORY_COLUMNS_SQL).all()).toEqual(columns);
    expect(db.prepare("SELECT memory_id, source_kind FROM projection_agent_memories ORDER BY memory_id").all()).toEqual(
      kinds,
    );
    expect(
      db
        .prepare("PRAGMA table_info(projection_agent_memories)")
        .all()
        .map((column) => column.name),
    ).toContain("source_thread_id");
    expectHealthy(db);
  });

  it("replays migration 61 over the latest schema without changing the kinds its writers recorded", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    seed(db);
    db.exec("UPDATE projection_agent_memories SET source_kind = 'reflection' WHERE memory_id = 'turn'");
    const columns = db.prepare(MEMORY_COLUMNS_SQL).all();
    db.exec("DELETE FROM schema_migrations WHERE version IN (61, 62, 63, 64)");

    expect(() => migrateOpenBotDatabase(db)).not.toThrow();

    expect(db.prepare(MEMORY_COLUMNS_SQL).all()).toEqual(columns);
    expect(db.prepare("SELECT source_kind FROM projection_agent_memories WHERE memory_id = 'turn'").get()).toEqual({
      source_kind: "reflection",
    });
    expectHealthy(db);
  });
});
