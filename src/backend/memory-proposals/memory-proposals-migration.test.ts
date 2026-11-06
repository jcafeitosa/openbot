// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Failure modes: the upgrade to version 65 loses or rewrites a row of any table it keeps; a proposal with a status or a
// target scope outside its list is stored; a text over 500 characters is stored; a second pending proposal for the same
// scope, target and fingerprint is stored. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database at version 64, built by the real migrations, as an install on that version has it. */
function databaseAt64(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > 64
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 65 failed");
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

/** An agent, a memory of it, a channel and a channel memory: the rows that migration 65 must keep. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
    VALUES ('chief', NULL, 'gpt-5.5', '2026-01-01', 0, '{}', 1)`).run();
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'Use the client VPN.', 'Use the client VPN.', 'manual', NULL,
      '2026-01-01', '2026-01-01', 2)`).run();
  db.prepare(`INSERT INTO projection_channels (channel_id, channel_json) VALUES ('channel-1', '{}')`).run();
  db.prepare(`INSERT INTO projection_channel_memories
    (memory_id, channel_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('channel-memory-1', 'channel-1', 'Ship on Fridays.', 'Ship on Fridays.', 'manual', NULL,
      '2026-01-01', '2026-01-01', 3)`).run();
}

/** Every row of every table that exists before the upgrade, by table name. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function insertProposal(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    scope: string;
    targetId: string;
    fingerprint: string;
    status: string;
    text: string;
  }>,
): void {
  db.prepare(`INSERT INTO memory_proposals
    (proposal_id, source_agent_id, source_memory_id, target_scope, target_id, text, fingerprint, status, created_at)
    VALUES (?, 'chief', 'memory-1', ?, ?, ?, ?, ?, '2026-01-02')`).run(
    overrides.id ?? "proposal-1",
    overrides.scope ?? "channel",
    overrides.targetId ?? "channel-1",
    overrides.text ?? "Ship on Fridays.",
    overrides.fingerprint ?? "fingerprint-1",
    overrides.status ?? "pending",
  );
}

describe("memory proposals migration", () => {
  it("upgrades a version 64 database to 65 and keeps every row", () => {
    const db = databaseAt64();
    seed(db);
    const before = contents(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_proposals'").get()).toBeUndefined();

    migrateOpenBotDatabase(db);

    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 65").get()).toEqual({ version: 65 });
    expect(contents(db)).toEqual({ ...before, memory_consolidation_runs: [], memory_proposals: [] });
  });

  it("refuses a status outside pending, approved and rejected", () => {
    const db = databaseAt64();
    migrateOpenBotDatabase(db);
    expect(() => insertProposal(db, { status: "archived" })).toThrow("CHECK constraint failed");
  });

  it("refuses a target scope outside channel and messaging", () => {
    const db = databaseAt64();
    migrateOpenBotDatabase(db);
    expect(() => insertProposal(db, { scope: "agent" })).toThrow("CHECK constraint failed");
  });

  it("refuses a text over 500 characters", () => {
    const db = databaseAt64();
    migrateOpenBotDatabase(db);
    expect(() => insertProposal(db, { text: "x".repeat(501) })).toThrow("CHECK constraint failed");
  });

  it("refuses a second pending proposal with the same scope, target and fingerprint, and allows one after a decision", () => {
    const db = databaseAt64();
    migrateOpenBotDatabase(db);
    insertProposal(db, { id: "proposal-1" });
    expect(() => insertProposal(db, { id: "proposal-2" })).toThrow("UNIQUE constraint failed");

    insertProposal(db, { id: "proposal-3", targetId: "channel-2" });
    db.prepare("UPDATE memory_proposals SET status = 'rejected' WHERE proposal_id = 'proposal-1'").run();
    insertProposal(db, { id: "proposal-4" });

    expect(db.prepare("SELECT proposal_id FROM memory_proposals ORDER BY proposal_id").all()).toEqual([
      { proposal_id: "proposal-1" },
      { proposal_id: "proposal-3" },
      { proposal_id: "proposal-4" },
    ]);
  });
});
