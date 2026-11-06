// Checks the reflection on a failed turn: when an agent's turn ends failed, one generation without tools
// reads the turn's error class and its redacted tool steps, and saves at most one lesson as an automatic
// memory. The lesson is searchable, never essential, and its source is the reflection's thread and turn.
// Runs the real agent service on a temporary profile with a fake Codex app-server. A turn whose message
// says FAIL_NOW runs a command step that fails and carries a seeded secret, then ends failed. A reflection
// generation is logged and answers the text in `control.json`. Checks:
//   1. A completed turn starts no reflection.
//   2. A failed turn starts one reflection. Its prompt marks the tool steps as untrusted data, shows the
//      error class and the redacted step, and has no seeded secret.
//   3. The reflection saves one searchable automatic lesson, the first of the model's answer. The lesson
//      has no seeded secret, even when the model answers one, and its source is the reflection's thread
//      and failed turn. The chat shows its change.
//   4. The failed turn shows no error.
// No provider, account or network is used. Run with `bun scripts/memory-reflection-e2e.ts`.
// Writes .openbot-build/memory-reflection-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, CONVERSATION_MEMORY_CHANGES_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/memory-reflection-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-memory-reflection-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const controlPath = join(root, "control.json");
const REFLECTION_MARKER = "You learn from one failed turn of the agent";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const FAIL_MARKER = "FAIL_NOW";

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const CONTROL = ${JSON.stringify(controlPath)};
const REFLECTION = ${JSON.stringify(REFLECTION_MARKER)};
const FAIL = ${JSON.stringify(FAIL_MARKER)};
const SECRET = ${JSON.stringify(SECRET)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn, text) => {
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const failTurn = (turn) => {
  // The failing command step carries the secret; the reflection must never see it.
  const command = { id: "command-" + turn.turnId, type: "commandExecution", command: "deploy --token " + SECRET, status: "failed", exitCode: 1 };
  write({ method: "item/started", params: { threadId: turn.threadId, turnId: turn.turnId, item: { ...command, status: "inProgress", exitCode: null } } });
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item: command } });
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text: "Failed.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "failed", error: { message: "The deploy failed." } } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [
      { model: "gpt-6-luna", displayName: "GPT-6 Luna" },
      { model: "gpt-6-astra", displayName: "GPT-6 Astra" },
    ] } });
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const turn = { threadId: params.threadId, turnId };
      if (text.includes(REFLECTION)) {
        const control = JSON.parse(fs.readFileSync(CONTROL, "utf8"));
        log({ method: "reflection", text, model: params.model });
        return setTimeout(() => finish(turn, control.answer), control.delayMs || 5);
      }
      const current = text.split("--- current message ---").at(-1);
      log({ method: "turn", text });
      if (current.includes(FAIL)) return setTimeout(() => failTurn(turn), 5);
      return setTimeout(() => finish(turn, "Done."), 5);
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
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = { checks: [], passed: false };

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

/** Waits for a state of the service, its database or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function logged(method: string): { text: string; model: string }[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): { method: string; text: string; model: string } => JSON.parse(line))
    .filter((entry) => entry.method === method);
}

function reflections(): string[] {
  return logged("reflection").map((entry) => entry.text);
}

function control(answer: unknown, delayMs = 5) {
  writeFileSync(
    controlPath,
    JSON.stringify({ answer: typeof answer === "string" ? answer : JSON.stringify(answer), delayMs }),
  );
}

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
control({ operations: [] });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  memoryReviewIdleMs: 60_000,
  memoryReviewInterval: () => 20,
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const events: AgentEvent[] = [];
service.on("event", (event) => events.push(event));

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

/** Creates an agent; its first message is a completed turn. */
async function createAgent(name: string) {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the reflection on a failed turn.",
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

/** Sends a message to the agent's own chat and waits for its turn to end. Answers the turn's status. */
async function send(agentId: string, text: string): Promise<string> {
  const receipt = await runCauseEffect(service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return waitFor(`"${text}" to end`, () => {
    const value = mailbox.getDelivery(deliveryId)?.delivery.status;
    return ended(value) ? value : null;
  });
}

function errorsFor(agentId: string, since: number) {
  return events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);
}

const settle = () => new Promise((done) => setTimeout(done, 300));

try {
  await runCauseEffect(service.initialize());

  const agent = await createAgent("Learner");
  const threadId = store.list().find((entry) => entry.id === agent.id)?.threadId ?? null;
  assert.ok(threadId, "The agent has its own chat.");

  await check("a completed turn starts no reflection", async () => {
    const status = await send(agent.id, "Plain message.");
    assert.equal(status, "completed", "The plain turn completes.");
    await settle();
    assert.equal(reflections().length, 0, "A completed turn starts no reflection.");
    return { status };
  });

  await check("a failed turn saves one searchable automatic lesson, without the secret", async () => {
    control({
      operations: [
        {
          type: "add",
          text: `The deploy command needs its token from the vault, not ${SECRET}.`,
          inclusion: "essential",
        },
        { type: "add", text: "A second lesson that must not be saved.", inclusion: "searchable" },
      ],
    });
    const since = events.length;
    const status = await send(agent.id, `${FAIL_MARKER} deploy the app.`);
    assert.equal(status, "failed", "The turn ends failed.");
    await waitFor("the reflection", () => reflections().length >= 1);
    await settle();
    assert.equal(reflections().length, 1, "One failed turn starts one reflection.");

    const prompt = reflections()[0] ?? "";
    assert.ok(prompt.includes("untrusted data"), "The prompt marks the tool steps as untrusted data.");
    assert.ok(prompt.includes("tool_failed"), "The prompt has the error class.");
    assert.ok(prompt.includes("deploy --token"), "The prompt has the redacted tool step.");
    assert.ok(!prompt.includes(SECRET), "The prompt has no seeded secret.");

    const saved = service.listMemories(agent.id);
    assert.equal(saved.length, 1, "Exactly one lesson is saved, the first of the answer.");
    const [lesson] = saved;
    assert.ok(lesson, "The lesson is saved.");
    assert.equal(lesson.origin, "automatic", "The lesson is automatic.");
    assert.ok(!lesson.text.includes(SECRET), "The stored lesson has no seeded secret.");
    assert.ok(lesson.text.includes("deploy command needs its token from the vault"), "The lesson is the first answer.");
    assert.ok(!saved.some((memory) => memory.text.includes("second lesson")), "The second answer is not saved.");

    const failedTurnId = database
      .readConversation(agent.id, threadId)
      .messages.find((message) => message.text === "Failed.")?.turnId;
    assert.ok(failedTurnId, "The failed turn has its answer.");
    const provenance = database.connection
      .prepare(
        "SELECT source_kind, source_thread_id, source_turn_id FROM projection_agent_memories WHERE memory_id = ?",
      )
      .get(lesson.id);
    assert.equal(provenance?.source_kind, "reflection", "The lesson's source kind is a reflection.");
    assert.equal(provenance?.source_thread_id, threadId, "The lesson's source is the reflection's thread.");
    assert.equal(provenance?.source_turn_id, failedTurnId, "The lesson's source is the failed turn, with no prefix.");

    const selection = service.getMemorySelection(agent.id).selections.find((entry) => entry.memoryId === lesson.id);
    assert.equal(selection?.inclusion, "searchable", "The lesson is never essential.");

    const lines = database
      .readConversation(agent.id, threadId)
      .messages.filter(
        (message) =>
          message.itemType === CONVERSATION_MEMORY_CHANGES_ITEM_TYPE && message.turnId?.startsWith("memory-review-"),
      );
    assert.equal(lines.length, 1, "The chat shows the lesson's change once.");
    assert.equal(errorsFor(agent.id, since).length, 0, "The failed turn shows no error.");
    return { lesson: lesson.text, source: lesson.sourceTurnId, inclusion: selection?.inclusion };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
