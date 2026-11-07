// Checks the two P0 pieces that are wired into production, on the real SQLite stores, the real mailbox and the real
// tool controllers. (a) An `await_event` opened in a real turn gets a 24-hour expiry; past it, the next wake check
// closes the wait and it does not wake. (b) A wait opened in a routine run is woken only by runs of that routine.
// (c) A promotion from an agent memory creates one pending proposal and one attention card, and writes nothing to
// the collective memory. (d) A local responder cannot approve the card. (e) A person's approval writes exactly one
// collective row. (f) A person's rejection writes nothing; a chat press counts as the person.
// The calls go through `AgentWaits.handleTool` and `MemoryPromotion.handleTool`, as the tool router sends them, and the
// card answer goes through `MemoryProposalCards.respond`, as the attention registry sends it. No provider, account or
// network is started. Run: `bun scripts/p0-wiring-e2e.ts`.
// Writes .openbot-build/p0-wiring-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { ForbiddenAttentionAnswer } from "../src/backend/agent/inactive-attention-request";
import { MemoryPromotion, PROMOTE_MEMORY_TOOL } from "../src/backend/agent/memory-promotion";
import type { OpenBotToolResponse } from "../src/backend/agent/routine-tools";
import { AgentMemoryStore } from "../src/backend/agent-memory-store";
import { AgentStore } from "../src/backend/agent-store";
import { AGENT_WAIT_MAX_TTL_MS, AgentWaitStore } from "../src/backend/agent-waits/agent-wait-store";
import { AgentWaits, AWAIT_EVENT_TOOL, AWAIT_EVENT_TTL_MS } from "../src/backend/agent-waits/agent-waits";
import { ChannelMemoryStore } from "../src/backend/channel-memory-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { MemoryProposalCards } from "../src/backend/memory-proposals/memory-proposal-cards";
import { MemoryProposalStore } from "../src/backend/memory-proposals/memory-proposals";
import { MessagingMemoryStore } from "../src/backend/messaging/messaging-memory-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "p0-wiring-e2e");
const HOUR_MS = 60 * 60 * 1000;
const CHANNEL = "channel-p0";
const CONNECTION = "connection-p0";
const CHANNEL_THREAD = "thread-channel-p0";
const CHAT_THREAD = "thread-chat-p0";
const CHAT_TURN = "turn-chat-p0";
const ROUTINE_TURN = "turn-routine-p0";
const PROMOTE_TURN = "turn-promote-p0";

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; notes: string[]; steps: Step[] } = {
  passed: false,
  notes: [
    "The default expiry (24 hours) and the routine predicate are set by AgentWaits.handleTool, not by the store.",
    "A promotion's card and its answer go through MemoryProposalCards, which the attention registry calls.",
    "A card lives in memory with its turn's registry; a restart drops the card while the proposal stays pending.",
  ],
  steps: [],
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** The JSON body of a tool answer. */
function body(response: OpenBotToolResponse | null): { success: boolean; value: DynamicRecord } {
  assert.ok(response, "The controller answers the tool.");
  const item = response.contentItems[0];
  assert.ok(item && item.type === "inputText", "The answer is text.");
  const value = JSON.parse(item.text);
  assert.ok(isDynamicRecord(value), "The answer is a JSON object.");
  return { success: response.success, value };
}

const root = await mkdtemp(join(tmpdir(), "openbot-p0-wiring-e2e-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
let clock = new Date("2026-03-01T10:00:00.000Z");
const waitStore = new AgentWaitStore({ database, now: () => clock });
const events: AgentEvent[] = [];
const routineByDelivery = new Map<string, string>();
const waits = new AgentWaits({
  store: waitStore,
  mailbox,
  now: () => clock,
  hooks: {
    emit: (event) => events.push(event),
    ownsRoutine: () => true,
    hasRoutine: () => true,
    requireKnownAgent: () => {},
    routineForDelivery: (deliveryId) => routineByDelivery.get(deliveryId) ?? null,
  },
});

const memoryStore = new AgentMemoryStore(database);
const channelMemories = new ChannelMemoryStore(database);
const messagingMemories = new MessagingMemoryStore(database);
const proposals = new MemoryProposalStore({ database, channelMemories, messagingMemories });
const cards = new MemoryProposalCards({ store: proposals, emit: (event) => events.push(event) });
const promotion = new MemoryPromotion({
  memories: { listFor: (agentId) => memoryStore.list(agentId) },
  attention: { proposeMemory: (input) => cards.promote(input) },
  channelForThread: (threadId) => (threadId === CHANNEL_THREAD ? CHANNEL : null),
  connectionForThread: (threadId) => (threadId === CHAT_THREAD ? CONNECTION : null),
});

function openWait(agentId: string, turnId: string, threadId: string, note: string, args: DynamicRecord = {}) {
  return body(
    waits.handleTool(
      {
        threadId,
        turnId,
        callId: crypto.randomUUID(),
        namespace: "openbot",
        tool: AWAIT_EVENT_TOOL,
        arguments: { note, ...args },
      },
      { agentId, inExecutionThread: false },
    ),
  );
}

/** A user request, marked running for a synthetic turn, as the wait tools e2e does. */
async function runningTurn(agentId: string, turnId: string, text: string): Promise<string> {
  const receipt = await runCauseEffect(
    mailbox.enqueue({ sender: { kind: "user" }, recipientAgentIds: [agentId], text }),
  );
  const delivery = receipt.deliveries[0];
  assert.ok(delivery, "The request has a delivery.");
  await runCauseEffect(mailbox.markStarting(delivery.id));
  await runCauseEffect(mailbox.markRunning(delivery.id, turnId));
  return delivery.id;
}

function collectiveRows(
  table: "projection_channel_memories" | "projection_messaging_memories",
  ownerColumn: string,
  owner: string,
): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn} = ?`).get(owner);
  assert.ok(isDynamicRecord(row) && typeof row.count === "number", "The count query returns a number.");
  return row.count;
}

function statusOf(proposalId: string): string {
  const row = database.connection.prepare("SELECT status FROM memory_proposals WHERE proposal_id = ?").get(proposalId);
  assert.ok(isDynamicRecord(row) && typeof row.status === "string", "The proposal has a status.");
  return row.status;
}

function storedExpiry(waitId: string): string {
  const row = database.connection.prepare("SELECT expires_at FROM agent_waits WHERE wait_id = ?").get(waitId);
  assert.ok(isDynamicRecord(row) && typeof row.expires_at === "string", "The wait row has an expiry.");
  return row.expires_at;
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  database.connection.exec("PRAGMA foreign_keys = ON");
  database.connection
    .prepare("INSERT INTO projection_channels (channel_id, channel_json) VALUES (?, '{}')")
    .run(CHANNEL);
  database.connection
    .prepare(
      `INSERT INTO projection_messaging_connections
         (connection_id, platform, workspace_id, workspace_name, enabled, created_at, updated_at)
       VALUES (?, 'slack', 'workspace-p0', 'Workspace', 1, '2026-01-01', '2026-01-01')`,
    )
    .run(CONNECTION);
  const worker = await runCauseEffect(
    store.createAgent({ name: "Waiter", description: "Waits for builds", avatarSeed: "p0-a", avatarHue: null }),
  );

  // (a) A wait opened in a real turn has an expiry, and the next wake check after it closes the wait.
  const expiring = await step("(a) await_event in a real turn gets a 24-hour expiry", async () => {
    await runningTurn(worker.id, CHAT_TURN, "Build the release and tell me when it passes.");
    const opened = openWait(worker.id, CHAT_TURN, CHAT_THREAD, "Waiting for the build");
    assert.equal(opened.success, true);
    const waitId = String(opened.value.waitId);
    const expected = new Date(clock.getTime() + AWAIT_EVENT_TTL_MS).toISOString();
    assert.equal(opened.value.expiresAt, expected, "The answer names the expiry.");
    assert.equal(storedExpiry(waitId), expected, "The stored wait has the same expiry.");
    assert.ok(AWAIT_EVENT_TTL_MS <= AGENT_WAIT_MAX_TTL_MS, "The default is within the store's cap.");
    return { waitId, expiresAt: expected };
  });

  await step("(a) past the expiry, the next wake check closes the wait and it does not wake", async () => {
    clock = new Date(clock.getTime() + AWAIT_EVENT_TTL_MS + HOUR_MS);
    const before = events.length;
    waits.wakeForRun({ agentId: worker.id, routineId: "routine-any" }, "delivery-after-expiry", null);
    assert.equal(waitStore.get(worker.id, expiring.waitId), null, "The expired wait is closed.");
    assert.deepEqual(waits.wokenBy("delivery-after-expiry"), [], "The expired wait does not wake.");
    assert.ok(
      events.slice(before).some((event) => event.type === "waits-changed" && event.snapshot.agentId === worker.id),
      "The chat is told the waits changed.",
    );
    return { closed: expiring.waitId };
  });

  // (b) A wait opened in a routine run is woken only by runs of that routine.
  await step("(b) a wait opened in a routine run is woken only by a run of that routine", async () => {
    const routineDelivery = await runningTurn(worker.id, ROUTINE_TURN, "Run the nightly check.");
    routineByDelivery.set(routineDelivery, "routine-a");
    const opened = openWait(worker.id, ROUTINE_TURN, CHAT_THREAD, "Waiting for the next nightly check");
    const waitId = String(opened.value.waitId);
    const row = database.connection.prepare("SELECT predicate_json FROM agent_waits WHERE wait_id = ?").get(waitId);
    assert.ok(isDynamicRecord(row));
    assert.equal(row.predicate_json, JSON.stringify({ routineId: "routine-a" }), "The predicate names the routine.");
    waits.wakeForRun({ agentId: worker.id, routineId: "routine-b" }, "delivery-routine-b", null);
    waits.wakeForRun({ agentId: worker.id, routineId: "routine-b" }, "delivery-routine-b-named", waitId);
    assert.ok(waitStore.get(worker.id, waitId), "A run of routine B leaves the wait open.");
    assert.deepEqual(waits.wokenBy("delivery-routine-b"), [], "A run of routine B does not wake it.");
    assert.deepEqual(waits.wokenBy("delivery-routine-b-named"), [], "A named event from routine B does not wake it.");
    waits.wakeForRun({ agentId: worker.id, routineId: "routine-a" }, "delivery-routine-a", null);
    assert.deepEqual(
      waits.wokenBy("delivery-routine-a").map((wait) => wait.id),
      [waitId],
      "A run of routine A wakes it.",
    );
    return { waitId };
  });

  // (c) A promotion from an agent memory creates one pending proposal and one card, and writes nothing.
  const memory = memoryStore.createManual(worker.id, "Ship the release on Fridays.");
  const proposal = await step("(c) a promotion from an agent creates one pending proposal and one card", async () => {
    await runningTurn(worker.id, PROMOTE_TURN, "Share the release rule with the channel.");
    const answer = body(
      promotion.handleTool(
        {
          threadId: CHANNEL_THREAD,
          turnId: PROMOTE_TURN,
          callId: crypto.randomUUID(),
          namespace: "openbot",
          tool: PROMOTE_MEMORY_TOOL,
          arguments: { memoryId: memory.id },
        },
        { agentId: worker.id, threadId: CHANNEL_THREAD, turnId: PROMOTE_TURN },
      ),
    );
    assert.equal(answer.success, true);
    const proposalId = String(answer.value.proposalId);
    assert.equal(statusOf(proposalId), "pending");
    assert.equal(cards.approvals().length, 1, "One card is up for the person.");
    const card = cards.approvals()[0];
    assert.equal(card?.requestId, proposalId);
    assert.equal(card?.threadId, CHANNEL_THREAD);
    assert.ok(
      events.some((event) => event.type === "approval" && event.approval.requestId === proposalId),
      "The card is announced as an approval.",
    );
    assert.equal(collectiveRows("projection_channel_memories", "channel_id", CHANNEL), 0, "Nothing is written yet.");
    // A repeat promotion of the same text reuses the pending proposal and shows no second card.
    body(
      promotion.handleTool(
        {
          threadId: CHANNEL_THREAD,
          turnId: PROMOTE_TURN,
          callId: crypto.randomUUID(),
          namespace: "openbot",
          tool: PROMOTE_MEMORY_TOOL,
          arguments: { memoryId: memory.id },
        },
        { agentId: worker.id, threadId: CHANNEL_THREAD, turnId: PROMOTE_TURN },
      ),
    );
    assert.equal(cards.approvals().length, 1, "A duplicate shows no second card.");
    return { proposalId };
  });

  await step("(d) a local responder cannot approve the card", async () => {
    assert.throws(() => cards.respond(proposal.proposalId, "accept", { owner: false }), ForbiddenAttentionAnswer);
    assert.equal(statusOf(proposal.proposalId), "pending", "The proposal stays pending.");
    assert.equal(collectiveRows("projection_channel_memories", "channel_id", CHANNEL), 0, "Nothing is written.");
    assert.equal(cards.has(proposal.proposalId), true, "The card stays up.");
    return { refused: "owner: false" };
  });

  await step("(e) a person's approval writes exactly one collective row with the source pointer", async () => {
    cards.respond(proposal.proposalId, "accept", undefined);
    assert.equal(statusOf(proposal.proposalId), "approved");
    assert.equal(collectiveRows("projection_channel_memories", "channel_id", CHANNEL), 1, "Exactly one row.");
    const row = database.connection
      .prepare("SELECT text, source_turn_id FROM projection_channel_memories WHERE channel_id = ?")
      .get(CHANNEL);
    assert.ok(isDynamicRecord(row));
    assert.equal(row.text, "Ship the release on Fridays.");
    assert.equal(row.source_turn_id, `agent-memory:${memory.id}`);
    assert.equal(cards.has(proposal.proposalId), false, "The card is gone once decided.");
    return { collectiveRows: 1 };
  });

  await step("(f) a person's rejection writes nothing", async () => {
    await runningTurn(worker.id, PROMOTE_TURN, "A second rule for the channel.");
    const other = memoryStore.createManual(worker.id, "Keep the staging database small.");
    const answer = body(
      promotion.handleTool(
        {
          threadId: CHANNEL_THREAD,
          turnId: PROMOTE_TURN,
          callId: crypto.randomUUID(),
          namespace: "openbot",
          tool: PROMOTE_MEMORY_TOOL,
          arguments: { memoryId: other.id },
        },
        { agentId: worker.id, threadId: CHANNEL_THREAD, turnId: PROMOTE_TURN },
      ),
    );
    const rejectedId = String(answer.value.proposalId);
    cards.respond(rejectedId, "decline", undefined);
    assert.equal(statusOf(rejectedId), "rejected");
    assert.equal(collectiveRows("projection_channel_memories", "channel_id", CHANNEL), 1, "Still exactly one row.");
    return { rejectedId };
  });

  await step("(f) a chat press counts as the person for a messaging promotion", async () => {
    await runningTurn(worker.id, "turn-chat-promote-p0", "Share the deploy rule with the chat.");
    const shared = memoryStore.createManual(worker.id, "Ana owns the deploys.");
    const answer = body(
      promotion.handleTool(
        {
          threadId: CHAT_THREAD,
          turnId: "turn-chat-promote-p0",
          callId: crypto.randomUUID(),
          namespace: "openbot",
          tool: PROMOTE_MEMORY_TOOL,
          arguments: { memoryId: shared.id },
        },
        { agentId: worker.id, threadId: CHAT_THREAD, turnId: "turn-chat-promote-p0" },
      ),
    );
    const proposalId = String(answer.value.proposalId);
    cards.respond(proposalId, "accept", { owner: false, chat: true });
    assert.equal(statusOf(proposalId), "approved");
    assert.equal(collectiveRows("projection_messaging_memories", "connection_id", CONNECTION), 1);
    return { proposalId };
  });

  report.passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
