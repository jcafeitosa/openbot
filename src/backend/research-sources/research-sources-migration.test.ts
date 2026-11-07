// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Failure modes covered: the upgrade from version 63 changes or loses a row of any table; a failed upgrade leaves
// the table, its index or its marker; a source with a snippet hash that is not a SHA-256 hex digest is stored.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database built by the real migrations up to `version`, so the fixture carries every table of that version. */
function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

/** An agent and a goal: rows of version 63 that migration 64 must keep unchanged. */
function seedVersion63(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('chief', NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 1)`).run();
  db.prepare(`INSERT INTO agent_goals
    (goal_id, agent_id, objective, status, max_runs, runs_used, deadline_at, created_at, updated_at)
    VALUES ('goal-1', 'chief', 'Ship the release notes', 'open', 2, 0, NULL, '2026-01-02', '2026-01-02')`).run();
}

/** Every row of the tables that exist at version 63, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('schema_migrations', 'research_sources') ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

const HASH = "a".repeat(64);

function insertSource(db: DatabaseSync, snippetHash: string): void {
  db.prepare(`INSERT INTO research_sources (id, agent_id, query, url, title, snippet_hash, fetched_at)
    VALUES ('source-1', 'chief', 'weather in lisbon', NULL, NULL, ?, '2026-01-03T00:00:00.000Z')`).run(snippetHash);
}

describe("research sources migration", () => {
  it("upgrades a version 63 database with rows and keeps every row", () => {
    const db = databaseAt(63);
    seedVersion63(db);
    const before = contents(db);

    migrateOpenBotDatabase(db);

    expect(contents(db)).toEqual({
      ...before,
      memory_consolidation_runs: [],
      memory_proposals: [],
      file_watch_triggers: [],
      person_preferences: [],
      work_board_items: [],
      working_memory: [],
    });
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get()?.version).toBe(72);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("creates the table and its index on upgrade, with the agent and query index", () => {
    const db = databaseAt(63);
    migrateOpenBotDatabase(db);

    const objects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'research_sources%' ORDER BY name")
      .all()
      .map((row) => `${row.type} ${row.name}`);
    expect(objects).toEqual(["table research_sources", "index research_sources_agent_query"]);
  });

  it("accepts a SHA-256 hex snippet hash and rejects a value that is not one", () => {
    const db = databaseAt(63);
    migrateOpenBotDatabase(db);

    insertSource(db, HASH);
    expect(() => insertSource(db, "not-a-hash")).toThrow(/CHECK constraint failed/u);
    expect(() => insertSource(db, "g".repeat(64))).toThrow(/CHECK constraint failed/u);
  });

  it("gives the same declarations to a database that is built at version 63 and then upgraded", () => {
    const upgraded = databaseAt(63);
    seedVersion63(upgraded);
    migrateOpenBotDatabase(upgraded);
    const fresh = new DatabaseSync(":memory:");
    databases.push(fresh);
    migrateOpenBotDatabase(fresh);

    const declarationsSql = "SELECT name, sql FROM sqlite_master WHERE name LIKE 'research_sources%' ORDER BY name";
    const upgradedDeclarations = upgraded
      .prepare(declarationsSql)
      .all()
      .map((row) => `${row.name}: ${row.sql}`);
    const freshDeclarations = fresh
      .prepare(declarationsSql)
      .all()
      .map((row) => `${row.name}: ${row.sql}`);
    expect(upgradedDeclarations).toEqual(freshDeclarations);
  });
});
