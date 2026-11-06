// Migration 34's table, and the tail of the latest schema. IF NOT EXISTS throughout, because both run this text. It
// stays as migration 34 declares it: migration 67 adds `expires_at` and `predicate_json` with ALTER TABLE, and the
// latest schema declares them in openbot-database-schema.ts after the columns below.
//
// An open wait is work an agent stopped before it was done, because it waits for something outside the turn: a
// build, a deploy, the next routine run. The agent opens it with `openbot.await_event`, lists it with
// `openbot.list_waits` and closes it with `openbot.close_wait`; another local agent can list and close it with
// `agentId`; the user can cancel it. A closed or cancelled wait is deleted, so every row is an open wait.
//
// Agent ids carry no foreign key, as in every other table keyed by an agent: `hardDeleteAgent` removes the rows of a
// deleted agent by hand.
//
// `request_delivery_id` and `request_text` are the message the wait serves, copied when the wait opens, so a wake can
// repeat the request after the transcript is compacted or cleared. `routine_id` limits the runs that wake the wait to
// one routine; absent, any routine run of the agent wakes it. A deleted routine leaves the wait to any run.
// `woken_at` and `wake_delivery_id` are the last run that woke the wait: the agent sees the wait in that delivery's
// input.
//
// Migration 67's `expires_at` is when the wait closes by itself, and `predicate_json` is the JSON object that names
// which runs wake it. Both are null for a wait opened before migration 67, which keeps its behaviour.
export const AGENT_WAIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_waits (
    wait_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    request_delivery_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    note TEXT NOT NULL,
    routine_id TEXT REFERENCES projection_agent_routines(routine_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    woken_at TEXT,
    wake_delivery_id TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_waits_agent ON agent_waits(agent_id);
  CREATE INDEX IF NOT EXISTS agent_waits_routine ON agent_waits(routine_id) WHERE routine_id IS NOT NULL;
`;
