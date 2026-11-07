// @vitest-environment node
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Failure modes: an upgrade changes or loses a row of a released table; an upgrade leaves its table or its marker
// without the other; a table accepts a value its CHECK refuses. Each migration is checked from version 68 and from
// version 67 with rows, as the released databases that reach it are.
const LATEST_VERSION = 71;
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

/** Runs the upgrade through `version`: the latest one needs no stop, since no later migration exists. */
function migrateThrough(db: DatabaseSync, version: number): void {
  if (version === LATEST_VERSION) migrateOpenBotDatabase(db);
  else migrateUpTo(db, version);
}

function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES ('routine-1', 'chief', 'Nightly build', 'Check the build.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`).run();
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'The build runs at night.', 'the build runs at night.', 'manual', NULL,
      '2026-01-01', '2026-01-01', 2)`).run();
}

type Contents = Record<string, Record<string, SQLOutputValue>[]>;

/** Every row of every table, by table name, except the migration's own table and the search index. */
function contents(db: DatabaseSync, except: readonly string[] = []): Contents {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !except.includes(name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

const MIGRATIONS = [
  {
    version: 69,
    table: "work_board_items",
    // A kind outside the three the board allows.
    refused: "INSERT INTO work_board_items VALUES ('item-x', 'task-x', 'chief', 'rumour', 'x', '2026-01-01')",
  },
  {
    version: 70,
    table: "person_preferences",
    // An empty value, which the CHECK refuses.
    refused: "INSERT INTO person_preferences VALUES ('owner', 'reply language', '', '2026-01-01')",
  },
  {
    version: 71,
    table: "working_memory",
    // A slot outside the four the working memory has.
    refused: "INSERT INTO working_memory VALUES ('chief', 'thread-x', 'diary', 'x', '2026-01-01')",
  },
] as const;

describe.each(MIGRATIONS)("migration $version", ({ version, table, refused }) => {
  it("upgrades a version 68 database and keeps every row of the released tables", () => {
    const db = databaseAt(68);
    seed(db);
    const before = contents(db);
    migrateThrough(db, version);
    const after = contents(db, [table]);
    for (const [name, rows] of Object.entries(before)) expect(after[name]).toEqual(rows);
    expect(hasTable(db, table)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)).toEqual({ version });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("upgrades a version 67 database with rows and keeps every row of the released tables", () => {
    const db = databaseAt(67);
    seed(db);
    const before = contents(db);
    migrateThrough(db, version);
    const after = contents(db, [table]);
    for (const [name, rows] of Object.entries(before)) expect(after[name]).toEqual(rows);
    expect(hasTable(db, table)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("refuses a value that its CHECK constraints do not allow", () => {
    const db = databaseAt(68);
    migrateThrough(db, version);
    expect(() => db.exec(refused)).toThrow();
  });
});
