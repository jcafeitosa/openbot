// Checks the rollback of an agent's instruction file. A roster persist that omits an agent keeps that agent's
// instruction history, and only `hardDeleteAgent` removes its rows. The agent proposes a rollback by hash through
// `propose_instructions_rollback`; the card is owner-only, so a local responder cannot answer it, and it shows the
// changed lines, not the whole text. Only the owner's accept runs the restore, which keeps the text it replaces. A
// rollback to the absent-file state removes the file that a first write created. Runs the real agent service, tool
// router, attention registry and instruction history on a temporary profile with a fake Codex app-server, and
// answers each approval card as the person. `bun scripts/instructions-rollback-e2e.ts`. Writes
// .openbot-build/instructions-rollback-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/instructions-rollback-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-instructions-rollback-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

const OLD_TEXT = "# Rules\n- Reply in one short paragraph.\n";
const NEW_TEXT = "# Rules\n- Reply in one short paragraph.\n- Ask before deleting files.\n";
const CREATED_TEXT = "# Rules\n- Keep answers brief.\n";
const CALL_MARK = "INSTRUCTIONS-ROLLBACK-CALL";

// The Codex process and the stores read the home folder when their modules load, so the environment is set
// first and the service modules are imported dynamically after it.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });
registerSecretValue("instructions-rollback-e2e-secret");

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { ABSENT_INSTRUCTIONS_SHA256, instructionsTextSha256, recordInstructionsSnapshot } = await import(
  "../src/backend/instructions-history-store"
);
const { restoreAgentInstructionsSnapshot, saveAgentInstructionsFile } = await import(
  "../src/backend/agent/workspace-instructions"
);

/**
 * A Codex app-server with the methods that the service calls. A turn whose input holds
 * `INSTRUCTIONS-ROLLBACK-CALL <<ARGS<base64 JSON>ARGS>>` calls `openbot.<__tool>` with the rest of that JSON and ends
 * once the result is logged. Other turns answer "Done.". The arguments travel as base64 so that the packet's quoting
 * cannot change them.
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

interface CallArguments {
  sha256?: string;
  text?: string;
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
/** The database connection, read at each use: `initialize` opens it, so a handle taken before that is closed. */
const connection = () => store.database.connection;

const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  // Full access: a rollback still waits for the person, because its card is owner-only.
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
  const encoded = Buffer.from(JSON.stringify({ __tool: tool, ...args })).toString("base64");
  const text = `${CALL_MARK} <<ARGS${encoded}ARGS>>`;
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
 * Starts a proposal and waits for its approval card, without answering. The caller answers the card, then reads
 * the outcome of the call.
 */
async function proposeAndHold(name: string, agentId: string, tool: string, args: CallArguments) {
  const before = approvals.length;
  const outcome = callFromChat(name, agentId, tool, args);
  const card = await waitFor(`${name} approval`, () => approvals[before]);
  return { card, outcome };
}

/** The instruction file of the agent's workspace, or null when there is none. */
const readInstructions = (workspace: string) => readFile(join(workspace, "AGENTS.md"), "utf8").catch(() => null);

/** The instruction snapshots of the agent's file, newest first. */
const snapshotRows = (agentId: string) =>
  connection()
    .prepare(
      "SELECT text, sha256 FROM agent_instructions_snapshots WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .all(agentId)
    .map((row) => ({ text: String(row.text), sha256: String(row.sha256) }));

/** A count of the rows that a query selects for one agent. */
const countFor = (sql: string, agentId: string): number => Number(connection().prepare(sql).get(agentId)?.count ?? 0);

/** Gives the agent 20 completed turns, so that a proposal from it is offered to the person: the replay judges it. */
function seedSteadyHistory(agentId: string): void {
  connection().prepare("DELETE FROM turn_outcomes WHERE agent_id = ?").run(agentId);
  for (let index = 0; index < 20; index += 1) {
    connection()
      .prepare(
        `INSERT INTO turn_outcomes (agent_id, thread_id, turn_id, outcome, cause_code, tool_failures,
           tool_failure_codes_json, approvals_accepted, approvals_declined, reactions_present, memory_changes,
           skill_loads, created_at)
         VALUES (?, 'seed-thread', ?, 'completed', NULL, 0, '{}', 0, 0, 0, 0, 0, ?)`,
      )
      .run(agentId, `${agentId}-seed-${index}`, new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString());
  }
}

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Keeps standing rules.",
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
  const listed = agents.listAgents().find((entry) => entry.id === agent.id);
  if (!listed) throw new Error(`${name} is not listed.`);
  await mkdir(listed.workspacePath, { recursive: true });
  return listed;
}

try {
  await runCauseEffect(agents.initialize());
  const alpha = await createAgent("Alpha");
  const beta = await createAgent("Beta");
  const gamma = await createAgent("Gamma");
  const alphaFile = join(alpha.workspacePath, "AGENTS.md");
  await writeFile(alphaFile, OLD_TEXT, { mode: 0o600 });
  // The write path keeps the replaced text, as an agent's own change does.
  await Effect.runPromise(
    saveAgentInstructionsFile(alpha.workspacePath, NEW_TEXT, OLD_TEXT, {
      agentId: alpha.id,
      database: connection(),
    }),
  );
  const oldSha = instructionsTextSha256(OLD_TEXT);
  // The replay judges a change only with 20 recorded turns, so the agents that propose rollbacks here get that history.
  seedSteadyHistory(alpha.id);
  seedSteadyHistory(gamma.id);

  // (a) A roster persist that omits an agent keeps that agent's instruction history.
  recordInstructionsSnapshot(connection(), { agentId: beta.id, filePath: "AGENTS.md", text: "# Beta rules\n" });
  const betaHistoryBefore = countFor(
    "SELECT COUNT(*) AS count FROM agent_instructions_snapshots WHERE agent_id = ?",
    beta.id,
  );
  store.database.replaceAgents(
    "instructions-rollback-e2e:roster-omits-beta",
    agents.listAgents().filter((agent) => agent.id !== beta.id),
    "agents.updated",
  );
  const betaHistoryAfter = countFor(
    "SELECT COUNT(*) AS count FROM agent_instructions_snapshots WHERE agent_id = ?",
    beta.id,
  );
  const betaRowAfter = countFor("SELECT COUNT(*) AS count FROM projection_agents WHERE agent_id = ?", beta.id);
  pass(
    "(a) A roster persist that omits an agent keeps that agent's instruction snapshots",
    betaHistoryBefore === 1 && betaHistoryAfter === 1 && betaRowAfter === 1,
    { before: betaHistoryBefore, after: betaHistoryAfter, agentRow: betaRowAfter },
  );

  // (b) Only the explicit hard delete removes the agent's rows, and its history with them.
  await runCauseEffect(agents.deleteAgent(beta.id));
  const betaRowDeleted = countFor("SELECT COUNT(*) AS count FROM projection_agents WHERE agent_id = ?", beta.id);
  const betaHistoryDeleted = countFor(
    "SELECT COUNT(*) AS count FROM agent_instructions_snapshots WHERE agent_id = ?",
    beta.id,
  );
  pass(
    "(b) hardDeleteAgent still removes the agent's rows and its history",
    betaRowDeleted === 0 && betaHistoryDeleted === 0 && !agents.listAgents().some((agent) => agent.id === beta.id),
    { agentRow: betaRowDeleted, history: betaHistoryDeleted },
  );

  // (c) The rollback card is owner-only: a local responder cannot answer it and the file keeps its text.
  const held = await proposeAndHold(
    "propose a rollback to the earlier text",
    alpha.id,
    "propose_instructions_rollback",
    {
      sha256: oldSha,
    },
  );
  pass(
    "The rollback card names the file and shows only the changed lines, not the whole text",
    (held.card.reason ?? "").includes("Restore AGENTS.md") &&
      (held.card.reason ?? "").includes("- - Ask before deleting files.") &&
      !(held.card.reason ?? "").includes("Reply in one short paragraph"),
    { reason: held.card.reason },
  );
  pass(
    "The rollback card is not listed for a local responder",
    !agents.getLocalAttention(alpha.id).approvals.some((approval) => approval.reason === held.card.reason),
  );
  const localAccepted = await runCauseEffect(
    agents.respondToLocalAttention(alpha.id, {
      kind: "approval",
      requestId: String(held.card.requestId),
      decision: "accept",
    }),
  ).then(
    () => true,
    () => false,
  );
  pass("(c) A local responder's accept of the rollback card is refused", !localAccepted);
  pass(
    "(c) A local responder's refused accept leaves the file as it was",
    (await readInstructions(alpha.workspacePath)) === NEW_TEXT,
  );

  // (d) The owner's accept restores the chosen text and keeps the text it replaces.
  await runCauseEffect(agents.respondToApproval({ requestId: held.card.requestId, decision: "accept" }));
  const restored = await held.outcome;
  pass(
    "(d) An owner's accept restores the chosen snapshot",
    restored.success &&
      restored.text.includes('"status":"applied"') &&
      (await readInstructions(alpha.workspacePath)) === OLD_TEXT,
    restored.text,
  );
  const alphaRows = snapshotRows(alpha.id);
  pass(
    "(d) The restore records a new snapshot of the text it replaced",
    alphaRows[0]?.text === NEW_TEXT && alphaRows[0]?.sha256 === instructionsTextSha256(NEW_TEXT),
    { newest: alphaRows[0]?.sha256 },
  );

  // (f) A change whose text holds a NUL character is refused before any card, and the file keeps its text. The
  // absent-file snapshot holds that character, so an agent's text must never take its place.
  const cardsBeforeNul = approvals.length;
  const nul = await callFromChat("propose a change with a NUL character", alpha.id, "propose_instructions_change", {
    text: `${NEW_TEXT}\u0000`,
  });
  pass(
    "(f) A change whose text holds a NUL character is refused with no card, and the file keeps its text",
    !nul.success && approvals.length === cardsBeforeNul && (await readInstructions(alpha.workspacePath)) === OLD_TEXT,
    { cards: approvals.length - cardsBeforeNul, text: nul.text },
  );

  // (e) A rollback to the absent-file state removes the file that a first write created.
  await mkdir(gamma.workspacePath, { recursive: true });
  await Effect.runPromise(
    saveAgentInstructionsFile(gamma.workspacePath, CREATED_TEXT, "", { agentId: gamma.id, database: connection() }),
  );
  pass(
    "The first write of a new AGENTS.md keeps the absent state, by its hash",
    snapshotRows(gamma.id)[0]?.sha256 === ABSENT_INSTRUCTIONS_SHA256 &&
      (await readInstructions(gamma.workspacePath)) === CREATED_TEXT,
    { newest: snapshotRows(gamma.id)[0]?.sha256 },
  );
  const removal = await proposeAndHold(
    "propose a rollback to the absent file",
    gamma.id,
    "propose_instructions_rollback",
    {
      sha256: ABSENT_INSTRUCTIONS_SHA256,
    },
  );
  pass("(e) The removal card names the file", (removal.card.reason ?? "").includes("Remove AGENTS.md"), {
    reason: removal.card.reason,
  });
  pass(
    "(e) The removal card shows the text that the removal deletes",
    (removal.card.reason ?? "").includes("--- AGENTS.md ---") &&
      (removal.card.reason ?? "").includes("- Keep answers brief."),
    { reason: removal.card.reason },
  );
  await runCauseEffect(agents.respondToApproval({ requestId: removal.card.requestId, decision: "accept" }));
  const removed = await removal.outcome;
  const gone = await stat(join(gamma.workspacePath, "AGENTS.md")).then(
    () => false,
    () => true,
  );
  pass(
    "(e) Restoring the absent-file snapshot removes the file",
    removed.success && removed.text.includes('"status":"applied"') && gone,
    removed.text,
  );
  pass("(e) The removed text is kept, so the removal can be undone", snapshotRows(gamma.id)[0]?.text === CREATED_TEXT);

  // (e2) A removal whose text is too big for the 8 KB card is refused with no card, and the file keeps its text.
  const delta = await createAgent("Delta");
  await mkdir(delta.workspacePath, { recursive: true });
  const DELTA_TEXT = "Keep answers brief and clear.\n".repeat(400);
  await Effect.runPromise(
    saveAgentInstructionsFile(delta.workspacePath, DELTA_TEXT, "", { agentId: delta.id, database: connection() }),
  );
  const cardsBeforeBig = approvals.length;
  const bigRemoval = await callFromChat(
    "propose a removal of a text too big for one card",
    delta.id,
    "propose_instructions_rollback",
    { sha256: ABSENT_INSTRUCTIONS_SHA256 },
  );
  pass(
    "(e2) A removal of a text too big for the 8 KB card is refused with no card, and the file keeps its text",
    !bigRemoval.success &&
      approvals.length === cardsBeforeBig &&
      bigRemoval.text.includes("too long for the person to review in one card") &&
      (await readInstructions(delta.workspacePath)) === DELTA_TEXT,
    { cards: approvals.length - cardsBeforeBig, text: bigRemoval.text },
  );

  // (g) A removal keeps a file that changed after its card was shown: the restore is given the hash of the text the
  // card showed, and the file holds other text now.
  await Effect.runPromise(
    saveAgentInstructionsFile(gamma.workspacePath, CREATED_TEXT, "", { agentId: gamma.id, database: connection() }),
  );
  const staleRemoval = await Effect.runPromise(
    restoreAgentInstructionsSnapshot(
      gamma.workspacePath,
      ABSENT_INSTRUCTIONS_SHA256,
      { agentId: gamma.id, database: connection() },
      instructionsTextSha256(OLD_TEXT),
    ),
  ).then(
    () => false,
    () => true,
  );
  pass(
    "(g) A removal is refused when the file no longer holds the text the card showed, and the file stays",
    staleRemoval && (await readInstructions(gamma.workspacePath)) === CREATED_TEXT,
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
