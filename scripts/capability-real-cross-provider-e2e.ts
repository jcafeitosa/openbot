// Measures the cross-provider check against the REAL providers. The agent runs on the real codex app-server
// (model gpt-6-luna); the second opinion comes from the real claude CLI. Each run creates a fresh agent and
// sends one flagged request: its text holds the marker word `verify`, so the check runs when the turn ends
// completed. The arm on sets the production switch crossProviderCheck on, the arm off sets it off; both arms
// send the same request.
//
// The count is the second-provider calls: claude CLI processes that were sent the cross-provider check prompt.
// A recording proxy sits in front of the real claude binary (OPENBOT_CLAUDE_PATH points at a wrapper that runs
// the proxy); the proxy forwards stdin and stdout unchanged and logs each check prompt it forwards. The codex
// side uses the same pass-through proxy as scripts/capability-real-codex-e2e.ts. The run also counts every claude
// process started during the turn, and whether the answer carries the abstention note.
//
// Selectors (this script only):
//   OPENBOT_E2E_CODEX_BIN    the real codex binary (default /opt/homebrew/bin/codex)
//   OPENBOT_E2E_CLAUDE_BIN   the real claude binary (default ~/.local/bin/claude)
//   OPENBOT_E2E_CODEX_MODEL  the model of the agent (default gpt-6-luna)
// The codex account is read from CODEX_HOME (default ~/.codex); only its auth.json is copied into a temporary
// CODEX_HOME. The claude CLI keeps the user's HOME and sign-in: on macOS its sign-in lives in the login keychain,
// which a temporary HOME cannot reach, so HOME is not replaced in this script.
//
// Scope: counts only, 5 runs per arm. The check's verdict is not scored; the note only shows that a disagreeing
// verdict reached the answer.
// Per-run timeout: 180 s. A run that hits it is recorded as timedOut, a measurement, not a pass.
// Run once: bun scripts/capability-real-cross-provider-e2e.ts
// Writes .openbot-build/capability-real-cross-provider-e2e/report.json. Exit code 0 when every one of the 10 runs
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
import type { AGENT_PROVIDERS as AGENT_PROVIDERS_LIST, AgentCapabilitySwitches } from "@openbot/contracts/ipc";
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
const OUT = resolve(import.meta.dirname, "../.openbot-build/capability-real-cross-provider-e2e");
const REAL_CODEX = process.env.OPENBOT_E2E_CODEX_BIN ?? "/opt/homebrew/bin/codex";
const REAL_CLAUDE = process.env.OPENBOT_E2E_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const MODEL = process.env.OPENBOT_E2E_CODEX_MODEL ?? "gpt-6-luna";
/** Read before the profile CODEX_HOME replaces the environment. */
const REAL_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const RUNS_PER_ARM = 5;
const RUN_TIMEOUT_MS = 180_000;
const CHILD_TIMEOUT_MS = 3_600_000;
/** The first line of the check prompt. The check's prompt starts with it, and only the check prompt carries it. */
const CHECK_MARK = "OpenBot cross-provider check, not a message from the user";
/** The start of the abstention note that a disagreeing check appends to the answer. */
const ABSTENTION_TEXT = "OpenBot cross-check: I am not sure of this answer.";
/** The request of every run, identical in both arms. Its marker word asks for the check. */
const FLAGGED_TEXT = "Verify this: what is 17 times 3? Reply with the number only.";
const TERMINAL_STATUSES = ["completed", "failed", "interrupted", "cancelled"];
const ARMS = ["on", "off"] as const;
type Arm = (typeof ARMS)[number];

/** One line of the codex proxy log: a turn that the service started, a turn that ended, or an answer. */
interface CodexRow {
  dir: "turn" | "turnCompleted" | "answer";
  threadId: string | null;
  text?: string;
  status?: string | null;
  phase?: string | null;
}

/** One line of the claude proxy log: a claude process that started, or a check prompt that it was sent. */
interface ClaudeRow {
  dir: "process" | "check";
  model: string | null;
}

/** A JSON-RPC message of the codex stream. Only the fields that the proxy reads are typed. */
interface RpcMessage {
  method?: string;
  params?: {
    threadId?: string;
    input?: { text?: string }[];
    turn?: { status?: string };
    item?: { type?: string; text?: string; phase?: string };
  };
}

type Scalar = string | number | boolean | null;
type Measured = Record<string, Scalar>;

interface RunRecord {
  arm: Arm;
  run: number;
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

/** A run that passed its deadline. Its partial measurements stay in the record. */
class RunTimeout extends Error {}

let deadline = 0;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The binary's version, or the reason it could not be read. */
function versionOf(path: string): string {
  const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return run.status === 0 ? run.stdout.trim() : `unknown (exit ${run.status ?? "none"})`;
}

/** The codex recording proxy: it forwards the RPC stream between the service and the real codex, unchanged. */
function codexProxyMain(): void {
  const real = process.argv[3] ?? "";
  const logPath = process.argv[4] ?? "";
  const codexArgs = process.argv.slice(5);
  const record = (row: CodexRow) => appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  const child = spawn(real, codexArgs, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.stdin.on("error", () => {});
  const messages = (onMessage: (message: RpcMessage) => void) => {
    let pending = "";
    return (chunk: string): void => {
      pending += chunk;
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          // A line that is not JSON is forwarded unchanged and not logged.
        }
      }
    };
  };
  const fromService = messages((message) => {
    if (message.method !== "turn/start") return;
    const input = message.params?.input ?? [];
    record({
      dir: "turn",
      threadId: message.params?.threadId ?? null,
      text: input.map((item) => item.text ?? "").join("\n"),
    });
  });
  const fromCodex = messages((message) => {
    const threadId = message.params?.threadId ?? null;
    if (message.method === "turn/completed") {
      record({ dir: "turnCompleted", threadId, status: message.params?.turn?.status ?? null });
    } else if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "agentMessage")
        record({ dir: "answer", threadId, text: item.text ?? "", phase: item.phase ?? null });
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

/**
 * The claude recording proxy: it forwards stdin and stdout of the real claude unchanged. It logs each process
 * that starts, with the model its arguments name, and each check prompt that reaches its stdin or its arguments.
 */
function claudeProxyMain(): void {
  const real = process.argv[3] ?? "";
  const logPath = process.argv[4] ?? "";
  const claudeArgs = process.argv.slice(5);
  const record = (row: ClaudeRow) => appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  const modelAt = claudeArgs.indexOf("--model");
  const model = modelAt >= 0 ? (claudeArgs[modelAt + 1] ?? null) : null;
  record({ dir: "process", model });
  if (claudeArgs.some((arg) => arg.includes(CHECK_MARK))) record({ dir: "check", model });
  const child = spawn(real, claudeArgs, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.stdin.on("error", () => {});
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.includes(CHECK_MARK)) record({ dir: "check", model });
    }
    child.stdin.write(chunk);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => process.stdout.write(chunk));
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
}

/** The production backend modules, as the other E2E scripts use them. */
interface Backend {
  AgentService: typeof AgentServiceClass;
  AgentStore: typeof AgentStoreClass;
  MailboxStore: typeof MailboxStoreClass;
  OpenBotDatabase: typeof OpenBotDatabaseClass;
  runCauseEffect: typeof runCauseEffectFn;
  AGENT_PROVIDERS: typeof AGENT_PROVIDERS_LIST;
  createAgentCapabilitySwitchesStore: typeof createSwitchesStoreFn;
  Effect: typeof EffectClass;
}

/**
 * Loaded dynamically on purpose: the provider clients read the provider paths when their modules load, so the
 * environment must be set before these imports run.
 */
async function loadBackend(): Promise<Backend> {
  const { AgentService } = await import("../src/backend/agent-service");
  const { AgentStore } = await import("../src/backend/agent-store");
  const { MailboxStore } = await import("../src/backend/mailbox-store");
  const { OpenBotDatabase } = await import("../src/backend/openbot-database");
  const { runCauseEffect } = await import("../src/backend/effect-boundary");
  const { AGENT_PROVIDERS } = await import("@openbot/contracts/ipc");
  const { createAgentCapabilitySwitchesStore } = await import("../src/main/agent-capability-switches-store");
  const { Effect } = await import("effect");
  return {
    AgentService,
    AgentStore,
    MailboxStore,
    OpenBotDatabase,
    runCauseEffect,
    AGENT_PROVIDERS,
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
  const service = new b.AgentService({
    store,
    mailbox,
    browser: browserHost(b),
    preferredProvider: "codex",
    // Only the two providers of the check start: codex runs the agent, claude gives the second opinion.
    offProviders: b.AGENT_PROVIDERS.filter((provider) => provider !== "codex" && provider !== "claude"),
    // Background memory reflection is off, so no other claude call enters the counts.
    memoryReviewInterval: () => 0,
    capabilitySwitches: () => switches.get(),
  });
  return { b, work: paths.work, service, mailbox, database, switches };
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
      description: "Checks the cross-provider check against the real providers.",
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

/** Waits for the delivery to end. The check runs before a turn's delivery ends, so its rows are logged by then. */
function settle(s: Session, deliveryId: string): Promise<string> {
  return waitFor(`delivery ${deliveryId} to end`, () => {
    const status = s.mailbox.getDelivery(deliveryId)?.delivery.status;
    return status !== undefined && TERMINAL_STATUSES.includes(status) ? status : null;
  });
}

function readRows<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): T => JSON.parse(line));
}

/** The rows of the thread that carries the token: the thread of the first turn whose text has the token. */
function threadOf(rows: CodexRow[], token: string): CodexRow[] {
  const anchor = rows.find((row) => row.dir === "turn" && row.text?.includes(token));
  if (!anchor) return [];
  return rows.filter((row) => row.threadId === anchor.threadId);
}

/** The text of the thread's last answer, or null. Commentary is not an answer. */
function lastAnswerOf(rows: CodexRow[]): string | null {
  return rows.filter((row) => row.dir === "answer" && row.phase !== "commentary").at(-1)?.text ?? null;
}

async function setSwitch(s: Session, key: keyof AgentCapabilitySwitches, on: boolean): Promise<void> {
  await s.b.runCauseEffect(s.switches.set({ ...s.switches.get(), [key]: on }));
}

/**
 * One flagged turn of a fresh agent. The count is the claude processes that were sent the check prompt in the
 * turn's window. The arm on expects one check; the arm off expects none.
 */
async function crossRun(s: Session, arm: Arm, run: number, out: Measured): Promise<boolean> {
  const token = `RUN-cross-${arm}-${run}-${randomUUID().slice(0, 8)}`;
  const agentId = await createAgent(s, `Checked ${arm} ${run}`);
  const codexLog = join(s.work, "codex-proxy.jsonl");
  const claudeLog = join(s.work, "claude-proxy.jsonl");
  const codexMark = readRows<CodexRow>(codexLog).length;
  const claudeMark = readRows<ClaudeRow>(claudeLog).length;
  const status = await settle(s, await send(s, agentId, `${token} ${FLAGGED_TEXT}`));
  const own = threadOf(readRows<CodexRow>(codexLog).slice(codexMark), token);
  const claude = readRows<ClaudeRow>(claudeLog).slice(claudeMark);
  const checks = claude.filter((row) => row.dir === "check");
  const answer = lastAnswerOf(own);
  out.deliveryStatus = status;
  out.secondProviderCalls = checks.length;
  out.claudeProcesses = claude.filter((row) => row.dir === "process").length;
  out.checkModel = checks.at(-1)?.model ?? null;
  out.abstentionNote = answer?.includes(ABSTENTION_TEXT) ?? false;
  out.answer = answer;
  return arm === "on" ? checks.length === 1 : checks.length === 0;
}

async function runOne(s: Session, arm: Arm, run: number): Promise<RunRecord> {
  const started = Date.now();
  deadline = started + RUN_TIMEOUT_MS;
  const measured: Measured = {};
  const record: RunRecord = {
    arm,
    run,
    durationMs: 0,
    timedOut: false,
    error: null,
    expectationMet: false,
    measured,
  };
  try {
    await setSwitch(s, "crossProviderCheck", arm === "on");
    record.expectationMet = await crossRun(s, arm, run, measured);
  } catch (error) {
    if (error instanceof RunTimeout) record.timedOut = true;
    else record.error = error instanceof Error ? error.message : String(error);
  } finally {
    record.durationMs = Date.now() - started;
  }
  return record;
}

async function runChild(resultPath: string): Promise<void> {
  const result: ChildResult = { runs: [], setupError: null };
  const root = mkdtempSync(join(tmpdir(), "openbot-real-cross-provider-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const userData = join(root, "user-data");
  const codexHome = join(home, ".codex");
  let session: Session | null = null;
  try {
    for (const dir of [codexHome, work, userData, join(OUT, "proxy-logs")]) {
      mkdirSync(dir, { recursive: true });
    }
    const authSource = join(REAL_CODEX_HOME, "auth.json");
    if (!existsSync(authSource)) throw new Error(`No codex sign-in: ${authSource} is missing.`);
    const authTarget = join(codexHome, "auth.json");
    copyFileSync(authSource, authTarget);
    chmodSync(authTarget, 0o600);
    const codexWrapper = join(work, "codex");
    writeFileSync(
      codexWrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(SCRIPT)} --codex-proxy ${shellQuote(REAL_CODEX)} ${shellQuote(join(work, "codex-proxy.jsonl"))} "$@"\n`,
      { mode: 0o755 },
    );
    const claudeWrapper = join(work, "claude");
    writeFileSync(
      claudeWrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(SCRIPT)} --claude-proxy ${shellQuote(REAL_CLAUDE)} ${shellQuote(join(work, "claude-proxy.jsonl"))} "$@"\n`,
      { mode: 0o755 },
    );
    // The provider paths are read when the backend modules load, so they are set before the import.
    process.env.CODEX_HOME = codexHome;
    process.env.OPENBOT_CODEX_PATH = codexWrapper;
    process.env.OPENBOT_CLAUDE_PATH = claudeWrapper;

    const b = await loadBackend();
    const switches = b.createAgentCapabilitySwitchesStore(join(userData, "capability-switches.json"));
    await b.runCauseEffect(switches.load());
    session = openSession(b, { work, userData, home }, switches);
    await b.runCauseEffect(session.service.initialize());
    for (let run = 1; run <= RUNS_PER_ARM; run++) {
      for (const arm of ARMS) {
        result.runs.push(await runOne(session, arm, run));
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
    for (const [log, copy] of [
      ["codex-proxy.jsonl", "codex.jsonl"],
      ["claude-proxy.jsonl", "claude.jsonl"],
    ] as const) {
      if (existsSync(join(work, log))) copyFileSync(join(work, log), join(OUT, "proxy-logs", copy));
    }
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

function numberOf(measured: Measured, key: string): number {
  const value = measured[key];
  return typeof value === "number" ? value : 0;
}

function runParent(): void {
  mkdirSync(join(OUT, "proxy-logs"), { recursive: true });
  const codex = { path: REAL_CODEX, version: versionOf(REAL_CODEX) };
  const claude = { path: REAL_CLAUDE, version: versionOf(REAL_CLAUDE) };
  const work = mkdtempSync(join(tmpdir(), "openbot-real-cross-results-"));
  const resultPath = join(work, "cross-provider.json");
  const child = spawnSync(process.execPath, [SCRIPT, "--child", resultPath], {
    stdio: "inherit",
    timeout: CHILD_TIMEOUT_MS,
  });
  const result: ChildResult | null = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
  const runs: RunRecord[] = [];
  for (const arm of ARMS) {
    for (let run = 1; run <= RUNS_PER_ARM; run++) {
      const found = result?.runs.find((candidate) => candidate.arm === arm && candidate.run === run);
      if (found) {
        runs.push(found);
        continue;
      }
      const reason = result?.setupError
        ? `setup failed: ${result.setupError.split("\n")[0]}`
        : `not run: child ended with status ${child.status ?? "none"} and signal ${child.signal ?? "none"}`;
      runs.push({ arm, run, durationMs: 0, timedOut: false, error: reason, expectationMet: false, measured: {} });
    }
  }
  rmSync(work, { recursive: true, force: true });

  const reportPath = join(OUT, "report.json");
  const report = {
    checkedAt: new Date().toISOString(),
    model: MODEL,
    codex,
    claude,
    runsPerArm: RUNS_PER_ARM,
    runTimeoutMs: RUN_TIMEOUT_MS,
    scope: {
      providers: ["codex (agent)", "claude (second provider)"],
      trigger: "the request holds the marker word verify, in both arms; the turn ends completed",
      counted:
        "second-provider calls: claude CLI processes that were sent the cross-provider check prompt during the turn",
      claudeIsolation: "the claude CLI uses the user's HOME and sign-in; the codex side uses a temporary CODEX_HOME",
      claims: "counts only; the check's verdict is not scored",
    },
    expectations: {
      on: "one second-provider call",
      off: "no second-provider call",
    },
    runs,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    "| Arm | Runs | Timeouts | Errors | Expectation met | Second-provider calls | Runs with a call | Claude processes | Abstention notes | Check model |\n",
  );
  process.stdout.write("|---|---|---|---|---|---|---|---|---|---|\n");
  for (const arm of ARMS) {
    const group = runs.filter((run) => run.arm === arm);
    const timeouts = group.filter((run) => run.timedOut).length;
    const errors = group.filter((run) => run.error !== null).length;
    const met = group.filter((run) => run.expectationMet).length;
    const calls = group.reduce((total, run) => total + numberOf(run.measured, "secondProviderCalls"), 0);
    const withCall = group.filter((run) => numberOf(run.measured, "secondProviderCalls") > 0).length;
    const processes = group.reduce((total, run) => total + numberOf(run.measured, "claudeProcesses"), 0);
    const notes = group.filter((run) => run.measured.abstentionNote === true).length;
    const models = [...new Set(group.map((run) => run.measured.checkModel).filter((value) => value !== null))];
    process.stdout.write(
      `| ${arm} | ${group.length} | ${timeouts} | ${errors} | ${met}/${group.length} | ${calls} | ${withCall} | ${processes} | ${notes} | ${models.join(", ") || "none"} |\n`,
    );
  }
  const harnessErrors = runs.filter((run) => run.error !== null).length;
  process.stdout.write(`${harnessErrors === 0 ? "OK" : "HARNESS ERRORS"} ${reportPath}\n`);
  process.exitCode = harnessErrors === 0 ? 0 : 1;
}

const [mode, resultPath = ""] = process.argv.slice(2);
if (mode === "--codex-proxy") codexProxyMain();
else if (mode === "--claude-proxy") claudeProxyMain();
else if (mode === "--child") await runChild(resultPath);
else runParent();
