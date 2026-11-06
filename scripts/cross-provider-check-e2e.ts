// Checks the cross-provider check: a final answer that its request flags (the marker word `verify` or
// `verifique`, or a numeric question answered with no tool) is checked by a provider other than the
// agent's own, with a tool-less generation. A disagreeing check appends an abstention note that lists
// the gaps; an agreeing one, or a check that cannot run, leaves the answer as it is.
// Runs the real agent service on a temporary profile. The agent runs on a Codex stand-in, and the check
// runs on Claude: the real `ClaudeAgentClient` talks to a stand-in `claude` executable, which answers
// the check with the verdict that the scripts wrote for the answer it quotes, or fails it.
// No provider, account or network is used. Writes .openbot-build/cross-provider-check-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, defaultProviderModel, latestTurnAnswer } from "@openbot/contracts/ipc";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { crossProviderTrigger } from "../src/backend/agent/cross-provider-check";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cross-provider-check-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-cross-provider-check-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeClaude = join(root, "claude");
const answersFile = join(root, "answers.json");
const verdictsFile = join(root, "verdicts.json");
const codexLog = join(root, "codex-turns.jsonl");
const claudeLog = join(root, "claude-checks.jsonl");
const CHECK_MARKER = "OpenBot cross-provider check, not a message from the user";
const NOTE_MARKER = "OpenBot cross-check: I am not sure of this answer.";
const FAIL = "__fail__";
const PRIMARY = defaultProviderModel("claude");
const BACKUP = PRIMARY === "claude-sonnet-5-5" ? "claude-opus-5-5" : "claude-sonnet-5-5";

// Before the service modules load: the stores and the CLI search read these.
process.env.HOME = home;
process.env.OPENBOT_CLAUDE_PATH = fakeClaude;
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.CODEX_HOME = join(home, ".codex");
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { ClaudeAgentClient } = await import("../src/backend/claude-client");
const { CodexAppServerClient } = await import("../src/backend/app-server-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/** The requests, the answers that the agent gives, and the verdict of the check of each answer. */
const CASES = {
  disagree: {
    request: "Verify the file count in the project. case:disagree",
    answer: "There are 12 files in the project.",
    verdict: { agrees: false, gaps: ["The answer gives 12 files, and no listing in it shows that count."] },
  },
  agree: {
    request: "Verifique a capital do Brasil. case:agree",
    answer: "The capital of Brazil is Brasilia.",
    verdict: { agrees: true, gaps: [] },
  },
  numeric: {
    request: "How many files are in the project? case:numeric",
    answer: "There are 7 files in the project.",
    verdict: { agrees: false, gaps: ["The answer gives 7 files, and no listing in it shows that count."] },
  },
  plain: {
    request: "What is the capital of Brazil? case:plain",
    answer: "Brasilia is the capital.",
    verdict: { agrees: false, gaps: ["This answer must not be checked at all."] },
  },
  unavailable: {
    request: "Verify the total of the invoice. case:unavailable",
    answer: "The total is 40 dollars.",
    verdict: FAIL,
  },
} as const;

type CaseId = keyof typeof CASES;

// The stand-in for the Codex app-server. It answers each turn with the answer of the case that its
// message names, and logs the turn. It makes no tool call, so a numeric question reaches the check.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const ANSWERS = ${JSON.stringify(answersFile)};
const LOG = ${JSON.stringify(codexLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answerFor = (text) => {
  const caseId = /case:([a-z-]+)/.exec(text)?.[1];
  const answers = fs.existsSync(ANSWERS) ? JSON.parse(fs.readFileSync(ANSWERS, "utf8")) : {};
  return caseId !== undefined && answers[caseId] !== undefined ? answers[caseId] : "Done.";
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
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      fs.appendFileSync(LOG, JSON.stringify({ threadId: params.threadId, turnId, text }) + "\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const item = { type: "agentMessage", id: "message-" + turnId, text: answerFor(text), phase: "final_answer" };
      write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
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

// The stand-in for the Claude CLI. It answers the check with the verdict of the answer that the check
// quotes, or fails it with the CLI's report of an overload, and logs each check it receives.
const STAND_IN_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.302 (Claude Code)\\n");
  process.exit(0);
}
const option = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(name + "="));
  if (index < 0) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
};
const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
let model = option("--model");
const project = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(project, { recursive: true });
const transcript = require("node:path").join(project, sessionId + ".jsonl");
const previous = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const recorded = new Set(previous.map((row) => row.uuid));
let parentUuid = previous.at(-1)?.uuid ?? null;
const record = (message) => {
  if (recorded.has(message.uuid)) return;
  const row = { ...message, parentUuid, sessionId, timestamp: new Date().toISOString(), isSidechain: false };
  fs.appendFileSync(transcript, JSON.stringify(row) + "\\n");
  recorded.add(row.uuid);
  parentUuid = row.uuid;
};
const write = (message) => {
  if (message.type === "assistant") record(message);
  process.stdout.write(JSON.stringify(message) + "\\n");
};
const result = (fields) =>
  write({ type: "result", subtype: "success", session_id: sessionId, uuid: randomUUID(), duration_ms: 1,
    duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [], modelUsage: {}, ...fields });
const assistant = (text) =>
  write({ type: "assistant", message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model,
    content: [{ type: "text", text }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
const VERDICTS = ${JSON.stringify(verdictsFile)};
const LOG = ${JSON.stringify(claudeLog)};
const CHECK = ${JSON.stringify(CHECK_MARKER)};
const FAIL = ${JSON.stringify(FAIL)};
const turn = (message) => {
  record(message);
  const input = JSON.stringify(message);
  if (!input.includes(CHECK)) {
    assistant("Done.");
    result({ is_error: false, result: "Done." });
    return;
  }
  const verdicts = fs.existsSync(VERDICTS) ? JSON.parse(fs.readFileSync(VERDICTS, "utf8")) : {};
  const quoted = Object.keys(verdicts).find((key) => input.includes(key));
  const verdict = quoted === undefined ? { agrees: true, gaps: [] } : verdicts[quoted];
  fs.appendFileSync(LOG, JSON.stringify({ model, quoted: quoted ?? null, verdict }) + "\\n");
  if (verdict === FAIL) {
    result({ is_error: true, result: "API Error: 529 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"overloaded_error\\"}}" });
    return;
  }
  const text = JSON.stringify(verdict);
  assistant(text);
  result({ is_error: false, result: text });
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      if (message.request?.subtype === "set_model") model = message.request.model ?? model;
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    } else if (message.type === "user") turn(message);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

/**
 * The real Claude client. Only the account, usage and model reads are answered here: the real ones
 * run `claude auth status` or a probe query.
 */
class ClaudeStandIn extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "claude";
  readonly contextCompaction = "native";
  readonly #real: InstanceType<typeof ClaudeAgentClient>;
  readonly readHistory: ReadProviderHistory;
  readonly toolAnswers = new Map<RequestId, unknown>();

  constructor(cli: ClaudeCliInfo) {
    super();
    this.#real = new ClaudeAgentClient(cli);
    this.readHistory = this.#real.readHistory;
    this.#real.on("notification", (notification) => this.emit("notification", notification));
    this.#real.on("request", (request) => this.emit("request", request));
    this.#real.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.#real.on("exit", (error) => this.emit("exit", error));
  }

  get running(): boolean {
    return this.#real.running;
  }

  start(): void {
    this.#real.start();
  }

  stop() {
    return this.#real.stop();
  }

  canReleaseProcess = () => this.#real.canReleaseProcess();

  releaseThread(externalThreadId: string) {
    return this.#real.releaseThread(externalThreadId);
  }

  releaseIdleThreads() {
    return this.#real.releaseIdleThreads();
  }

  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number) {
    if (!this.#real.running) return this.#real.request(method, params, decoder, timeoutMs);
    switch (method) {
      case "account/read":
        return providerSync(() => decoder({ account: { type: "claude", email: "claude@example.com" } }));
      case "account/rateLimits/read":
        return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
      case "model/list":
        return providerSync(() =>
          decoder({
            data: [
              { model: PRIMARY, displayName: "Primary" },
              { model: BACKUP, displayName: "Backup" },
            ],
          }),
        );
      default:
        return this.#real.request(method, params, decoder, timeoutMs);
    }
  }

  notify(): void {
    this.#real.notify();
  }

  respond(id: RequestId, result: unknown): void {
    this.#real.respond(id, result);
  }

  respondError(id: RequestId, error: Parameters<AgentClient["respondError"]>[1]): void {
    this.#real.respondError(id, error);
  }
}

interface Check {
  name: string;
  passed: boolean;
  detail?: unknown;
}

const report: {
  checks: Check[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = {
  checks: [],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
}

function readLog<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The check's generations on the Claude stand-in, in order: the quoted answer and the verdict it gave. */
interface LoggedCheck {
  model: string;
  quoted: string | null;
  verdict: unknown;
}

const checkEntries = () => readLog<LoggedCheck>(claudeLog);

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
await writeFile(fakeClaude, STAND_IN_CLAUDE, { mode: 0o755 });
writeFileSync(
  answersFile,
  JSON.stringify(
    Object.fromEntries(Object.values(CASES).map((entry) => [entry.request.split("case:")[1], entry.answer])),
  ),
);
writeFileSync(
  verdictsFile,
  JSON.stringify(Object.fromEntries(Object.values(CASES).map((entry) => [entry.answer, entry.verdict]))),
);

const database = new OpenBotDatabase(userData);
const events: AgentEvent[] = [];
/** The lines that the cross-provider check logs, as the log writes them. */
const checkLog: string[] = [];
const removeTee = teeLogLines(["cross-provider-check"], (line) => checkLog.push(line));

const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex" && provider !== "claude"),
  clientFactory: (provider, cli) => {
    if (provider === "codex") return new CodexAppServerClient(cli.executable, 30000);
    return new ClaudeStandIn(cli);
  },
});
service.on("event", (event) => events.push(event));

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the cross-provider check.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s first turn`, () =>
    service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
  );
  return agent;
}

/** Sends a message to the agent's own chat. Answers its delivery id. */
async function send(agentId: string, text: string): Promise<string> {
  const receipt = await runCauseEffect(service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

/** Waits for the delivery to end, and answers its status. */
function settled(deliveryId: string) {
  return waitFor(`delivery ${deliveryId} to end`, () => {
    const value = mailbox.getDelivery(deliveryId)?.delivery.status;
    return ended(value) ? value : null;
  });
}

/** Sends one case's request, waits for its turn to end, and answers the turn's final answer and id. */
async function ask(agentId: string, caseId: CaseId) {
  const mark = events.length;
  const deliveryId = await send(agentId, CASES[caseId].request);
  assert.equal(await settled(deliveryId), "completed", `${caseId} completes.`);
  const completed = await waitFor(`${caseId}'s turn to complete`, () => {
    const found = events.slice(mark).find((event) => event.type === "turn-completed" && event.agentId === agentId);
    return found?.type === "turn-completed" ? found : null;
  });
  const threadId = store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  const messages = database.readConversation(agentId, threadId).messages;
  return { answer: latestTurnAnswer(messages, completed.turnId)?.text ?? "" };
}

function errorsFor(agentId: string, since: number) {
  return events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);
}

async function check(name: string, run: () => Promise<unknown>) {
  try {
    report.checks.push({ name, passed: true, detail: await run() });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

try {
  await runCauseEffect(service.initialize());
  const agent = await createAgent("Checker");

  // The policy, as the turn lifecycle uses it: a marker always asks, a numeric question asks only with no
  // tool, and any other request never does.
  await check("the trigger is the marker word or a numeric question answered with no tool", async () => {
    const marker = crossProviderTrigger({ request: "Verifique o relatório.", usedTool: true });
    const numericNoTool = crossProviderTrigger({ request: "How many files are there?", usedTool: false });
    const numericWithTool = crossProviderTrigger({ request: "How many files are there?", usedTool: true });
    const unverified = crossProviderTrigger({ request: "The data is unverified.", usedTool: false });
    const plain = crossProviderTrigger({ request: "What is the capital of Brazil?", usedTool: false });
    assert.equal(marker, "marker");
    assert.equal(numericNoTool, "numeric");
    assert.equal(numericWithTool, null, "A numeric question with a tool call is not checked.");
    assert.equal(unverified, null, "The marker needs a whole word.");
    assert.equal(plain, null, "A question with no numeric cue is not checked.");
    return { marker, numericNoTool, numericWithTool, unverified, plain };
  });

  await check(
    "a flagged turn that the second provider disagrees with gets an abstention note listing the gaps",
    async () => {
      const checksBefore = checkEntries().length;
      const { answer } = await ask(agent.id, "disagree");
      const original = CASES.disagree.answer;
      const gap = CASES.disagree.verdict.gaps[0];
      assert.ok(answer.startsWith(`${original}\n\n${NOTE_MARKER}`), "The note follows the answer.");
      assert.ok(answer.endsWith(`- ${gap}`), "The note lists the gap that the check named.");
      const ran = checkEntries().slice(checksBefore);
      assert.equal(ran.length, 1, "The check runs once.");
      assert.equal(ran[0]?.quoted, original, "The check quotes the answer.");
      return { answer, check: ran[0] };
    },
  );

  await check("a flagged turn that the second provider agrees with gets no note", async () => {
    const checksBefore = checkEntries().length;
    const { answer } = await ask(agent.id, "agree");
    assert.equal(answer, CASES.agree.answer, "The answer is unchanged.");
    const ran = checkEntries().slice(checksBefore);
    assert.equal(ran.length, 1, "The check runs once.");
    assert.equal(ran[0]?.quoted, CASES.agree.answer);
    return { answer, check: ran[0] };
  });

  await check("a numeric question answered with no tool is flagged and checked", async () => {
    const checksBefore = checkEntries().length;
    const { answer } = await ask(agent.id, "numeric");
    assert.ok(answer.startsWith(`${CASES.numeric.answer}\n\n${NOTE_MARKER}`), "The note follows the answer.");
    assert.equal(checkEntries().slice(checksBefore).length, 1, "The check runs once.");
    return { answer };
  });

  await check("an unflagged turn triggers no second-provider call", async () => {
    const checksBefore = checkEntries().length;
    const { answer } = await ask(agent.id, "plain");
    assert.equal(answer, CASES.plain.answer, "The answer is unchanged.");
    assert.equal(checkEntries().length, checksBefore, "No check runs.");
    return { answer };
  });

  await check("when the second provider is unavailable the answer is unchanged and the check says so", async () => {
    const checksBefore = checkEntries().length;
    const logMark = checkLog.length;
    const since = events.length;
    const { answer } = await ask(agent.id, "unavailable");
    assert.equal(answer, CASES.unavailable.answer, "The answer is unchanged.");
    const attempts = checkEntries().slice(checksBefore);
    assert.equal(attempts.length, 1, "The check was attempted once.");
    assert.equal(attempts[0]?.verdict, FAIL, "The second provider failed the check.");
    const said = checkLog.slice(logMark).find((line) => line.includes("did not run"));
    assert.ok(said, "The log says the check did not run.");
    assert.equal(errorsFor(agent.id, since).length, 0, "No error is shown for the check.");
    return { answer, logLine: said };
  });

  report.passed = report.checks.every((entry) => entry.passed);
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  removeTee();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
