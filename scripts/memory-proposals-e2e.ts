// Runs the memory proposal queue on the real OpenBot database and the real channel and messaging memory stores. A
// proposal writes nothing to the collective memory; a duplicate proposal returns the same proposal; only a person can
// approve or reject; an approval writes exactly one collective row with the text and a pointer to the source memory;
// a rejection writes nothing; a text with a registered secret is refused and never stored; and an approval into a full
// channel memory is refused, leaving the proposal pending. The database is a migrated temporary file and no provider is
// used. The store API is the surface: no router tool and no UI is involved. Run: `bun scripts/memory-proposals-e2e.ts`.
// Writes .openbot-build/memory-proposals-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { redactText, registerSecretValue } from "@openbot/logging";
import { ChannelMemoryStore } from "../src/backend/channel-memory-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type MemoryProposal, MemoryProposalStore } from "../src/backend/memory-proposals/memory-proposals";
import { MessagingMemoryStore } from "../src/backend/messaging/messaging-memory-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/memory-proposals-e2e");
const AGENT = "agent-1";
const SOURCE_MEMORY = "memory-1";
const CHANNEL = "channel-1";
const CONNECTION = "connection-1";
const TEXT = "Ship the release on Fridays.";
const OTHER_TEXT = "Keep the staging database small.";
const MESSAGING_TEXT = "Ana owns the release.";
const FULL_TEXT = "The on-call rota changes weekly.";
const SECRET = "e2e-proposal-secret-4c1d8e";
const SECRET_TEXT = `The staging token is ${SECRET}.`;
const CHANNEL_LIMIT = 32;

interface Check {
  name: string;
  status: "passed" | "failed";
  detail?: string;
}

const checks: Check[] = [];
const root = await mkdtemp(join(tmpdir(), "openbot-memory-proposals-e2e-"));
const database = new OpenBotDatabase(join(root, "state"));

/** Runs one step and returns its value, so a later step can use what an earlier one produced. */
function check<T>(name: string, run: () => T): T {
  try {
    const value = run();
    checks.push({ name, status: "passed", ...(typeof value === "string" ? { detail: value } : {}) });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: "failed", detail: redactText(message) });
    throw error;
  }
}

/** The one number a COUNT query returns, narrowed at runtime: a SQLite row is not trusted to have a shape. */
function countOf(sql: string, ...params: string[]): number {
  const row = database.connection.prepare(sql).get(...params);
  if (!isDynamicRecord(row) || !isNumber(row.count)) throw new Error("the count query returned no number");
  return row.count;
}

function statusOf(proposalId: string): string {
  const row = database.connection.prepare("SELECT status FROM memory_proposals WHERE proposal_id = ?").get(proposalId);
  if (!isDynamicRecord(row) || !isString(row.status)) throw new Error("the proposal has no status");
  return row.status;
}

function channelMemoryCount(): number {
  return countOf("SELECT COUNT(*) AS count FROM projection_channel_memories WHERE channel_id = ?", CHANNEL);
}

function messagingMemoryCount(): number {
  return countOf("SELECT COUNT(*) AS count FROM projection_messaging_memories WHERE connection_id = ?", CONNECTION);
}

/** The collective rows of the channel, with their text and source pointer. */
function channelMemoryRows(): Array<{ text: string; source_turn_id: string | null }> {
  return database.connection
    .prepare("SELECT text, source_turn_id FROM projection_channel_memories WHERE channel_id = ? ORDER BY memory_id")
    .all(CHANNEL)
    .map((row) => {
      if (!isDynamicRecord(row) || !isString(row.text)) throw new Error("a channel memory has no text");
      const sourceTurnId = row.source_turn_id;
      if (sourceTurnId !== null && !isString(sourceTurnId)) throw new Error("a channel memory has a bad source");
      return { text: row.text, source_turn_id: sourceTurnId };
    });
}

try {
  await mkdir(join(root, "state"), { recursive: true });
  await runCauseEffect(database.initialize());
  database.connection.exec("PRAGMA foreign_keys = ON");
  database.connection
    .prepare("INSERT INTO projection_channels (channel_id, channel_json) VALUES (?, '{}')")
    .run(CHANNEL);
  database.connection
    .prepare(
      `INSERT INTO projection_messaging_connections
         (connection_id, platform, workspace_id, workspace_name, enabled, created_at, updated_at)
       VALUES (?, 'slack', 'workspace-1', 'Workspace', 1, '2026-01-01', '2026-01-01')`,
    )
    .run(CONNECTION);

  const channelMemories = new ChannelMemoryStore(database);
  const messagingMemories = new MessagingMemoryStore(database);
  const queue = new MemoryProposalStore({ database, channelMemories, messagingMemories });
  const proposeChannel = (text: string): MemoryProposal =>
    queue.propose({
      sourceAgentId: AGENT,
      sourceMemoryId: SOURCE_MEMORY,
      targetScope: "channel",
      targetId: CHANNEL,
      text,
    });

  const first = check("a proposal records a pending row and writes nothing to the collective memory", () => {
    const proposal = proposeChannel(TEXT);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.decidedBy, null);
    assert.equal(statusOf(proposal.proposalId), "pending");
    assert.equal(channelMemoryCount(), 0, "the collective memory holds no row before a decision");
    return proposal;
  });

  check("a duplicate proposal returns the same proposal id", () => {
    const duplicate = queue.propose({
      sourceAgentId: AGENT,
      sourceMemoryId: SOURCE_MEMORY,
      targetScope: "channel",
      targetId: CHANNEL,
      text: "  Ship the   release on Fridays.  ",
    });
    assert.equal(duplicate.proposalId, first.proposalId);
    assert.equal(countOf("SELECT COUNT(*) AS count FROM memory_proposals"), 1);
  });

  check("an approval by an agent is refused and writes nothing", () => {
    assert.throws(() => queue.approve(first.proposalId, "agent"), /Only a person/);
    assert.equal(statusOf(first.proposalId), "pending");
    assert.equal(channelMemoryCount(), 0);
  });

  check("an approval by a person writes exactly one collective row with the text and its source", () => {
    const approved = queue.approve(first.proposalId, "person");
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, "person");
    assert.equal(statusOf(first.proposalId), "approved");
    assert.deepEqual(channelMemoryRows(), [{ text: TEXT, source_turn_id: `agent-memory:${SOURCE_MEMORY}` }]);
    return `collective rows=${channelMemoryCount()}`;
  });

  check("a rejection by a person writes nothing to the collective memory", () => {
    const rejectable = proposeChannel(OTHER_TEXT);
    const rejected = queue.reject(rejectable.proposalId, "person");
    assert.equal(rejected.status, "rejected");
    assert.equal(statusOf(rejectable.proposalId), "rejected");
    assert.equal(channelMemoryCount(), 1, "only the approved row is in the collective memory");
  });

  check("a text with a registered secret is refused and not stored", () => {
    registerSecretValue(SECRET);
    assert.throws(() => proposeChannel(SECRET_TEXT), /secret/i);
    assert.equal(countOf("SELECT COUNT(*) AS count FROM memory_proposals WHERE text LIKE ?", `%${SECRET}%`), 0);
    assert.equal(channelMemoryCount(), 1);
  });

  check("an approval for a messaging connection writes that connection's memory", () => {
    const messaging = queue.propose({
      sourceAgentId: AGENT,
      sourceMemoryId: SOURCE_MEMORY,
      targetScope: "messaging",
      targetId: CONNECTION,
      text: MESSAGING_TEXT,
    });
    queue.approve(messaging.proposalId, "person");
    assert.equal(messagingMemoryCount(), 1);
    assert.equal(channelMemoryCount(), 1, "the channel memory is unchanged");
  });

  check("an approval into a full channel memory is refused and the proposal stays pending", () => {
    for (let index = channelMemoryCount(); index < CHANNEL_LIMIT; index += 1) {
      channelMemories.createManual(CHANNEL, `Fact number ${index}.`);
    }
    assert.equal(channelMemoryCount(), CHANNEL_LIMIT);
    const full = proposeChannel(FULL_TEXT);
    assert.throws(() => queue.approve(full.proposalId, "person"), /32|limit/i);
    assert.equal(statusOf(full.proposalId), "pending");
    assert.equal(channelMemoryCount(), CHANNEL_LIMIT, "nothing is written past the cap");
    return `collective rows=${channelMemoryCount()}`;
  });

  const report = {
    status: "passed",
    generatedAt: new Date().toISOString(),
    scope: "store API only; no router tool and no UI in this item",
    checks,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`memory-proposals-e2e: ${checks.length} checks passed; report at ${OUT}/report.json\n`);
} catch (error) {
  const report = {
    status: "failed",
    generatedAt: new Date().toISOString(),
    scope: "store API only; no router tool and no UI in this item",
    checks,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
  process.stderr.write(`memory-proposals-e2e failed: ${redactText(String(error))}\n`);
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}
