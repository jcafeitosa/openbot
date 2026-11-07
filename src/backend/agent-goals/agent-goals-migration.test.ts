// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves the table, its index or
// its marker; a goal with an unknown status, a non-positive run budget, or an objective outside 1-500 characters is
// stored; a goal is lost when its agent's roster rows are rewritten; a newer history is accepted. These fixtures cover each.
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

/** An agent and a memory: the rows that migration 63 must keep, and the agent that its goals belong to. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('chief', NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 1)`).run();
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Use the client VPN 界"\\', 'use the client vpn 界"\\', 'manual', NULL,
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

function goalObjects(db: DatabaseSync) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'agent_goals%' ORDER BY name").all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 72 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

interface GoalFixture {
  goal_id: string;
  agent_id: string;
  objective: string;
  status: string;
  max_runs: number;
}

function insertGoal(db: DatabaseSync, values: Partial<GoalFixture> = {}): void {
  const row: GoalFixture = {
    goal_id: "goal-1",
    agent_id: "chief",
    objective: "Ship the release notes",
    status: "open",
    max_runs: 2,
    ...values,
  };
  db.prepare(`INSERT INTO agent_goals
    (goal_id, agent_id, objective, status, max_runs, runs_used, deadline_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, NULL, '2026-01-02', '2026-01-02')`).run(
    row.goal_id,
    row.agent_id,
    row.objective,
    row.status,
    row.max_runs,
  );
}

describe("agent goals migration", () => {
  it.each(Array.from({ length: 55 }, (_, index) => index + 8))(
    "preserves every row from released schema %i",
    (version) => {
      const db = databaseAt(version);
      seed(db);
      // The earlier migrations run first; the rows at schema 62 are what v63 must keep.
      if (version < 62) migrateUpTo(db, 62);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual({
        ...before,
        agent_goals: [],
        research_sources: [],
        memory_consolidation_runs: [],
        memory_proposals: [],
        file_watch_triggers: [],
        person_preferences: [],
        work_board_items: [],
        working_memory: [],
      });
      expectHealthy(db);
    },
  );

  it("creates the table and its index on an upgraded schema 62 database", () => {
    const db = databaseAt(62);
    seed(db);
    expect(goalObjects(db)).toEqual([]);
    migrateOpenBotDatabase(db);
    expect(goalObjects(db)).toEqual([
      { type: "table", name: "agent_goals" },
      { type: "index", name: "agent_goals_agent" },
    ]);
    expectHealthy(db);
  });

  it("accepts every listed status and rejects any other", () => {
    const db = databaseAt(62);
    seed(db);
    migrateOpenBotDatabase(db);
    for (const status of ["open", "paused", "done", "exhausted", "failed"]) {
      insertGoal(db, { goal_id: `goal-${status}`, status });
    }
    expect(() => insertGoal(db, { goal_id: "goal-archived", status: "archived" })).toThrow(/CHECK constraint failed/);
  });

  it("rejects a run budget of zero or less", () => {
    const db = databaseAt(62);
    seed(db);
    migrateOpenBotDatabase(db);
    expect(() => insertGoal(db, { goal_id: "goal-zero", max_runs: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertGoal(db, { goal_id: "goal-negative", max_runs: -1 })).toThrow(/CHECK constraint failed/);
  });

  it("rejects an objective that is empty or longer than 500 characters", () => {
    const db = databaseAt(62);
    seed(db);
    migrateOpenBotDatabase(db);
    expect(() => insertGoal(db, { goal_id: "goal-empty", objective: "" })).toThrow(/CHECK constraint failed/);
    expect(() => insertGoal(db, { goal_id: "goal-long", objective: "x".repeat(501) })).toThrow(
      /CHECK constraint failed/,
    );
    insertGoal(db, { goal_id: "goal-max", objective: "x".repeat(500) });
  });

  it("keeps an agent's goals when its roster rows are rewritten", () => {
    const db = databaseAt(62);
    seed(db);
    migrateOpenBotDatabase(db);
    insertGoal(db, { goal_id: "goal-1" });
    // The roster is rewritten by deleting every agent row and inserting it again: a cascade would clear the goal.
    db.exec("DELETE FROM projection_agents");
    db.prepare(`INSERT INTO projection_agents
      (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
      VALUES ('chief', NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 2)`).run();
    expect(db.prepare("SELECT goal_id FROM agent_goals").all()).toEqual([{ goal_id: "goal-1" }]);
    expectHealthy(db);
  });

  it("rolls back the table, its index and the marker after a late failure, then retries", () => {
    const db = databaseAt(62);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=63
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 63 failed");
    expect(contents(db)).toEqual(before);
    expect(goalObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=63").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({
      ...before,
      agent_goals: [],
      research_sources: [],
      memory_consolidation_runs: [],
      memory_proposals: [],
      file_watch_triggers: [],
      person_preferences: [],
      work_board_items: [],
      working_memory: [],
    });
    expect(goalObjects(db)).toEqual([
      { type: "table", name: "agent_goals" },
      { type: "index", name: "agent_goals_agent" },
    ]);
    expectHealthy(db);
  });

  it("rejects a newer history before it creates the table", () => {
    const db = databaseAt(62);
    seed(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(73,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    expect(contents(db)).toEqual(before);
    expect(goalObjects(db)).toEqual([]);
  });
});
