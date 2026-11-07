// Checks the workstate of the agents on a temporary profile, with the real database, the real stores, the real
// tool handler and the real prompt builders. A sibling's work board fact reaches a subtask's prompt, and a fact of
// another parent task does not. A person's preference appears in that person's agent instructions, and an agent's
// own attempt to set one is refused. A working memory slot written in one turn is rendered in the next turn of the
// same thread, and in no other thread. A registered secret in a board text, a preference value or a working memory
// body is not stored, and a known secret pattern is stored without its value. `bun scripts/workstate-e2e.ts`. Writes
// .openbot-build/workstate-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSecretValue } from "@openbot/logging";
import { developerInstructions } from "../src/backend/agent/developer-instructions";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { LOCAL_PERSON_ID, PersonPreferencesStore } from "../src/backend/workstate/person-preferences-store";
import { WorkBoardStore, withWorkBoard } from "../src/backend/workstate/work-board-store";
import { WorkingMemoryStore } from "../src/backend/workstate/working-memory-store";
import { WorkstateTextRefused } from "../src/backend/workstate/workstate-text";
import { WorkstateTools } from "../src/backend/workstate/workstate-tools";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workstate-e2e");

// A value the owner registered as a secret, and a known secret pattern that the text rules mask.
const SECRET = "ghp_WorkstateSecret2026";
const PATTERN_SECRET = "sk-workstate-abcdef1234567890";
registerSecretValue(SECRET);

const root = await mkdtemp(join(tmpdir(), "openbot-workstate-"));
const checks: Record<string, boolean> = {};
const database = new OpenBotDatabase(join(root, "state"));
try {
  const store = new AgentStore(join(root, "state"), join(root, "home"), database);
  await runCauseEffect(store.initialize());
  const agent =
    store.list()[0] ??
    (await runCauseEffect(
      store.createAgent({
        name: "Workstate fixture",
        description: "Synthetic fixture",
        avatarSeed: "workstate",
        avatarHue: null,
      }),
    ));

  // (a) A subtask's prompt shows the board of its own parent: a sibling's fact, and not another parent's.
  const board = new WorkBoardStore(database);
  board.post({
    parentTaskId: "parent-a",
    authorAgentId: "sibling-agent",
    kind: "fact",
    text: "The staging API listens on port 8081.",
  });
  board.post({
    parentTaskId: "parent-b",
    authorAgentId: "other-agent",
    kind: "fact",
    text: "The other task uses port 9999.",
  });
  const subtaskPrompt = withWorkBoard(board, "parent-a", "Assignment: check the API.");
  assert.match(subtaskPrompt, /- fact: The staging API listens on port 8081\./);
  assert.doesNotMatch(subtaskPrompt, /port 9999/);
  assert.equal(withWorkBoard(board, null, "Assignment: check the API."), "Assignment: check the API.");
  checks.boardFactVisibleToSiblingOnly = true;

  // (b) A person's preference is in that person's agent instructions. The stub gate stands for the router's check:
  // "person-turn" is a message of the person, and "agent-turn" is an agent's own turn.
  const preferences = new PersonPreferencesStore(database);
  const tools = new WorkstateTools({
    database,
    conversation: { publicThreadId: (_agentId, threadId) => threadId },
    personRequest: (_agentId, turnId) => turnId === "person-turn",
  });
  const instructions = () =>
    developerInstructions(agent, store.sharedRoot, [], store.automationRoot, store.agentDefaults(), {
      personPreferences: preferences.instructionPreferences(LOCAL_PERSON_ID),
    });
  const personSet = tools.handle(
    {
      threadId: "thread-1",
      turnId: "person-turn",
      callId: "call-1",
      namespace: null,
      tool: "set_preference",
      arguments: { key: "reply language", value: "Brazilian Portuguese" },
    },
    agent.id,
  );
  assert.equal(personSet?.success, true);
  assert.match(instructions(), /reply language: Brazilian Portuguese/);
  const agentSet = tools.handle(
    {
      threadId: "thread-1",
      turnId: "agent-turn",
      callId: "call-2",
      namespace: null,
      tool: "set_preference",
      arguments: { key: "reply language", value: "English" },
    },
    agent.id,
  );
  assert.equal(agentSet?.success, false);
  assert.deepEqual(
    preferences.list(LOCAL_PERSON_ID).map((item) => item.value),
    ["Brazilian Portuguese"],
  );
  assert.match(instructions(), /reply language: Brazilian Portuguese/);
  checks.personPreferenceInInstructions = true;
  checks.agentPreferenceRefused = true;

  // (c) A working memory slot written in one turn is rendered in the next turn of that thread only.
  const working = new WorkingMemoryStore(database);
  const written = tools.handle(
    {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-3",
      namespace: null,
      tool: "set_working_memory",
      arguments: { slot: "goal", body: "Ship the migration." },
    },
    agent.id,
  );
  assert.equal(written?.success, true);
  assert.match(working.render(agent.id, "thread-1"), /Goal: Ship the migration\./);
  assert.equal(working.render(agent.id, "thread-2"), "");
  checks.workingMemoryNextTurnOnly = true;

  // (d) A registered secret is not stored in a board text, a preference value or a working memory body. A known
  // secret pattern is stored without its value.
  assert.throws(
    () =>
      board.post({
        parentTaskId: "parent-a",
        authorAgentId: "sibling-agent",
        kind: "fact",
        text: `Use token ${SECRET}.`,
      }),
    WorkstateTextRefused,
  );
  const preferenceSecret = tools.handle(
    {
      threadId: "thread-1",
      turnId: "person-turn",
      callId: "call-4",
      namespace: null,
      tool: "set_preference",
      arguments: { key: "deploy token", value: SECRET },
    },
    agent.id,
  );
  assert.equal(preferenceSecret?.success, false);
  const bodySecret = tools.handle(
    {
      threadId: "thread-1",
      turnId: "turn-2",
      callId: "call-5",
      namespace: null,
      tool: "set_working_memory",
      arguments: { slot: "facts", body: `The token is ${SECRET}.` },
    },
    agent.id,
  );
  assert.equal(bodySecret?.success, false);
  const patterned = board.post({
    parentTaskId: "parent-a",
    authorAgentId: "sibling-agent",
    kind: "fact",
    text: `The CI key is api_key=${PATTERN_SECRET}.`,
  });
  assert.equal(patterned.text.includes(PATTERN_SECRET), false);
  for (const [table, column] of [
    ["work_board_items", "text"],
    ["person_preferences", "value"],
    ["working_memory", "body"],
  ] as const) {
    const stored = database.connection
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`)
      .get(`%${SECRET}%`);
    assert.equal(stored?.count, 0, `${table} stored the registered secret`);
  }
  checks.registeredSecretNotStored = true;
  checks.patternSecretRedacted = true;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
  process.stdout.write(`workstate e2e passed: ${Object.keys(checks).join(", ")}\n`);
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}
