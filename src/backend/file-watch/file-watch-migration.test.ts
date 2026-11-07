// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "../openbot-database-schema";

// Migration 68 adds `file_watch_triggers`: one file-change trigger per routine, with a debounce from 1 to 60 seconds.
// These fixtures cover an upgrade from version 67 that keeps every routine, the CHECK that refuses a debounce of 0 or
// 61, the unique index that allows one trigger per routine, the cascade that removes a trigger with its routine, and a
// failed upgrade that leaves no table behind.

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

function insertRoutine(db: DatabaseSync, routineId: string): void {
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES (?, 'chief', 'Nightly build', 'Check the build.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`).run(routineId);
}

function insertTrigger(db: DatabaseSync, triggerId: string, routineId: string, debounce: number): void {
  db.prepare(`INSERT INTO file_watch_triggers
    (trigger_id, routine_id, agent_id, path, debounce_seconds, created_at)
    VALUES (?, ?, 'chief', 'inbox', ?, '2026-02-01T00:00:00.000Z')`).run(triggerId, routineId, debounce);
}

function routineRows(db: DatabaseSync) {
  return db
    .prepare("SELECT routine_id, agent_id, name, active FROM projection_agent_routines ORDER BY routine_id")
    .all();
}

function triggerCount(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM file_watch_triggers").get()?.n);
}

describe("file-watch trigger migration", () => {
  it("keeps every routine from version 67 and gives none a file trigger", () => {
    const db = databaseAt(67);
    insertRoutine(db, "routine-1");
    insertRoutine(db, "routine-2");
    const before = routineRows(db);
    expect(before).toHaveLength(2);

    migrateOpenBotDatabase(db);

    expect(routineRows(db)).toEqual(before);
    expect(triggerCount(db)).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_watch_triggers'").get(),
    ).toEqual({ name: "file_watch_triggers" });
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 68 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("refuses a debounce of 0 or 61 and accepts 1 and 60", () => {
    const db = databaseAt(67);
    migrateOpenBotDatabase(db);
    insertRoutine(db, "routine-1");
    insertRoutine(db, "routine-2");

    expect(() => insertTrigger(db, "zero", "routine-1", 0)).toThrow(/CHECK constraint failed/);
    expect(() => insertTrigger(db, "sixty-one", "routine-1", 61)).toThrow(/CHECK constraint failed/);
    expect(triggerCount(db)).toBe(0);

    insertTrigger(db, "shortest", "routine-1", 1);
    insertTrigger(db, "longest", "routine-2", 60);
    expect(
      db.prepare("SELECT trigger_id, debounce_seconds FROM file_watch_triggers ORDER BY trigger_id").all(),
    ).toEqual([
      { trigger_id: "longest", debounce_seconds: 60 },
      { trigger_id: "shortest", debounce_seconds: 1 },
    ]);
  });

  it("allows one trigger per routine", () => {
    const db = databaseAt(67);
    migrateOpenBotDatabase(db);
    insertRoutine(db, "routine-1");
    insertTrigger(db, "first", "routine-1", 5);

    expect(() => insertTrigger(db, "second", "routine-1", 5)).toThrow(/UNIQUE constraint failed/);
    expect(triggerCount(db)).toBe(1);
  });

  it("removes a trigger with its routine", () => {
    const db = databaseAt(67);
    migrateOpenBotDatabase(db);
    db.exec("PRAGMA foreign_keys = ON");
    insertRoutine(db, "routine-1");
    insertTrigger(db, "first", "routine-1", 5);
    expect(triggerCount(db)).toBe(1);

    db.prepare("DELETE FROM projection_agent_routines WHERE routine_id = ?").run("routine-1");

    expect(triggerCount(db)).toBe(0);
  });

  it("leaves no table behind when the upgrade fails, then creates it on retry", () => {
    const db = databaseAt(67);
    insertRoutine(db, "routine-1");
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=68
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 68 failed");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'file_watch_triggers'").get()).toBeUndefined();
    expect(routineRows(db)).toHaveLength(1);
    db.exec("DROP TRIGGER fail_marker");

    migrateOpenBotDatabase(db);

    expect(routineRows(db)).toHaveLength(1);
    expect(triggerCount(db)).toBe(0);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 68 });
  });
});
