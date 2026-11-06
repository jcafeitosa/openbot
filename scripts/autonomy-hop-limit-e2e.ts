// Checks the agent delivery-chain hop limit: a request that would pass the fifth agent hop of one chain
// is refused, and the sender sees the refusal as a failed tool call. Runs the real agent service, tool
// router and mailbox on a temporary profile with a fake Codex app-server. Two agents pass a message back
// and forth: a person starts the chain, and each agent answers with the next hop number. The check
// asserts that the first five hops are accepted and share one chain id, that the sixth is refused with
// the localized limit text, and that a mailbox state written before the chain fields existed still loads
// with no chain (hop 0). `bun scripts/autonomy-hop-limit-e2e.ts`. Writes
// .openbot-build/autonomy-hop-limit-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_MESSAGE_HOP_LIMIT } from "@openbot/contracts/input-limits";
import { AGENT_PROVIDERS, type QueuedMessageReceipt } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/autonomy-hop-limit-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-hop-limit-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// Before the service modules load: the Codex process and the stores read the home folder. That is why
// the modules below are imported dynamically, after this environment is set.
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
 * A Codex app-server with the methods that the service calls. A person's message that names a peer,
 * `RELAY:<agentId>`, starts the chain: the agent sends `HOP:1` to that peer. A teammate's message that
 * carries `HOP:n` makes the agent send `HOP:n+1` back to its sender. Other turns make no call. A turn
 * calls the tools it is given in order, logs each result, then answers.
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
/** Tool request id -> the turn that waits for its result. */
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn) => {
  const { threadId, turnId } = turn;
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const callNext = (turn) => {
  const call = turn.calls.shift();
  if (!call) return setTimeout(() => finish(turn), 20);
  const id = "tool-" + turn.turnId + "-" + turn.calls.length;
  waiting.set(id, { turn, tool: call.tool });
  write({
    id,
    method: "item/tool/call",
    params: { threadId: turn.threadId, turnId: turn.turnId, callId: "call-" + id, namespace: "openbot", tool: call.tool, arguments: call.arguments || {} },
  });
};
const sendTo = (agentId, text) => ({ tool: "send_message", arguments: { recipientAgentIds: [agentId], text } });
const callsFor = (text) => {
  const relay = /RELAY:(\\S+)/.exec(text);
  if (relay) return [sendTo(relay[1], "HOP:1")];
  const teammate = /Message from OpenBot teammate [^\\n]* \\(([^()\\s]+)\\)\\.\\nMessage ID: \\S+\\n/.exec(text);
  const hop = /HOP:(\\d+)/.exec(text);
  if (teammate && hop) return [sendTo(teammate[1], "HOP:" + (Number(hop[1]) + 1))];
  return [];
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return callNext({ threadId: params.threadId, turnId, calls: callsFor(text) });
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
      else if (!message.method && waiting.has(message.id)) {
        const { turn, tool } = waiting.get(message.id);
        waiting.delete(message.id);
        log({ method: "tool-result", turnId: turn.turnId, tool, result: message.result ?? null, error: message.error ?? null });
        callNext(turn);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface ToolResult {
  success: boolean;
  contentItems: { type: string; text: string }[];
}

interface LogEntry {
  method: string;
  tool?: string;
  result?: ToolResult | null;
  /** A tool call the router refused reaches the fake as a JSON-RPC error, not as a result. */
  error?: { message?: string } | null;
}

const report: {
  attempts: { index: number; success: boolean; text: string }[];
  limit: number;
  refusal: { hop: number; text: string } | null;
  chain: { id: string; hops: number[] } | null;
  legacy: { messageId: string; chain: boolean; stored: boolean } | null;
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = {
  attempts: [],
  limit: AGENT_MESSAGE_HOP_LIMIT,
  refusal: null,
  chain: null,
  legacy: null,
  checks: [],
  passed: false,
};

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

/** Waits for a state of the service, its database or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function fakeEntries(): LogEntry[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The `send_message` results that the fake's turns received, in the order the tool answered them. */
function sendResults(): ToolResult[] {
  return fakeEntries()
    .filter((entry) => entry.method === "tool-result" && entry.tool === "send_message")
    .map(
      (entry) =>
        entry.result ?? { success: false, contentItems: [{ type: "inputText", text: entry.error?.message ?? "" }] },
    );
}

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
}

/** The text a tool result carries, as the sender reads it. */
const resultText = (result: ToolResult) => result.contentItems.map((item) => item.text).join("\n");

/**
 * A mailbox state written before the chain fields existed: a legacy v3 blob whose message has no
 * `chain`. The service must still read it, and the message must have no chain (hop 0).
 */
async function legacyFixture(
  since: string,
  sharedRoot: string,
): Promise<{ messageId: string; chain: boolean; stored: boolean }> {
  const dir = join(root, "legacy");
  mkdirSync(dir, { recursive: true });
  const messageId = "legacy-message-1";
  writeFileSync(
    join(dir, "mailbox.json"),
    JSON.stringify({
      version: 3,
      messages: [
        {
          id: messageId,
          sender: { kind: "user" },
          text: "Written before the chain fields existed.",
          attachments: [],
          replyToMessageId: null,
          createdAt: since,
        },
      ],
      deliveries: [],
      drafts: [],
      generatedAttachments: [],
      pausedAgentIds: [],
      idempotency: {},
      reactions: [],
    }),
  );
  const legacyDatabase = new OpenBotDatabase(dir);
  try {
    const legacy = new MailboxStore(dir, sharedRoot, legacyDatabase);
    await runCauseEffect(legacy.initialize());
    return {
      messageId,
      chain: legacy.messageChain(messageId) !== null,
      stored: JSON.stringify(legacyDatabase.readMailboxState()).includes(messageId),
    };
  } finally {
    legacyDatabase.close();
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

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Passes requests along a chain.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s thread`, () => store.list().find((entry) => entry.id === agent.id)?.threadId);
  await waitFor(`${name}'s first turn`, () =>
    agents.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
  );
  return agent;
}

try {
  await runCauseEffect(agents.initialize());
  const since = new Date().toISOString();
  const alpha = await createAgent("Alpha");
  const bravo = await createAgent("Bravo");

  await runCauseEffect(agents.sendMessage({ agentId: alpha.id, text: `Start the chain. RELAY:${bravo.id}` }));

  // The chain settles when the limit's attempt has been answered and both queues are idle.
  await waitFor("the chain to settle", () => {
    const results = sendResults();
    const idle = [alpha, bravo].every((agent) =>
      agents.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    return idle && results.length >= AGENT_MESSAGE_HOP_LIMIT + 1;
  });
  // A quiet second confirms that no further attempt follows the refusal.
  await new Promise((done) => setTimeout(done, 1_000));
  const settled = sendResults();
  report.attempts = settled.map((result, index) => ({
    index: index + 1,
    success: result.success,
    text: resultText(result),
  }));

  pass("The chain makes exactly one attempt past the limit", settled.length === AGENT_MESSAGE_HOP_LIMIT + 1, {
    attempts: settled.length,
  });
  const accepted = settled.slice(0, AGENT_MESSAGE_HOP_LIMIT);
  pass(
    `The first ${AGENT_MESSAGE_HOP_LIMIT} hops are accepted`,
    accepted.every((result) => result.success),
    {
      attempts: report.attempts,
    },
  );

  const refused = settled[AGENT_MESSAGE_HOP_LIMIT];
  assert.ok(refused, "The sixth attempt has no result.");
  const refusalText = resultText(refused);
  report.refusal = { hop: AGENT_MESSAGE_HOP_LIMIT + 1, text: refusalText };
  pass(
    "The sixth hop is refused with the limit text",
    !refused.success && refusalText.includes(`stop after ${AGENT_MESSAGE_HOP_LIMIT} hops`),
    refusalText,
  );

  // Each accepted message names its chain: one id, and hop numbers 1 to 5 in order.
  const messageIds = accepted.map((result) => {
    const receipt: QueuedMessageReceipt = JSON.parse(resultText(result));
    return receipt.messageId;
  });
  const chains = messageIds.map((messageId) => mailbox.messageChain(messageId));
  const chainId = chains[0]?.id ?? "";
  const hops = chains.map((chain) => chain?.hop ?? 0);
  report.chain = { id: chainId, hops };
  pass(
    "Accepted hops share one chain id and count 1 to 5",
    chainId !== "" && chains.every((chain) => chain?.id === chainId) && hops.every((hop, index) => hop === index + 1),
    { hops },
  );

  report.legacy = await legacyFixture(since, store.sharedRoot);
  pass(
    "A state blob without chain fields loads with no chain (hop 0)",
    report.legacy.stored && !report.legacy.chain,
    report.legacy,
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
