// Checks the internal wake of a routine thread on the real SQLite stores, the mailbox and AgentTasks.
// A wait that a routine run opens in its routine thread wakes once, when a later turn of that thread
// completes with a completed outcome. A failed or interrupted turn does not wake it, nor does a turn of
// another thread. The woken note reaches the owning agent's next prompt once, and no sender is faked:
// the delivery keeps the sender that really sent it. Each call goes through the same stores the service
// wires, and no provider, account or network is started: a turn is a mailbox delivery marked running for
// a synthetic turn id, and its end goes through `AgentTasks.event` as the service sends it.
// Run: `bun scripts/task-wake-e2e.ts`.
// Writes .openbot-build/task-wake-e2e/report.json.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentWait } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { deliveryPromptInput } from "../src/backend/agent/delivery-content";
import type { OpenBotToolResponse } from "../src/backend/agent/routine-tools";
import { AgentStore } from "../src/backend/agent-store";
import { AgentTasks } from "../src/backend/agent-tasks/agent-tasks";
import { type AgentThreadRecord, AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { AgentWaitStore } from "../src/backend/agent-waits/agent-wait-store";
import { AgentWaits, AWAIT_EVENT_TOOL, CLOSE_WAIT_TOOL } from "../src/backend/agent-waits/agent-waits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "task-wake-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

type Sender =
  | { kind: "user" }
  | { kind: "routine"; routineId: string; runId: string; routineName: string; scheduledFor: string };

type TurnStatus = "completed" | "failed" | "interrupted";

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

/** The JSON body of a tool answer. */
function body(response: OpenBotToolResponse | null): { success: boolean; value: DynamicRecord } {
  assert.ok(response, "AgentWaits answers the tool.");
  const item = response.contentItems[0];
  assert.ok(item && item.type === "inputText", "The answer is text.");
  const value = JSON.parse(item.text);
  assert.ok(isDynamicRecord(value), "The answer is a JSON object.");
  return { success: response.success, value };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const root = await mkdtemp(join(tmpdir(), "openbot-task-wake-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
const conversation = new ConversationRuntime(
  store,
  () => {},
  () => store.list(),
);
const events: AgentEvent[] = [];
const waits = new AgentWaits({
  store: new AgentWaitStore({ database }),
  mailbox,
  hooks: {
    emit: (event) => events.push(event),
    ownsRoutine: () => true,
    hasRoutine: () => true,
    requireKnownAgent: (agentId) => {
      conversation.requireKnownAgent(agentId);
    },
    routineForDelivery: () => null,
  },
});
// The same wiring as the service: a completed routine-thread turn goes to the waits.
const tasks = new AgentTasks({
  store: new AgentThreadStore(database),
  mailbox,
  conversation,
  hooks: {
    emit: (event) => events.push(event),
    agent: (agentId) => store.list().find((agent) => agent.id === agentId),
    hold: () => null,
    queued: () => {},
    turnActive: () => false,
    archived: () => Effect.void,
    completed: (agentId, taskId, turnId) => waits.taskCompleted(agentId, taskId, turnId),
  },
});

/** A tool call from one turn of an agent, through `AgentWaits.handleTool` as the tool router sends it. */
function call(agentId: string, turnId: string, tool: string, args: unknown) {
  return body(
    waits.handleTool(
      {
        threadId: `thread-${agentId}`,
        turnId,
        callId: crypto.randomUUID(),
        namespace: "openbot",
        tool,
        arguments: args,
      },
      { agentId, inExecutionThread: false },
    ),
  );
}

/** A message that starts one turn: a delivery in the task (or the agent's own chat), marked running. */
async function startTurn(
  agentId: string,
  taskId: string | null,
  sender: Sender,
  text: string,
  turnId: string,
): Promise<string> {
  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender,
      recipientAgentIds: [agentId],
      text,
      ...(taskId === null ? {} : { taskId }),
    }),
  );
  const delivery = receipt.deliveries[0];
  assert.ok(delivery, "The message has a delivery.");
  await runCauseEffect(mailbox.markStarting(delivery.id));
  await runCauseEffect(mailbox.markRunning(delivery.id, turnId));
  return delivery.id;
}

/** The end of a turn: the delivery settles, and the task's `turn-completed` goes through AgentTasks. */
async function endTurn(
  agentId: string,
  task: AgentThreadRecord,
  deliveryId: string,
  turnId: string,
  status: TurnStatus,
): Promise<void> {
  await runCauseEffect(mailbox.markTerminal(deliveryId, status, status === "completed" ? null : `The turn ${status}.`));
  tasks.event({ type: "turn-completed", agentId, threadId: task.threadId, turnId, status, origin: "user" });
}

function waitOf(agentId: string, waitId: string): AgentWait | undefined {
  return waits.list(agentId).waits.find((wait) => wait.id === waitId);
}

function routineRun(routineId: string, routineName: string): Sender {
  return {
    kind: "routine",
    routineId,
    runId: crypto.randomUUID(),
    routineName,
    scheduledFor: new Date().toISOString(),
  };
}

try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const worker = await runCauseEffect(
    store.createAgent({ name: "Watcher", description: "Watches a build", avatarSeed: "wake-a", avatarHue: null }),
  );
  const neighbour = await runCauseEffect(
    store.createAgent({ name: "Neighbour", description: "Another agent", avatarSeed: "wake-b", avatarHue: null }),
  );
  const build = tasks.routineThread(worker.id, "routine-build", "Build watch");
  const deploy = tasks.routineThread(worker.id, "routine-deploy", "Deploy watch");
  assert.ok(build && deploy, "The two routine threads exist.");

  const first = await step("A routine run in the build thread opens a wait", async () => {
    const deliveryId = await startTurn(
      worker.id,
      build.taskId,
      routineRun("routine-build", "Build watch"),
      "Watch the build and report.",
      "turn-open-build",
    );
    const opened = call(worker.id, "turn-open-build", AWAIT_EVENT_TOOL, { note: "Build finishes" });
    assert.equal(opened.success, true, "The routine run opens a wait.");
    const waitId = String(opened.value.waitId);
    assert.equal(waitOf(worker.id, waitId)?.wokenAt ?? null, null, "A new wait is not woken.");
    return { deliveryId, waitId };
  });

  await step("The turn that opened the wait does not wake it", async () => {
    await endTurn(worker.id, build, first.deliveryId, "turn-open-build", "completed");
    assert.equal(waitOf(worker.id, first.waitId)?.wokenAt ?? null, null, "The opening turn leaves it open.");
    return { waitId: first.waitId };
  });

  const buildWake = await step("A later completed turn of the build thread wakes the wait once", async () => {
    const deliveryId = await startTurn(worker.id, build.taskId, { kind: "user" }, "Any news?", "turn-build-2");
    const before = events.length;
    await endTurn(worker.id, build, deliveryId, "turn-build-2", "completed");
    const wait = waitOf(worker.id, first.waitId);
    assert.ok(wait?.wokenAt, "The completed turn wakes the wait.");
    assert.equal(wait.wakeDeliveryId ?? null, null, "The wake names no delivery: the next prompt takes the note.");
    assert.ok(
      events.slice(before).some((event) => event.type === "waits-changed" && event.snapshot.agentId === worker.id),
      "The change reaches the agent's chat.",
    );
    return { wokenAt: wait.wokenAt };
  });

  await step("A third completed turn does not wake the same wait again", async () => {
    const deliveryId = await startTurn(worker.id, build.taskId, { kind: "user" }, "Still running?", "turn-build-3");
    await endTurn(worker.id, build, deliveryId, "turn-build-3", "completed");
    assert.equal(waitOf(worker.id, first.waitId)?.wokenAt, buildWake.wokenAt, "The wake happened once.");
    return { wokenAt: buildWake.wokenAt };
  });

  const second = await step("A second wait opens in the build thread", async () => {
    await startTurn(
      worker.id,
      build.taskId,
      routineRun("routine-build", "Build watch"),
      "Check the cache.",
      "turn-open-2",
    );
    const opened = call(worker.id, "turn-open-2", AWAIT_EVENT_TOOL, { note: "Cache warms" });
    assert.equal(opened.success, true);
    return String(opened.value.waitId);
  });

  await step("A failed turn and an interrupted turn of the build thread do not wake it", async () => {
    const failed = await startTurn(worker.id, build.taskId, { kind: "user" }, "Retry.", "turn-build-fail");
    await endTurn(worker.id, build, failed, "turn-build-fail", "failed");
    assert.equal(waitOf(worker.id, second)?.wokenAt ?? null, null, "A failed turn leaves the wait open.");
    const stopped = await startTurn(worker.id, build.taskId, { kind: "user" }, "Stop.", "turn-build-stop");
    await endTurn(worker.id, build, stopped, "turn-build-stop", "interrupted");
    assert.equal(waitOf(worker.id, second)?.wokenAt ?? null, null, "An interrupted turn leaves the wait open.");
    return { failedTurn: "failed", stoppedTurn: "interrupted" };
  });

  await step("A completed turn after them wakes the second wait", async () => {
    const deliveryId = await startTurn(worker.id, build.taskId, { kind: "user" }, "Done yet?", "turn-build-4");
    await endTurn(worker.id, build, deliveryId, "turn-build-4", "completed");
    assert.ok(waitOf(worker.id, second)?.wokenAt, "The completed turn wakes the second wait.");
    return { waitId: second };
  });

  const third = await step("A routine run in the deploy thread opens a wait", async () => {
    await startTurn(
      worker.id,
      deploy.taskId,
      routineRun("routine-deploy", "Deploy watch"),
      "Watch the deploy.",
      "turn-open-deploy",
    );
    const opened = call(worker.id, "turn-open-deploy", AWAIT_EVENT_TOOL, { note: "Deploy goes live" });
    assert.equal(opened.success, true);
    return String(opened.value.waitId);
  });

  await step("A completed turn of the build thread leaves the deploy wait closed", async () => {
    const deliveryId = await startTurn(worker.id, build.taskId, { kind: "user" }, "Build again.", "turn-build-5");
    await endTurn(worker.id, build, deliveryId, "turn-build-5", "completed");
    assert.equal(waitOf(worker.id, third)?.wokenAt ?? null, null, "A wait of another thread stays open.");
    return { waitId: third };
  });

  await step("A completed turn of the deploy thread wakes the deploy wait", async () => {
    const deliveryId = await startTurn(worker.id, deploy.taskId, { kind: "user" }, "Deployed?", "turn-deploy-2");
    await endTurn(worker.id, deploy, deliveryId, "turn-deploy-2", "completed");
    assert.ok(waitOf(worker.id, third)?.wokenAt, "The deploy thread's own completed turn wakes its wait.");
    return { waitId: third };
  });

  await step("The owning agent's next prompt carries each internal wake note once, under the real sender", async () => {
    const snapshot = conversation.ensureSnapshot(
      worker.id,
      store.list().find((a) => a.id === worker.id)?.threadId ?? null,
    );
    // The prompt of one delivery, as the drain builds it. Building it takes the note for that delivery.
    const promptOf = (deliveryId: string) => {
      const context = mailbox.getDelivery(deliveryId);
      assert.ok(context, "The message is in the mailbox.");
      const taskWakes = waits.takeTaskWakes(worker.id, deliveryId);
      return deliveryPromptInput(context, { agentNames: new Map(), snapshot, routineRun: null, taskWakes })
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
    };
    const next = await startTurn(worker.id, null, { kind: "user" }, "What is the status?", "turn-own-1");
    const prompt = promptOf(next);
    assert.equal(count(prompt, "--- internal wake:"), 1, "The note is in the prompt once.");
    for (const waitId of [first.waitId, second, third]) {
      assert.equal(count(prompt, `Wait ID: ${waitId}`), 1, `Wait ${waitId} is named once.`);
    }
    assert.equal(
      mailbox.getDelivery(next)?.delivery.sender.kind,
      "user",
      "The delivery keeps the sender that sent it.",
    );
    assert.equal(
      count(promptOf(next), "--- internal wake:"),
      1,
      "A prompt built again for the same delivery gets the same note.",
    );
    const later = await startTurn(worker.id, null, { kind: "user" }, "Thanks.", "turn-own-2");
    assert.equal(count(promptOf(later), "--- internal wake:"), 0, "No later prompt repeats the note.");
    assert.deepEqual(waits.takeTaskWakes(neighbour.id, next), [], "Another agent gets no note.");
    return { promptChars: prompt.length, waits: [first.waitId, second, third] };
  });

  await step("The woken waits are still open until the agent closes them", async () => {
    const closed = call(worker.id, "turn-own-3", CLOSE_WAIT_TOOL, { waitId: third });
    assert.equal(closed.success, true, "close_wait closes a woken wait.");
    assert.equal(waitOf(worker.id, third), undefined);
    return { closed: third };
  });

  report.passed = true;
} finally {
  conversation.dispose();
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
