import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { EXACT_TOOL_GUIDANCE, exactToolGuidance } from "../src/backend/agent/exact-tool-policy";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

// Checks the compute_exact policy in two layers.
// 1. Pure: decimal arithmetic and comparison chains get guidance, plain text gets null, identifier-only
//    expressions get null, and the guidance is a fixed template of at most 200 characters with no user text.
// 2. Provider: the real agent service runs on a temporary profile with a fake Codex app-server. An arithmetic
//    message's turn input carries the guidance; a plain message's turn input does not.
// `bun scripts/exact-tool-policy-e2e.ts`. Writes .openbot-build/exact-tool-policy-e2e/report.json.

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/exact-tool-policy-e2e");

type Check = { name: string; passed: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

// 1. Decimal arithmetic names compute_exact.
for (const request of ["What is 0.1 + 0.2 and the total?", "Sum 19.99*3 plus tax", "2 ^ 100 please"]) {
  const guidance = exactToolGuidance(request);
  check(`arithmetic gets guidance: ${request}`, guidance?.includes("compute_exact") === true, String(guidance));
}

// 2. Plain text gets null.
for (const request of ["Tell me a story about a cat.", "Summarize the meeting notes.", "Dates: 2024-05-06"]) {
  check(
    `no arithmetic gives null: ${request}`,
    exactToolGuidance(request) === null,
    String(exactToolGuidance(request)),
  );
}

// 3. Identifier-like expressions: function calls with arithmetic get guidance; bare identifiers do not.
check("sqrt(2) + 1 is arithmetic", exactToolGuidance("What is sqrt(2) + 1?") !== null, "");
check("x + y (identifiers only) gives null", exactToolGuidance("compute x + y for me") === null, "");
check("2 + x (one identifier operand) gives null", exactToolGuidance("what is 2 + x") === null, "");

// 4. Comparison chains get guidance.
check("comparison chain 1 < 2 < 3 gets guidance", exactToolGuidance("is 1 < 2 < 3 true?") !== null, "");

// 5. Guidance is a fixed template: at most 200 characters, no user text.
const marker = "zzqmarker";
const withMarker = exactToolGuidance(`${marker} 0.1 + 0.2`);
check("guidance is the fixed template", withMarker === EXACT_TOOL_GUIDANCE, String(withMarker));
check("guidance is at most 200 characters", EXACT_TOOL_GUIDANCE.length <= 200, `length=${EXACT_TOOL_GUIDANCE.length}`);
check("guidance contains no user text", !String(withMarker).includes(marker), "");

// 6. Provider: the real service sends the guidance in an arithmetic turn's input and not in a plain one.
const ARITHMETIC_TOKEN = "exact-arith-marker";
const PLAIN_TOKEN = "exact-plain-marker";

const root = await mkdtemp(join(tmpdir(), "openbot-exact-tool-policy-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// The service modules read HOME and CODEX_HOME when they load: set the environment first, then import them.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

// The service modules read HOME and CODEX_HOME when they load, so they are imported only after the environment is set.
// Static imports would load them first, so these dynamic imports are required.
const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods the service calls. Every turn completes with "Done.", and each turn
 * that starts logs the text of its input.
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
      setTimeout(() => {
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

/** Waits until a condition holds, or fails after the timeout. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
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

/** The one turn whose input holds the token. */
function turnWith(token: string): string {
  const matches = startedTexts().filter((text) => text.includes(token));
  if (matches.length !== 1) throw new Error(`Expected exactly one turn with ${token}, found ${matches.length}.`);
  return matches[0] ?? "";
}

let providerError: string | null = null;
try {
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
  try {
    await runCauseEffect(agents.initialize());
    const agent = await runCauseEffect(
      agents.createAgent({
        name: "Exact",
        description: "Checks the compute_exact guidance of the turn input.",
        avatarSeed: "exact",
        avatarHue: null,
        initialMessage: "say hello",
      }),
    );
    const sendAndWait = async (text: string): Promise<string> => {
      const receipt = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text }));
      const deliveryId = receipt.deliveries[0]?.id;
      if (!deliveryId) throw new Error("The message has no delivery.");
      return waitFor(`the delivery of "${text}" to end`, () => {
        const value = mailbox.getDelivery(deliveryId)?.delivery.status;
        return value === "completed" || value === "failed" || value === "interrupted" ? value : null;
      });
    };
    const arithmeticStatus = await sendAndWait(`${ARITHMETIC_TOKEN} what is 0.1 + 0.2 for the total?`);
    const plainStatus = await sendAndWait(`${PLAIN_TOKEN} tell me about cats.`);
    const arithmeticTurn = turnWith(ARITHMETIC_TOKEN);
    const plainTurn = turnWith(PLAIN_TOKEN);
    check(
      "provider: the arithmetic turn input carries the compute_exact guidance",
      arithmeticStatus === "completed" && arithmeticTurn.includes(EXACT_TOOL_GUIDANCE),
      arithmeticTurn,
    );
    check(
      "provider: the plain turn input carries no compute_exact guidance",
      plainStatus === "completed" && !plainTurn.includes(EXACT_TOOL_GUIDANCE),
      plainTurn,
    );
    database.close();
  } finally {
    await runCauseEffect(agents.stop()).catch(() => {});
  }
} catch (error) {
  providerError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  check("provider run completed", false, providerError);
} finally {
  await rm(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
const report = {
  name: "exact-tool-policy-e2e",
  passed: failed.length === 0,
  total: checks.length,
  failed: failed.length,
  guidanceLength: EXACT_TOOL_GUIDANCE.length,
  checks,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const item of checks) process.stdout.write(`${item.passed ? "PASS" : "FAIL"} ${item.name}\n`);
if (failed.length > 0) {
  process.stderr.write(`${failed.length} of ${checks.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`all ${checks.length} checks passed\n`);
process.exit(0);
