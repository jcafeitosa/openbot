// Checks the agent goal budget on the real routine scheduler, SQLite stores and mailbox. A goal with two
// runs lets two scheduled runs of an agent's routine count, then refuses the third and exhausts the goal.
// A goal whose deadline has passed refuses the next run. Each request goes through the real IPC decoder
// (`parseCreateRoutine`) into `RoutineScheduler.create`. The clock is moved with `setSystemTime`, and each
// scheduler pass gets an explicit clock. No provider, account or network is started: a queued delivery is
// cancelled to end its run, as a user does in the queue.
// Run: `bun scripts/agent-goals-e2e.ts`.
// Writes .openbot-build/agent-goals-e2e/report.json.

import { setSystemTime } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, Routine, RoutineRun } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { RoutineScheduler } from "../src/backend/agent/routine-scheduler";
import { type AgentGoal, AgentGoalStore } from "../src/backend/agent-goals/agent-goals";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { AgentStore } from "../src/backend/agent-store";
import { AgentWaitStore } from "../src/backend/agent-waits/agent-wait-store";
import { AgentWaits } from "../src/backend/agent-waits/agent-waits";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { RoutineTimer } from "../src/backend/routine-timer";
import { parseCreateRoutine } from "../src/main/ipc/agent-inputs";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "agent-goals-e2e");
const STEP_DEADLINE_MS = 15_000;
const DAY = "2031-03-03";
const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

interface Fixture {
  database: OpenBotDatabase;
  mailbox: MailboxStore;
  scheduler: RoutineScheduler;
  store: AgentStore;
  goals: AgentGoalStore;
  runs: AgentRoutineStore;
  agentId: string;
  events: AgentEvent[];
  errors: string[];
  close(): void;
}

async function openFixture(root: string): Promise<Fixture> {
  const database = new OpenBotDatabase(join(root, "state"));
  const store = new AgentStore(join(root, "state"), join(root, "home"), database);
  const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
  let conversation: ConversationRuntime | undefined;
  try {
    await runCauseEffect(store.initialize());
    await runCauseEffect(mailbox.initialize());
    const agent =
      store.list()[0] ??
      (await runCauseEffect(
        store.createAgent({
          name: "Goal fixture",
          description: "Synthetic goal fixture",
          avatarSeed: "agent-goals",
          avatarHue: null,
        }),
      ));
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    conversation = new ConversationRuntime(
      store,
      () => {},
      () => store.list(),
    );
    const runtime = conversation;
    const timer = new RoutineTimer(
      () => [],
      () => false,
      (code) => errors.push(code),
    );
    const waits = new AgentWaits({
      store: new AgentWaitStore({ database }),
      mailbox,
      hooks: {
        emit: () => {},
        ownsRoutine: () => true,
        hasRoutine: () => true,
        requireKnownAgent: () => {},
        routineForDelivery: () => null,
      },
    });
    const scheduler = new RoutineScheduler({
      store,
      mailbox,
      conversation: runtime,
      timer,
      waits,
      timezone: () => "UTC",
      hooks: {
        emit: (event) => events.push(event),
        emitError: (code) => errors.push(code),
        emitQueue: () => {},
        scheduleDrain: () => {},
        interrupt: () => Effect.void,
        awaitDrain: () => undefined,
        syncMailboxMessages: () => {},
        listAgents: () => store.list(),
        excludedAgents: () => new Set(),
        isRunning: () => false,
        usageLimited: () => false,
        routineThread: () => null,
        routineDeleted: () => Effect.void,
      },
    });
    return {
      database,
      mailbox,
      scheduler,
      store,
      goals: new AgentGoalStore(database),
      runs: new AgentRoutineStore(database),
      agentId: agent.id,
      events,
      errors,
      close() {
        timer.dispose();
        runtime.dispose();
        database.close();
      },
    };
  } catch (error) {
    conversation?.dispose();
    database.close();
    throw error;
  }
}

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // A bound on failure only: each check awaits its own operation.
    const timeout = Promise.withResolvers<never>();
    deadline = setTimeout(
      () => timeout.reject(new Error(`No result within ${STEP_DEADLINE_MS} ms.`)),
      STEP_DEADLINE_MS,
    );
    const value = await Promise.race([run(), timeout.promise]);
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-agent-goals-"));
let fixture: Fixture | undefined;

function current(): Fixture {
  assert.ok(fixture, "The fixture is open.");
  return fixture;
}

function routine(id: string): Routine {
  const found = current()
    .scheduler.list(current().agentId)
    .find((row) => row.id === id);
  assert.ok(found, "The routine exists.");
  return found;
}

function deliveries(id: string): number {
  return current()
    .mailbox.conversationMessages(current().agentId)
    .filter((message) => message.routine?.routineId === id).length;
}

function runs(id: string): RoutineRun[] {
  return current().runs.listRuns(current().agentId, id, 50, true);
}

function runAt(id: string, time: string): RoutineRun {
  const found = runs(id).find((run) => run.scheduledFor === at(time).toISOString());
  assert.ok(found, `The routine has a run scheduled for ${time}.`);
  return found;
}

function goal(id: string): AgentGoal {
  const found = current().goals.get(id);
  assert.ok(found, "The goal exists.");
  return found;
}

/** Ends the queued routine runs, as a user who cancels them in the queue. */
async function cancelQueued(): Promise<void> {
  const { mailbox, agentId } = current();
  for (const deliveryId of mailbox.queuedDeliveryIds(agentId))
    await runCauseEffect(mailbox.cancel(agentId, deliveryId));
}

async function pass(now: Date): Promise<void> {
  await runCauseEffect(current().scheduler.processDue(now));
}

try {
  let routineId = "";
  let budgetGoalId = "";
  let deadlineGoalId = "";

  await step("Create a routine and a goal with two runs for its agent", async () => {
    setSystemTime(at("10:01"));
    fixture = await openFixture(root);
    const created = current().scheduler.create(
      parseCreateRoutine({
        agentId: current().agentId,
        name: "Quarter-hour report",
        instruction: "Write the quarter-hour report.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "*/15 * * * *" },
        missedPolicy: "run-once",
      }),
      { recordConversationEvent: false },
    );
    routineId = created.id;
    assert.equal(created.trigger.nextRunAt, at("10:15").toISOString());
    const budget = current().goals.create({
      agentId: current().agentId,
      objective: "Write two quarter-hour reports.",
      maxRuns: 2,
    });
    budgetGoalId = budget.id;
    assert.equal(budget.status, "open");
    assert.equal(budget.runsUsed, 0);
    return { routineId, goal: { status: budget.status, runsUsed: budget.runsUsed, maxRuns: budget.maxRuns } };
  });

  await step("The first scheduled run is admitted and counts once", async () => {
    setSystemTime(at("10:15"));
    await pass(at("10:15"));
    assert.equal(deliveries(routineId), 1);
    assert.equal(runAt(routineId, "10:15").status === "failed", false);
    assert.equal(goal(budgetGoalId).runsUsed, 1);
    assert.equal(goal(budgetGoalId).status, "open");
    assert.equal(routine(routineId).trigger.nextRunAt, at("10:30").toISOString());
    await cancelQueued();
    return {
      deliveries: deliveries(routineId),
      goal: { status: goal(budgetGoalId).status, runsUsed: goal(budgetGoalId).runsUsed },
    };
  });

  await step("The second scheduled run is admitted and exhausts the goal", async () => {
    setSystemTime(at("10:30"));
    await pass(at("10:30"));
    assert.equal(deliveries(routineId), 2);
    assert.notEqual(runAt(routineId, "10:30").status, "failed");
    assert.equal(goal(budgetGoalId).runsUsed, 2);
    assert.equal(goal(budgetGoalId).status, "exhausted");
    await cancelQueued();
    return {
      deliveries: deliveries(routineId),
      goal: { status: goal(budgetGoalId).status, runsUsed: goal(budgetGoalId).runsUsed },
    };
  });

  await step("The third scheduled run is refused and the goal stays exhausted", async () => {
    setSystemTime(at("10:45"));
    const errorsBefore = current().errors.length;
    await pass(at("10:45"));
    assert.equal(deliveries(routineId), 2, "The refused run queues no delivery.");
    const refused = runAt(routineId, "10:45");
    assert.equal(refused.status, "failed");
    assert.match(refused.error ?? "", /has used all 2 of its runs, so the run was refused/);
    assert.equal(goal(budgetGoalId).runsUsed, 2, "A refused run does not count.");
    assert.equal(goal(budgetGoalId).status, "exhausted");
    assert.ok(
      current().errors.slice(errorsBefore).includes("routine_delivery_failed"),
      "The refusal reaches the routine failure path.",
    );
    return { run: { status: refused.status, error: refused.error }, goal: { status: goal(budgetGoalId).status } };
  });

  await step("A goal past its deadline refuses the next run", async () => {
    setSystemTime(at("10:46"));
    const deadline = current().goals.create({
      agentId: current().agentId,
      objective: "Write the report before 10:50.",
      maxRuns: 5,
      deadlineAt: at("10:50").toISOString(),
    });
    deadlineGoalId = deadline.id;
    assert.equal(deadline.status, "open");
    setSystemTime(at("11:00"));
    const errorsBefore = current().errors.length;
    await pass(at("11:00"));
    assert.equal(deliveries(routineId), 2, "The run past the deadline queues no delivery.");
    const refused = runAt(routineId, "11:00");
    assert.equal(refused.status, "failed");
    assert.match(refused.error ?? "", /deadline has passed, so the run was refused/);
    assert.equal(goal(deadlineGoalId).status, "exhausted");
    assert.equal(goal(deadlineGoalId).runsUsed, 0, "A run past the deadline does not count.");
    assert.ok(current().errors.slice(errorsBefore).includes("routine_delivery_failed"));
    return { run: { status: refused.status, error: refused.error }, goal: { status: goal(deadlineGoalId).status } };
  });

  await step("Deleting the agent removes its goals", async () => {
    const goalRows = "SELECT goal_id FROM agent_goals WHERE agent_id = ?";
    const before = current().database.connection.prepare(goalRows).all(current().agentId).length;
    assert.equal(before, 2, "The agent has the two goals of this run.");
    await runCauseEffect(current().store.deleteAgent(current().agentId));
    const after = current().database.connection.prepare(goalRows).all(current().agentId).length;
    assert.equal(after, 0, "The deleted agent keeps no goal rows.");
    return { goalsBefore: before, goalsAfter: after };
  });
} finally {
  fixture?.close();
  fixture = undefined;
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  report.passed = report.steps.length > 0 && report.steps.every((item) => item.passed);
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) {
  const failed = report.steps.filter((item) => !item.passed);
  throw new Error(
    `${failed.length} of ${report.steps.length} agent goal checks failed. See ${join(OUT, "report.json")}.`,
  );
}
process.stdout.write(`Passed ${report.steps.length} agent goal checks. Wrote ${join(OUT, "report.json")}.\n`);
