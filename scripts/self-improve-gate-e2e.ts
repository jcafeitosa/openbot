// Checks the gate on an agent's own changes. The agent proposes a new instruction file (`propose_instructions_change`)
// or a skill draft (`propose_skill`) through its tools. A proposal waits for the person's answer on an owner-only card;
// an accepted instruction change is written only when a replay of the recorded turns shows no rise in failed turns; a
// local responder cannot answer the card; a secret in the change is refused before any card; and a skill draft is
// installed once, from a task whose plan the person started with its card in the same turn, after the person accepts
// the draft's card, with its scripts never run. A plan that the host starts when its wait runs out approves nothing.
// Runs the real agent service, tool router, attention
// registry, turn ledger, instruction history and local skill library on a temporary profile with a fake Codex
// app-server, and answers each approval card as the person. `bun scripts/self-improve-gate-e2e.ts`. Writes
// .openbot-build/self-improve-gate-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const OUT = resolve(import.meta.dirname, "../.openbot-build/self-improve-gate-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-self-improve-gate-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const RAN_MARKER = join(root, "draft-script-ran");

const OLD_TEXT = "# Rules\n- Reply in one short paragraph.\n";
const NEW_TEXT = "# Rules\n- Reply in one short paragraph.\n- Ask before deleting files.\n";
const SECOND_TEXT = "# Rules\n- Reply in one short paragraph.\n- Keep answers brief.\n";
// Registered, so the redaction finds it in any text the gate reads.
const SECRET = "self-improve-secret-4b9e";
const SECRET_TEXT = `${OLD_TEXT}- Use token ${SECRET} for the staging site.\n`;
const CALL_MARK = "SELF-IMPROVE-CALL";
const PLAN_MARK = "SELF-IMPROVE-PLAN";
const DRAFT_NAME = "Triage Notes";
const DRAFT_FOLDER = "draft";
const SECRET_FOLDER = "secret-draft";
const BIG_FOLDER = "big-draft";
const CHANGED_FOLDER = "changed-draft";
const SEAM_FOLDER = "seam-draft";

// The Codex process and the stores read the home folder when their modules load, so the environment is set
// first and the service modules are imported dynamically after it.
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
const { instructionsTextSha256 } = await import("../src/backend/instructions-history-store");
const { restoreAgentInstructionsSnapshot } = await import("../src/backend/agent/workspace-instructions");
const { LocalSkillLibrary } = await import("../src/main/local-skill-library");
const { localSkillTools } = await import("../src/main/local-skill-tools");

/**
 * A Codex app-server with the methods that the service calls. A turn whose input holds
 * `SELF-IMPROVE-CALL <<ARGS<base64 JSON>ARGS>>` calls `openbot.<__tool>` with the rest of that JSON and ends once the
 * result is logged. A turn that also holds `SELF-IMPROVE-PLAN` first reports a finished two-step plan, as Codex does.
 * Other turns answer "Done.". The arguments travel as base64 so that the packet's quoting cannot change them.
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
let tools = 0;
/** Makes the next call of a turn, then waits for its result. */
const callNext = (threadId, turnId, calls) => {
  const [match, ...rest] = calls;
  const { __tool, ...args } = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const id = "tool-" + (++tools);
  waiting.set(id, { threadId, turnId, tool: __tool, rest });
  write({
    id,
    method: "item/tool/call",
    params: { threadId, turnId, callId: "call-" + id, namespace: "openbot", tool: __tool, arguments: args },
  });
};
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      if (text.includes(${JSON.stringify(PLAN_MARK)})) {
        write({ method: "turn/plan/updated", params: { threadId: params.threadId, turnId, explanation: "Two steps.", plan: [{ step: "Read the notes", status: "completed" }, { step: "Write the draft", status: "completed" }] } });
      }
      const matches = text.includes(${JSON.stringify(CALL_MARK)}) ? [...text.matchAll(/<<ARGS([A-Za-z0-9+/=]*)ARGS>>/g)] : [];
      if (matches.length === 0) return setTimeout(() => finish(params.threadId, turnId), 20);
      return callNext(params.threadId, turnId, matches);
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
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ turnId: turn.turnId, tool: turn.tool, result: message.result ?? null, error: message.error ?? null });
        if (turn.rest.length > 0) callNext(turn.threadId, turn.turnId, turn.rest);
        else finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

/** The arguments of one call. The fake sends them to the tool as JSON, so any shape is possible. */
type CallArguments = object;

interface ToolLog {
  turnId: string;
  tool: string;
  result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error: unknown;
}

interface CallOutcome {
  success: boolean;
  text: string;
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

/** Waits for a state of the service or the fake's log. */
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

function toolLogs(): ToolLog[] {
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

const report: {
  calls: { name: string; success: boolean; text: string }[];
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], passed: false };

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
/** The database connection, read at each use: `initialize` opens it, so a handle taken before that is closed. */
const connection = () => store.database.connection;

// The skill library is the real one. Installing is faked, because the marketplace service needs the whole app; the
// adapter that calls it is the real `localSkillTools`.
// The hook runs once, right before a create reads the folder, so a test can change a file there and the archive holds
// text that the person did not approve. It is the seam between the gate and the archive step.
let beforeArchive: (() => Promise<void>) | null = null;
class SeamLibrary extends LocalSkillLibrary {
  override create(agentId: string, sourcePath: string, approvedSha256?: string) {
    return Effect.promise(async () => {
      const hook = beforeArchive;
      beforeArchive = null;
      await hook?.();
    }).pipe(Effect.flatMap(() => super.create(agentId, sourcePath, approvedSha256)));
  }
}
const library = new SeamLibrary(join(root, "local-skills"), () => agents.listAgents());
const installs: { agentId: string; skillId: string; revision: number }[] = [];
const skillsService = {
  requireLocalLibrary: () => library,
  installLocal: (input: { agentId: string; skillId: string; revision: number }) => {
    installs.push(input);
    return Effect.succeed(input);
  },
  listInstalled: (agentId: string) => Effect.succeed(installs.filter((install) => install.agentId === agentId)),
  setEnabled: unused,
  uninstall: unused,
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the adapter reads only the five members above, not the class.
} as unknown as SkillMarketplaceService;

const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  // Full access: an instruction change or a skill still waits for the person.
  approvalAutomation: { autoApproves: () => true },
  localSkillTools: () => localSkillTools(skillsService),
});

/** The approval cards that the service shows, in order. */
const approvals: { requestId: string | number; reason: string | null }[] = [];
/** The plan cards that the service shows, in order: the prompts that `acknowledge_request` raises. */
const prompts: { requestId: string | number; questionId: string | undefined }[] = [];
agents.on("event", (event) => {
  if (event.type === "approval") approvals.push({ requestId: event.approval.requestId, reason: event.approval.reason });
  if (event.type === "prompt") prompts.push({ requestId: event.requestId, questionId: event.questions[0]?.id });
});

/** The outcome of one logged tool call. */
function outcomeOf(entry: ToolLog): CallOutcome {
  return {
    success: entry.result?.success === true,
    text: entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error),
  };
}

/** Reads the tool result that the fake logged at the given index, and records it. */
async function logged(name: string, before: number): Promise<CallOutcome> {
  const outcome = outcomeOf(await waitFor(`${name} tool result`, () => toolLogs()[before]));
  report.calls.push({ name, ...outcome });
  return outcome;
}

/** The message that makes the fake call each tool in order. `plan` adds the finished plan that a skill draft needs. */
function callText(calls: { tool: string; args: CallArguments }[], plan = false): string {
  const encoded = calls.map(({ tool, args }) => {
    const payload = Buffer.from(JSON.stringify({ __tool: tool, ...args })).toString("base64");
    return `${CALL_MARK} <<ARGS${payload}ARGS>>`;
  });
  return `${plan ? `${PLAN_MARK} ` : ""}${encoded.join(" ")}`;
}

/** Sends a message to the agent's chat that makes the fake call `tool` with `args`. */
async function callFromChat(name: string, agentId: string, tool: string, args: CallArguments): Promise<CallOutcome> {
  const before = toolLogs().length;
  await runCauseEffect(agents.sendMessage({ agentId, text: callText([{ tool, args }]) }));
  const outcome = await logged(name, before);
  await waitFor("the chat turn to end", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
  return outcome;
}

/** Starts a proposal and waits for its approval card, without answering. The caller answers the card. */
async function proposeAndHold(name: string, agentId: string, tool: string, args: CallArguments) {
  const before = approvals.length;
  const outcome = callFromChat(name, agentId, tool, args);
  const card = await waitFor(`${name} approval`, () => approvals[before]);
  return { card, outcome, asked: () => approvals.length - before };
}

/** Starts a proposal, waits for its turn to end, and returns its outcome with the cards it raised. */
async function proposeWithoutCard(name: string, agentId: string, tool: string, args: CallArguments) {
  const before = approvals.length;
  const outcome = await callFromChat(name, agentId, tool, args);
  return { outcome, asked: approvals.length - before };
}

/** The plan that `acknowledge_request` shows at the start of each task turn of this check. */
const PLAN_CARD_ARGS = {
  message: "On it. This is my plan for the draft.",
  steps: [
    { label: "First", step: "Read the notes." },
    { label: "Then", step: "Write the draft." },
  ],
  startLabel: "Start the work",
  cancelLabel: "Cancel",
};

/**
 * What the person does with the plan card of a task turn: `person` presses its start button, `timer` leaves it to
 * the host's wait, and `none` shows no plan card at all.
 * `local` has a local script answer the card first: that answer must be refused, and then the person presses start.
 */
type PlanCard = "person" | "timer" | "none" | "local";

/**
 * Starts a task whose first turn holds a finished two-step plan, then makes `calls` in order. `draft` answers the
 * approval card of a skill draft with `accept` or `decline`, or is null when the turn should raise no card.
 * `whileWaiting` runs once that card is up, before it is answered. Returns the outcome of each call and the reason
 * of each approval card the turn raised.
 */
async function taskTurn(
  name: string,
  agentId: string,
  calls: { tool: string; args: CallArguments }[],
  options: { plan: PlanCard; draft: "accept" | "decline" | null; whileWaiting?: () => Promise<void>; ask?: string },
): Promise<{ outcomes: CallOutcome[]; reasons: (string | null)[]; localPlanRefused: boolean | null }> {
  const logBefore = toolLogs().length;
  const approvalsBefore = approvals.length;
  const promptsBefore = prompts.length;
  const planCalls = options.plan === "none" ? [] : [{ tool: "acknowledge_request", args: PLAN_CARD_ARGS }];
  await runCauseEffect(agents.startTask({ agentId, text: callText([...planCalls, ...calls], true) }));
  let localPlanRefused: boolean | null = null;
  if (options.plan === "person" || options.plan === "local") {
    const card = await waitFor(`${name} plan card`, () => prompts[promptsBefore]);
    const answers = { [card.questionId ?? ""]: [PLAN_CARD_ARGS.startLabel] };
    if (options.plan === "local") {
      // The local script's answer must be refused, and the card keeps waiting for the person.
      const handle = agents
        .getLocalAttention(agentId)
        .prompts.find((prompt) => prompt.questions.some((question) => question.id === card.questionId))?.requestId;
      localPlanRefused = await runCauseEffect(
        agents.respondToLocalAttention(agentId, { kind: "prompt", requestId: handle ?? "", answers }),
      ).then(
        () => false,
        () => true,
      );
    }
    // A card that a local script answered is already answered, so the person's press does not apply.
    if (localPlanRefused !== false)
      await runCauseEffect(agents.respondToPrompt({ requestId: card.requestId, answers }));
  }
  if (options.ask !== undefined) {
    // The ask_ui block comes after the plan card of this turn, when there is one.
    const card = await waitFor(`${name} ask card`, () => prompts[promptsBefore + (options.plan === "none" ? 0 : 1)]);
    const answers = { [card.questionId ?? ""]: [options.ask] };
    await runCauseEffect(agents.respondToPrompt({ requestId: card.requestId, answers }));
  }
  if (options.draft !== null) {
    const card = await waitFor(`${name} approval`, () => approvals[approvalsBefore]);
    await options.whileWaiting?.();
    await runCauseEffect(agents.respondToApproval({ requestId: card.requestId, decision: options.draft }));
  }
  const expected = logBefore + planCalls.length + calls.length;
  await waitFor(`${name} tool results`, () => toolLogs().length >= expected);
  await waitFor(`${name} turn`, () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
  const outcomes = toolLogs()
    .slice(logBefore + planCalls.length)
    .map(outcomeOf);
  for (const [index, outcome] of outcomes.entries()) {
    report.calls.push({ name: `${name}: ${calls[index]?.tool ?? "?"}`, ...outcome });
  }
  return { outcomes, reasons: approvals.slice(approvalsBefore).map((card) => card.reason), localPlanRefused };
}

/** The instruction file of the agent's workspace. */
let workspace = "";
const readInstructions = () => readFile(join(workspace, "AGENTS.md"), "utf8");

/** The instruction snapshots of the agent, newest first, as the rows the history keeps. */
const snapshotRows = (agentId: string) =>
  connection()
    .prepare(
      "SELECT text, sha256 FROM agent_instructions_snapshots WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .all(agentId)
    .map((row) => ({ text: String(row.text), sha256: String(row.sha256) }));

/** Replaces the agent's recorded turns with these outcomes, newest first. */
function seedOutcomes(agentId: string, outcomes: readonly ("completed" | "failed")[]): void {
  connection().prepare("DELETE FROM turn_outcomes WHERE agent_id = ?").run(agentId);
  outcomes.forEach((outcome, index) => {
    // Earlier index, later time: the first entry is the newest turn.
    const createdAt = new Date(Date.UTC(2020, 0, 1) + (outcomes.length - index) * 1000).toISOString();
    connection()
      .prepare(
        `INSERT INTO turn_outcomes (agent_id, thread_id, turn_id, outcome, cause_code, tool_failures,
           tool_failure_codes_json, approvals_accepted, approvals_declined, reactions_present, memory_changes,
           skill_loads, created_at)
         VALUES (?, 'seed-thread', ?, ?, ?, 0, '{}', 0, 0, 0, 0, 0, ?)`,
      )
      .run(agentId, `seed-turn-${index}`, outcome, outcome === "failed" ? "seed_failure" : null, createdAt);
  });
}

/** Five failed turns in the newest ten, and none in the ten before: a rise the replay must refuse. */
const RISING = [
  "failed",
  "failed",
  "failed",
  "failed",
  "failed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  ...Array.from({ length: 10 }, () => "completed" as const),
] as const;
/** No failed turn at all: no regression. */
const STEADY = Array.from({ length: 20 }, () => "completed" as const);

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Keeps standing rules and drafts skills.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s thread`, () => store.list().find((entry) => entry.id === agent.id)?.threadId);
  await waitFor(
    `${name}'s first turn`,
    () => agents.listQueue(agent.id).deliveries.every((delivery) => delivery.status !== "running") || null,
  );
  return agent;
}

/** Writes a skill folder with SKILL.md and one script. The script writes a marker file if anything runs it. */
async function writeDraft(folder: string, extra: Record<string, string>, base = workspace) {
  const dir = join(base, folder);
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${DRAFT_NAME}\ndescription: Sorts incoming notes by urgency.\n---\nSort the notes by urgency, then reply with the top three.\n`,
  );
  await writeFile(join(dir, "scripts", "run.sh"), `#!/bin/sh\nprintf ran > '${RAN_MARKER}'\n`);
  for (const [name, text] of Object.entries(extra)) await writeFile(join(dir, name), text);
}

try {
  await runCauseEffect(agents.initialize());
  const alpha = await createAgent("Alpha");
  const agent = agents.listAgents().find((entry) => entry.id === alpha.id);
  if (!agent) throw new Error("The agent is not listed.");
  workspace = agent.workspacePath;
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), OLD_TEXT, { mode: 0o600 });
  await runCauseEffect(agents.updateAgent({ agentId: alpha.id, quickAcknowledgement: true }));
  const history = { agentId: alpha.id, database: connection() };
  // N. A new agent has too few recorded turns for the replay to judge its changes, so neither proposal is offered: no
  // card is raised. The agent of the checks below gets a full history first, so its own changes can be judged.
  seedOutcomes(alpha.id, STEADY);
  const newcomer = await createAgent("Newcomer");
  const newcomerEntry = agents.listAgents().find((entry) => entry.id === newcomer.id);
  if (!newcomerEntry) throw new Error("The new agent is not listed.");
  await mkdir(newcomerEntry.workspacePath, { recursive: true });
  await runCauseEffect(agents.updateAgent({ agentId: newcomer.id, quickAcknowledgement: true }));
  const newcomerChange = await proposeWithoutCard(
    "a new agent proposes an instruction change",
    newcomer.id,
    "propose_instructions_change",
    { text: NEW_TEXT },
  );
  pass(
    "A new agent's instruction change is refused for insufficient evidence, with no approval card",
    !newcomerChange.outcome.success &&
      newcomerChange.asked === 0 &&
      newcomerChange.outcome.text.includes("Insufficient evidence"),
    { cards: newcomerChange.asked, text: newcomerChange.outcome.text },
  );
  await writeDraft(DRAFT_FOLDER, {}, newcomerEntry.workspacePath);
  const newcomerDraft = await taskTurn(
    "a skill draft from a new agent",
    newcomer.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    { plan: "person", draft: null },
  );
  const newcomerDraftOutcome = newcomerDraft.outcomes[0];
  pass(
    "A new agent's skill draft is refused for insufficient evidence, with no approval card, and nothing is installed",
    newcomerDraftOutcome?.success === false &&
      newcomerDraft.reasons.length === 0 &&
      installs.length === 0 &&
      (newcomerDraftOutcome?.text.includes("Insufficient evidence") ?? false),
    { cards: newcomerDraft.reasons.length, text: newcomerDraftOutcome?.text },
  );

  // A. A proposal waits for the person: its card shows the diff, nothing is written while it waits, and a decline keeps it.
  const held = await proposeAndHold("propose an instruction change", alpha.id, "propose_instructions_change", {
    text: NEW_TEXT,
  });
  pass(
    "The card for an instruction change shows the file and the changed line",
    (held.card.reason ?? "").includes("Change to AGENTS.md") &&
      (held.card.reason ?? "").includes("+ - Ask before deleting files."),
    { reason: held.card.reason },
  );
  pass("An instruction change is not written while its card waits", (await readInstructions()) === OLD_TEXT);
  pass("No snapshot is kept before a change is applied", snapshotRows(alpha.id).length === 0);
  await runCauseEffect(agents.respondToApproval({ requestId: held.card.requestId, decision: "decline" }));
  const declined = await held.outcome;
  pass(
    "A declined instruction change is not written and answers with approval_required",
    !declined.success && declined.text.includes('"approval_required"') && (await readInstructions()) === OLD_TEXT,
    declined.text,
  );
  pass("A declined instruction change keeps no snapshot", snapshotRows(alpha.id).length === 0);

  // F1. A text with a secret is refused before any card: nothing is shown, written or kept.
  const secretProposal = await proposeWithoutCard(
    "propose an instruction change with a secret",
    alpha.id,
    "propose_instructions_change",
    { text: SECRET_TEXT },
  );
  pass(
    "An instruction change with a secret is refused with no approval card",
    !secretProposal.outcome.success &&
      secretProposal.asked === 0 &&
      secretProposal.outcome.text.includes("holds a secret"),
    { cards: secretProposal.asked, text: secretProposal.outcome.text },
  );
  pass(
    "A refused secret change is not written and not stored",
    (await readInstructions()) === OLD_TEXT &&
      snapshotRows(alpha.id).length === 0 &&
      !JSON.stringify(connection().prepare("SELECT text FROM agent_instructions_snapshots").all()).includes(SECRET),
  );

  // B. A person's accept does not apply the change when the replay shows a rise in failed turns.
  seedOutcomes(alpha.id, RISING);
  const regressed = await proposeAndHold("propose a change during a rise", alpha.id, "propose_instructions_change", {
    text: NEW_TEXT,
  });
  await runCauseEffect(agents.respondToApproval({ requestId: regressed.card.requestId, decision: "accept" }));
  const regressedOutcome = await regressed.outcome;
  pass(
    "A person's accept with a replay regression is refused and the file stays",
    !regressedOutcome.success &&
      regressedOutcome.text.includes("Recent turns show more failed turns") &&
      (await readInstructions()) === OLD_TEXT,
    regressedOutcome.text,
  );
  pass("A replay refusal keeps no snapshot", snapshotRows(alpha.id).length === 0);

  // D. A local responder (a script on this computer) cannot approve the agent's own change.
  seedOutcomes(alpha.id, STEADY);
  const local = await proposeAndHold(
    "propose a change for the local responder",
    alpha.id,
    "propose_instructions_change",
    {
      text: SECOND_TEXT,
    },
  );
  const listedForLocal = agents
    .getLocalAttention(alpha.id)
    .approvals.some((approval) => approval.reason === local.card.reason);
  pass("A change card is not listed for a local responder", !listedForLocal);
  const localAccepted = await runCauseEffect(
    agents.respondToLocalAttention(alpha.id, {
      kind: "approval",
      requestId: String(local.card.requestId),
      decision: "accept",
    }),
  ).then(
    () => true,
    () => false,
  );
  pass("A local responder's accept of a change card is refused", !localAccepted);
  pass("A local responder's refused accept writes nothing", (await readInstructions()) === OLD_TEXT);
  await runCauseEffect(agents.respondToApproval({ requestId: local.card.requestId, decision: "decline" }));
  await local.outcome;

  // C. A person's accept with no regression applies the change once, records it, and rolls back by hash.
  const applied = await proposeAndHold("propose a change with no regression", alpha.id, "propose_instructions_change", {
    text: NEW_TEXT,
  });
  await runCauseEffect(agents.respondToApproval({ requestId: applied.card.requestId, decision: "accept" }));
  const appliedOutcome = await applied.outcome;
  pass(
    "A person's accept with no regression applies the change",
    appliedOutcome.success &&
      appliedOutcome.text.includes('"status":"applied"') &&
      (await readInstructions()) === NEW_TEXT,
    appliedOutcome.text,
  );
  const rows = snapshotRows(alpha.id);
  pass(
    "The applied change keeps the replaced text in the instruction history, by its hash",
    rows.length === 1 && rows[0]?.text === OLD_TEXT && rows[0]?.sha256 === instructionsTextSha256(OLD_TEXT),
    { snapshots: rows.length },
  );
  const again = await runCauseEffect(
    agents.respondToApproval({ requestId: applied.card.requestId, decision: "accept" }),
  ).then(
    () => true,
    () => false,
  );
  pass("A decided change cannot be applied a second time", !again && snapshotRows(alpha.id).length === 1);
  await Effect.runPromise(
    restoreAgentInstructionsSnapshot(
      workspace,
      instructionsTextSha256(OLD_TEXT),
      history,
      instructionsTextSha256(NEW_TEXT),
    ),
  );
  pass("A rollback by hash restores the previous text", (await readInstructions()) === OLD_TEXT);

  // E0. A skill draft needs a finished plan: without one, nothing is asked.
  await writeDraft(DRAFT_FOLDER, {});
  const noPlan = await proposeWithoutCard("propose a skill with no plan", alpha.id, "propose_skill", {
    sourcePath: DRAFT_FOLDER,
  });
  pass(
    "A skill draft without a finished plan is refused with no approval card",
    !noPlan.outcome.success && noPlan.asked === 0 && noPlan.outcome.text.includes("finished task"),
    { cards: noPlan.asked, text: noPlan.outcome.text },
  );

  // P. A skill draft needs the person's approval of the plan it comes from. The plan is finished in every case, so the
  // check reaches the approval: a plan that nobody started is refused with no card, and so is a plan that the host
  // started when its wait ran out. An agent's claim in its arguments is refused too.
  const unapproved = await taskTurn(
    "a skill draft from a plan nobody started",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    { plan: "none", draft: null },
  );
  const unapprovedOutcome = unapproved.outcomes[0];
  pass(
    "A skill draft from a finished plan that the person did not start is refused with no approval card",
    unapprovedOutcome?.success === false &&
      unapproved.reasons.length === 0 &&
      (unapprovedOutcome?.text.includes("needs the person's approval") ?? false),
    { cards: unapproved.reasons.length, text: unapprovedOutcome?.text },
  );
  pass("A skill draft without the person's approval is not installed", installs.length === 0);

  const timed = await taskTurn(
    "a skill draft after a plan the host started",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    { plan: "timer", draft: null },
  );
  const timedOutcome = timed.outcomes[0];
  pass(
    "A plan that the host started at the end of its wait does not approve a skill draft",
    timedOutcome?.success === false &&
      timed.reasons.length === 0 &&
      (timedOutcome?.text.includes("needs the person's approval") ?? false),
    { cards: timed.reasons.length, text: timedOutcome?.text },
  );
  pass("A skill draft after the host's start is not installed", installs.length === 0);

  const claimed = await taskTurn(
    "a skill draft that claims the plan is approved",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER, planApproved: true } }],
    { plan: "none", draft: null },
  );
  const claimedOutcome = claimed.outcomes[0];
  pass(
    "The agent cannot record the plan approval itself: a claim in its arguments is refused with no card",
    claimedOutcome?.success === false && claimed.reasons.length === 0,
    { cards: claimed.reasons.length, text: claimedOutcome?.text },
  );
  pass("A claimed plan approval installs nothing", installs.length === 0);

  // P2. A plan card that a local script tries to answer does not start the work: that answer is refused, and the
  // person's start counts. An ask_ui block with a button named start does not count.
  const localPlan = await taskTurn(
    "a skill draft after a plan card that a local script tries to answer",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    { plan: "local", draft: "decline" },
  );
  pass("A local script's answer to a plan card is refused", localPlan.localPlanRefused === true, {
    refused: localPlan.localPlanRefused,
  });
  pass("The person's start of the plan card raises the approval card of the draft", localPlan.reasons.length === 1, {
    cards: localPlan.reasons.length,
  });
  const askStart = await taskTurn(
    "a skill draft after an ask_ui button named start",
    alpha.id,
    [
      {
        tool: "ask_ui",
        args: {
          block: {
            type: "confirm",
            title: "Start the draft?",
            actions: [{ id: "start", label: "Start", style: "primary" }],
          },
        },
      },
      { tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } },
    ],
    { plan: "none", draft: null, ask: "Start" },
  );
  const askDraft = askStart.outcomes[1];
  pass(
    "An ask_ui button named start does not approve a skill draft: it is refused with no approval card",
    askDraft?.success === false &&
      askStart.reasons.length === 0 &&
      (askDraft?.text.includes("needs the person's approval") ?? false),
    { cards: askStart.reasons.length, text: askDraft?.text },
  );
  pass("An ask_ui start does not install the draft", installs.length === 0);

  // F2. A skill folder with a secret is refused before any card, and installs nothing. Its plan is one the person
  // started, so the check reaches the folder.
  await writeDraft(SECRET_FOLDER, { "notes.md": `Use ${SECRET} to reach the staging site.\n` });
  const secretDraft = await taskTurn(
    "a skill draft with a secret",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: SECRET_FOLDER } }],
    { plan: "person", draft: null },
  );
  const secretOutcome = secretDraft.outcomes[0];
  pass(
    "A skill draft with a secret is refused with no approval card",
    secretOutcome?.success === false &&
      secretDraft.reasons.length === 0 &&
      (secretOutcome?.text.includes("holds a secret") ?? false),
    { cards: secretDraft.reasons.length, text: secretOutcome?.text },
  );
  pass("A skill draft with a secret is not installed", installs.length === 0);

  // F3. A skill folder reached through a link to a folder outside the workspace is refused before any card, and the
  // text outside the workspace is never shown.
  const OUTSIDE_MARK = "OUTSIDE-DRAFT-TEXT-7f3a";
  const outsideRoot = join(root, "outside-draft");
  await mkdir(join(outsideRoot, "skill"), { recursive: true });
  await writeFile(join(outsideRoot, "skill", "SKILL.md"), `---\nname: Outside\n---\n${OUTSIDE_MARK}\n`);
  await symlink(outsideRoot, join(workspace, "linked"));
  const linked = await taskTurn(
    "a skill draft through a link to an outside folder",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: "linked/skill" } }],
    { plan: "person", draft: null },
  );
  const linkedOutcome = linked.outcomes[0];
  pass(
    "A skill draft under a link to a folder outside the workspace is refused with no approval card",
    linkedOutcome?.success === false &&
      linked.reasons.length === 0 &&
      (linkedOutcome?.text.includes("must be a folder inside your workspace") ?? false),
    { cards: linked.reasons.length, text: linkedOutcome?.text },
  );
  pass(
    "The text of a skill folder outside the workspace reaches no card or answer",
    approvals.every((approval) => !(approval.reason ?? "").includes(OUTSIDE_MARK)) &&
      !(linkedOutcome?.text.includes(OUTSIDE_MARK) ?? false),
  );

  // F4. A skill draft whose card would not fit in 8 KB is refused before any card.
  await writeDraft(BIG_FOLDER, { "notes.md": "n".repeat(9 * 1024) });
  const big = await taskTurn(
    "an oversized skill draft",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: BIG_FOLDER } }],
    { plan: "person", draft: null },
  );
  const bigOutcome = big.outcomes[0];
  pass(
    "A skill draft too big for the 8 KB card is refused with no approval card",
    bigOutcome?.success === false &&
      big.reasons.length === 0 &&
      (bigOutcome?.text.includes("too long for the person to review in one card") ?? false),
    { cards: big.reasons.length, text: bigOutcome?.text },
  );

  // E1. A skill draft that the person started the plan of is not installed unless the person accepts its card.
  seedOutcomes(alpha.id, STEADY);
  const draftDeclined = await taskTurn(
    "a skill draft that the person declines",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    {
      plan: "person",
      draft: "decline",
      whileWaiting: async () => {
        const reason = approvals.at(-1)?.reason ?? "";
        pass(
          "The card for a skill draft names the skill and its files",
          reason.includes(`New skill ${DRAFT_FOLDER}`) && reason.includes("SKILL.md"),
          { reason },
        );
        pass(
          "The card for a skill draft shows the text of SKILL.md",
          reason.includes("Sort the notes by urgency, then reply with the top three."),
          { reason },
        );
        pass("A skill draft is not installed while its card waits", installs.length === 0);
        pass(
          "A skill draft is not published while its card waits",
          (await runCauseEffect(library.list())).length === 0,
        );
      },
    },
  );
  const declinedOutcome = draftDeclined.outcomes[0];
  pass(
    "A declined skill draft is not installed",
    declinedOutcome?.success === false &&
      (declinedOutcome?.text.includes('"approval_required"') ?? false) &&
      installs.length === 0,
    declinedOutcome?.text,
  );

  // E1b. A skill folder that changes while its card waits is refused at accept, and nothing is installed.
  await writeDraft(CHANGED_FOLDER, {});
  const changed = await taskTurn(
    "a skill draft whose folder changes while its card waits",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: CHANGED_FOLDER } }],
    {
      plan: "person",
      draft: "accept",
      whileWaiting: async () => {
        await writeFile(
          join(workspace, CHANGED_FOLDER, "SKILL.md"),
          `---\nname: ${DRAFT_NAME}\ndescription: Sorts notes by age.\n---\nSort the notes by age.\n`,
        );
      },
    },
  );
  const changedOutcome = changed.outcomes[0];
  pass(
    "A skill draft whose folder changes after its card is shown is refused at accept, and nothing is installed",
    changedOutcome?.success === false &&
      (changedOutcome?.text.includes("changed while the draft waited") ?? false) &&
      installs.length === 0 &&
      (await runCauseEffect(library.list())).length === 0,
    { installs: installs.length, text: changedOutcome?.text },
  );

  // E1c. The seam: a file changes after the person accepts and before the archive step. The archive then holds text that
  // the person did not approve, so the draft is refused there, and nothing is published or installed.
  await writeDraft(SEAM_FOLDER, {});
  beforeArchive = () =>
    writeFile(
      join(workspace, SEAM_FOLDER, "SKILL.md"),
      `---\nname: ${DRAFT_NAME}\ndescription: Sorts notes by age.\n---\nSort the notes by age.\n`,
    );
  const seam = await taskTurn(
    "a skill draft that changes between accept and its archive",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: SEAM_FOLDER } }],
    { plan: "person", draft: "accept" },
  );
  const seamOutcome = seam.outcomes[0];
  pass(
    "A skill draft that changes between the accept and its archive is refused, and nothing is installed or published",
    seamOutcome?.success === false &&
      (seamOutcome?.text.includes("changed while the draft waited") ?? false) &&
      installs.length === 0 &&
      (await runCauseEffect(library.list())).length === 0,
    { installs: installs.length, text: seamOutcome?.text },
  );

  // E2. The same draft, after the person started its plan and accepts its card, is installed once, and its script is
  // never run.
  seedOutcomes(alpha.id, STEADY);
  const accepted = await taskTurn(
    "a skill draft that the person accepts",
    alpha.id,
    [{ tool: "propose_skill", args: { sourcePath: DRAFT_FOLDER } }],
    { plan: "person", draft: "accept" },
  );
  const installed = accepted.outcomes[0];
  pass(
    "An accepted skill draft is installed for the agent once",
    installed?.success === true && (installed.text.includes('"status":"installed"') ?? false) && installs.length === 1,
    { installs: installs.length, text: installed?.text },
  );
  pass(
    "The installed skill is the one published in the local library",
    installs[0]?.agentId === alpha.id && (await runCauseEffect(library.list())).length === 1,
  );
  pass("The draft's script was never run", !(await readFile(RAN_MARKER, "utf8").catch(() => null)));

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
