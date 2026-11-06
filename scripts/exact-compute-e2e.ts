// Checks the `compute_exact` tool (exact arithmetic and boolean logic). Runs the real agent service and
// tool router on a temporary profile with a fake Codex app-server, the same pattern as
// `routine-report-failure-e2e.ts`. The fake calls `compute_exact` through the `openbot` namespace, so the
// dispatch in `openbot-tool-router.ts` answers each call. Then it checks the evaluator directly for the
// edge cases that the dispatch does not add: precision, fractions, nesting and size limits.
// `bun scripts/exact-compute-e2e.ts`. Writes .openbot-build/exact-compute-e2e/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { computeExact, type ExactComputeResult } from "../src/backend/exact-compute";

const OUT = resolve(import.meta.dirname, "../.openbot-build/exact-compute-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-exact-compute-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// The service modules read HOME and CODEX_HOME when they load: set the env first, then import them.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { OPENBOT_DYNAMIC_TOOLS } = await import("../src/backend/openbot-tools");

/** One `compute_exact` call of the fake turn, with the result the dispatch must give. */
const CASES = [
  { name: "decimal sum", expression: "0.1 + 0.2" },
  { name: "power of two", expression: "2^100" },
  { name: "division by zero", expression: "1/0" },
  { name: "function call", expression: "sqrt(2)" },
  { name: "identifier", expression: "x + 1" },
  { name: "boolean logic", expression: "1 < 2 and not false" },
  { name: "property access", expression: "(1).toString" },
] as const;

const TWO_TO_THE_100 = "1267650600228229401496703205376";

/**
 * A Codex app-server with the methods that the service calls. A turn calls, one at a time, the OpenBot
 * tools that its input names in `<<CALLS[...]CALLS>>`, logs each result, then answers "Checked." The
 * `tool-result` entries of the log are what the dispatch returned to the model.
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
  const item = { type: "agentMessage", id: "message-" + turnId, text: turn.reply, phase: "final_answer" };
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
      const named = /<<CALLS([\\s\\S]*?)CALLS>>/.exec(text);
      const turnCalls = named ? JSON.parse(named[1]) : [];
      return callNext({ threadId: params.threadId, turnId, calls: turnCalls, reply: "Checked." });
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

interface LogEntry {
  method: string;
  turnId?: string;
  text?: string;
  tool?: string;
  result?: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error?: unknown;
}

interface Outcome {
  success: boolean | null;
  body: { value?: string; type?: string; error?: string; code?: string } | null;
}

const report: {
  dispatch: Record<string, Outcome | null>;
  evaluator: Record<string, ExactComputeResult>;
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  error?: string;
} = { dispatch: {}, evaluator: {}, checks: [], passed: false };

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

/** Waits for a state of the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
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

/** The `compute_exact` results that the dispatch returned, in call order. */
function computeResults(): LogEntry[] {
  return fakeEntries().filter((entry) => entry.method === "tool-result" && entry.tool === "compute_exact");
}

function outcomeOf(entry: LogEntry): Outcome {
  const text = entry.result?.contentItems[0]?.text ?? null;
  return { success: entry.result?.success ?? null, body: text === null ? null : JSON.parse(text) };
}

function check(name: string, passed: boolean, detail?: unknown) {
  report.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

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
const events: AgentEvent[] = [];
agents.on("event", (event) => {
  events.push(event);
});

try {
  await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
  await runCauseEffect(agents.initialize());

  // Dispatch: one agent turn calls every case in order through the real router.
  const calls = CASES.map(({ expression }) => ({ tool: "compute_exact", arguments: { expression } }));
  await runCauseEffect(
    agents.createAgent({
      name: "Calculator",
      description: "Computes exact results.",
      avatarSeed: "calculator",
      avatarHue: null,
      initialMessage: `Compute these exactly.\n<<CALLS${JSON.stringify(calls)}CALLS>>`,
    }),
  );
  const entries = await waitFor("compute_exact results", () => {
    const found = computeResults();
    return found.length >= CASES.length ? found : null;
  });
  const outcomes = entries.slice(0, CASES.length).map(outcomeOf);
  CASES.forEach(({ name }, index) => {
    report.dispatch[name] = outcomes[index] ?? null;
  });
  const [sum, power, divZero, call, identifier, logic, property] = outcomes;
  const registered = OPENBOT_DYNAMIC_TOOLS.tools.some((tool) => tool.name === "compute_exact");

  check("compute_exact is registered in the openbot namespace", registered);
  check(
    "(1) 0.1 + 0.2 returns 0.3 exactly",
    sum?.success === true && sum.body?.value === "0.3" && sum.body.type === "number",
    sum,
  );
  check(
    "(2) 2^100 returns the exact 31-digit integer",
    power?.success === true &&
      power.body?.value === TWO_TO_THE_100 &&
      power.body.value.length === 31 &&
      power.body.value === (2n ** 100n).toString() &&
      power.body.type === "number",
    power,
  );
  check(
    "(3) 1/0 returns code validation",
    divZero?.success === false &&
      divZero.body?.code === "validation" &&
      divZero.body.error?.includes("Division by zero") === true,
    divZero,
  );
  check(
    "(4a) a function call is rejected with code validation",
    call?.success === false && call.body?.code === "validation",
    call,
  );
  check(
    "(4b) an identifier is rejected with code validation",
    identifier?.success === false && identifier.body?.code === "validation",
    identifier,
  );
  check(
    "(5) 1 < 2 and not false returns boolean true",
    logic?.success === true && logic.body?.value === "true" && logic.body.type === "boolean",
    logic,
  );
  check(
    "A property access is rejected with code validation",
    property?.success === false && property.body?.code === "validation",
    property,
  );
  check(
    "A dispatch failure keeps the tool failure shape: success false and a JSON error",
    divZero?.success === false && typeof divZero.body?.error === "string",
    divZero,
  );

  // Evaluator: the edge cases, called directly.
  const VALID: [string, string, string][] = [
    ["precedence", "2 + 3 * 4", "14"],
    ["right-associative power", "2^3^2", "512"],
    ["unary minus binds below power", "-2^2", "-4"],
    ["negative exponent", "2^-2", "0.25"],
    ["fraction that is not a finite decimal", "1/3", "1/3"],
    ["finite decimal from a division", "1/8", "0.125"],
    ["decimal product", "0.1 * 3", "0.3"],
    ["remainder takes the dividend's sign", "-7 % 3", "-1"],
    ["remainder of decimals", "5.5 % 2", "1.5"],
    ["leading-dot literal", ".5 + 1", "1.5"],
    ["zero to the zero", "0^0", "1"],
    ["nested parentheses at the depth limit", `${"(".repeat(64)}1${")".repeat(64)}`, "1"],
    ["boolean equality with a parenthesized comparison", "(1 < 2) == true", "true"],
    ["comparison operators", "3 >= 3 and 2 != 2", "false"],
    ["exact power far beyond float precision", "(2^100) - (2^100) + 1", "1"],
  ];
  const REJECTED: [string, string][] = [
    ["empty expression", ""],
    ["division by zero from a power", "0^-1"],
    ["modulo by zero", "5 % 0"],
    ["a non-integer exponent", "2^0.5"],
    ["a chained comparison", "1 < 2 < 3"],
    ["a number with a boolean", "1 + true"],
    ["and on numbers", "1 and 2"],
    ["two numbers side by side", "2 2"],
    ["a bare identifier", "x"],
    ["an identifier in a call", "sqrt(4)"],
    ["an exponent that is too large", "2^20000"],
    ["nesting beyond the depth limit", `${"(".repeat(65)}1${")".repeat(65)}`],
    ["more than 500 characters", `${"1+".repeat(250)}1`],
    ["an unclosed parenthesis", "(1 + 2"],
    ["an unsupported character", "1 = 1"],
  ];
  for (const [name, expression, expected] of VALID) {
    const result = computeExact(expression);
    report.evaluator[name] = result;
    check(`evaluator: ${name}`, result.ok === true && result.value === expected, { expression, result });
  }
  for (const [name, expression] of REJECTED) {
    const result = computeExact(expression);
    report.evaluator[name] = result;
    check(`evaluator rejects: ${name}`, result.ok === false && result.code === "validation", { expression, result });
  }
  // The fake finishes the turn after its last call, so the turn ends after the results arrive.
  const completed = await waitFor("the agent turn to complete", () =>
    events.find((event) => event.type === "turn-completed"),
  );
  check("The turn completes after its calls are answered", completed.type === "turn-completed");
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  report.passed = report.error === undefined && report.checks.every((item) => item.passed);
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
