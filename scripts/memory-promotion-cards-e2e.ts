// Checks that a memory promotion's card survives a restart. An agent calls `promote_memory` in a channel's routine
// run; the proposal waits for a person, and its card is listed in the runtime attention of the agent service. The card
// is rebuilt from the pending `memory_proposals` row, so a restart of the service on the same database lists the same
// card with the same proposal id. Checks:
//   1. A pending promotion lists its card in the runtime attention, with the proposal id as its request id.
//   2. After the service is closed and reopened on the same database, the same card is listed again, unchanged.
//   3. An agent cannot accept or decline the card: the owner-only answer is refused, the agent path does not list it,
//      and the proposal stays pending with nothing written to the channel memory.
//   4. After the owner accepts, the proposal is approved, the text is in the channel memory, and no card remains after
//      another restart.
// Runs the real agent service on a temporary profile with a fake Codex app-server. No provider, account or network is
// used. Run: `bun scripts/memory-promotion-cards-e2e.ts`. Writes .openbot-build/memory-promotion-cards-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { CONSOLIDATION_PROMPT_MARKER } from "../src/backend/agent/memory-consolidation";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/memory-promotion-cards-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-memory-promotion-cards-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const CHANNEL_ID = "channel-cards";
const MEMORY_TEXT = "Ship the release on Fridays.";

// Before the service modules load: the Codex process and the stores read the home folder. The modules are loaded
// after that, so they are imported dynamically here; a static import would load them first.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { AgentMemoryStore } = await import("../src/backend/agent-memory-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

type Database = InstanceType<typeof OpenBotDatabase>;
type Service = InstanceType<typeof AgentService>;

/** One run of the agent service on the profile. Closing it and opening another on the same files is a restart. */
interface Session {
  database: Database;
  service: Service;
}

/** The fake Codex answers a turn by calling the OpenBot tools named in `<<CALLS[...]CALLS>>`, then "Done.". */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const CONSOLIDATION = ${JSON.stringify(CONSOLIDATION_PROMPT_MARKER)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn, text) => {
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const callNext = (turn) => {
  const call = turn.calls.shift();
  if (!call) return setTimeout(() => finish(turn, "Done."), 5);
  const id = "tool-" + turn.turnId + "-" + turn.calls.length;
  waiting.set(id, turn);
  write({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.turnId, callId: "call-" + id, namespace: "openbot", tool: call.tool, arguments: call.arguments } });
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const turn = { threadId: params.threadId, turnId, calls: [] };
      if (text.includes(CONSOLIDATION)) return setTimeout(() => finish(turn, '{"operations":[]}'), 5);
      const named = /<<CALLS([\\s\\S]*?)CALLS>>/.exec(text.split("--- current message ---").at(-1));
      turn.calls = named ? JSON.parse(named[1]) : [];
      return callNext(turn);
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
        callNext(turn);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: () => Effect.die(new Error("Not used by this check.")),
  endTakeover: () => {},
  resolveUploadTarget: () => Effect.die(new Error("Not used by this check.")),
  handleDynamicTool: () => Effect.die(new Error("Not used by this check.")),
  userControlTabFor: () => null,
  awaitUserControlRelease: () => Effect.die(new Error("Not used by this check.")),
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

const report: { checks: { name: string; passed: boolean; detail?: unknown }[]; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};

async function check(name: string, run: () => unknown): Promise<void> {
  try {
    const detail = await run();
    report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    report.checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Waits until a read returns a value. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function openSession(): Promise<Session> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  });
  await runCauseEffect(service.initialize());
  return { database, service };
}

async function closeSession(session: Session): Promise<void> {
  await runCauseEffect(session.service.stop());
  session.database.close();
}

/** The proposal rows, read from the database that the restart shares. */
function proposalRows(database: Database): Array<{ proposal_id: string; status: string }> {
  return database.connection
    .prepare("SELECT proposal_id, status FROM memory_proposals ORDER BY created_at, proposal_id")
    .all()
    .map((row) => {
      if (!isDynamicRecord(row) || !isString(row.proposal_id) || !isString(row.status)) {
        throw new Error("a proposal row has no id or status");
      }
      return { proposal_id: row.proposal_id, status: row.status };
    });
}

function channelMemoryTexts(database: Database): string[] {
  return database.connection
    .prepare("SELECT text FROM projection_channel_memories WHERE channel_id = ? ORDER BY memory_id")
    .all(CHANNEL_ID)
    .map((row) => {
      if (!isDynamicRecord(row) || !isString(row.text)) throw new Error("a channel memory has no text");
      return row.text;
    });
}

/** The cards of the runtime attention that the person sees, for one request id. */
function cardsFor(service: Service, requestId: string) {
  return service.getRuntimeSnapshot().pendingApprovals.filter((approval) => approval.requestId === requestId);
}

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

let session: Session | null = null;

/** The open session. A check runs only while one is open. */
function live(): Session {
  if (!session) throw new Error("No agent service is open.");
  return session;
}

async function restart(): Promise<void> {
  await closeSession(live());
  session = await openSession();
}

try {
  await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
  session = await openSession();
  const { service, database } = live();

  const agent = await runCauseEffect(
    service.createAgent({
      name: "Promoter",
      description: "Checks the memory promotion cards.",
      avatarSeed: "promoter",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first turn of the agent", () =>
    service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
  );

  // The channel holds the agent as its member and lead, so its routine runs in the channel's thread.
  await runCauseEffect(
    service.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: CHANNEL_ID,
        draft: { name: "cards", title: "", instructions: "", members: [{ agentId: agent.id }], leadAgentId: agent.id },
      },
      { id: "local", name: "Alex" },
    ),
  );

  // The agent's own memory, which the promotion copies.
  const memory = new AgentMemoryStore(database).createManual(agent.id, MEMORY_TEXT);
  const routine = service.createChannelRoutine({
    channelId: CHANNEL_ID,
    name: "Promote",
    instruction: `<<CALLS${JSON.stringify([{ tool: "promote_memory", arguments: { memoryId: memory.id } }])}CALLS>>`,
    active: false,
    timezone: "UTC",
    schedule: { kind: "daily", time: "09:00" },
  });
  await runCauseEffect(service.testChannelRoutine({ channelId: CHANNEL_ID, routineId: routine.id }));

  const requestId = (
    await waitFor("the pending proposal", () => {
      const pending = proposalRows(database).filter((row) => row.status === "pending");
      return pending.length > 0 ? pending : null;
    })
  )[0]?.proposal_id;
  assert.ok(requestId, "the promotion made a pending proposal");

  // 1. The card is listed, with the proposal id.
  let issued: { agentId: string; threadId: string; turnId: string } | undefined;
  await check("a pending promotion lists its card in the attention list", () => {
    const listed = cardsFor(live().service, requestId);
    assert.equal(listed.length, 1, "exactly one card for the proposal");
    const card = listed[0];
    assert.ok(card?.threadId && card.turnId, "the card names its thread and turn");
    issued = { agentId: card.agentId, threadId: card.threadId, turnId: card.turnId };
    return { requestId, ...issued };
  });

  // 2. A restart lists the same card, with the same proposal id.
  await restart();
  await check("after a restart the same card is listed with the same proposal id", () => {
    const listed = cardsFor(live().service, requestId);
    assert.equal(listed.length, 1, "the card is listed after the restart");
    const card = listed[0];
    assert.deepEqual(
      { requestId: card?.requestId, agentId: card?.agentId, threadId: card?.threadId, turnId: card?.turnId },
      { requestId, ...issued },
    );
    return { requestId };
  });

  // 3. An agent cannot answer the card.
  await check(
    "an agent cannot accept the card: owner-only is enforced and the agent path does not list it",
    async () => {
      const current = live();
      await assert.rejects(
        runCauseEffect(current.service.respondToApproval({ requestId, decision: "accept" }, { owner: false })),
        "a responder that is not the owner is refused",
      );
      await assert.rejects(
        runCauseEffect(
          current.service.respondToLocalAttention(agent.id, { kind: "approval", requestId, decision: "accept" }),
        ),
        "the agent path does not answer the card",
      );
      assert.equal(proposalRows(current.database).find((row) => row.proposal_id === requestId)?.status, "pending");
      assert.deepEqual(channelMemoryTexts(current.database), [], "nothing is written to the channel memory");
      assert.equal(cardsFor(current.service, requestId).length, 1, "the card is still listed");
      return { status: "pending" };
    },
  );

  // 4. The owner accepts; the memory is promoted, and no card remains after a restart.
  await check("after the owner accepts, the proposal is promoted and no card remains after a restart", async () => {
    await runCauseEffect(live().service.respondToApproval({ requestId, decision: "accept" }, { owner: true }));
    assert.equal(proposalRows(live().database).find((row) => row.proposal_id === requestId)?.status, "approved");
    assert.deepEqual(channelMemoryTexts(live().database), [MEMORY_TEXT]);
    assert.equal(cardsFor(live().service, requestId).length, 0, "no card right after the accept");

    await restart();
    assert.equal(cardsFor(live().service, requestId).length, 0, "no card after the restart");
    assert.deepEqual(channelMemoryTexts(live().database), [MEMORY_TEXT]);
    return { status: "approved", channelMemories: 1 };
  });

  report.passed = report.checks.every((entry) => entry.passed);
  mkdirSync(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `memory-promotion-cards-e2e: ${report.checks.length} checks passed; report at ${OUT}/report.json\n`,
  );
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  mkdirSync(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
  process.stderr.write(`memory-promotion-cards-e2e failed: ${report.error}\n`);
} finally {
  if (session) await closeSession(session).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
