// Checks the turn outcome ledger. Runs the real agent service on a temporary profile with a fake Codex
// app-server. The first turn (the agent's first message) completes. The second turn (a message that holds
// the marker `[[FAIL]]`) runs a command that fails with a seeded fake secret in its command and output, then
// ends with a provider error. Checks:
//   1. The `turn_outcomes` table has one row for each turn, in the agent's chat thread, with the outcome of
//      the turn and the cause of the failed one.
//   2. The failed turn's row counts one failed tool step, by code, and keeps no text of the turn.
//   3. The seeded fake secret, the user's words and the command are absent from the table.
// `bun scripts/turn-outcome-ledger-e2e.ts`. Writes .openbot-build/turn-outcome-ledger-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/turn-outcome-ledger-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-turn-outcome-ledger-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

// The modules read HOME and CODEX_HOME when they load, so they are imported after the environment is set.
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

// The secret that the failing command carries in its command and output. It must never reach the ledger.
const SECRET = "FAKE_SECRET_9f2c";

/**
 * A Codex app-server with the methods that the service calls. A turn whose input holds `[[FAIL]]` runs
 * a command that fails, reports a provider error and ends as failed; any other turn answers "Done.".
 */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const failingTurn = (threadId, turnId) => {
  const command = { id: "command-" + turnId, type: "commandExecution", command: "deploy --token ${SECRET}", status: "inProgress" };
  write({ method: "item/started", params: { threadId, turnId, item: command } });
  const failed = { ...command, status: "failed", exitCode: 1, aggregatedOutput: "token ${SECRET} rejected" };
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
      const fails = JSON.stringify(params.input).includes("[[FAIL]]");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        if (fails) return failingTurn(params.threadId, turnId);
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 50);
      return;
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
  agent_id: string;
  thread_id: string;
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
  created_at: string;
}

const report: {
  rows: LedgerRow[];
  passed: boolean;
  error?: string;
} = { rows: [], passed: false };

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
let connection: DatabaseSync | null = null;
const closeReader = () => connection?.close();
const sqlite = () => {
  connection ??= new DatabaseSync(database.path);
  return connection;
};

/** Every row of the ledger, oldest first. */
function rows(): LedgerRow[] {
  return sqlite()
    .prepare(
      `SELECT agent_id, thread_id, turn_id, outcome, cause_code, tool_failures, tool_failure_codes_json,
         approvals_accepted, approvals_declined, reactions_present, memory_changes, skill_loads, created_at
       FROM turn_outcomes ORDER BY created_at, rowid`,
    )
    .all()
    .map((row) => ({
      agent_id: String(row.agent_id),
      thread_id: String(row.thread_id),
      turn_id: String(row.turn_id),
      outcome: String(row.outcome),
      cause_code: typeof row.cause_code === "string" ? row.cause_code : null,
      tool_failures: Number(row.tool_failures),
      tool_failure_codes_json: String(row.tool_failure_codes_json),
      approvals_accepted: Number(row.approvals_accepted),
      approvals_declined: Number(row.approvals_declined),
      reactions_present: Number(row.reactions_present),
      memory_changes: Number(row.memory_changes),
      skill_loads: Number(row.skill_loads),
      created_at: String(row.created_at),
    }));
}

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Ledger",
      description: "Checks the turn outcome ledger.",
      avatarSeed: "ledger",
      avatarHue: null,
      initialMessage: "say hello",
    }),
  );
  const chatThread = await waitFor(
    "the agent's own thread",
    () => store.list().find((entry) => entry.id === agent.id)?.threadId,
  );
  await waitFor("the first turn to end", () => rows().length === 1 && rows());

  const receipt = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "run the deploy [[FAIL]]" }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The failing message has a delivery.");
  const status = await waitFor("the failing delivery to end", () => {
    const value = mailbox.getDelivery(deliveryId)?.delivery.status;
    return value === "completed" || value === "failed" || value === "interrupted" ? value : null;
  });
  assert.equal(status, "failed", "The failing turn ends its delivery as failed.");
  const all = await waitFor("both turns in the ledger", () => rows().length === 2 && rows());
  report.rows = all;

  const completed = all.find((row) => row.outcome === "completed");
  const failed = all.find((row) => row.outcome === "failed");
  assert.ok(completed, "The completed turn has a row.");
  assert.ok(failed, "The failed turn has a row.");
  assert.notEqual(completed.turn_id, failed.turn_id, "Each turn has its own row.");

  assert.equal(completed.agent_id, agent.id, "The completed row belongs to the agent.");
  assert.equal(completed.thread_id, chatThread, "The completed row belongs to the agent's chat.");
  assert.equal(completed.cause_code, null, "A completed turn has no cause.");
  assert.equal(completed.tool_failures, 0, "A completed turn without tools has no tool failure.");
  assert.equal(completed.tool_failure_codes_json, "{}", "A completed turn has no tool failure code.");

  assert.equal(failed.agent_id, agent.id, "The failed row belongs to the agent.");
  assert.equal(failed.thread_id, chatThread, "The failed row belongs to the agent's chat.");
  assert.equal(failed.cause_code, "provider_internal_error", "The failed row names the provider's cause.");
  assert.equal(failed.tool_failures, 1, "The failed row counts the one failed command.");
  assert.equal(failed.tool_failure_codes_json, '{"exit_nonzero":1}', "The failed row counts the command by its code.");
  assert.equal(failed.approvals_accepted, 0, "No approval was asked in this turn.");
  assert.equal(failed.approvals_declined, 0, "No approval was asked in this turn.");

  // The ledger holds codes and counts only: no user words, no command, and no output of the tool.
  const dump = JSON.stringify(sqlite().prepare("SELECT * FROM turn_outcomes").all());
  for (const forbidden of ["say hello", "run the deploy", "[[FAIL]]", "deploy --token", SECRET, "rejected"]) {
    assert.equal(dump.includes(forbidden), false, `The ledger does not contain "${forbidden}".`);
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  closeReader();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
