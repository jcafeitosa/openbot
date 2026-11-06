// Checks the dry-run gate on irreversible tools: a post to an external chat, a deleted memory, an
// uninstalled skill and a deleted routine wait for a person's approval of their preview and run only
// after "accept". A declined call runs nothing and answers with the preview; a secret in an argument
// stays out of the preview; a reversible memory read is not gated. Runs the real agent service, tool
// router, attention registry and memory store on a temporary profile with a fake Codex app-server, and
// answers each approval card as the person. `bun scripts/dry-run-gate-e2e.ts`. Writes
// .openbot-build/dry-run-gate-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/dry-run-gate-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-dry-run-gate-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// Not a known secret pattern and not registered: only the argument summary keeps it out of the preview.
const SECRET = "E2E-PLANTED-SECRET-5d1c";
const CALL_MARK = "DRY-RUN-CALL";
const PREVIEW_PREFIX = "Dry run, not run yet:";

// The Codex process and the stores read the home folder when their modules load, so the environment is
// set first and the service modules are imported dynamically after it.
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
 * A Codex app-server with the methods that the service calls. A turn whose input holds
 * `DRY-RUN-CALL <<ARGS<base64 JSON>ARGS>>` calls `openbot.<__tool>` directly with the rest of that JSON,
 * logs the result and ends. Other turns answer "Done.". The arguments travel as base64 so that the
 * packet's quoting cannot change them.
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
      const matches = text.includes(${JSON.stringify(CALL_MARK)}) ? [...text.matchAll(/<<ARGS([A-Za-z0-9+/=]*)ARGS>>/g)] : [];
      const match = matches.at(-1);
      if (!match) return setTimeout(() => finish(params.threadId, turnId), 20);
      const { __tool, ...args } = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId, tool: __tool });
      return write({
        id,
        method: "item/tool/call",
        params: { threadId: params.threadId, turnId, callId: "call-" + turnId, namespace: "openbot", tool: __tool, arguments: args },
      });
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
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

/** The input fields of the tools that this check calls. */
interface CallArguments {
  text?: string;
  memoryId?: string;
  connection?: string;
  place?: string;
  skillId?: string;
  agentId?: string;
  routineId?: string;
  query?: string;
  recipientAgentIds?: string[];
}

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
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  // Full access: an irreversible call must still wait for the person.
  approvalAutomation: { autoApproves: () => true },
});

/** The approval cards that the service shows, in order. */
const approvals: { requestId: string | number; reason: string | null }[] = [];
agents.on("event", (event) => {
  if (event.type === "approval") approvals.push({ requestId: event.approval.requestId, reason: event.approval.reason });
});

/** Reads the tool result that the fake logged after the given index. */
async function logged(name: string, before: number): Promise<CallOutcome> {
  const entry = await waitFor(`${name} tool result`, () => toolLogs()[before]);
  const text = entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error);
  const success = entry.result?.success === true;
  report.calls.push({ name, success, text });
  return { success, text };
}

/** Sends a message to the agent's chat that makes the fake call `tool` with `args`. */
async function callFromChat(name: string, agentId: string, tool: string, args: CallArguments): Promise<CallOutcome> {
  const before = toolLogs().length;
  const text = `${CALL_MARK} <<ARGS${Buffer.from(JSON.stringify({ __tool: tool, ...args })).toString("base64")}ARGS>>`;
  await runCauseEffect(agents.sendMessage({ agentId, text }));
  const outcome = await logged(name, before);
  await waitFor("the chat turn to end", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
  return outcome;
}

/**
 * Makes the call and answers its approval card as the person. Returns the outcome, the card's reason and
 * how many cards the call raised.
 */
async function callWithAnswer(
  name: string,
  agentId: string,
  tool: string,
  args: CallArguments,
  decision: "accept" | "decline",
) {
  const before = approvals.length;
  const outcome = callFromChat(name, agentId, tool, args);
  const approval = await waitFor(`${name} approval`, () => approvals[before]);
  await runCauseEffect(agents.respondToApproval({ requestId: approval.requestId, decision }));
  return { ...(await outcome), reason: approval.reason ?? "", asked: approvals.length - before };
}

/** The memory ids that the agent holds now. */
const memoryIds = (agentId: string): string[] =>
  store.database.connection
    .prepare("SELECT memory_id FROM projection_agent_memories WHERE agent_id = ?")
    .all(agentId)
    .map((row) => String(row.memory_id));

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Remembers and forgets facts.",
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

try {
  await runCauseEffect(agents.initialize());
  const alpha = await createAgent("Alpha");

  // A memory to forget. `remember` is reversible, so it runs without an approval card.
  await callFromChat("remember a fact", alpha.id, "remember", { text: "The deploy window is Tuesday." });
  const [memoryId] = memoryIds(alpha.id);
  pass("The memory to forget is saved", memoryId !== undefined, { memories: memoryIds(alpha.id) });

  // 1. Without approval: a declined forget_memory runs nothing and answers with the preview.
  const declined = await callWithAnswer(
    "forget without approval",
    alpha.id,
    "forget_memory",
    { memoryId: memoryId ?? "" },
    "decline",
  );
  pass(
    "A declined forget_memory answers with the preview and the approval code",
    !declined.success &&
      declined.text.includes('"approval_required"') &&
      declined.text.includes(`${PREVIEW_PREFIX} Delete an agent memory (forget_memory)`),
    declined.text,
  );
  pass("A declined forget_memory leaves the memory in place", memoryIds(alpha.id).includes(memoryId ?? ""), {
    memories: memoryIds(alpha.id),
  });
  pass("A declined forget_memory asked the person exactly once", declined.asked === 1, { asked: declined.asked });
  pass(
    "The approval card shows the same preview",
    declined.reason.startsWith(`${PREVIEW_PREFIX} Delete an agent memory`),
    { reason: declined.reason },
  );

  // 2. The same call after approval runs once.
  const accepted = await callWithAnswer(
    "forget after approval",
    alpha.id,
    "forget_memory",
    { memoryId: memoryId ?? "" },
    "accept",
  );
  pass("An accepted forget_memory is staged", accepted.success && accepted.text.includes("staged"), accepted.text);
  await waitFor("the approved memory to be forgotten", () =>
    memoryIds(alpha.id).includes(memoryId ?? "") ? null : true,
  );
  pass("The approved forget_memory asked the person exactly once", accepted.asked === 1, { asked: accepted.asked });
  const forgets = toolLogs().filter((entry) => entry.tool === "forget_memory" && entry.result?.success === true);
  pass("The approved forget_memory ran exactly once", forgets.length === 1, { successful: forgets.length });

  // 3. A secret in an argument stays out of the preview, both on the card and in the result.
  const withSecret = await callWithAnswer(
    "post with a secret argument",
    alpha.id,
    "messaging_post",
    { connection: "workspace-1", place: "general", text: `Deploy key ${SECRET}` },
    "decline",
  );
  pass(
    "A preview with a secret argument does not contain the secret",
    !withSecret.reason.includes(SECRET) && !withSecret.text.includes(SECRET),
    { reason: withSecret.reason, text: withSecret.text },
  );
  pass(
    "The preview names the post and summarizes its text argument by size",
    withSecret.reason.includes("Post a message to an external chat (messaging_post)") &&
      withSecret.reason.includes("text | text, "),
    { reason: withSecret.reason },
  );
  pass("A declined messaging_post answers with the approval code", withSecret.text.includes('"approval_required"'), {
    text: withSecret.text,
  });

  // 4. Every other listed irreversible tool waits for approval too.
  const others: [string, CallArguments][] = [
    ["uninstall_skill", { skillId: "local-skill-1" }],
    ["delete_routine", { agentId: alpha.id, routineId: "routine-1" }],
  ];
  for (const [tool, args] of others) {
    const held = await callWithAnswer(`${tool} without approval`, alpha.id, tool, args, "decline");
    pass(
      `${tool} is held for approval`,
      !held.success && held.text.includes('"approval_required"') && held.asked === 1,
      {
        text: held.text,
        asked: held.asked,
      },
    );
  }

  // A messaging_forget_memory outside an external chat is refused before any approval card.
  const askedBeforeLinkless = approvals.length;
  const linkless = await callFromChat("messaging_forget_memory outside a chat", alpha.id, "messaging_forget_memory", {
    memoryId: "external-memory-1",
  });
  pass(
    "A messaging_forget_memory outside an external chat is refused with no approval card",
    !linkless.success &&
      approvals.length === askedBeforeLinkless &&
      linkless.text.includes("Messaging tools work only in a turn that answers an external chat message."),
    { cards: approvals.length - askedBeforeLinkless, text: linkless.text },
  );

  // 5. A reversible memory read is not gated.
  const askedBeforeRead = approvals.length;
  const read = await callFromChat("memory read", alpha.id, "search_memories", { query: "deploy" });
  pass(
    "A reversible memory read raises no approval card",
    approvals.length === askedBeforeRead && !read.text.includes('"approval_required"'),
    { cards: approvals.length - askedBeforeRead, text: read.text },
  );

  // 6. An agent-initiated uninstall of another agent's skill is refused, and no approval card is raised for it.
  const bravo = await createAgent("Bravo");
  const encodeCall = (tool: string, args: CallArguments) =>
    `${CALL_MARK} <<ARGS${Buffer.from(JSON.stringify({ __tool: tool, ...args })).toString("base64")}ARGS>>`;
  const askedBeforeTeammate = approvals.length;
  const teammateCall = encodeCall("uninstall_skill", { agentId: bravo.id, skillId: "local-skill-1" });
  const relayed = encodeCall("send_message", { recipientAgentIds: [alpha.id], text: teammateCall });
  const beforeRelay = toolLogs().length;
  await runCauseEffect(agents.sendMessage({ agentId: bravo.id, text: relayed }));
  const uninstall = await waitFor("the teammate's uninstall", () =>
    toolLogs()
      .slice(beforeRelay)
      .find((entry) => entry.tool === "uninstall_skill"),
  );
  const uninstallText =
    uninstall.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(uninstall.error);
  pass(
    "An agent-initiated uninstall on another agent raises no approval card",
    approvals.length === askedBeforeTeammate,
    { cards: approvals.length - askedBeforeTeammate },
  );
  pass(
    "An agent-initiated uninstall on another agent is refused as a person-only change",
    uninstall.result?.success === false &&
      uninstallText.includes("Only a person's message can install, enable or uninstall a skill on another agent"),
    uninstallText,
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
