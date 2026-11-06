// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves the table, its
// index or its marker; a newer history is accepted; an outcome row takes an unknown outcome, a negative
// count, a reaction flag other than 0 or 1, or tool failure codes that are not an object; a second row
// for the same turn replaces the first. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const LEDGER_TABLES = {
  agent_memory_revisions: [],
  agent_goals: [],
  research_sources: [],
  memory_proposals: [],
  turn_outcomes: [],
  agent_instructions_snapshots: [],
};

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

/** A memory, and from schema 45 on a named browser profile: the rows that migration 59 must keep. */
function seed(db: DatabaseSync, version: number): void {
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Use the client VPN 界"\\', 'use the client vpn 界"\\', 'manual', NULL,
      '2026-01-01', '2026-01-01', 2)`).run();
  if (version >= 45)
    db.prepare(`INSERT INTO browser_profiles (profile_id, name, hue, created_at, updated_at)
      VALUES (?, 'Client A 界', 215, '2026-01-02', '2026-01-02')`).run("a".repeat(32));
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

function ledgerObjects(db: DatabaseSync) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'turn_outcomes%' ORDER BY name").all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 65 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

interface OutcomeFixture {
  turn_id: string;
  outcome: string;
  cause_code: string | null;
  tool_failures: number;
  tool_failure_codes_json: string;
  approvals_accepted: number;
  approvals_declined: number;
  reactions_present: number;
  memory_changes: number;
  skill_loads: number;
}

function insertOutcome(db: DatabaseSync, values: Partial<OutcomeFixture> = {}, verb = "INSERT"): void {
  const row: OutcomeFixture = {
    turn_id: "turn-1",
    outcome: "failed",
    cause_code: "provider_internal_error",
    tool_failures: 1,
    tool_failure_codes_json: '{"exit_nonzero":1}',
    approvals_accepted: 1,
    approvals_declined: 0,
    reactions_present: 0,
    memory_changes: 0,
    skill_loads: 0,
    ...values,
  };
  db.prepare(`${verb} INTO turn_outcomes
    (agent_id, turn_id, thread_id, outcome, cause_code, tool_failures, tool_failure_codes_json,
     approvals_accepted, approvals_declined, reactions_present, memory_changes, skill_loads, created_at)
    VALUES ('chief', ?, 'thread-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-03T10:00:00.000Z')`).run(
    row.turn_id,
    row.outcome,
    row.cause_code,
    row.tool_failures,
    row.tool_failure_codes_json,
    row.approvals_accepted,
    row.approvals_declined,
    row.reactions_present,
    row.memory_changes,
    row.skill_loads,
  );
}

describe("turn outcome ledger migration", () => {
  it.each([8, 58])("preserves every row from released schema %i", (version) => {
    const db = databaseAt(version);
    seed(db, version);
    // The earlier migrations run first; the rows after them are what v59 must keep.
    if (version < 58) migrateUpTo(db, 58);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...LEDGER_TABLES });
    expectHealthy(db);
  });

  it("rolls back the table, its index and the marker after a late failure, then retries", () => {
    const db = databaseAt(58);
    seed(db, 58);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=59
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 59 failed");
    expect(contents(db)).toEqual(before);
    expect(ledgerObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=59").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...LEDGER_TABLES });
    expect(ledgerObjects(db)).toEqual([
      { type: "table", name: "turn_outcomes" },
      { type: "index", name: "turn_outcomes_created" },
    ]);
    expectHealthy(db);
  });

  it("rejects a newer history before it creates the table", () => {
    const db = databaseAt(58);
    seed(db, 58);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(66,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    expect(contents(db)).toEqual(before);
    expect(ledgerObjects(db)).toEqual([]);
  });

  it("refuses an outcome row that breaks a constraint, and keeps the first row of a turn", () => {
    const db = databaseAt(58);
    seed(db, 58);
    migrateOpenBotDatabase(db);
    expect(() => insertOutcome(db, { outcome: "running" })).toThrow("CHECK constraint failed");
    expect(() => insertOutcome(db, { cause_code: "" })).toThrow("CHECK constraint failed");
    expect(() => insertOutcome(db, { tool_failures: -1 })).toThrow("CHECK constraint failed");
    expect(() => insertOutcome(db, { approvals_accepted: -1 })).toThrow("CHECK constraint failed");
    expect(() => insertOutcome(db, { reactions_present: 2 })).toThrow("CHECK constraint failed");
    expect(() => insertOutcome(db, { tool_failure_codes_json: "[]" })).toThrow("CHECK constraint failed");
    insertOutcome(db, {
      turn_id: "turn-2",
      outcome: "completed",
      cause_code: null,
      tool_failures: 0,
      tool_failure_codes_json: "{}",
      approvals_accepted: 0,
    });
    insertOutcome(db, { turn_id: "turn-2", outcome: "failed", cause_code: "unknown" }, "INSERT OR IGNORE");
    expect(() => insertOutcome(db, { turn_id: "turn-2" })).toThrow("UNIQUE constraint failed");
    expect(db.prepare("SELECT turn_id, outcome, cause_code FROM turn_outcomes ORDER BY turn_id").all()).toEqual([
      { turn_id: "turn-2", outcome: "completed", cause_code: null },
    ]);
    expectHealthy(db);
  });
});
