// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Migration 67 adds `expires_at` and `predicate_json` to the open waits. These fixtures cover an upgrade from
// version 66 that keeps every wait and gives it neither an expiry nor a predicate, the CHECKs that refuse an expiry
// not after the wait opened and a predicate that is not a JSON object, and a failed upgrade that leaves no column.

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database migrated to `version`: the migration after it is stopped by a trigger, as the other fixtures do. */
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

function seedVersion66(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES ('routine-1', 'chief', 'Nightly build', 'Check the build.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`).run();
  db.prepare(`INSERT INTO agent_waits
    (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at, woken_at, wake_delivery_id)
    VALUES ('wait-1', 'chief', 'delivery-1', 'Ship it.', 'Build', 'routine-1', '2026-01-02T00:00:00.000Z', NULL, NULL),
      ('wait-2', 'chief', 'delivery-2', 'Deploy it.', 'Deploy', NULL, '2026-01-03T00:00:00.000Z',
        '2026-01-04T00:00:00.000Z', 'delivery-3')`).run();
}

function waitRows(db: DatabaseSync) {
  return db.prepare("SELECT * FROM agent_waits ORDER BY wait_id").all();
}

function columnNames(db: DatabaseSync): string[] {
  return db
    .prepare("PRAGMA table_info(agent_waits)")
    .all()
    .map((column) => String(column.name));
}

function insertWait(
  db: DatabaseSync,
  id: string,
  createdAt: string,
  expiresAt: string | null,
  predicate: string | null,
) {
  db.prepare(`INSERT INTO agent_waits
    (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at, expires_at, predicate_json)
    VALUES (?, 'chief', 'delivery-x', 'Request.', 'Note', NULL, ?, ?, ?)`).run(id, createdAt, expiresAt, predicate);
}

describe("agent wait TTL and predicate migration", () => {
  it("keeps every open wait from version 66 and gives it no expiry and no predicate", () => {
    const db = databaseAt(66);
    seedVersion66(db);
    const before = waitRows(db);
    expect(before).toHaveLength(2);

    migrateOpenBotDatabase(db);

    expect(waitRows(db)).toEqual(before.map((row) => ({ ...row, expires_at: null, predicate_json: null })));
    expect(columnNames(db)).toEqual(expect.arrayContaining(["expires_at", "predicate_json", "wake_delivery_id"]));
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 72 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("refuses an expiry that is not after the wait opened", () => {
    const db = databaseAt(66);
    migrateOpenBotDatabase(db);
    const opened = "2026-03-01T10:00:00.000Z";
    expect(() => insertWait(db, "past", opened, "2026-03-01T09:00:00.000Z", null)).toThrow(/CHECK constraint failed/);
    expect(() => insertWait(db, "same", opened, opened, null)).toThrow(/CHECK constraint failed/);
    insertWait(db, "later", opened, "2026-03-01T11:00:00.000Z", null);
    expect(db.prepare("SELECT wait_id FROM agent_waits").all()).toEqual([{ wait_id: "later" }]);
  });

  it("refuses a predicate that is not a JSON object and accepts an object or no predicate", () => {
    const db = databaseAt(66);
    migrateOpenBotDatabase(db);
    const opened = "2026-03-01T10:00:00.000Z";
    expect(() => insertWait(db, "text", opened, null, "not json")).toThrow(/CHECK constraint failed/);
    expect(() => insertWait(db, "array", opened, null, "[1]")).toThrow(/CHECK constraint failed/);
    insertWait(db, "object", opened, null, '{"routineId":"routine-1"}');
    insertWait(db, "none", opened, null, null);
    expect(db.prepare("SELECT wait_id FROM agent_waits ORDER BY wait_id").all()).toEqual([
      { wait_id: "none" },
      { wait_id: "object" },
    ]);
  });

  it("leaves no column behind when the upgrade fails, then applies it on retry", () => {
    const db = databaseAt(66);
    seedVersion66(db);
    const before = waitRows(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=67
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 67 failed");
    expect(columnNames(db)).not.toContain("expires_at");
    expect(columnNames(db)).not.toContain("predicate_json");
    expect(waitRows(db)).toEqual(before);
    db.exec("DROP TRIGGER fail_marker");

    migrateOpenBotDatabase(db);

    expect(waitRows(db)).toEqual(before.map((row) => ({ ...row, expires_at: null, predicate_json: null })));
  });
});
