// Measures five agent capabilities against the REAL codex app-server (codex-cli, model gpt-6-luna). Each
// capability has an on arm and an off arm. Two arms flip production switches of
// src/main/agent-capability-switches-store.ts (planVerifier, recurrenceNote); memory reflection flips the
// memoryReviewInterval setting. The dry-run gate and the exact-tool guidance have no switch, so their arms are
// the request: an irreversible or a reversible call, and an arithmetic request or the same arithmetic in words.
// Runs use the same AgentService wiring as scripts/capability-comparison-e2e.ts, with the provider pointed at
// the real codex through OPENBOT_CODEX_PATH. That path is a wrapper that runs the real binary through a
// pass-through proxy; the proxy only records the turn inputs, turn statuses, plan updates, tool calls and agent
// answers it forwards.
//
// Selectors (this script only):
//   OPENBOT_E2E_CODEX_BIN    the real codex binary (default /opt/homebrew/bin/codex)
//   OPENBOT_E2E_CODEX_MODEL  the model of every agent (default gpt-6-luna)
// The codex account is read from CODEX_HOME (default ~/.codex); only its auth.json is copied into a temporary
// CODEX_HOME. The user's config, history and MCP servers are not used.
//
// Scope: codex only, 5 runs per arm per capability. Exact-tool reports correct/total for exact arithmetic only;
// no other accuracy claim. The cross-provider check is not measured here; it needs a second provider.
// Background memory reflection is off (interval 0) in every run except the memory-reflection on arm, which keeps
// the production default (20).
//
// Per-run timeout: 180 s. A run that hits it is recorded as timedOut, a measurement, not a pass.
// Run once: bun scripts/capability-real-codex-e2e.ts
// Writes .openbot-build/capability-real-codex-e2e/report.json. Exit code 0 when every one of the 50 runs
// produced a record without a harness error (timeouts included); 1 otherwise.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AGENT_PROVIDERS as AGENT_PROVIDERS_LIST,
  AgentCapabilitySwitches,
  AgentEvent,
} from "@openbot/contracts/ipc";
import type { Effect as EffectClass } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentService as AgentServiceClass } from "../src/backend/agent-service";
import type { AgentStore as AgentStoreClass } from "../src/backend/agent-store";
import type { runCauseEffect as runCauseEffectFn } from "../src/backend/effect-boundary";
import type { MailboxStore as MailboxStoreClass } from "../src/backend/mailbox-store";
import type { OpenBotDatabase as OpenBotDatabaseClass } from "../src/backend/openbot-database";
import type {
  AgentCapabilitySwitchesStore,
  createAgentCapabilitySwitchesStore as createSwitchesStoreFn,
} from "../src/main/agent-capability-switches-store";

const SCRIPT = fileURLToPath(import.meta.url);
const OUT = resolve(import.meta.dirname, "../.openbot-build/capability-real-codex-e2e");
const REAL_CODEX = process.env.OPENBOT_E2E_CODEX_BIN ?? "/opt/homebrew/bin/codex";
const MODEL = process.env.OPENBOT_E2E_CODEX_MODEL ?? "gpt-6-luna";
/** Read before the profile HOME replaces the environment. */
const REAL_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const RUNS_PER_ARM = 5;
const RUN_TIMEOUT_MS = 180_000;
const CHILD_TIMEOUT_MS = 3_600_000;
/** A background reflection starts after its turn, so each memory-reflection run waits this long before it counts. */
const REFLECTION_WINDOW_MS = 20_000;

/** The text of the plan check that the verifier turn carries. */
const PLAN_CHECK_MARK = "OpenBot plan check, not a message from the user";
/** The prefix of the note that starts a plan continuation or a next-step continuation turn. */
const CONTINUATION_MARK = "OpenBot note, not a message from the user. Your last turn ended";
const GAP_PREFIX = "- Gap: ";
/** The recurrence note's text, which the follow-up prompt carries when the note is on. */
const RECURRENCE_MARK = "turns failed with cause";
/** The first line of the memory review prompt and of the failed-turn reflection prompt. */
const REVIEW_MARK = "You keep the long-term memory of the agent in this profile";
const REFLECTION_MARK = "You learn from one failed turn of the agent";
const FAILING_COMMAND = "cat /openbot-e2e-missing/deploy.env";
const FAILING_TEXT = `Run this exact shell command now with your shell tool, even if an earlier turn already ran it, then report its output in one line: ${FAILING_COMMAND}`;
const PLAN_REQUEST =
  "Complete this three-step plan and track the steps with your plan tool (update_plan), marking each step completed when it is done: (1) multiply 17 by 3; (2) name the capital of Japan; (3) name the chemical symbol of gold. In your final answer, give the evidence for each step on its own line, starting with the step number.";
/** The seeded memory that both dry-run arms use, and the request of each arm. */
const SEED_MEMORY = "The deploy window is Tuesday.";
const DRY_RUN_ON =
  "Find the saved memory that says the deploy window is Tuesday, then forget it with your forget memory tool. Reply in one line.";
const DRY_RUN_OFF = "Search your saved memories for the deploy window and reply in one line with what you find.";
/** The exact arithmetic. The expected value is computed here with BigInt, never taken from the model. */
const EXACT_A = 7362519n;
const EXACT_B = 8130476n;
const EXACT_C = 1234567n;
const EXACT_EXPECTED = (EXACT_A * EXACT_B + EXACT_C).toString();
/** The on arm has operators, which the guidance trigger reads. The off arm has the same numbers in words. */
const EXACT_ON = `What is ${EXACT_A} * ${EXACT_B} + ${EXACT_C}? Give the exact integer only.`;
const EXACT_OFF = `Multiply ${EXACT_A} by ${EXACT_B}, then add ${EXACT_C}. Give the exact integer only.`;
const TERMINAL_STATUSES = ["completed", "failed", "interrupted", "cancelled"];

const ARMS = ["on", "off"] as const;
type Arm = (typeof ARMS)[number];
type CapabilityId = "plan-verifier" | "recurrence" | "dry-run" | "exact-tool" | "memory-reflection";
const CAPABILITY_IDS: readonly CapabilityId[] = [
  "plan-verifier",
  "recurrence",
  "dry-run",
  "exact-tool",
  "memory-reflection",
];
/** The capabilities whose arm is a production switch. The others are set in `setArm`. */
const SWITCH: Partial<Record<CapabilityId, keyof AgentCapabilitySwitches>> = {
  "plan-verifier": "planVerifier",
  recurrence: "recurrenceNote",
};
/** An approval card that the service raised. */
type ApprovalCard = Extract<AgentEvent, { type: "approval" }>["approval"];

/** One line of the proxy log: a turn that the service started, a turn that ended, a plan update, a tool call, or an answer. */
interface ProxyRow {
  dir: "turn" | "turnCompleted" | "plan" | "toolCall" | "answer";
  threadId: string | null;
  text?: string;
  status?: string | null;
  steps?: { step: string; status: string }[];
  tool?: string | null;
  phase?: string | null;
}

/** A JSON-RPC message of the stream. Only the fields that the proxy reads are typed. */
interface RpcMessage {
  method?: string;
  params?: {
    threadId?: string;
    input?: { text?: string }[];
    turn?: { status?: string };
    plan?: { step?: string; status?: string }[];
    tool?: string;
    item?: { type?: string; text?: string; phase?: string };
  };
}

type Scalar = string | number | boolean | null;
/** A value that a run measures: a count, a flag, a text, or a list of codes or statuses. */
type Measure = Scalar | readonly Scalar[];
type Measured = Record<string, Measure>;

interface RunRecord {
  capability: CapabilityId;
  arm: Arm;
  run: number;
  model: string;
  binaryPath: string;
  binaryVersion: string;
  durationMs: number;
  timedOut: boolean;
  error: string | null;
  expectationMet: boolean;
  measured: Measured;
}

interface ChildResult {
  runs: RunRecord[];
  setupError: string | null;
}

interface LedgerRow {
  outcome: string;
  toolFailureCodes: string;
}

/** A run that passed its deadline. Its partial measurements stay in the record. */
class RunTimeout extends Error {}

let deadline = 0;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The codex version, or the reason it could not be read. */
function versionOf(path: string): string {
  const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return run.status === 0 ? run.stdout.trim() : `unknown (exit ${run.status ?? "none"})`;
}

/** The recording proxy: it forwards the RPC stream between the service and the real codex, unchanged. */
function codexProxyMain(): void {
  const real = process.argv[3] ?? "";
  const logPath = process.argv[4] ?? "";
  const codexArgs = process.argv.slice(5);
  const record = (row: ProxyRow) => appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  const child = spawn(real, codexArgs, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.stdin.on("error", () => {});
  const lines = (onLine: (message: RpcMessage) => void) => {
    let pending = "";
    return (chunk: string): void => {
      pending += chunk;
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        try {
          const message: RpcMessage = JSON.parse(line);
          onLine(message);
        } catch {
          // A line that is not JSON is forwarded unchanged and not logged.
        }
      }
    };
  };
  const fromService = lines((message) => {
    if (message.method !== "turn/start") return;
    const input = message.params?.input ?? [];
    record({
      dir: "turn",
      threadId: message.params?.threadId ?? null,
      text: input.map((item) => item.text ?? "").join("\n"),
    });
  });
  const fromCodex = lines((message) => {
    const threadId = message.params?.threadId ?? null;
    if (message.method === "turn/completed") {
      record({ dir: "turnCompleted", threadId, status: message.params?.turn?.status ?? null });
    } else if (message.method === "turn/plan/updated") {
      const plan = message.params?.plan ?? [];
      record({
        dir: "plan",
        threadId,
        steps: plan.map((entry) => ({ step: entry.step ?? "", status: entry.status ?? "" })),
      });
    } else if (message.method === "item/tool/call") {
      record({ dir: "toolCall", threadId, tool: message.params?.tool ?? null });
    } else if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage") {
        record({ dir: "answer", threadId, text: item.text ?? "", phase: item.phase ?? null });
      }
    }
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    fromService(chunk);
    child.stdin.write(chunk);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    fromCodex(chunk);
    process.stdout.write(chunk);
  });
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
}

/** The production backend modules, as the comparison script uses them. */
interface Backend {
  AgentService: typeof AgentServiceClass;
  AgentStore: typeof AgentStoreClass;
  MailboxStore: typeof MailboxStoreClass;
  OpenBotDatabase: typeof OpenBotDatabaseClass;
  runCauseEffect: typeof runCauseEffectFn;
  AGENT_PROVIDERS: typeof AGENT_PROVIDERS_LIST;
  DEFAULT_MEMORY_REVIEW_INTERVAL: number;
  createAgentCapabilitySwitchesStore: typeof createSwitchesStoreFn;
  Effect: typeof EffectClass;
}

/**
 * Loaded dynamically on purpose: the stores and the provider clients read HOME and the provider paths when
 * their modules load, so the profile environment must be set before these imports run.
 */
async function loadBackend(): Promise<Backend> {
  const { AgentService } = await import("../src/backend/agent-service");
  const { AgentStore } = await import("../src/backend/agent-store");
  const { MailboxStore } = await import("../src/backend/mailbox-store");
  const { OpenBotDatabase } = await import("../src/backend/openbot-database");
  const { runCauseEffect } = await import("../src/backend/effect-boundary");
  const { AGENT_PROVIDERS, DEFAULT_MEMORY_REVIEW_INTERVAL } = await import("@openbot/contracts/ipc");
  const { createAgentCapabilitySwitchesStore } = await import("../src/main/agent-capability-switches-store");
  const { Effect } = await import("effect");
  return {
    AgentService,
    AgentStore,
    MailboxStore,
    OpenBotDatabase,
    runCauseEffect,
    AGENT_PROVIDERS,
    DEFAULT_MEMORY_REVIEW_INTERVAL,
    createAgentCapabilitySwitchesStore,
    Effect,
  };
}

type Service = InstanceType<Backend["AgentService"]>;

interface Session {
  b: Backend;
  work: string;
  service: Service;
  mailbox: InstanceType<Backend["MailboxStore"]>;
  database: InstanceType<Backend["OpenBotDatabase"]>;
  switches: AgentCapabilitySwitchesStore;
  /** Every approval card that the service raised, in order. */
  cards: ApprovalCard[];
  /** The memory review interval, which the service reads at each use. */
  review: { interval: number };
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

function openSession(
  b: Backend,
  paths: { work: string; userData: string; home: string },
  switches: AgentCapabilitySwitchesStore,
): Session {
  const database = new b.OpenBotDatabase(paths.userData);
  const store = new b.AgentStore(paths.userData, paths.home, database);
  const mailbox = new b.MailboxStore(paths.userData, store.sharedRoot, store.database);
  const review = { interval: 0 };
  const service = new b.AgentService({
    store,
    mailbox,
    browser: browserHost(b),
    preferredProvider: "codex",
    offProviders: b.AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    // Background reflection is off in every run except the memory-reflection on arm, so other turns stay out of the counts.
    memoryReviewInterval: () => review.interval,
    capabilitySwitches: () => switches.get(),
  });
  const session: Session = { b, work: paths.work, service, mailbox, database, switches, cards: [], review };
  service.on("event", (event: AgentEvent) => {
    if (event.type === "approval") session.cards.push(event.approval);
  });
  return session;
}

/** Polls until the read returns a value, or the run's deadline passes. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new RunTimeout(`Timed out waiting for ${label}.`);
    await sleep(50);
  }
}

async function createAgent(s: Session, name: string): Promise<string> {
  const agent = await s.b.runCauseEffect(
    s.service.createAgent({
      name,
      description: "Checks one capability against the real codex.",
      avatarSeed: name.toLowerCase().replace(/\W+/g, "-"),
      avatarHue: null,
      initialMessage: "Hello.",
      provider: "codex",
      model: MODEL,
    }),
  );
  await waitFor(`${name}'s first turn`, () => {
    const deliveries = s.service.listQueue(agent.id).deliveries;
    return deliveries.every((delivery) => TERMINAL_STATUSES.includes(delivery.status)) || null;
  });
  return agent.id;
}

async function send(s: Session, agentId: string, text: string): Promise<string> {
  const receipt = await s.b.runCauseEffect(s.service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  if (!deliveryId) throw new Error("The message has no delivery.");
  return deliveryId;
}

function settle(s: Session, deliveryId: string): Promise<string> {
  return waitFor(`delivery ${deliveryId} to end`, () => {
    const status = s.mailbox.getDelivery(deliveryId)?.delivery.status;
    return status !== undefined && TERMINAL_STATUSES.includes(status) ? status : null;
  });
}

/**
 * Waits for the delivery to end. Each approval card that opens meanwhile is recorded with what `present` reads at
 * that moment, then declined, so a held call does not run.
 */
async function settleDeclining(
  s: Session,
  deliveryId: string,
  from: number,
  present: () => boolean,
): Promise<{ status: string; presentAtCard: boolean[] }> {
  const presentAtCard: boolean[] = [];
  let next = from;
  for (;;) {
    while (next < s.cards.length) {
      const card = s.cards[next];
      next += 1;
      if (!card) continue;
      presentAtCard.push(present());
      await s.b.runCauseEffect(s.service.respondToApproval({ requestId: card.requestId, decision: "decline" }));
    }
    const status = s.mailbox.getDelivery(deliveryId)?.delivery.status;
    if (status !== undefined && TERMINAL_STATUSES.includes(status)) return { status, presentAtCard };
    if (Date.now() >= deadline) throw new RunTimeout(`Timed out waiting for delivery ${deliveryId} to end.`);
    await sleep(50);
  }
}

function proxyRows(s: Session): ProxyRow[] {
  const path = join(s.work, "codex-proxy.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): ProxyRow => JSON.parse(line));
}

/** The rows of the thread that carries the token: the thread of the first turn whose text has the token. */
function threadOf(rows: ProxyRow[], token: string): ProxyRow[] {
  const anchor = rows.find((row) => row.dir === "turn" && row.text?.includes(token));
  if (!anchor) return [];
  return rows.filter((row) => row.threadId === anchor.threadId);
}

/** The text of the thread's last answer, or null. Commentary is not an answer. */
function lastAnswerOf(rows: ProxyRow[]): string | null {
  return rows.filter((row) => row.dir === "answer" && row.phase !== "commentary").at(-1)?.text ?? null;
}

/** The integers of a text, with thousands separators removed. */
function integersOf(text: string): string[] {
  return text.replace(/(?<=\d),(?=\d{3}\b)/g, "").match(/\d+/g) ?? [];
}

function ledgerRows(s: Session, agentId: string): LedgerRow[] {
  return s.database.connection
    .prepare("SELECT outcome, tool_failure_codes_json FROM turn_outcomes WHERE agent_id = ? ORDER BY created_at, rowid")
    .all(agentId)
    .map((row) => ({ outcome: String(row.outcome), toolFailureCodes: String(row.tool_failure_codes_json) }));
}

/** The automatic memories of the agent: the lessons that a reflection saved. */
function automaticLessons(s: Session, agentId: string): number {
  return s.service.listMemories(agentId).filter((memory) => memory.origin === "automatic").length;
}

async function setSwitch(s: Session, key: keyof AgentCapabilitySwitches, on: boolean): Promise<void> {
  await s.b.runCauseEffect(s.switches.set({ ...s.switches.get(), [key]: on }));
}

/** Sets the arm of a capability: a production switch or the review interval. The other arms are the request. */
async function setArm(s: Session, capability: CapabilityId, arm: Arm): Promise<void> {
  if (capability === "memory-reflection") {
    s.review.interval = arm === "on" ? s.b.DEFAULT_MEMORY_REVIEW_INTERVAL : 0;
  }
  const key = SWITCH[capability];
  if (key) await setSwitch(s, key, arm === "on");
}

/**
 * Plan verifier. The request asks for a three-step plan with evidence. The run counts the verifier calls, the
 * extra turns that a plan or a check starts, and whether the second turn's prompt names a gap.
 */
async function planRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-plan-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Planner ${arm} ${run}`);
  const mark = proxyRows(s).length;
  const status = await settle(s, await send(s, agentId, `${token} ${PLAN_REQUEST}`));
  const rows = proxyRows(s).slice(mark);
  const own = threadOf(rows, token);
  const continuations = own.filter((row) => row.dir === "turn" && row.text?.includes(CONTINUATION_MARK));
  const verifierCalls = rows.filter((row) => row.dir === "turn" && row.text?.includes(PLAN_CHECK_MARK)).length;
  const plans = own.filter((row) => row.dir === "plan");
  const gapLines = (continuations[0]?.text ?? "").split("\n").filter((line) => line.startsWith(GAP_PREFIX));
  out.deliveryStatus = status;
  out.verifierCalls = verifierCalls;
  out.extraTurns = continuations.length;
  out.gapTurns = continuations.filter((row) => row.text?.includes(GAP_PREFIX)).length;
  out.secondTurnNamesGap = gapLines.length > 0;
  out.firstGap = gapLines[0]?.slice(GAP_PREFIX.length) ?? null;
  out.planUpdates = plans.length;
  out.lastPlanStatuses = plans.at(-1)?.steps?.map((step) => step.status) ?? [];
  return arm === "on" ? verifierCalls >= 1 : verifierCalls === 0 && continuations.length === 0;
}

/**
 * Recurrence note. The same shell call fails in three consecutive turns. The follow-up prompt is read for the
 * note. The ledger outcomes and the codex turn statuses are kept, because the note counts failed turns.
 */
async function recurrenceRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-recurrence-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Recurring ${arm} ${run}`);
  await waitFor("the first turn's outcome row", () => ledgerRows(s, agentId).length >= 1 || null);
  const before = ledgerRows(s, agentId).length;
  const mark = proxyRows(s).length;
  const request = `${token} ${FAILING_TEXT}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await settle(s, await send(s, agentId, request));
    await waitFor(
      "the outcome row of the failed turn",
      () => ledgerRows(s, agentId).length >= before + attempt || null,
    );
  }
  const failureRows = ledgerRows(s, agentId).slice(before);
  const failureThread = threadOf(proxyRows(s).slice(mark), token);
  out.outcomes = failureRows.map((row) => row.outcome);
  out.toolFailureCodes = failureRows.map((row) => row.toolFailureCodes);
  out.codexTurnStatuses = failureThread.filter((row) => row.dir === "turnCompleted").map((row) => row.status ?? null);
  out.failedOutcomes = failureRows.filter((row) => row.outcome === "failed").length;

  const followMark = proxyRows(s).length;
  const followStatus = await settle(
    s,
    await send(s, agentId, `${token} follow-up: state in one short line what you will do next.`),
  );
  const prompt = proxyRows(s)
    .slice(followMark)
    .find((row) => row.dir === "turn" && row.text?.includes("follow-up:"))?.text;
  const promptFound = prompt !== undefined;
  const noteInPrompt = prompt?.includes(RECURRENCE_MARK) ?? false;
  out.followUpStatus = followStatus;
  out.promptFound = promptFound;
  out.noteInPrompt = noteInPrompt;
  return arm === "on" ? noteInPrompt : promptFound && !noteInPrompt;
}

/**
 * Dry-run gate. The arm on asks for an irreversible forget. Its approval card must open, the memory must still
 * exist while the card waits, and the run declines the card, so the memory must still exist after the turn. The
 * arm off searches the same seeded memory: no card, and the search call runs. Every card that opens is declined.
 */
async function dryRunRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-dry-run-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Gated ${arm} ${run}`);
  const seeded = s.service.createMemory({ agentId, text: SEED_MEMORY });
  const present = () => s.service.listMemories(agentId).some((memory) => memory.id === seeded.id);
  const mark = proxyRows(s).length;
  const cardsBefore = s.cards.length;
  const deliveryId = await send(s, agentId, `${token} ${arm === "on" ? DRY_RUN_ON : DRY_RUN_OFF}`);
  const { status, presentAtCard } = await settleDeclining(s, deliveryId, cardsBefore, present);
  const own = threadOf(proxyRows(s).slice(mark), token);
  const cards = s.cards.length - cardsBefore;
  const memoryAfterTurn = present();
  const forgetCalls = own.filter((row) => row.dir === "toolCall" && row.tool === "forget_memory").length;
  const searchCalls = own.filter((row) => row.dir === "toolCall" && row.tool === "search_memories").length;
  const searchFoundMemory = lastAnswerOf(own)?.includes("Tuesday") ?? false;
  out.deliveryStatus = status;
  out.ranBeforeAnswer = presentAtCard.includes(false);
  out.memoryKept = memoryAfterTurn;
  out.forgetCalls = forgetCalls;
  out.searchCalls = searchCalls;
  out.searchFoundMemory = searchFoundMemory;
  return arm === "on"
    ? cards === 1 && presentAtCard[0] === true && memoryAfterTurn
    : cards === 0 && searchCalls >= 1 && memoryAfterTurn;
}

/**
 * Exact-tool guidance. The arm on writes the arithmetic with operators, which the guidance trigger reads. The arm
 * off writes the same numbers and the same expected value in words, which the trigger does not read. The run
 * counts the compute_exact calls and checks the integers of the final answer against the BigInt value.
 */
async function exactToolRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-exact-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Calculator ${arm} ${run}`);
  const mark = proxyRows(s).length;
  const status = await settle(s, await send(s, agentId, `${token} ${arm === "on" ? EXACT_ON : EXACT_OFF}`));
  const own = threadOf(proxyRows(s).slice(mark), token);
  const answer = lastAnswerOf(own);
  const calls = own.filter((row) => row.dir === "toolCall" && row.tool === "compute_exact").length;
  const correct = answer !== null && integersOf(answer).includes(EXACT_EXPECTED);
  out.deliveryStatus = status;
  out.computeExactCalls = calls;
  out.answer = answer;
  out.expected = EXACT_EXPECTED;
  out.correct = correct;
  return arm === "on" ? calls >= 1 : calls === 0;
}

/**
 * Memory reflection. One failing shell step, the same as the recurrence scenario. The arm on keeps the production
 * review interval (20); the arm off sets it to 0. The run counts the reflection turns, the review turns and the
 * automatic lessons saved, after a fixed window in which a background reflection would start.
 */
async function reflectionRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-reflection-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Reflecting ${arm} ${run}`);
  const lessonsBefore = automaticLessons(s, agentId);
  const outcomesBefore = ledgerRows(s, agentId).length;
  const mark = proxyRows(s).length;
  const status = await settle(s, await send(s, agentId, `${token} ${FAILING_TEXT}`));
  await waitFor("the outcome row of the failing turn", () => ledgerRows(s, agentId).length > outcomesBefore || null);
  await sleep(REFLECTION_WINDOW_MS);
  const rows = proxyRows(s).slice(mark);
  const own = threadOf(rows, token);
  const reflections = rows.filter((row) => row.dir === "turn" && row.text?.includes(REFLECTION_MARK)).length;
  const reviews = rows.filter((row) => row.dir === "turn" && row.text?.includes(REVIEW_MARK)).length;
  const lessons = automaticLessons(s, agentId) - lessonsBefore;
  out.deliveryStatus = status;
  out.outcomes = ledgerRows(s, agentId)
    .slice(outcomesBefore)
    .map((row) => row.outcome);
  out.codexTurnStatuses = own.filter((row) => row.dir === "turnCompleted").map((row) => row.status ?? null);
  out.reflections = reflections;
  out.reviews = reviews;
  out.lessons = lessons;
  return arm === "on" ? reflections >= 1 && lessons >= 1 : reflections === 0 && lessons === 0;
}

const RUNNERS: Record<CapabilityId, (s: Session, arm: Arm, run: number, out: Measured) => Promise<boolean>> = {
  "plan-verifier": planRun,
  recurrence: recurrenceRun,
  "dry-run": dryRunRun,
  "exact-tool": exactToolRun,
  "memory-reflection": reflectionRun,
};

async function runOne(
  s: Session,
  capability: CapabilityId,
  arm: Arm,
  run: number,
  binary: { path: string; version: string },
): Promise<RunRecord> {
  const started = Date.now();
  deadline = started + RUN_TIMEOUT_MS;
  const cardsBefore = s.cards.length;
  const measured: Measured = {};
  const record: RunRecord = {
    capability,
    arm,
    run,
    model: MODEL,
    binaryPath: binary.path,
    binaryVersion: binary.version,
    durationMs: 0,
    timedOut: false,
    error: null,
    expectationMet: false,
    measured,
  };
  try {
    await setArm(s, capability, arm);
    record.expectationMet = await RUNNERS[capability](s, arm, run, measured);
  } catch (error) {
    if (error instanceof RunTimeout) record.timedOut = true;
    else record.error = error instanceof Error ? error.message : String(error);
  } finally {
    measured.approvalCards = s.cards.length - cardsBefore;
    record.durationMs = Date.now() - started;
  }
  return record;
}

async function runChild(capability: CapabilityId, resultPath: string): Promise<void> {
  const result: ChildResult = { runs: [], setupError: null };
  const root = mkdtempSync(join(tmpdir(), `openbot-real-codex-${capability}-`));
  const home = join(root, "home");
  const work = join(root, "work");
  const userData = join(root, "user-data");
  let session: Session | null = null;
  try {
    for (const dir of [join(home, ".codex"), work, userData, join(OUT, "proxy-logs")]) {
      mkdirSync(dir, { recursive: true });
    }
    const authSource = join(REAL_CODEX_HOME, "auth.json");
    if (!existsSync(authSource)) throw new Error(`No codex sign-in: ${authSource} is missing.`);
    const authTarget = join(home, ".codex", "auth.json");
    copyFileSync(authSource, authTarget);
    chmodSync(authTarget, 0o600);
    const wrapper = join(work, "codex");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(SCRIPT)} --codex-proxy ${shellQuote(REAL_CODEX)} ${shellQuote(join(work, "codex-proxy.jsonl"))} "$@"\n`,
      { mode: 0o755 },
    );
    // The service modules read the home folder and the provider paths when they load.
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.OPENBOT_CODEX_PATH = wrapper;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    const binary = { path: REAL_CODEX, version: versionOf(REAL_CODEX) };

    const b = await loadBackend();
    const switches = b.createAgentCapabilitySwitchesStore(join(userData, "capability-switches.json"));
    await b.runCauseEffect(switches.load());
    session = openSession(b, { work, userData, home }, switches);
    await b.runCauseEffect(session.service.initialize());
    for (let run = 1; run <= RUNS_PER_ARM; run++) {
      for (const arm of ARMS) {
        result.runs.push(await runOne(session, capability, arm, run, binary));
        writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      }
    }
  } catch (error) {
    result.setupError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    if (session) {
      await session.b.runCauseEffect(session.service.stop()).catch(() => {});
      session.database.close();
    }
    const log = join(work, "codex-proxy.jsonl");
    if (existsSync(log)) copyFileSync(log, join(OUT, "proxy-logs", `${capability}.jsonl`));
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

function numberOf(measured: Measured, key: string): number {
  const value = measured[key];
  return typeof value === "number" ? value : 0;
}

function countsOf(capability: CapabilityId, runs: RunRecord[]): string {
  const sum = (key: string) => runs.reduce((total, run) => total + numberOf(run.measured, key), 0);
  const count = (key: string) => runs.filter((run) => run.measured[key] === true).length;
  const runsWith = (key: string) => runs.filter((run) => numberOf(run.measured, key) > 0).length;
  if (capability === "plan-verifier") {
    const gapRuns = runs.filter((run) => numberOf(run.measured, "gapTurns") > 0).length;
    return `verifier calls ${sum("verifierCalls")}; extra turns ${sum("extraTurns")}; runs with a gap turn ${gapRuns}; second turn names gap ${count("secondTurnNamesGap")}`;
  }
  if (capability === "recurrence") {
    return `note in next prompt ${count("noteInPrompt")}; prompt found ${count("promptFound")}; failed turns ${sum("failedOutcomes")}`;
  }
  if (capability === "dry-run") {
    return `approval cards ${sum("approvalCards")} (runs with a card ${runsWith("approvalCards")}); ran before answer ${count("ranBeforeAnswer")}; memory kept ${count("memoryKept")}; forget calls ${sum("forgetCalls")}; search calls ${sum("searchCalls")}; search found memory ${count("searchFoundMemory")}`;
  }
  if (capability === "exact-tool") {
    return `compute_exact calls ${sum("computeExactCalls")} (runs with a call ${runsWith("computeExactCalls")}); correct ${count("correct")}/${runs.length}`;
  }
  return `reflections ${sum("reflections")}; saved lessons ${sum("lessons")}; review turns ${sum("reviews")}; runs with a lesson ${runsWith("lessons")}`;
}

function runParent(): void {
  mkdirSync(join(OUT, "proxy-logs"), { recursive: true });
  const binary = { path: REAL_CODEX, version: versionOf(REAL_CODEX) };
  const runs: RunRecord[] = [];
  for (const capability of CAPABILITY_IDS) {
    const work = mkdtempSync(join(tmpdir(), "openbot-real-codex-results-"));
    const resultPath = join(work, `${capability}.json`);
    const child = spawnSync(process.execPath, [SCRIPT, "--child", capability, resultPath], {
      stdio: "inherit",
      timeout: CHILD_TIMEOUT_MS,
    });
    const result: ChildResult | null = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
    for (let run = 1; run <= RUNS_PER_ARM; run++) {
      for (const arm of ARMS) {
        const found = result?.runs.find((candidate) => candidate.arm === arm && candidate.run === run);
        if (found) {
          runs.push(found);
          continue;
        }
        const reason = result?.setupError
          ? `setup failed: ${result.setupError.split("\n")[0]}`
          : `not run: child ended with status ${child.status ?? "none"} and signal ${child.signal ?? "none"}`;
        runs.push({
          capability,
          arm,
          run,
          model: MODEL,
          binaryPath: binary.path,
          binaryVersion: binary.version,
          durationMs: 0,
          timedOut: false,
          error: reason,
          expectationMet: false,
          measured: {},
        });
      }
    }
    rmSync(work, { recursive: true, force: true });
  }

  const reportPath = join(OUT, "report.json");
  const report = {
    checkedAt: new Date().toISOString(),
    model: MODEL,
    binary,
    runsPerArm: RUNS_PER_ARM,
    runTimeoutMs: RUN_TIMEOUT_MS,
    scope: {
      providers: ["codex"],
      crossProvider: "not measured in this round: it needs a second provider",
      claims: "counts only; exact-tool reports correct/total for exact arithmetic",
      isolation: "temporary HOME and CODEX_HOME; only auth.json is copied from the codex home",
      memoryReflection:
        "memoryReviewInterval 0 in every run except the memory-reflection on arm (production default 20)",
      dryRunArms:
        "no switch: the arm is the request (irreversible forget versus reversible search); every card is declined",
      exactToolArms:
        "no switch: the trigger is the request text (exactToolGuidance); the off arm writes the same numbers in words",
    },
    expectations: {
      "plan-verifier on": "at least one verifier call",
      "plan-verifier off": "no verifier call and no extra turn",
      "recurrence on": "the recurrence note is in the follow-up prompt",
      "recurrence off": "the follow-up prompt is found and carries no note",
      "dry-run on": "one approval card; the memory is present while the card waits and after the decline",
      "dry-run off": "no approval card; the search call runs",
      "exact-tool on": "at least one compute_exact call",
      "exact-tool off": "no compute_exact call",
      "memory-reflection on": "at least one reflection and one automatic lesson",
      "memory-reflection off": "no reflection and no automatic lesson",
    },
    runs,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write("| Capability | Arm | Runs | Timeouts | Errors | Expectation met | Counts |\n");
  process.stdout.write("|---|---|---|---|---|---|---|\n");
  for (const capability of CAPABILITY_IDS) {
    for (const arm of ARMS) {
      const group = runs.filter((run) => run.capability === capability && run.arm === arm);
      const timeouts = group.filter((run) => run.timedOut).length;
      const errors = group.filter((run) => run.error !== null).length;
      const met = group.filter((run) => run.expectationMet).length;
      process.stdout.write(
        `| ${capability} | ${arm} | ${group.length} | ${timeouts} | ${errors} | ${met}/${group.length} | ${countsOf(capability, group)} |\n`,
      );
    }
  }
  const harnessErrors = runs.filter((run) => run.error !== null).length;
  process.stdout.write(`${harnessErrors === 0 ? "OK" : "HARNESS ERRORS"} ${reportPath}\n`);
  process.exitCode = harnessErrors === 0 ? 0 : 1;
}

const [mode, capabilityId = "", resultPath = ""] = process.argv.slice(2);
if (mode === "--codex-proxy") codexProxyMain();
else if (mode === "--child") {
  const capability = CAPABILITY_IDS.find((candidate) => candidate === capabilityId);
  if (!capability) throw new Error(`Unknown capability: ${capabilityId}`);
  await runChild(capability, resultPath);
} else runParent();
