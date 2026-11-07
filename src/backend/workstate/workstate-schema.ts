// Migration 69 keeps the shared work board of one parent task: the facts, dependencies and open questions that
// its subtasks write for each other. A row is visible only to the subtasks of the parent that wrote it. The text
// is stored after `redactText`, and a text that holds a registered secret is refused before any row is written.
// No foreign key to the task: the store reads the board by its parent id. IF NOT EXISTS throughout, because this
// text is both migration 69 and the tail of the latest schema.
export const WORK_BOARD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_board_items (
    item_id TEXT PRIMARY KEY,
    parent_task_id TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fact', 'dependency', 'question')),
    text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_board_items_parent ON work_board_items(parent_task_id, created_at);
`;

// Migration 70 keeps one preference per person and key, as the person stated it in a message. The value is stored
// after `redactText`. Only a person's message writes a row, and the store refuses a value with a registered secret.
// No foreign key: a person is not a table. IF NOT EXISTS throughout, because this text is both migration 70 and
// the tail of the latest schema.
export const PERSON_PREFERENCES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS person_preferences (
    person_id TEXT NOT NULL,
    key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 64),
    value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 300),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(person_id, key)
  );
`;

// Migration 71 keeps the working memory of one agent in one thread: four typed slots that the agent rewrites as its
// work moves on. A slot body is stored after `redactText`, and an empty body clears its slot. No foreign key to the
// thread, because the agent's own chat has no thread row. A deleted thread leaves its rows here, and no later turn
// reads them. IF NOT EXISTS throughout, because this text is both migration 71 and the tail of the latest schema.
export const WORKING_MEMORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS working_memory (
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('goal', 'facts', 'open_questions', 'next_step')),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 0 AND 2000),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, thread_id, slot)
  );
`;
