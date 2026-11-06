// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves the table, its
// indexes or its marker; a snapshot names no agent, a hash that is not 64 characters or an empty file
// name; deleting an agent keeps its snapshots. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const HISTORY_TABLES = { agent_memory_revisions: [], agent_goals: [], agent_instructions_snapshots: [] };

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

/** An agent and a memory, the rows that migration 60 must keep. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('chief', NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 1)`).run();
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Use the client VPN', 'use the client vpn', 'manual', NULL,
      '2026-01-01', '2026-01-01', 2)`).run();
}

/** Every row of every table, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(
          table === "projection_agent_memories"
            ? `SELECT memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence FROM "${table}"`
            : `SELECT * FROM "${table}"`,
        )
        .all(),
    ]),
  );
}

function historyObjects(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'agent_instructions_snapshots%' ORDER BY name")
    .all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 63 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

interface SnapshotFixture {
  snapshot_id: string;
  agent_id: string;
  file_path: string;
  text: string;
  sha256: string;
}

function insertSnapshot(db: DatabaseSync, values: Partial<SnapshotFixture> = {}): void {
  const row: SnapshotFixture = {
    snapshot_id: "snap-1",
    agent_id: "chief",
    file_path: "AGENTS.md",
    text: "Reply briefly.",
    sha256: "a".repeat(64),
    ...values,
  };
  db.prepare(`INSERT INTO agent_instructions_snapshots
    (snapshot_id, agent_id, file_path, text, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, '2026-01-04T10:00:00.000Z')`).run(
    row.snapshot_id,
    row.agent_id,
    row.file_path,
    row.text,
    row.sha256,
  );
}

describe("agent instructions history migration", () => {
  it.each(Array.from({ length: 52 }, (_, index) => index + 8))(
    "preserves every row from released schema %i and creates the snapshot table",
    (version) => {
      const db = databaseAt(version);
      seed(db);
      // The earlier migrations run first; the rows after them are what v60 must keep.
      if (version < 59) migrateUpTo(db, 59);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual({ ...before, ...HISTORY_TABLES });
      expect(historyObjects(db).map((row) => row.name)).toEqual([
        "agent_instructions_snapshots",
        "agent_instructions_snapshots_file",
        "agent_instructions_snapshots_hash",
      ]);
      expectHealthy(db);
    },
  );

  it("rolls back the table, its indexes and the marker after a late failure, then retries", () => {
    const db = databaseAt(59);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=60
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 60 failed");
    expect(contents(db)).toEqual(before);
    expect(historyObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=60").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...HISTORY_TABLES });
    expect(historyObjects(db)).toHaveLength(3);
    expectHealthy(db);
  });

  it("refuses a snapshot with no agent, a hash that is not 64 characters or an empty file name, and removes snapshots with their agent", () => {
    const db = databaseAt(59);
    seed(db);
    migrateOpenBotDatabase(db);
    expect(() => insertSnapshot(db, { agent_id: "missing" })).toThrow("FOREIGN KEY constraint failed");
    expect(() => insertSnapshot(db, { sha256: "a".repeat(63) })).toThrow("CHECK constraint failed");
    expect(() => insertSnapshot(db, { file_path: "" })).toThrow("CHECK constraint failed");
    insertSnapshot(db, { snapshot_id: "snap-1" });
    insertSnapshot(db, { snapshot_id: "snap-2", sha256: "b".repeat(64) });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_instructions_snapshots").get()).toEqual({ count: 2 });
    db.prepare("DELETE FROM projection_agents WHERE agent_id = 'chief'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_instructions_snapshots").get()).toEqual({ count: 0 });
    expectHealthy(db);
  });
});
