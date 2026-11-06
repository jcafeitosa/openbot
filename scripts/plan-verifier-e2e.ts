// Checks the plan verifier: a turn whose plan steps all read done is checked, with a tool-less
// generation over the steps and the final answer, before the request ends. The verifier's gaps run
// once more with a note that names them; an approval ends the request with no extra turn. Runs the
// real agent service on a temporary profile with a fake Codex app-server. The current message names
// its turns in `<<PLAN[...]PLAN>>`: each element is one turn, with its plan steps, its answer and an
// optional `verdict` for the check of that answer (`{ approved, gaps }`, or a raw text that is not a
// verdict). The fake answers the check's own thread with the verdict of the answer it quotes, and
// logs it. A continuation turn takes the next element of its thread.
// Checks:
//   1. A step marked done with no evidence is sent back by the check: the gap shows in the note, the
//      request does not end after the first turn, and the second turn closes it after an approval.
//   2. An approved plan runs no extra turn, and the check sees the steps and the answer.
//   3. A check that repeats the same gap stops the chain: the request ends after two checks.
//   4. A verdict that is not a verdict approves: the turn ends, and no error shows.
// No provider, account or network is used. Writes .openbot-build/plan-verifier-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, PLAN_CONTINUATION_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/plan-verifier-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-plan-verifier-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const verdictsFile = join(root, "verdicts.json");
const NOTE_MARKER = "OpenBot note, not a message from the user";
const VERIFIER_MARKER = "OpenBot plan check, not a message from the user";

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

type StepStatus = "pending" | "inProgress" | "completed";

/** One verdict of the check: an object, or a raw text that is not a verdict. */
type FakeVerdict = { approved: boolean; gaps: string[] } | string;

/** One turn of the fake: its plan, its answer, and the verdict of the check of that answer. */
interface FakeTurn {
  steps: [string, StepStatus][];
  answer?: string;
  verdict?: FakeVerdict;
}

const plan = (...turns: FakeTurn[]) => `<<PLAN${JSON.stringify(turns)}PLAN>>`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const NOTE = ${JSON.stringify(NOTE_MARKER)};
const VERIFIER = ${JSON.stringify(VERIFIER_MARKER)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** The turns that each thread has still to run, from the message that named them. */
const scripts = new Map();
/** The verdict of the check for each agent answer that a script named, shared by every provider process. */
const VERDICTS = ${JSON.stringify(verdictsFile)};
const readVerdicts = () => (fs.existsSync(VERDICTS) ? JSON.parse(fs.readFileSync(VERDICTS, "utf8")) : {});
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finishWith = (threadId, turnId, text) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const finish = (turn) => {
  const plan = (turn.script.steps || []).map(([step, status]) => ({ step, status }));
  if (plan.length > 0) write({ method: "turn/plan/updated", params: { threadId: turn.threadId, turnId: turn.turnId, plan } });
  finishWith(turn.threadId, turn.turnId, turn.script.answer || "Done.");
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
      if (text.includes(VERIFIER)) {
        // The check runs in its own provider process, so the verdicts come from the file that the scripts wrote.
        const known = readVerdicts();
        const quoted = Object.keys(known).find((key) => text.includes(key));
        const verdict = quoted === undefined ? { approved: true, gaps: [] } : known[quoted];
        log({ method: "verifier", threadId: params.threadId, turnId, text });
        return finishWith(params.threadId, turnId, typeof verdict === "string" ? verdict : JSON.stringify(verdict));
      }
      const note = text.includes(NOTE);
      if (!note) {
        const named = /<<PLAN([\\s\\S]*?)PLAN>>/.exec(text.split("--- current message ---").at(-1));
        const parsed = named ? JSON.parse(named[1]) : [];
        const known = readVerdicts();
        for (const turn of parsed) if (turn.verdict !== undefined) known[turn.answer] = turn.verdict;
        fs.writeFileSync(VERDICTS, JSON.stringify(known));
        scripts.set(params.threadId, parsed);
      }
      const script = (scripts.get(params.threadId) || []).shift() || { steps: [] };
      log({ method: "turn", threadId: params.threadId, turnId, note, text });
      return finish({ threadId: params.threadId, turnId, script });
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
  notChecked: string[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = {
  checks: [],
  notChecked: [
    "a check that is skipped while no spare client is free (the turn then ends without a check)",
    "the gap sentence itself, which the verifier writes; the check asserts only that the gap shows in the note",
  ],
  passed: false,
};

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

interface LoggedTurn {
  method: string;
  threadId: string;
  turnId: string;
  note: boolean;
  text: string;
}

interface LoggedCheck {
  method: string;
  threadId: string;
  turnId: string;
  text: string;
}

function loggedEntries(): (LoggedTurn | LoggedCheck)[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): LoggedTurn | LoggedCheck => JSON.parse(line));
}

/** The user and continuation turns of the agent's threads, in order. */
function loggedTurns(): LoggedTurn[] {
  return loggedEntries().filter((entry): entry is LoggedTurn => entry.method === "turn");
}

/** The check's own tool-less generations, in order. */
function loggedChecks(): LoggedCheck[] {
  return loggedEntries().filter((entry): entry is LoggedCheck => entry.method === "verifier");
}

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });

function openService() {
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
  const events: AgentEvent[] = [];
  service.on("event", (event) => events.push(event));
  return { database, store, mailbox, service, events };
}

const current = openService();

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

async function createAgent(name: string) {
  const { service } = current;
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the plan verifier.",
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

/** Sends a message to the agent's own chat. Answers its delivery id. */
async function send(agentId: string, text: string): Promise<string> {
  const receipt = await runCauseEffect(current.service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

/** Waits for the delivery to end, with all of its continuations, and answers its status. */
function settled(deliveryId: string) {
  return waitFor(`delivery ${deliveryId} to end`, () => {
    const value = current.mailbox.getDelivery(deliveryId)?.delivery.status;
    return ended(value) ? value : null;
  });
}

/** The messages of the agent's own chat, as the database holds them. */
function chatMessages(agentId: string) {
  const threadId = current.store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  return current.database.readConversation(agentId, threadId).messages;
}

/** The continuation lines of the agent's own chat, as the database holds them. */
function continuationLines(agentId: string) {
  return chatMessages(agentId).filter((message) => message.itemType === PLAN_CONTINUATION_ITEM_TYPE);
}

function errorsFor(agentId: string, since: number) {
  return current.events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);
}

const turnsSince = (mark: number) => loggedTurns().slice(mark);
const checksSince = (mark: number) => loggedChecks().slice(mark);

try {
  await runCauseEffect(current.service.initialize());

  await check(
    "a step marked done with no evidence is sent back by the check, then closed by the next turn",
    async () => {
      const agent = await createAgent("Reporter");
      const mark = loggedTurns().length;
      const checkMark = loggedChecks().length;
      const since = current.events.length;
      const gap = "Write the report is marked done, but no report file was written.";
      const id = await send(
        agent.id,
        `Write the report. ${plan(
          {
            steps: [["Write the report", "completed"]],
            answer: "Report written without the file.",
            verdict: { approved: false, gaps: [gap] },
          },
          {
            steps: [["Write the report", "completed"]],
            answer: "Report saved as docs/report.md.",
            verdict: { approved: true, gaps: [] },
          },
        )}`,
      );
      assert.equal(await settled(id), "completed");
      const turns = turnsSince(mark);
      assert.deepEqual(
        turns.map((turn) => turn.note),
        [false, true],
        "One continuation turn runs after the gap.",
      );
      const note = turns[1]?.text ?? "";
      assert.ok(note.includes(`- Gap: ${gap}`), "The note names the gap.");
      assert.ok(note.includes("Automatic continuation 1 of 8."));
      const checks = checksSince(checkMark);
      assert.equal(checks.length, 2, "The check runs after each of the two turns.");
      assert.ok(checks[0]?.text.includes("- [completed] Write the report"), "The check sees the done step.");
      assert.ok(checks[0]?.text.includes("Report written without the file."), "The check sees the final answer.");
      const completions = current.events
        .slice(since)
        .filter((event) => event.type === "turn-completed" && event.agentId === agent.id);
      assert.deepEqual(
        completions.map((event) => event.type === "turn-completed" && event.continues === true),
        [true, false],
        "The request stays open after the gap, and ends after the second check approves.",
      );
      assert.equal(continuationLines(agent.id).length, 1, "One continuation line shows.");
      assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
      return {
        turns: turns.map((turn) => ({ note: turn.note, text: turn.text.slice(0, 400) })),
        checks: checks.map((entry) => ({ turnId: entry.turnId, text: entry.text })),
        gapInNote: gap,
        continues: completions.map((event) => event.type === "turn-completed" && event.continues === true),
      };
    },
  );

  await check("an approved plan runs no extra turn", async () => {
    const agent = await createAgent("Approver");
    const mark = loggedTurns().length;
    const checkMark = loggedChecks().length;
    const since = current.events.length;
    const id = await send(
      agent.id,
      `Save the report. ${plan({
        steps: [["Save the report", "completed"]],
        answer: "Saved at docs/approved.md.",
        verdict: { approved: true, gaps: [] },
      })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false],
      "No continuation turn runs.",
    );
    assert.equal(checksSince(checkMark).length, 1, "The check runs once.");
    assert.equal(continuationLines(agent.id).length, 0, "No continuation line shows.");
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    return { turns: 1, checks: checksSince(checkMark).length };
  });

  await check("a check that repeats the same gap stops the chain", async () => {
    const agent = await createAgent("Repeater");
    const mark = loggedTurns().length;
    const checkMark = loggedChecks().length;
    const gap = "Index the docs is marked done, but no index file exists.";
    const same: FakeTurn = {
      steps: [["Index the docs", "completed"]],
      answer: "Indexed without evidence.",
      verdict: { approved: false, gaps: [gap] },
    };
    const id = await send(agent.id, `Index the docs. ${plan(same, same, same)}`);
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false, true],
      "One continuation turn runs, then the repeated gap ends the chain.",
    );
    assert.equal(checksSince(checkMark).length, 2, "The check runs twice.");
    assert.equal(continuationLines(agent.id).length, 1, "One continuation line shows.");
    return { turns: turnsSince(mark).length, checks: checksSince(checkMark).length };
  });

  await check("a verdict that is not a verdict approves, and no error shows", async () => {
    const agent = await createAgent("Unreadable");
    const mark = loggedTurns().length;
    const since = current.events.length;
    const id = await send(
      agent.id,
      `Ship it. ${plan({
        steps: [["Ship it", "completed"]],
        answer: "Shipped without a readable verdict.",
        verdict: "not a verdict",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false],
      "No continuation turn runs.",
    );
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    return { turns: 1 };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(current.service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  current.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
