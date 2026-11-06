// Checks the agent message write path on the real SQLite mailbox: a secret the user registered is refused
// in an agent's send_message text and never stored, and a known secret pattern in an agent's text is masked
// before the mailbox row is written. A person's own message is stored as typed. No provider, account or
// network is started.
// Run: `bun scripts/message-redaction-e2e.ts`.
// Writes .openbot-build/message-redaction-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSecretValue } from "@openbot/logging";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "message-redaction-e2e");
const REGISTERED_SECRET = "registered-fake-secret-7f3a9c21";
const PATTERN_SECRET = "password=hunter2-fake-7731";

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

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

const root = await mkdtemp(join(tmpdir(), "openbot-message-redaction-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);

/** The stored mailbox message text, read from the projection row that the mailbox writes. */
function storedRow(messageId: string): string | null {
  const row = database.connection
    .prepare("SELECT message_json FROM projection_mailbox_messages WHERE message_id = ?")
    .get(messageId);
  return row ? String(row.message_json) : null;
}

/** The whole stored mailbox state, as the database holds it. */
function storedState(): string {
  return JSON.stringify(database.readMailboxState());
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  registerSecretValue(REGISTERED_SECRET);

  await step("An agent message that holds a registered secret is refused and not stored", async () => {
    await assert.rejects(
      runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "agent", agentId: "agent-sender" },
          recipientAgentIds: ["agent-recipient"],
          text: `Use the key ${REGISTERED_SECRET} for the deploy.`,
        }),
      ),
      /holds a secret/,
    );
    assert.ok(!storedState().includes(REGISTERED_SECRET), "The registered secret is not in the stored mailbox state.");
    assert.equal(mailbox.listQueue("agent-recipient").deliveries.length, 0, "A refused message is not queued.");
    return { refused: true };
  });

  const masked = await step("An agent message with a known secret pattern is stored masked", async () => {
    const receipt = await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "agent", agentId: "agent-sender" },
        recipientAgentIds: ["agent-recipient"],
        text: `Deploy with ${PATTERN_SECRET} please.`,
      }),
    );
    const row = storedRow(receipt.messageId);
    assert.ok(row, "The agent message row exists.");
    assert.ok(!row.includes("hunter2-fake-7731"), "The secret value is not in the stored message row.");
    assert.ok(!storedState().includes("hunter2-fake-7731"), "The secret value is not in the stored mailbox state.");
    return { messageId: receipt.messageId };
  });

  await step("A person's own message is stored as typed", async () => {
    const receipt = await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "user" },
        recipientAgentIds: ["agent-recipient"],
        text: `Deploy with ${PATTERN_SECRET} please.`,
      }),
    );
    const row = storedRow(receipt.messageId);
    assert.ok(row?.includes("hunter2-fake-7731"), "A person's message keeps its text.");
    return { messageId: receipt.messageId, masked: masked.messageId };
  });

  report.passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
