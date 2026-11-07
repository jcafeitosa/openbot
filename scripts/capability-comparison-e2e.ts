// Compares six agent capabilities. Each capability runs twice on the production path of the real agent
// service: once with the input that triggers it ("enabled") and once with the input that does not
// ("disabled"). The runs use a temporary profile, a fake Codex app-server and, for the cross-provider
// check only, a fake Claude CLI. No provider, account or network is used.
//
// None of the six capabilities has an on/off setting. Each is an unconditional hook in the tool router,
// the turn lifecycle or the memory review, so the comparison is trigger versus no trigger, and each
// assertion reads an observable artifact (a card, a prompt, a note, a second call, a turn, a memory).
//
// Each capability runs in its own child process with its own profile. Run once:
//   bun scripts/capability-comparison-e2e.ts
// Writes .openbot-build/capability-comparison-e2e/report.json.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@openbot/contracts/ipc";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const SCRIPT = fileURLToPath(import.meta.url);
const OUT = resolve(import.meta.dirname, "../.openbot-build/capability-comparison-e2e");
const CALL_MARK = "DRY-RUN-CALL";
const PLAN_NOTE = "OpenBot note, not a message from the user";
const PLAN_CHECK_MARK = "OpenBot plan check, not a message from the user";
const REFLECTION_MARK = "You learn from one failed turn of the agent";
const CROSS_CHECK_MARK = "OpenBot cross-provider check, not a message from the user";
const ABSTENTION_NOTE = "OpenBot cross-check: I am not sure of this answer.";
const RECURRENCE_NOTE = "OpenBot note, not a message from the user.";
const TERMINAL_STATUSES = ["completed", "failed", "interrupted", "cancelled"];
const PLAN_STEPS: [string, string][] = [["Write the report", "completed"]];

const CAPABILITIES = [
  {
    id: "dry-run-gate",
    name: "Dry-run gate",
    control: "none: unconditional hook in the tool router (dry-run-policy)",
    compared: "irreversible forget_memory vs reversible search_memories",
  },
  {
    id: "exact-tool",
    name: "Exact-tool guidance",
    control: "none: unconditional delivery hook (exact-tool-policy)",
    compared: "arithmetic request vs plain request, the turn input of each",
  },
  {
    id: "recurrence",
    name: "Recurrence note",
    control: "none: unconditional delivery hook (turn-ledger)",
    compared: "3 failed turns vs 2 failed turns, then the next prompt",
  },
  {
    id: "cross-provider",
    name: "Cross-provider check",
    control: "none: unconditional turn hook (turn-lifecycle)",
    compared: "flagged request with a disagreeing check vs unflagged request",
  },
  {
    id: "plan-verifier",
    name: "Plan verifier",
    control: "none: unconditional turn hook (verifyPlan); the verdict is the only variable",
    compared: "gap verdict vs approved verdict, the turns that follow each",
  },
  {
    id: "memory-reflection",
    name: "Memory reflection",
    control: "none: unconditional turn-end hook (memory review); the turn outcome is the only variable",
    compared: "failed turn vs completed turn, the reflections and saved lessons of each",
  },
] as const;

type CapabilityId = (typeof CAPABILITIES)[number]["id"];

type Scalar = string | number | boolean | null;
/** The values that a variant observes. */
type Observed = Record<string, Scalar>;

interface Variant {
  label: string;
  signature: string;
  passed: boolean;
  observed: Observed;
}

interface Pair {
  enabled: Variant;
  disabled: Variant;
}

interface CapabilityResult {
  id: CapabilityId;
  name: string;
  control: string;
  compared: string;
  enabled: Variant | null;
  disabled: Variant | null;
  differs: boolean;
  passed: boolean;
  error?: string;
}

/** One line of the fake Codex log. */
interface FakeEntry {
  method: string;
  threadId?: string;
  turnId?: string;
  note?: boolean;
  text?: string;
  tool?: string;
  result?: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error?: unknown;
}

/** A JSON-RPC message from the service to the fake Codex app-server. */
interface Rpc {
  id?: number | string;
  method?: string;
  params?: { threadId?: string; turnId?: string; input?: { text?: string }[] };
  result?: unknown;
  error?: unknown;
}

/** One turn of a plan script: its steps, its answer, and the verdict that the check gives that answer. */
interface PlanTurn {
  steps?: [string, string][];
  answer?: string;
  verdict?: unknown;
}

/** A verdict that the fake plan check gives for the answer that it quotes. */
interface VerdictRow {
  answer: string;
  verdict: unknown;
}

/** An answer that the fake Codex gives for the case that its message names. */
interface CaseRow {
  case: string;
  answer: string;
}

/** The reply that the fake Codex gives to a reflection, after a delay. */
interface ControlFile {
  answer: string;
  delayMs: number;
}

/** The arguments of one dry-run tool call, as the chat message encodes them. */
type ToolArgs = Record<string, Scalar>;
type ToolCall = { __tool: string } & ToolArgs;

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

function readRows<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = JSON.parse(readFileSync(path, "utf8"));
  return rows;
}

function readControl(path: string): ControlFile {
  if (!existsSync(path)) return { answer: "{}", delayMs: 5 };
  const control: ControlFile = JSON.parse(readFileSync(path, "utf8"));
  return control;
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): T => JSON.parse(line));
}

function variant(label: string, signature: string, passed: boolean, observed: Observed): Variant {
  return { label, signature, passed, observed };
}

const sleep = (ms: number) => {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
};

async function pollFor(read: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

/** The fake Codex app-server. It runs in a child process that the service starts, from the wrapper script. */
async function fakeCodexMain(dir: string): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.160.1\n");
    return;
  }
  const logPath = join(dir, "codex.jsonl");
  const controlPath = join(dir, "control.json");
  const planVerdictsPath = join(dir, "plan-verdicts.json");
  const casesPath = join(dir, "answers.json");
  const log = (entry: unknown): void => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  process.stdout.on("error", () => process.exit(0));
  const config = {
    config: { mcp_servers: {} },
    layers: [
      {
        name: { type: "user", file: "/fake/.codex/config.toml", profile: null },
        version: "1",
        config: { mcp_servers: {} },
      },
    ],
  };
  const waiting = new Map<string, { threadId: string; turnId: string; tool: string }>();
  const scripts = new Map<string, PlanTurn[]>();
  let threads = 0;
  let turns = 0;

  const finishWith = (threadId: string, turnId: string, text: string): void => {
    const item = { type: "agentMessage", id: `message-${turnId}`, text, phase: "final_answer" };
    write({ method: "item/completed", params: { threadId, turnId, item } });
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  };
  const commandFailure = (threadId: string, turnId: string): void => {
    const command = {
      id: `command-${turnId}`,
      type: "commandExecution",
      command: "deploy",
      status: "failed",
      exitCode: 1,
    };
    write({
      method: "item/started",
      params: { threadId, turnId, item: { ...command, status: "inProgress", exitCode: null } },
    });
    write({ method: "item/completed", params: { threadId, turnId, item: command } });
  };
  // A provider error with one failed command: the cause that the recurrence note counts.
  const providerFailure = (threadId: string, turnId: string): void => {
    commandFailure(threadId, turnId);
    const error = { message: "Provider internal error", codexErrorInfo: "provider_internal_error" };
    write({ method: "error", params: { threadId, turnId, message: error.message, error } });
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } });
  };
  // A turn that fails through a failed command, with no provider error.
  const toolFailure = (threadId: string, turnId: string): void => {
    commandFailure(threadId, turnId);
    const item = { type: "agentMessage", id: `message-${turnId}`, text: "Failed.", phase: "final_answer" };
    write({ method: "item/completed", params: { threadId, turnId, item } });
    write({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "failed", error: { message: "The deploy failed." } } },
    });
  };
  const caseAnswer = (text: string): string | undefined => {
    const id = /case:([a-z-]+)/.exec(text)?.[1];
    return readRows<CaseRow>(casesPath).find((row) => row.case === id)?.answer;
  };

  const startTurn = (threadId: string, turnId: string, text: string): void => {
    if (text.includes(PLAN_CHECK_MARK)) {
      const row = readRows<VerdictRow>(planVerdictsPath).find((candidate) => text.includes(candidate.answer));
      const verdict = row?.verdict ?? { approved: true, gaps: [] };
      log({ method: "verifier", threadId, turnId, text });
      finishWith(threadId, turnId, JSON.stringify(verdict));
      return;
    }
    if (text.includes(REFLECTION_MARK)) {
      log({ method: "reflection", threadId, turnId, text });
      const control = readControl(controlPath);
      setTimeout(() => finishWith(threadId, turnId, control.answer), control.delayMs);
      return;
    }
    const isNote = text.includes(PLAN_NOTE);
    const call = [...text.matchAll(/<<ARGS([A-Za-z0-9+/=]*)ARGS>>/g)].at(-1);
    if (text.includes(CALL_MARK) && call) {
      log({ method: "turn", threadId, turnId, note: isNote, text });
      const decoded: ToolCall = JSON.parse(Buffer.from(call[1] ?? "", "base64").toString("utf8"));
      const { __tool, ...args } = decoded;
      const id = `tool-${turnId}`;
      waiting.set(id, { threadId, turnId, tool: __tool });
      write({
        id,
        method: "item/tool/call",
        params: { threadId, turnId, callId: `call-${turnId}`, namespace: "openbot", tool: __tool, arguments: args },
      });
      return;
    }
    if (text.includes("[[FAIL]]")) {
      log({ method: "turn", threadId, turnId, note: isNote, text });
      setTimeout(() => providerFailure(threadId, turnId), 20);
      return;
    }
    if (text.includes("FAIL_NOW")) {
      log({ method: "turn", threadId, turnId, note: isNote, text });
      setTimeout(() => toolFailure(threadId, turnId), 20);
      return;
    }
    if (!isNote) {
      const named = /<<PLAN([\s\S]*?)PLAN>>/.exec(text);
      const planTurns: PlanTurn[] = named ? JSON.parse(named[1] ?? "[]") : [];
      const rows = readRows<VerdictRow>(planVerdictsPath);
      for (const turn of planTurns) {
        if (turn.answer !== undefined && turn.verdict !== undefined) {
          rows.push({ answer: turn.answer, verdict: turn.verdict });
        }
      }
      writeFileSync(planVerdictsPath, JSON.stringify(rows));
      scripts.set(threadId, planTurns);
    }
    const script: PlanTurn = scripts.get(threadId)?.shift() ?? {};
    log({ method: "turn", threadId, turnId, note: isNote, text });
    const steps = script.steps ?? [];
    if (steps.length > 0) {
      write({
        method: "turn/plan/updated",
        params: { threadId, turnId, plan: steps.map(([step, status]) => ({ step, status })) },
      });
    }
    finishWith(threadId, turnId, script.answer ?? caseAnswer(text) ?? "Done.");
  };

  const answer = (message: Rpc): void => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? "";
    const respond = (result: unknown): void => write({ id: message.id, result });
    switch (message.method) {
      case "initialize":
        respond({});
        break;
      case "account/read":
        respond({ account: { type: "chatgpt", email: "codex@example.com" } });
        break;
      case "account/rateLimits/read":
        respond({ rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null });
        break;
      case "model/list":
        respond({
          data: [
            { model: "gpt-6-luna", displayName: "GPT-6 Luna" },
            { model: "gpt-6-astra", displayName: "GPT-6 Astra" },
          ],
        });
        break;
      case "plugin/list":
        respond({ marketplaces: [] });
        break;
      case "config/read":
        respond(config);
        break;
      case "config/batchWrite":
        respond({});
        break;
      case "thread/start":
        respond({ thread: { id: `thread-${++threads}`, turns: [] } });
        break;
      case "thread/resume":
        respond({ thread: { id: threadId, turns: [] } });
        break;
      case "thread/unsubscribe":
        respond({ status: "Unsubscribed" });
        break;
      case "thread/turns/list":
      case "thread/items/list":
        respond({ data: [], nextCursor: null });
        break;
      case "thread/read":
        respond({ thread: { id: threadId, turns: [] } });
        break;
      case "turn/start": {
        const turnId = `turn-${process.pid}-${++turns}`;
        const text = (params.input ?? []).map((item) => item.text ?? "").join("\n");
        respond({ turn: { id: turnId, status: "inProgress", items: [] } });
        write({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
        startTurn(threadId, turnId, text);
        break;
      }
      case "turn/interrupt":
        respond({});
        write({ method: "turn/completed", params: { threadId, turn: { id: params.turnId, status: "interrupted" } } });
        break;
      default:
        write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  };

  const handle = (message: Rpc): void => {
    if (message.method !== undefined && message.id !== undefined) {
      answer(message);
      return;
    }
    if (message.method !== undefined || message.id === undefined) return;
    const pending = waiting.get(String(message.id));
    if (!pending) return;
    waiting.delete(String(message.id));
    log({
      method: "tool-result",
      turnId: pending.turnId,
      tool: pending.tool,
      result: message.result ?? null,
      error: message.error ?? null,
    });
    finishWith(pending.threadId, pending.turnId, "Done.");
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message: Rpc = JSON.parse(line);
        handle(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
}

/** One frame that the fake Claude CLI reads from its input. */
interface ClaudeInput {
  type?: string;
  uuid?: string;
  request_id?: string;
  request?: { subtype?: string; model?: string };
}

/** The fake Claude CLI. It answers a cross-provider check with the verdict of the answer that the check quotes. */
async function fakeClaudeMain(dir: string): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write("2.1.302 (Claude Code)\n");
    return;
  }
  const args = process.argv.slice(2);
  const option = (name: string): string | null => {
    const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index < 0) return null;
    return args[index] === name ? (args[index + 1] ?? null) : (args[index]?.slice(name.length + 1) ?? null);
  };
  const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
  let model: string | null = option("--model");
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(dir, "claude-config");
  const project = join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${sessionId}.jsonl`);
  const previous = readLines<{ uuid: string }>(transcript);
  const recorded = new Set(previous.map((row) => row.uuid));
  let parentUuid: string | null = previous.at(-1)?.uuid ?? null;
  const record = (message: object) => {
    const uuid = "uuid" in message && typeof message.uuid === "string" ? message.uuid : randomUUID();
    if (recorded.has(uuid)) return;
    const row = { ...message, uuid, parentUuid, sessionId, timestamp: new Date().toISOString(), isSidechain: false };
    appendFileSync(transcript, `${JSON.stringify(row)}\n`);
    recorded.add(uuid);
    parentUuid = uuid;
  };
  const emit = (message: object): void => {
    if ("type" in message && message.type === "assistant") record(message);
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const result = (text: string): void => {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      session_id: sessionId,
      uuid: randomUUID(),
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      permission_denials: [],
      modelUsage: {},
    });
  };
  const assistant = (text: string): void => {
    emit({
      type: "assistant",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    });
  };
  const checkLog = join(dir, "claude-checks.jsonl");
  const verdictsPath = join(dir, "claude-verdicts.json");
  const turn = (message: ClaudeInput): void => {
    record(message);
    const input = JSON.stringify(message);
    if (!input.includes(CROSS_CHECK_MARK)) {
      assistant("Done.");
      result("Done.");
      return;
    }
    const row = readRows<VerdictRow>(verdictsPath).find((candidate) => input.includes(candidate.answer));
    const verdict = row?.verdict ?? { agrees: true, gaps: [] };
    appendFileSync(checkLog, `${JSON.stringify({ model, quoted: row?.answer ?? null, verdict })}\n`);
    const text = JSON.stringify(verdict);
    assistant(text);
    result(text);
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message: ClaudeInput & { message?: unknown } = JSON.parse(line);
        if (message.type === "control_request") {
          if (message.request?.subtype === "set_model") model = message.request.model ?? model;
          emit({
            type: "control_response",
            response: { subtype: "success", request_id: message.request_id, response: {} },
          });
        } else if (message.type === "user") {
          turn(message);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// Dynamic on purpose: the Codex and Claude processes and the stores read HOME and the provider paths when
// their modules load, so the child process sets that environment before these imports run.
/** The production backend modules, loaded after the profile environment is set. */
async function loadBackend() {
  const { AgentService } = await import("../src/backend/agent-service");
  const { AgentStore } = await import("../src/backend/agent-store");
  const { ClaudeAgentClient } = await import("../src/backend/claude-client");
  const { CodexAppServerClient } = await import("../src/backend/app-server-client");
  const { runCauseEffect } = await import("../src/backend/effect-boundary");
  const { MailboxStore } = await import("../src/backend/mailbox-store");
  const { OpenBotDatabase } = await import("../src/backend/openbot-database");
  const { providerSync } = await import("../src/backend/provider-client-effects");
  const { EXACT_TOOL_GUIDANCE } = await import("../src/backend/agent/exact-tool-policy");
  const { AGENT_PROVIDERS, defaultProviderModel, latestTurnAnswer } = await import("@openbot/contracts/ipc");
  const { Effect } = await import("effect");
  return {
    AgentService,
    AgentStore,
    ClaudeAgentClient,
    CodexAppServerClient,
    runCauseEffect,
    MailboxStore,
    OpenBotDatabase,
    providerSync,
    EXACT_TOOL_GUIDANCE,
    AGENT_PROVIDERS,
    defaultProviderModel,
    latestTurnAnswer,
    Effect,
  };
}

type Backend = Awaited<ReturnType<typeof loadBackend>>;
type ServiceOptions = ConstructorParameters<Backend["AgentService"]>[0];
type Service = InstanceType<Backend["AgentService"]>;

interface Approval {
  requestId: string | number;
  reason: string | null;
}

interface Session {
  b: Backend;
  dir: string;
  service: Service;
  store: InstanceType<Backend["AgentStore"]>;
  mailbox: InstanceType<Backend["MailboxStore"]>;
  database: InstanceType<Backend["OpenBotDatabase"]>;
  events: AgentEvent[];
  approvals: Approval[];
}

function browserHost(b: Backend): AgentBrowserHost {
  const unused = () => b.Effect.die(new Error("Not used by this check."));
  return {
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
    close: () => b.Effect.void,
    clearAgentSession: () => b.Effect.void,
    shareTab: () => undefined,
    unshareThread: () => undefined,
    agentTab: () => null,
  };
}

/** The Claude client of the cross-provider check: the real client, with the account and model reads answered here. */
function defineClaudeStandIn(b: Backend, models: { primary: string; backup: string }) {
  return class ClaudeStandIn extends EventEmitter<ClientEvents> implements AgentClient {
    readonly provider = "claude";
    readonly contextCompaction = "native";
    readonly #real: InstanceType<Backend["ClaudeAgentClient"]>;
    readonly readHistory: ReadProviderHistory;
    readonly toolAnswers = new Map<RequestId, unknown>();

    constructor(cli: ClaudeCliInfo) {
      super();
      this.#real = new b.ClaudeAgentClient(cli);
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
          return b.providerSync(() => decoder({ account: { type: "claude", email: "claude@example.com" } }));
        case "account/rateLimits/read":
          return b.providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
        case "model/list":
          return b.providerSync(() =>
            decoder({
              data: [
                { model: models.primary, displayName: "Primary" },
                { model: models.backup, displayName: "Backup" },
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
  };
}

function serviceExtras(id: CapabilityId, b: Backend): Partial<ServiceOptions> {
  const notCodex = b.AGENT_PROVIDERS.filter((provider) => provider !== "codex");
  switch (id) {
    case "dry-run-gate":
      // Full access: an irreversible call still waits for the person's answer.
      return { offProviders: notCodex, approvalAutomation: { autoApproves: () => true } };
    case "memory-reflection":
      return { offProviders: notCodex, memoryReviewIdleMs: 60_000, memoryReviewInterval: () => 20 };
    case "cross-provider": {
      const primary = b.defaultProviderModel("claude");
      const backup = primary === "claude-sonnet-5-5" ? "claude-opus-5-5" : "claude-sonnet-5-5";
      const ClaudeStandIn = defineClaudeStandIn(b, { primary, backup });
      return {
        offProviders: b.AGENT_PROVIDERS.filter((provider) => provider !== "codex" && provider !== "claude"),
        clientFactory: (provider, cli) =>
          provider === "codex" ? new b.CodexAppServerClient(cli.executable, 30000) : new ClaudeStandIn(cli),
      };
    }
    default:
      return { offProviders: notCodex };
  }
}

function openSession(
  b: Backend,
  paths: { dir: string; userData: string; home: string },
  extras: Partial<ServiceOptions>,
): Session {
  const database = new b.OpenBotDatabase(paths.userData);
  const store = new b.AgentStore(paths.userData, paths.home, database);
  const mailbox = new b.MailboxStore(paths.userData, store.sharedRoot, store.database);
  const service = new b.AgentService({
    store,
    mailbox,
    browser: browserHost(b),
    preferredProvider: "codex",
    ...extras,
  });
  const session: Session = { b, dir: paths.dir, service, store, mailbox, database, events: [], approvals: [] };
  service.on("event", (event) => {
    session.events.push(event);
    if (event.type === "approval") {
      session.approvals.push({ requestId: event.approval.requestId, reason: event.approval.reason });
    }
  });
  return session;
}

const ended = (status: string | undefined) => status !== undefined && TERMINAL_STATUSES.includes(status);

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(25);
  }
}

async function createAgent(s: Session, name: string): Promise<string> {
  const agent = await s.b.runCauseEffect(
    s.service.createAgent({
      name,
      description: "Checks one capability of the agent runtime.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(
    `${name}'s first turn`,
    () => s.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)) || null,
  );
  return agent.id;
}

async function send(s: Session, agentId: string, text: string): Promise<string> {
  const receipt = await s.b.runCauseEffect(s.service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  if (!deliveryId) throw new Error("The message has no delivery.");
  return deliveryId;
}

function settleDelivery(s: Session, deliveryId: string): Promise<string> {
  return waitFor(`delivery ${deliveryId} to end`, () => {
    const status = s.mailbox.getDelivery(deliveryId)?.delivery.status;
    return status !== undefined && ended(status) ? status : null;
  });
}

function fakeEntries(dir: string): FakeEntry[] {
  return readLines<FakeEntry>(join(dir, "codex.jsonl"));
}

/** The text of the first turn that started after the mark and carries the token, or null. */
function turnSince(s: Session, mark: number, token: string): string | null {
  const entry = fakeEntries(s.dir)
    .slice(mark)
    .find((candidate) => candidate.method === "turn" && (candidate.text ?? "").includes(token));
  return entry?.text ?? null;
}

function toolResults(s: Session, mark: number, tool: string): FakeEntry[] {
  return fakeEntries(s.dir)
    .slice(mark)
    .filter((entry) => entry.method === "tool-result" && entry.tool === tool);
}

function memoryIds(s: Session, agentId: string): string[] {
  return s.database.connection
    .prepare("SELECT memory_id FROM projection_agent_memories WHERE agent_id = ?")
    .all(agentId)
    .map((row) => String(row.memory_id));
}

function ledgerRows(s: Session, agentId: string): number {
  const row = s.database.connection.prepare("SELECT COUNT(*) AS n FROM turn_outcomes WHERE agent_id = ?").get(agentId);
  return Number(row?.n ?? 0);
}

const callText = (tool: string, args: ToolArgs) =>
  `${CALL_MARK} <<ARGS${Buffer.from(JSON.stringify({ __tool: tool, ...args })).toString("base64")}ARGS>>`;

/** Sends one chat message that calls `tool`, and waits until the turn ends. */
async function callFromChat(s: Session, agentId: string, tool: string, args: ToolArgs): Promise<void> {
  await settleDelivery(s, await send(s, agentId, callText(tool, args)));
}

/** Dry-run gate: an irreversible call waits for the person's answer; a reversible call runs with no card. */
async function dryRunGate(s: Session): Promise<Pair> {
  const forgetter = await createAgent(s, "Gated");
  await callFromChat(s, forgetter, "remember", { text: "The deploy window is Tuesday." });
  const memoryId = memoryIds(s, forgetter)[0] ?? "";
  const cardsBefore = s.approvals.length;
  const logMark = fakeEntries(s.dir).length;
  const delivery = await send(s, forgetter, callText("forget_memory", { memoryId }));
  const card = await waitFor("the forget_memory approval card", () => s.approvals[cardsBefore]);
  const ranBeforeAnswer = toolResults(s, logMark, "forget_memory").length > 0;
  await s.b.runCauseEffect(s.service.respondToApproval({ requestId: card.requestId, decision: "decline" }));
  const declined = await waitFor(
    "the declined forget_memory result",
    () => toolResults(s, logMark, "forget_memory")[0],
  );
  await settleDelivery(s, delivery);
  const declinedText =
    declined.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(declined.error);
  const enabledCards = s.approvals.length - cardsBefore;
  const memoryKept = memoryIds(s, forgetter).includes(memoryId);
  const approvalRequired = declinedText.includes('"approval_required"');
  const enabled = variant(
    "irreversible forget_memory, declined",
    `cards=${enabledCards}; ran_before_answer=${ranBeforeAnswer}; declined_with_approval_required=${approvalRequired}`,
    enabledCards === 1 && !ranBeforeAnswer && memoryKept && approvalRequired && declined.result?.success !== true,
    { cards: enabledCards, ranBeforeAnswer, memoryKept, approvalRequired, declinedText },
  );

  const reader = await createAgent(s, "Reader");
  const cardsBeforeRead = s.approvals.length;
  const readMark = fakeEntries(s.dir).length;
  const readDelivery = await send(s, reader, callText("search_memories", { query: "deploy" }));
  const search = await waitFor("the search_memories result", () => toolResults(s, readMark, "search_memories")[0]);
  await settleDelivery(s, readDelivery);
  const disabledCards = s.approvals.length - cardsBeforeRead;
  const searchSucceeded = search.result?.success === true;
  const disabled = variant(
    "reversible search_memories",
    `cards=${disabledCards}; ran=true; success=${searchSucceeded}`,
    disabledCards === 0 && searchSucceeded,
    { cards: disabledCards, success: searchSucceeded },
  );
  return { enabled, disabled };
}

/** Exact-tool guidance: the arithmetic turn input carries the guidance line; the plain turn input does not. */
async function exactToolGuidance(s: Session): Promise<Pair> {
  const calculator = await createAgent(s, "Calculator");
  const armedMark = fakeEntries(s.dir).length;
  await settleDelivery(s, await send(s, calculator, "ARITH-REQUEST-ALPHA What is 0.1 + 0.2 and the total?"));
  const armedInput = turnSince(s, armedMark, "ARITH-REQUEST-ALPHA");
  const plainMark = fakeEntries(s.dir).length;
  await settleDelivery(s, await send(s, calculator, "PLAIN-REQUEST-BRAVO Summarize the meeting notes from Monday."));
  const plainInput = turnSince(s, plainMark, "PLAIN-REQUEST-BRAVO");
  const enabledGuidance = armedInput?.includes(s.b.EXACT_TOOL_GUIDANCE) ?? false;
  const disabledGuidance = plainInput?.includes(s.b.EXACT_TOOL_GUIDANCE) ?? false;
  return {
    enabled: variant(
      "arithmetic request",
      `turn_found=${armedInput !== null}; guidance_line=${enabledGuidance}`,
      armedInput !== null && enabledGuidance,
      { turnFound: armedInput !== null, guidanceLine: enabledGuidance },
    ),
    disabled: variant(
      "plain request",
      `turn_found=${plainInput !== null}; guidance_line=${disabledGuidance}`,
      plainInput !== null && !disabledGuidance,
      { turnFound: plainInput !== null, guidanceLine: disabledGuidance },
    ),
  };
}

/** Runs failing turns, then one follow-up. Reports whether the follow-up prompt carries the recurrence note. */
async function recurrenceRun(s: Session, name: string, failures: number) {
  const agent = await createAgent(s, name);
  await waitFor(`${name}'s first ledger row`, () => (ledgerRows(s, agent) >= 1 ? true : null));
  for (let index = 1; index <= failures; index++) {
    const status = await settleDelivery(s, await send(s, agent, `${name} fail-${index} deploy [[FAIL]]`));
    if (status !== "failed") throw new Error(`Failure ${index} of ${name} ended ${status}.`);
    await waitFor(`${name}'s ledger row ${index + 1}`, () => (ledgerRows(s, agent) >= index + 1 ? true : null));
  }
  const mark = fakeEntries(s.dir).length;
  const status = await settleDelivery(s, await send(s, agent, `${name} follow-up continue`));
  const prompt = turnSince(s, mark, `${name} follow-up`);
  return { status, promptFound: prompt !== null, note: prompt?.includes(RECURRENCE_NOTE) ?? false };
}

/** Recurrence note: the delivery after three failed turns carries the note; the one after two does not. */
async function recurrenceNote(s: Session): Promise<Pair> {
  const recurring = await recurrenceRun(s, "Recurring", 3);
  const twice = await recurrenceRun(s, "Twice", 2);
  return {
    enabled: variant(
      "three failed turns, then the next prompt",
      `note_in_next_prompt=${recurring.note}`,
      recurring.promptFound && recurring.note && recurring.status === "completed",
      { ...recurring },
    ),
    disabled: variant(
      "two failed turns, then the next prompt",
      `note_in_next_prompt=${twice.note}`,
      twice.promptFound && !twice.note && twice.status === "completed",
      { ...twice },
    ),
  };
}

/** Sends a request, waits for its turn to end, and answers the final answer of that turn. */
async function askCase(s: Session, agentId: string, text: string): Promise<string> {
  const mark = s.events.length;
  const status = await settleDelivery(s, await send(s, agentId, text));
  if (status !== "completed") throw new Error(`"${text}" ended ${status}.`);
  const completed = await waitFor(`the turn of "${text}" to complete`, () => {
    const found = s.events.slice(mark).find((event) => event.type === "turn-completed" && event.agentId === agentId);
    return found?.type === "turn-completed" ? found : null;
  });
  const threadId = s.store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  const messages = s.database.readConversation(agentId, threadId).messages;
  return s.b.latestTurnAnswer(messages, completed.turnId)?.text ?? "";
}

/** Cross-provider check: a flagged turn that the other provider disagrees with gets the note; an unflagged one does not. */
async function crossProvider(s: Session): Promise<Pair> {
  const disagreeAnswer = "There are 12 files in the project.";
  const plainAnswer = "Brasilia is the capital.";
  const cases: CaseRow[] = [
    { case: "disagree", answer: disagreeAnswer },
    { case: "plain", answer: plainAnswer },
  ];
  writeFileSync(join(s.dir, "answers.json"), JSON.stringify(cases));
  const verdicts: VerdictRow[] = [
    {
      answer: disagreeAnswer,
      verdict: { agrees: false, gaps: ["The answer gives 12 files, and no listing in it shows that count."] },
    },
    { answer: plainAnswer, verdict: { agrees: false, gaps: ["This answer must not be checked."] } },
  ];
  writeFileSync(join(s.dir, "claude-verdicts.json"), JSON.stringify(verdicts));
  const checkLog = join(s.dir, "claude-checks.jsonl");
  const checkCount = () => readLines<unknown>(checkLog).length;
  const checker = await createAgent(s, "Checker");

  const flaggedBefore = checkCount();
  const flagged = await askCase(s, checker, "Verify the file count in the project. case:disagree");
  const flaggedCalls = checkCount() - flaggedBefore;
  const unflaggedBefore = checkCount();
  const unflagged = await askCase(s, checker, "What is the capital of Brazil? case:plain");
  const unflaggedCalls = checkCount() - unflaggedBefore;

  const flaggedNote = flagged.includes(ABSTENTION_NOTE);
  const unflaggedNote = unflagged.includes(ABSTENTION_NOTE);
  return {
    enabled: variant(
      "flagged request, disagreeing check",
      `second_provider_calls=${flaggedCalls}; abstention_note=${flaggedNote}`,
      flaggedCalls === 1 && flaggedNote && flagged.startsWith(disagreeAnswer),
      { calls: flaggedCalls, abstentionNote: flaggedNote, answer: flagged },
    ),
    disabled: variant(
      "unflagged request",
      `second_provider_calls=${unflaggedCalls}; abstention_note=${unflaggedNote}`,
      unflaggedCalls === 0 && !unflaggedNote && unflagged === plainAnswer,
      { calls: unflaggedCalls, abstentionNote: unflaggedNote, answer: unflagged },
    ),
  };
}

function reflectionsSince(s: Session, mark: number): number {
  return fakeEntries(s.dir)
    .slice(mark)
    .filter((entry) => entry.method === "reflection").length;
}

/** Plan verifier: a gap verdict sends the plan back for one more turn; an approved verdict ends it. */
async function planVerifier(s: Session): Promise<Pair> {
  const gap = "The report step is marked done, but no report file was written.";
  const gapped = await createAgent(s, "Reporter");
  const gapMark = fakeEntries(s.dir).length;
  const gapTurns: PlanTurn[] = [
    { steps: PLAN_STEPS, answer: "Draft report is done.", verdict: { approved: false, gaps: [gap] } },
    { steps: PLAN_STEPS, answer: "Final report is written to report.md.", verdict: { approved: true, gaps: [] } },
  ];
  const gapStatus = await settleDelivery(
    s,
    await send(s, gapped, `Write the report. <<PLAN${JSON.stringify(gapTurns)}PLAN>>`),
  );
  const gapEntries = fakeEntries(s.dir).slice(gapMark);
  const continuations = gapEntries.filter((entry) => entry.method === "turn" && entry.note === true);

  const approver = await createAgent(s, "Approver");
  const approvedMark = fakeEntries(s.dir).length;
  const approvedTurns: PlanTurn[] = [
    { steps: PLAN_STEPS, answer: "Approved report is final.", verdict: { approved: true, gaps: [] } },
  ];
  const approvedStatus = await settleDelivery(
    s,
    await send(s, approver, `Write the report. <<PLAN${JSON.stringify(approvedTurns)}PLAN>>`),
  );
  const approvedEntries = fakeEntries(s.dir).slice(approvedMark);
  const approvedContinuations = approvedEntries.filter((entry) => entry.method === "turn" && entry.note === true);
  const approvedChecks = approvedEntries.filter((entry) => entry.method === "verifier").length;

  const gapNamed = continuations[0]?.text?.includes(gap) ?? false;
  return {
    enabled: variant(
      "gap verdict",
      `extra_turns=${continuations.length}; gap_named_in_next_turn=${gapNamed}`,
      gapStatus === "completed" && continuations.length === 1 && gapNamed,
      { status: gapStatus, extraTurns: continuations.length, gapNamed },
    ),
    disabled: variant(
      "approved verdict",
      `extra_turns=${approvedContinuations.length}; checks=${approvedChecks}`,
      approvedStatus === "completed" && approvedContinuations.length === 0 && approvedChecks >= 1,
      { status: approvedStatus, extraTurns: approvedContinuations.length, checks: approvedChecks },
    ),
  };
}

/** Memory reflection: a failed turn saves one lesson; a completed turn starts no reflection and saves none. */
async function memoryReflection(s: Session): Promise<Pair> {
  const control: ControlFile = {
    answer: JSON.stringify({
      operations: [
        { type: "add", text: "Check the deploy token in the vault before a deploy.", inclusion: "searchable" },
        { type: "add", text: "A second lesson that the reflection must not save.", inclusion: "searchable" },
      ],
    }),
    delayMs: 5,
  };
  writeFileSync(join(s.dir, "control.json"), JSON.stringify(control));
  const learner = await createAgent(s, "Learner");
  const failedMark = fakeEntries(s.dir).length;
  const failedStatus = await settleDelivery(s, await send(s, learner, "FAIL_NOW deploy the app."));
  await pollFor(() => reflectionsSince(s, failedMark) >= 1, 20_000);
  await pollFor(() => s.service.listMemories(learner).length >= 1, 10_000);
  await sleep(300);
  const enabledReflections = reflectionsSince(s, failedMark);
  const enabledSaved = s.service.listMemories(learner).length;

  const quiet = await createAgent(s, "Quiet");
  const completedMark = fakeEntries(s.dir).length;
  const completedStatus = await settleDelivery(s, await send(s, quiet, "Plain message."));
  await sleep(1500);
  const disabledReflections = reflectionsSince(s, completedMark);
  const disabledSaved = s.service.listMemories(quiet).length;

  return {
    enabled: variant(
      "failed turn",
      `status=${failedStatus}; reflections=${enabledReflections}; saved_lessons=${enabledSaved}`,
      failedStatus === "failed" && enabledReflections === 1 && enabledSaved === 1,
      { status: failedStatus, reflections: enabledReflections, savedLessons: enabledSaved },
    ),
    disabled: variant(
      "completed turn",
      `status=${completedStatus}; reflections=${disabledReflections}; saved_lessons=${disabledSaved}`,
      completedStatus === "completed" && disabledReflections === 0 && disabledSaved === 0,
      { status: completedStatus, reflections: disabledReflections, savedLessons: disabledSaved },
    ),
  };
}

const SCENARIOS: Record<CapabilityId, (s: Session) => Promise<Pair>> = {
  "dry-run-gate": dryRunGate,
  "exact-tool": exactToolGuidance,
  recurrence: recurrenceNote,
  "cross-provider": crossProvider,
  "plan-verifier": planVerifier,
  "memory-reflection": memoryReflection,
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A shell wrapper that runs this script in one of its fake modes, so the service spawns a fake provider. */
function writeWrapper(path: string, flag: string, dir: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(SCRIPT)} ${flag} --fake-dir ${shellQuote(dir)} "$@"\n`,
    { mode: 0o755 },
  );
}

async function runChild(capability: (typeof CAPABILITIES)[number], resultPath: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `openbot-capability-${capability.id}-`));
  const home = join(root, "home");
  const dir = join(root, "fake");
  const userData = join(root, "user-data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeWrapper(join(dir, "codex"), "--fake-codex", dir);
  writeWrapper(join(dir, "claude"), "--fake-claude", dir);
  // The service modules read the home folder and the provider paths when they load.
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.OPENBOT_CODEX_PATH = join(dir, "codex");
  process.env.OPENBOT_CLAUDE_PATH = join(dir, "claude");

  const result: CapabilityResult = {
    id: capability.id,
    name: capability.name,
    control: capability.control,
    compared: capability.compared,
    enabled: null,
    disabled: null,
    differs: false,
    passed: false,
  };
  let session: Session | null = null;
  try {
    const b = await loadBackend();
    session = openSession(b, { dir, userData, home }, serviceExtras(capability.id, b));
    await b.runCauseEffect(session.service.initialize());
    const pair = await SCENARIOS[capability.id](session);
    result.enabled = pair.enabled;
    result.disabled = pair.disabled;
    result.differs = pair.enabled.signature !== pair.disabled.signature;
    result.passed = pair.enabled.passed && pair.disabled.passed && result.differs;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    if (session) {
      await session.b.runCauseEffect(session.service.stop()).catch(() => {});
      session.database.close();
    }
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(result.passed ? 0 : 1);
}

const cell = (variantResult: Variant | null) =>
  variantResult ? `${variantResult.signature} (${variantResult.passed ? "as expected" : "UNEXPECTED"})` : "-";

function runParent(): void {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "openbot-capability-results-"));
  const results = CAPABILITIES.map((capability): CapabilityResult => {
    const resultPath = join(work, `${capability.id}.json`);
    const run = spawnSync(process.execPath, [SCRIPT, "--child", capability.id, resultPath], {
      stdio: "inherit",
      timeout: 900_000,
    });
    if (existsSync(resultPath)) {
      const parsed: CapabilityResult = JSON.parse(readFileSync(resultPath, "utf8"));
      return parsed;
    }
    return {
      id: capability.id,
      name: capability.name,
      control: capability.control,
      compared: capability.compared,
      enabled: null,
      disabled: null,
      differs: false,
      passed: false,
      error: `child process ended with status ${run.status ?? "none"} and signal ${run.signal ?? "none"}`,
    };
  });
  rmSync(work, { recursive: true, force: true });
  const passed = results.every((result) => result.passed);
  const reportPath = join(OUT, "report.json");
  const report = { passed, checkedAt: new Date().toISOString(), capabilities: results };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("| Capability | Enabled | Disabled | Comparison |\n|---|---|---|---|\n");
  for (const result of results) {
    const note = result.error ? ` (${result.error.split("\n")[0]})` : "";
    process.stdout.write(
      `| ${result.name} | ${cell(result.enabled)} | ${cell(result.disabled)} | ${result.passed ? "PASS" : "FAIL"}${note} |\n`,
    );
  }
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${reportPath}\n`);
  process.exitCode = passed ? 0 : 1;
}

const fakeDir = () => process.argv[process.argv.indexOf("--fake-dir") + 1] ?? "";
const [mode, capabilityId = "", resultPath = ""] = process.argv.slice(2);
const capability = CAPABILITIES.find((entry) => entry.id === capabilityId);
if (mode === "--fake-codex") await fakeCodexMain(fakeDir());
else if (mode === "--fake-claude") await fakeClaudeMain(fakeDir());
else if (mode === "--child" && capability) await runChild(capability, resultPath);
else if (mode === "--child") throw new Error(`Unknown capability: ${capabilityId}`);
else runParent();
