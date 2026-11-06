// Checks the recurrence note of the turn outcome ledger. Runs the real agent service on a temporary profile
// with a fake Codex app-server, the same pattern as `exact-compute-e2e.ts`. Each agent sends messages whose
// turns fail in a seeded way, and the fake logs the input text of every turn that starts. Checks:
//   1. Three failed turns with one cause and one tool failure code: the next delivery's prompt carries one
//      note with those codes and the count 3, and the delivery after it carries no note.
//   2. Two failed turns with the same key: the next delivery carries no note.
//   3. Three failed turns with three different tool failure codes: the next delivery carries no note.
//   4. The note holds no seeded user text, no tool argument and no secret, and the ledger keeps none either.
// `bun scripts/recurrence-e2e.ts`. Writes .openbot-build/recurrence-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/recurrence-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-recurrence-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// The secret that the failing commands carry, and the user text of each message. Neither may reach a note.
const SECRET = "FAKE_SECRET_5c81";
const USER_TEXT = "FAKE_USER_TEXT_a7d2";
const NOTE_START = "OpenBot note, not a message from the user.";

// The service modules read HOME and CODEX_HOME when they load: set the environment first, then import them.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods that the service calls. A turn whose input holds a failure marker
 * ends as failed with one failed command: `[[FAIL]]` a command that exits 1, `[[FAIL_STATUS]]` a command
 * that fails without an exit code, `[[DECLINE]]` a declined command. Any other turn answers "Done.". Each
 * turn that starts logs the text of its input.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const failingTurn = (threadId, turnId, mode) => {
  const command = { id: "command-" + turnId, type: "commandExecution", command: "deploy --token ${SECRET}", status: "inProgress" };
  write({ method: "item/started", params: { threadId, turnId, item: command } });
  const failed = mode === "exit"
    ? { ...command, status: "failed", exitCode: 1, aggregatedOutput: "token ${SECRET} rejected" }
    : mode === "declined"
      ? { ...command, status: "declined", aggregatedOutput: "token ${SECRET} refused" }
      : { ...command, status: "failed", aggregatedOutput: "token ${SECRET} rejected" };
  write({ method: "item/completed", params: { threadId, turnId, item: failed } });
  const error = { message: "Provider internal error", codexErrorInfo: "provider_internal_error" };
  write({ method: "error", params: { threadId, turnId, message: error.message, error } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      log({ method: "turn/start", threadId: params.threadId, turnId, text });
      const mode = text.includes("[[DECLINE]]") ? "declined" : text.includes("[[FAIL_STATUS]]") ? "status" : text.includes("[[FAIL]]") ? "exit" : null;
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        if (mode) return failingTurn(params.threadId, turnId, mode);
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 50);
      return;
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface LedgerRow {
  outcome: string;
  cause_code: string | null;
  tool_failure_codes_json: string;
}

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  error?: string;
} = { checks: [], passed: false };

function check(name: string, passed: boolean, detail?: unknown) {
  report.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

/** Waits for a state of the service or of its database. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
// A second connection reads the ledger while the service writes it.
let reader: DatabaseSync | null = null;
const sqlite = () => {
  reader ??= new DatabaseSync(database.path);
  return reader;
};

/** The ledger rows of one agent, oldest first. */
function ledgerRows(agentId: string): LedgerRow[] {
  return sqlite()
    .prepare(
      "SELECT outcome, cause_code, tool_failure_codes_json FROM turn_outcomes WHERE agent_id = ? ORDER BY created_at, rowid",
    )
    .all(agentId)
    .map((row) => ({
      outcome: String(row.outcome),
      cause_code: typeof row.cause_code === "string" ? row.cause_code : null,
      tool_failure_codes_json: String(row.tool_failure_codes_json),
    }));
}

/** The text of every turn that started, oldest first, as the fake received it. */
function startedTexts(): string[] {
  let raw = "";
  try {
    raw = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line): { method?: unknown; text?: unknown } => JSON.parse(line))
    .filter((entry) => entry.method === "turn/start")
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""));
}

/** The prompt of the one turn whose input holds the token. */
function promptWith(token: string): string {
  const matches = startedTexts().filter((text) => text.includes(token));
  assert.equal(matches.length, 1, `Exactly one turn carries ${token}.`);
  return matches[0] ?? "";
}

/** The note of a prompt: its sentence and the line that follows it, or "" when the prompt has none. */
function noteOf(prompt: string): string {
  const start = prompt.indexOf(NOTE_START);
  if (start < 0) return "";
  const end = prompt.indexOf("\n", start);
  return prompt.slice(start, end < 0 ? undefined : end);
}

/** Sends one message and waits until its delivery ends and its ledger row is written. */
async function sendAndWait(agentId: string, text: string, rows: number): Promise<string> {
  const receipt = await runCauseEffect(agents.sendMessage({ agentId, text }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  const status = await waitFor(`the delivery of "${text}" to end`, () => {
    const value = mailbox.getDelivery(deliveryId)?.delivery.status;
    return value === "completed" || value === "failed" || value === "interrupted" ? value : null;
  });
  await waitFor(`${rows} ledger rows`, () => ledgerRows(agentId).length >= rows);
  return status;
}

/** Creates an agent whose first turn completes, so the ledger holds one completed row. */
async function startAgent(name: string): Promise<string> {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks the recurrence note of the turn outcome ledger.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "say hello",
    }),
  );
  await waitFor(`${name} to finish its first turn`, () => ledgerRows(agent.id).length >= 1);
  return agent.id;
}

const closeReader = () => reader?.close();
try {
  await runCauseEffect(agents.initialize());

  // Scenario 1: three failed turns with one key, then a fourth delivery that must carry the note.
  const recurring = await startAgent("Recurring");
  for (const [index, marker] of ["[[FAIL]]", "[[FAIL]]", "[[FAIL]]"].entries()) {
    const status = await sendAndWait(recurring, `${USER_TEXT} recur-message-${index + 1} deploy ${marker}`, index + 2);
    assert.equal(status, "failed", "A failing message ends its delivery as failed.");
  }
  const fourth = await sendAndWait(recurring, `${USER_TEXT} recur-message-4 continue`, 5);
  assert.equal(fourth, "completed", "The fourth delivery completes.");
  const fourthNote = noteOf(promptWith("recur-message-4"));
  check(
    "1. The fourth delivery's prompt carries the note with the codes and the count 3",
    fourthNote.includes(
      "3 of your last 20 turns failed with cause provider_internal_error and tool failure exit_nonzero.",
    ),
    { note: fourthNote },
  );
  const fifth = await sendAndWait(recurring, `${USER_TEXT} recur-message-5 continue`, 6);
  assert.equal(fifth, "completed", "The fifth delivery completes.");
  check(
    "1. Only the next delivery gets the note: the fifth delivery's prompt carries none",
    noteOf(promptWith("recur-message-5")) === "",
  );
  const recurringRows = ledgerRows(recurring);
  check(
    "1. The three failed rows share one cause and one tool failure code",
    recurringRows.filter((row) => row.outcome === "failed").length === 3 &&
      recurringRows
        .filter((row) => row.outcome === "failed")
        .every(
          (row) => row.cause_code === "provider_internal_error" && row.tool_failure_codes_json === '{"exit_nonzero":1}',
        ),
    recurringRows,
  );

  // Scenario 2: two failed turns with one key. No note.
  const pair = await startAgent("Pair");
  for (const [index, marker] of ["[[FAIL]]", "[[FAIL]]"].entries()) {
    const status = await sendAndWait(pair, `${USER_TEXT} pair-message-${index + 1} deploy ${marker}`, index + 2);
    assert.equal(status, "failed", "A failing message ends its delivery as failed.");
  }
  const pairNext = await sendAndWait(pair, `${USER_TEXT} pair-message-3 continue`, 4);
  assert.equal(pairNext, "completed", "The next delivery completes.");
  check(
    "2. Two failures with the same key: the next delivery's prompt carries no note",
    noteOf(promptWith("pair-message-3")) === "",
  );

  // Scenario 3: three failed turns, each with another tool failure code. No note.
  const mixed = await startAgent("Mixed");
  for (const [index, marker] of ["[[FAIL]]", "[[FAIL_STATUS]]", "[[DECLINE]]"].entries()) {
    const status = await sendAndWait(mixed, `${USER_TEXT} mixed-message-${index + 1} deploy ${marker}`, index + 2);
    assert.equal(status, "failed", "A failing message ends its delivery as failed.");
  }
  const mixedNext = await sendAndWait(mixed, `${USER_TEXT} mixed-message-4 continue`, 5);
  assert.equal(mixedNext, "completed", "The next delivery completes.");
  const mixedCodes = ledgerRows(mixed)
    .filter((row) => row.outcome === "failed")
    .map((row) => row.tool_failure_codes_json);
  check(
    "3. Three failures with three tool failure codes: the next delivery's prompt carries no note",
    noteOf(promptWith("mixed-message-4")) === "" && new Set(mixedCodes).size === 3,
    { toolFailureCodes: mixedCodes },
  );

  // Scenario 4: the note of scenario 1 holds no user text, no tool argument and no secret.
  const note = fourthNote;
  const forbidden = [USER_TEXT, SECRET, "recur-message", "deploy", "[[FAIL", "continue"];
  check(
    "4. The note holds no seeded user text, tool argument or secret",
    note !== "" && forbidden.every((text) => !note.includes(text)),
    { forbidden },
  );
  const ledgerDump = JSON.stringify(sqlite().prepare("SELECT * FROM turn_outcomes").all());
  check(
    "4. The ledger keeps no seeded user text, tool argument or secret",
    forbidden.every((text) => !ledgerDump.includes(text)),
  );

  report.passed = report.checks.every((item) => item.passed);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  closeReader();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
