// Migration 68 gives a routine a file-change trigger: a path inside the agent's workspace that starts one run after the
// last change, once the debounce has passed in quiet. Frozen with the migration; the latest schema declares the same
// text. One trigger per routine, enforced by the unique index, so a routine has at most one watched path.
//
// `routine_id` cascades: a deleted routine takes its trigger with it, and the watcher is closed by the routine owner.
// `agent_id` carries no foreign key, as in every other table keyed by an agent.
export const FILE_WATCH_TRIGGERS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS file_watch_triggers (
    trigger_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_agent_routines(routine_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    path TEXT NOT NULL,
    debounce_seconds INTEGER NOT NULL CHECK(debounce_seconds BETWEEN 1 AND 60),
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS file_watch_triggers_routine ON file_watch_triggers(routine_id);
`;
