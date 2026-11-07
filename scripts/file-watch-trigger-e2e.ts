// Checks file-change triggers on routines. A routine with a `fileWatch` starts one run after a burst of changes in its
// folder, refuses a path outside its agent's workspace, rebuilds its watcher on a restart, closes the watcher at once
// when the routine is paused or deleted, and reopens it when the routine resumes. Runs the real agent service on a
// temporary profile with a fake Codex app-server, so an agent can take a turn.
// `bun scripts/file-watch-trigger-e2e.ts`. Writes .openbot-build/file-watch-trigger-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type RoutineFileWatchInput } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/file-watch-trigger-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-file-watch-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService: AgentServiceClass } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const DEBOUNCE_SECONDS = 2;
/** After the quiet time: enough for the watcher to deliver its events and the run to be recorded. */
const SETTLE_MS = 1500;

/**
 * A Codex app-server with the methods that the service calls. Every turn completes with one answer, so an agent
 * can take its first turn and a routine run ends.
 */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
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
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      write({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "agentMessage", id: "message-" + turnId, text: "All good.", phase: "final_answer" } } });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
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

const report: { checks: { name: string; passed: boolean }[]; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Waits for a state of the service or its files. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(25);
  }
}

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

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

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);

function createService() {
  return new AgentServiceClass({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  });
}

let agents = createService();

/** A daily schedule two hours ahead, so the routine's own clock does not fire during the check. */
function scheduleAhead(): { kind: "daily"; time: string } {
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const hh = String(later.getUTCHours()).padStart(2, "0");
  const mm = String(later.getUTCMinutes()).padStart(2, "0");
  return { kind: "daily", time: `${hh}:${mm}` };
}

try {
  await runCauseEffect(agents.initialize());
  const created = await runCauseEffect(
    agents.createAgent({
      name: "Watcher",
      description: "Watches a folder.",
      avatarSeed: "watcher",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  const agentId = created.id;
  await waitFor("the first turn", () =>
    agents.listQueue(agentId).deliveries.every((delivery) => ended(delivery.status)),
  );
  await runCauseEffect(agents.updateAgent({ agentId, allowAutomation: true }));
  const workspace = await waitFor(
    "the workspace",
    () => store.list().find((agent) => agent.id === agentId)?.workspacePath,
  );

  const inbox = join(workspace, "inbox");
  await mkdir(inbox, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  symlinkSync(outside, join(workspace, "escape"), "dir");

  const runs = (routineId: string) => agents.listRoutineRuns({ agentId, routineId }).length;

  function createWatchedRoutine(name: string, fileWatch: RoutineFileWatchInput) {
    return agents.createRoutine({
      agentId,
      name,
      instruction: "Review the new files in the inbox.",
      active: true,
      timezone: "UTC",
      schedule: scheduleAhead(),
      fileWatch,
    });
  }

  // (b) A path outside the workspace is refused before any routine is written.
  for (const [label, path] of [
    ["an absolute folder outside the workspace", outside],
    ["a link out of the workspace", "escape"],
  ] as const) {
    let refused = false;
    try {
      createWatchedRoutine("Refused", { path, debounceSeconds: DEBOUNCE_SECONDS });
    } catch {
      refused = true;
    }
    pass(`A path that is ${label} is refused`, refused, { path });
  }
  pass("A refused path leaves no routine", agents.listRoutines(agentId).length === 0);

  // (a) Three writes inside the debounce window start one run.
  const routine = createWatchedRoutine("Inbox", { path: "inbox", debounceSeconds: DEBOUNCE_SECONDS });
  pass("A routine with a file trigger opens its watcher", agents.isRoutineFileWatchOpen(routine.id));
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(join(inbox, `note-${index}.txt`), `${index}`);
    await sleep(100);
  }
  await sleep(DEBOUNCE_SECONDS * 1000 + SETTLE_MS);
  const afterBurst = runs(routine.id);
  pass("Three writes in the debounce window start one run", afterBurst === 1, { runs: afterBurst });
  await sleep(SETTLE_MS);
  pass("The burst starts no second run later", runs(routine.id) === 1);

  // (c) A restart rebuilds the watcher from its row, and one write starts one run.
  await runCauseEffect(agents.stop());
  agents = createService();
  await runCauseEffect(agents.initialize());
  pass("A restart rebuilds the watcher", agents.isRoutineFileWatchOpen(routine.id));
  await writeFile(join(inbox, "after-restart.txt"), "restart");
  await sleep(DEBOUNCE_SECONDS * 1000 + SETTLE_MS);
  const afterRestart = runs(routine.id);
  pass("After a restart one write starts one run", afterRestart === 2, { runs: afterRestart });

  // (d) Pausing closes the watcher at once, so a write starts no run. Resuming opens it again.
  agents.updateRoutine({ agentId, routineId: routine.id, active: false });
  pass("Pausing the routine closes its watcher at once", !agents.isRoutineFileWatchOpen(routine.id));
  const beforePause = runs(routine.id);
  await writeFile(join(inbox, "while-paused.txt"), "paused");
  await sleep(DEBOUNCE_SECONDS * 1000 + SETTLE_MS);
  pass("A write while the routine is paused starts no run", runs(routine.id) === beforePause);
  agents.updateRoutine({ agentId, routineId: routine.id, active: true });
  pass("Resuming the routine opens its watcher again", agents.isRoutineFileWatchOpen(routine.id));

  // Deleting the routine closes its watcher at once.
  const second = createWatchedRoutine("Second inbox", { path: "inbox", debounceSeconds: DEBOUNCE_SECONDS });
  pass("A second routine on the same folder opens its own watcher", agents.isRoutineFileWatchOpen(second.id));
  await runCauseEffect(agents.deleteRoutine({ agentId, routineId: second.id }));
  pass("Deleting a routine closes its watcher at once", !agents.isRoutineFileWatchOpen(second.id));
  pass("The first routine keeps its watcher", agents.isRoutineFileWatchOpen(routine.id));

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
