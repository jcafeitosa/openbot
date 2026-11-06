// Checks the person gate on cross-agent changes and the secret redaction of remembered text. Runs the real
// agent service, tool router, routine scheduler and memory store on a temporary profile with a fake Codex
// app-server. The check asserts that a teammate's message that makes an agent install a skill on, and
// create a routine for, another agent is refused, while the same calls from a person's message pass; that
// a remembered text holding a registered secret is not stored; and that a remembered text holding a known
// secret pattern is stored without its value. `bun scripts/autonomy-person-gate-e2e.ts`. Writes
// .openbot-build/autonomy-person-gate-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { LocalSkillTools } from "../src/backend/agent/skill-tools";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/autonomy-person-gate-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-person-gate-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// A value the owner registered as a secret, and a known secret pattern that the text rules mask.
const SECRET = "ghp_E2ESecretValue2026";
const PATTERN_SECRET = "sk-e2e-abcdef1234567890";
registerSecretValue(SECRET);

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

const rememberCalls = [
  { tool: "remember", arguments: { text: `The deploy token is ${SECRET}.` } },
  { tool: "remember", arguments: { text: `The CI cache key is api_key=${PATTERN_SECRET}.` } },
];

/**
 * A Codex app-server with the methods that the service calls. A turn calls, in order, the tools its input
 * asks for:
 * - `RELAY:<agentId> PLAN:<name> TARGET:<agentId>` in a person's message makes the agent send
 *   `PLAN:<name> TARGET:<agentId>` to that teammate, as an injected teammate message;
 * - `PLAN:person TARGET:<agentId>` or `PLAN:injected TARGET:<agentId>` makes the agent install a skill on
 *   and create a routine for the target;
 * - `PLAN:remember` makes the agent remember two texts.
 * - `PLAN:selfroutine TARGET:<agentId>` in a person's message creates a routine on that agent, whose instruction is
 *   `PLAN:routine TARGET:<agentId>`; a routine run of it makes the agent try to install, create, update and enable on itself;
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const REMEMBER = ${JSON.stringify(rememberCalls)};
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
const peerCalls = (agentId, name) => [
  { tool: "install_local_skill", arguments: { agentId, skillId: "local-skill-00000000-0000-0000-0000-000000000000", revision: 1 } },
  { tool: "create_routine", arguments: { agentId, name, instruction: "Check the peer.", schedule: { kind: "daily", time: "09:00" }, active: false, timezone: "UTC" } },
];
const callsFor = (text) => {
  // A routine run's prompt carries the chat history before its task: only the task's own text names a plan.
  const scope = text.split("--- routine task ---").pop();
  const relay = /RELAY:(\\S+) (PLAN:\\w+ TARGET:\\S+)/.exec(scope);
  if (relay) return [{ tool: "send_message", arguments: { recipientAgentIds: [relay[1]], text: relay[2] } }];
  const plan = /PLAN:(\\w+)/.exec(scope);
  const target = /TARGET:(\\S+)/.exec(scope);
  if (!plan) return [];
  if (plan[1] === "remember") return REMEMBER.slice();
  if (plan[1] === "person" && target) return peerCalls(target[1], "Person peer check");
  if (plan[1] === "injected" && target) return peerCalls(target[1], "Injected peer check");
  if (plan[1] === "uninstall" && target) return [{ tool: "uninstall_skill", arguments: { agentId: target[1], skillId: "local-skill-00000000-0000-0000-0000-000000000000" } }];
  if (plan[1] === "selfroutine" && target) return [{ tool: "create_routine", arguments: { agentId: target[1], name: "Self routine", instruction: "Run the self check. PLAN:routine TARGET:" + target[1], schedule: { kind: "daily", time: "09:00" }, active: false, timezone: "UTC" } }];
  if (plan[1] === "routine" && target) return [
    { tool: "install_local_skill", arguments: { agentId: target[1], skillId: "local-skill-00000000-0000-0000-0000-000000000000", revision: 1 } },
    { tool: "create_routine", arguments: { agentId: target[1], name: "Routine run check", instruction: "Check.", schedule: { kind: "daily", time: "09:00" }, active: false, timezone: "UTC" } },
    { tool: "update_routine", arguments: { agentId: target[1], routineId: "routine-check", instruction: "Changed by a run." } },
    { tool: "set_skill_enabled", arguments: { agentId: target[1], skillId: "local-skill-00000000-0000-0000-0000-000000000000", enabled: true } },
  ];
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
  installs: number;
  results: { tool: string; success: boolean; text: string }[];
  stored: number;
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = { installs: 0, results: [], stored: 0, checks: [], passed: false };

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

/** The skill store of this check. It records each install that reaches it, then fails the call. */
const installs: Array<{ agentId: string; skillId: string }> = [];
const skillTools: LocalSkillTools = {
  create: unused,
  revise: unused,
  list: () => Effect.succeed([]),
  get: unused,
  install: (input) => {
    installs.push({ agentId: input.agentId, skillId: input.skillId });
    return Effect.die(new Error("The fake skill store recorded the install."));
  },
  listInstalled: () => Effect.succeed([]),
  setEnabled: unused,
  uninstall: unused,
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

/** The results of one tool that the fake's turns received, in the order the tool answered them. */
function toolResults(tool: string): ToolResult[] {
  return fakeEntries()
    .filter((entry) => entry.method === "tool-result" && entry.tool === tool)
    .map(
      (entry) =>
        entry.result ?? { success: false, contentItems: [{ type: "inputText", text: entry.error?.message ?? "" }] },
    );
}

const resultText = (result: ToolResult) => result.contentItems.map((item) => item.text).join("\n");

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
}

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

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
  localSkillTools: () => skillTools,
});

/** The approval cards that the service shows, in order. */
const approvals: { requestId: string | number; reason: string | null }[] = [];
agents.on("event", (event) => {
  if (event.type === "approval") approvals.push({ requestId: event.approval.requestId, reason: event.approval.reason });
});

const idle = (agentIds: string[]) =>
  agentIds.every((agentId) => agents.listQueue(agentId).deliveries.every((delivery) => ended(delivery.status)));

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Changes routines and skills.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s thread`, () => store.list().find((entry) => entry.id === agent.id)?.threadId);
  await waitFor(`${name}'s first turn`, () => idle([agent.id]) || null);
  return agent;
}

/** The texts that the agent's memory holds now. */
const rememberedTexts = (agentId: string): string[] =>
  store.database.connection
    .prepare("SELECT text FROM projection_agent_memories WHERE agent_id = ?")
    .all(agentId)
    .map((row) => String(row.text));

try {
  await runCauseEffect(agents.initialize());
  const alpha = await createAgent("Alpha");
  const bravo = await createAgent("Bravo");

  // A person's message asks Alpha to install a skill on Bravo and to create a routine for Bravo.
  await runCauseEffect(agents.sendMessage({ agentId: alpha.id, text: `Set up Bravo. PLAN:person TARGET:${bravo.id}` }));
  await waitFor("the person's calls", () =>
    toolResults("install_local_skill").length >= 1 && toolResults("create_routine").length >= 1 && idle([alpha.id])
      ? true
      : null,
  );
  const [personInstall] = toolResults("install_local_skill");
  const [personCreate] = toolResults("create_routine");
  pass(
    "A person's message reaches the skill store for a peer",
    installs.length === 1 &&
      installs[0]?.agentId === bravo.id &&
      personInstall !== undefined &&
      resultText(personInstall).includes("recorded the install"),
    { installs, install: personInstall && resultText(personInstall) },
  );
  pass("A person's message can create a routine for a peer", personCreate?.success === true, {
    create: personCreate && resultText(personCreate),
  });

  // Bravo's turn sends Alpha the same two calls as a teammate's message: an injected agent turn.
  await runCauseEffect(
    agents.sendMessage({ agentId: bravo.id, text: `Pass it on. RELAY:${alpha.id} PLAN:injected TARGET:${bravo.id}` }),
  );
  await waitFor("the injected calls", () =>
    toolResults("install_local_skill").length >= 2 &&
    toolResults("create_routine").length >= 2 &&
    idle([alpha.id, bravo.id])
      ? true
      : null,
  );
  const [, injectedInstall] = toolResults("install_local_skill");
  const [, injectedCreate] = toolResults("create_routine");
  pass(
    "An injected install of a skill on a peer is refused",
    injectedInstall !== undefined &&
      !injectedInstall.success &&
      resultText(injectedInstall).includes("Only a person's message can install, enable or uninstall a skill"),
    { install: injectedInstall && resultText(injectedInstall) },
  );
  pass("The injected install never reaches the skill store", installs.length === 1, { installs });
  pass(
    "An injected routine create on a peer is refused",
    injectedCreate !== undefined &&
      !injectedCreate.success &&
      resultText(injectedCreate).includes("Only a person's message can create, change or delete a routine"),
    { create: injectedCreate && resultText(injectedCreate) },
  );

  // Alpha removes a skill of Bravo on a person's request. The uninstall is irreversible, so its preview comes first
  // as an approval card: the card appears, the person approves it, and the uninstall runs exactly once.
  const cardsBeforePerson = approvals.length;
  await runCauseEffect(agents.sendMessage({ agentId: alpha.id, text: `Remove it. PLAN:uninstall TARGET:${bravo.id}` }));
  const card = await waitFor("the person's uninstall card", () => approvals[cardsBeforePerson]);
  pass(
    "A person's uninstall raises one preview card",
    approvals.length === cardsBeforePerson + 1 &&
      (card.reason ?? "").startsWith("Dry run, not run yet: Uninstall a skill (uninstall_skill)"),
    { reason: card.reason },
  );
  await runCauseEffect(agents.respondToApproval({ requestId: card.requestId, decision: "accept" }));
  await waitFor("the person's uninstall", () =>
    toolResults("uninstall_skill").length >= 1 && idle([alpha.id]) ? true : null,
  );
  const [personUninstall] = toolResults("uninstall_skill");
  pass(
    "An approved person's uninstall reaches the uninstall lookup for a peer",
    personUninstall !== undefined && !resultText(personUninstall).includes("Only a person's message"),
    { uninstall: personUninstall && resultText(personUninstall) },
  );
  pass(
    "The approved uninstall runs exactly once",
    toolResults("uninstall_skill").length === 1 && approvals.length === cardsBeforePerson + 1,
    { calls: toolResults("uninstall_skill").length, cards: approvals.length - cardsBeforePerson },
  );

  // Bravo's turn asks Alpha to do the same as a teammate. A teammate's call is refused before any card.
  const cardsBeforeInjected = approvals.length;
  await runCauseEffect(
    agents.sendMessage({
      agentId: bravo.id,
      text: `Remove it too. RELAY:${alpha.id} PLAN:uninstall TARGET:${bravo.id}`,
    }),
  );
  await waitFor("the injected uninstall", () =>
    toolResults("uninstall_skill").length >= 2 && idle([alpha.id, bravo.id]) ? true : null,
  );
  const [, injectedUninstall] = toolResults("uninstall_skill");
  pass(
    "An injected uninstall of a skill on a peer is refused",
    injectedUninstall !== undefined &&
      !injectedUninstall.success &&
      resultText(injectedUninstall).includes("Only a person's message can install, enable or uninstall"),
    { uninstall: injectedUninstall && resultText(injectedUninstall) },
  );
  pass("The injected uninstall raises no approval card", approvals.length === cardsBeforeInjected, {
    cards: approvals.length - cardsBeforeInjected,
  });

  // A remembered text with a registered secret is refused; one with a known secret pattern is redacted.
  await runCauseEffect(agents.sendMessage({ agentId: alpha.id, text: "Remember the facts. PLAN:remember" }));
  const remembered = await waitFor("the remembered texts", () =>
    toolResults("remember").length >= 2 && idle([alpha.id]) && rememberedTexts(alpha.id).length >= 1
      ? rememberedTexts(alpha.id)
      : null,
  );
  pass(
    "A remembered text with a registered secret is not stored",
    remembered.every((text) => !text.includes(SECRET)),
    {
      stored: remembered,
    },
  );
  pass(
    "A remembered text with a known secret pattern is stored without its value",
    remembered.length === 1 &&
      !remembered[0]?.includes(PATTERN_SECRET) &&
      remembered[0]?.includes("[redacted]") === true,
    { stored: remembered },
  );

  // A routine run is not a person's message: on its own agent it still cannot create or update a routine, or install
  // or enable a skill.
  await runCauseEffect(
    agents.sendMessage({
      agentId: alpha.id,
      text: `Make a routine for this agent. PLAN:selfroutine TARGET:${alpha.id}`,
    }),
  );
  const selfRoutine = await waitFor(
    "the person's own routine",
    () => agents.listRoutines(alpha.id).find((routine) => routine.name === "Self routine") ?? null,
  );
  const before = {
    install: toolResults("install_local_skill").length,
    create: toolResults("create_routine").length,
    update: toolResults("update_routine").length,
    enable: toolResults("set_skill_enabled").length,
  };
  const installsBeforeRun = installs.length;
  await runCauseEffect(agents.testRoutine({ agentId: alpha.id, routineId: selfRoutine.id }));
  await waitFor("the routine run's calls", () =>
    toolResults("set_skill_enabled").length > before.enable && idle([alpha.id]) ? true : null,
  );
  const [runInstall] = toolResults("install_local_skill").slice(before.install);
  const [runCreate] = toolResults("create_routine").slice(before.create);
  const [runUpdate] = toolResults("update_routine").slice(before.update);
  const [runEnable] = toolResults("set_skill_enabled").slice(before.enable);
  pass(
    "A routine run cannot install a skill on its own agent",
    runInstall !== undefined &&
      !runInstall.success &&
      resultText(runInstall).includes("Only a person's message can install, enable or uninstall a skill"),
    { install: runInstall && resultText(runInstall) },
  );
  pass(
    "A routine run cannot create a routine on its own agent",
    runCreate !== undefined &&
      !runCreate.success &&
      resultText(runCreate).includes("Only a person's message can create, change or delete a routine"),
    { create: runCreate && resultText(runCreate) },
  );
  pass(
    "A routine run cannot update its own routine",
    runUpdate !== undefined &&
      !runUpdate.success &&
      resultText(runUpdate).includes("Only a person's message can create, change or delete a routine"),
    { update: runUpdate && resultText(runUpdate) },
  );
  pass(
    "A routine run cannot enable a skill on its own agent",
    runEnable !== undefined &&
      !runEnable.success &&
      resultText(runEnable).includes("Only a person's message can install, enable or uninstall a skill"),
    { enable: runEnable && resultText(runEnable) },
  );
  pass("A routine run's skill install never reaches the skill store", installs.length === installsBeforeRun, {
    installs,
  });

  report.installs = installs.length;
  report.stored = remembered.length;
  report.results = fakeEntries()
    .filter((entry) => entry.method === "tool-result")
    .map((entry) => {
      const result = entry.result ?? {
        success: false,
        contentItems: [{ type: "inputText", text: entry.error?.message ?? "" }],
      };
      return { tool: entry.tool ?? "", success: result.success, text: resultText(result) };
    });
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
