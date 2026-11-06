// Checks the tool error taxonomy through the real OpenBot tool router. Runs the real agent service on a
// temporary profile with a fake Codex app-server, the same pattern as `exact-compute-e2e.ts`. The fake
// calls three tools through the `openbot` namespace, and the dispatch in `openbot-tool-router.ts`
// answers each call. The checks read the answer the model sees: the `tool-result` the fake logs.
//   1. An invalid argument to `compute_exact` is code `validation`, not retryable.
//   2. A handler that throws a seeded fake secret is code `internal`, not retryable, and its text holds
//      no secret. `send_message` throws `Unknown OpenBot agent: <recipient>` for an unknown recipient id,
//      so the seeded secret is passed as that id.
//   3. Division by zero through `compute_exact` is code `validation`.
// `bun scripts/tool-error-taxonomy-router-e2e.ts`. Writes .openbot-build/tool-error-taxonomy-router-e2e/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/tool-error-taxonomy-router-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-tool-error-router-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const SECRET = "tero-fake-secret-3b8e52";

// The service modules read HOME and CODEX_HOME when they load. These imports stay dynamic so the env is set first.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });
registerSecretValue(SECRET);

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/** The calls of the fake turn, in order. Each one is answered before the next is sent. */
const CALLS = [
  { name: "invalid argument", tool: "compute_exact", arguments: { expression: 42 } },
  {
    name: "handler throws a seeded secret",
    tool: "send_message",
    arguments: { recipientAgentIds: [SECRET], text: "Hello." },
  },
  { name: "division by zero", tool: "compute_exact", arguments: { expression: "1/0" } },
] as const;

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
  tool?: string;
  result?: { success: boolean; contentItems: { type: string; text: string }[] } | null;
}

/** What the model saw. `text` is the raw answer, read only by the checks and never written to the report. */
interface Answer {
  success: boolean | null;
  body: { error?: string; code?: string; retryable?: boolean } | null;
  text: string | null;
}

/** The answer as the report holds it: every string is redacted before it is written. */
interface PublishedAnswer {
  success: boolean | null;
  body: { error?: string; code?: string; retryable?: boolean } | null;
  text: string | null;
}

const report: {
  results: Record<string, PublishedAnswer | null>;
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  error?: string;
} = { results: {}, checks: [], passed: false };

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

function answerOf(entry: LogEntry): Answer {
  const text = entry.result?.contentItems[0]?.text ?? null;
  let body: Answer["body"] = null;
  if (text !== null) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { success: entry.result?.success ?? null, body, text };
}

function publish(answer: Answer | undefined): PublishedAnswer | null {
  if (!answer) return null;
  return {
    success: answer.success,
    body: answer.body && {
      ...(answer.body.code === undefined ? {} : { code: answer.body.code }),
      ...(answer.body.retryable === undefined ? {} : { retryable: answer.body.retryable }),
      ...(answer.body.error === undefined ? {} : { error: redactText(answer.body.error) }),
    },
    text: answer.text === null ? null : redactText(answer.text),
  };
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

  // One agent turn makes every call in order through the real router.
  const calls = CALLS.map(({ tool, arguments: args }) => ({ tool, arguments: args }));
  await runCauseEffect(
    agents.createAgent({
      name: "Calculator",
      description: "Computes exact results.",
      avatarSeed: "calculator",
      avatarHue: null,
      initialMessage: `Make these calls.\n<<CALLS${JSON.stringify(calls)}CALLS>>`,
    }),
  );
  const entries = await waitFor("tool results", () => {
    const found = fakeEntries().filter((entry) => entry.method === "tool-result");
    return found.length >= CALLS.length ? found : null;
  });
  const answers = entries.slice(0, CALLS.length).map(answerOf);
  CALLS.forEach(({ name }, index) => {
    report.results[name] = publish(answers[index]);
  });
  const [invalid, thrown, divZero] = answers;

  check(
    "(1) an invalid argument to compute_exact returns code validation, retryable false",
    invalid?.success === false && invalid.body?.code === "validation" && invalid.body.retryable === false,
    publish(invalid),
  );
  check(
    "(2) a handler that throws a seeded secret returns code internal, retryable false",
    thrown?.success === false && thrown.body?.code === "internal" && thrown.body.retryable === false,
    publish(thrown),
  );
  check(
    "(2) the handler's own message reaches the answer, so the handler really threw",
    thrown?.body?.error?.includes("Unknown OpenBot agent") === true,
    publish(thrown),
  );
  check("(2) the text of that answer holds no seeded secret", thrown?.text != null && !thrown.text.includes(SECRET));
  check(
    "(3) division by zero through compute_exact returns code validation",
    divZero?.success === false && divZero.body?.code === "validation",
    publish(divZero),
  );

  // The fake finishes the turn after its last call, so the turn ends after the results arrive.
  const completed = await waitFor("the agent turn to complete", () =>
    events.find((event) => event.type === "turn-completed"),
  );
  check("The turn completes after its calls are answered", completed.type === "turn-completed");
} catch (error) {
  report.error = redactText(error instanceof Error ? (error.stack ?? error.message) : String(error));
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
