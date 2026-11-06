// Checks the web source cache through the production turn path: the real agent service, turn lifecycle and
// SQLite store on a temporary profile, with a fake Codex app-server. When a person's message holds
// `WEB-SEARCH <<query>>`, the fake runs a web search for that query as Codex does: it emits a `webSearch`
// item and completes it. Checks:
// 1. The first search is kept when it completes. `recall` returns it with its query, fetch time and age.
// 2. A second turn that asks the same query is kept too, and the first source is still returned with the
//    fetch time it had.
// 3. A query that holds a known secret pattern is kept redacted, and the secret is not in the table.
// 4. A query that holds a registered secret is refused, the turn still completes, and no row is added.
// `recall` is called from this check, since no router tool exposes it yet.
// Run: `bun scripts/research-cache-e2e.ts`. Writes .openbot-build/research-cache-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { RecalledResearchSource } from "../src/backend/research-sources/research-sources";

const OUT = resolve(import.meta.dirname, "../.openbot-build/research-cache-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-research-cache-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder, so these
// modules are imported after the environment is set and cannot be static imports.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { ResearchSourceStore } = await import("../src/backend/research-sources/research-sources");
const { registerSecretValue } = await import("@openbot/logging");

const QUERY = "weather in lisbon";
const SEEDED_SECRET = "sk-fakeresearch00012345";
const REGISTERED_SECRET = "registered-research-secret-value";

const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [] };
let buffer = "";
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const step = (ms) => new Promise((done) => setTimeout(done, ms));
async function runTurn(threadId, turnId, text) {
  const search = /WEB-SEARCH <<([\\s\\S]*?)>>/.exec(text);
  if (search) {
    const query = search[1];
    const item = { type: "webSearch", id: "search-" + turnId, query, action: { type: "search", query } };
    write({ method: "item/started", params: { threadId, turnId, item } });
    await step(10);
    write({ method: "item/completed", params: { threadId, turnId, item } });
  }
  write({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" } } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid, turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/archive": return write({ id: message.id, result: {} });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      void runTurn(params.threadId, turnId, text);
      return;
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
setInterval(() => {}, 1000);
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
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

/** Waits for a state of the service. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 25);
    await pause.promise;
  }
}

interface Report {
  passed: boolean;
  firstSearch: RecalledResearchSource | null;
  secondTurnSources: RecalledResearchSource[];
  seededSecretQuery: string | null;
  rowCountAfterRefusal: number | null;
  error?: string;
}

const report: Report = {
  passed: false,
  firstSearch: null,
  secondTurnSources: [],
  seededSecretQuery: null,
  rowCountAfterRefusal: null,
};

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  requestTimeoutMs: 5_000,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const research = new ResearchSourceStore(database);

/** Sends a person's message and waits until its turn ends. The turn must complete, refused cache or not. */
async function send(agentId: string, text: string): Promise<void> {
  const receipt = await runCauseEffect(agents.sendMessage({ agentId, text }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message was queued.");
  const status = await waitFor(`the turn for "${text}" to end`, () => {
    const current = mailbox.getDelivery(deliveryId)?.delivery.status;
    return current === "completed" || current === "failed" || current === "interrupted" ? current : null;
  });
  assert.equal(status, "completed", `The turn for "${text}" completed.`);
}

/** Every row of the table, oldest first. The check reads the table itself, not the store's recall. */
function storedRows() {
  return database.connection
    .prepare(
      "SELECT id, agent_id, query, url, title, snippet_hash, fetched_at FROM research_sources ORDER BY fetched_at",
    )
    .all();
}

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Research cache",
      description: "Checks the web source cache.",
      avatarSeed: "research-cache",
      avatarHue: null,
      initialMessage: `WEB-SEARCH <<${QUERY}>>`,
    }),
  );
  const idle = () =>
    !agents
      .listQueue(agent.id)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
  await waitFor("the first turn to start", () => !idle());
  await waitFor("the first turn to end", idle);

  // 1. The first search completes and is kept; recall returns it with its fetch time and age.
  const afterFirst = research.recall(agent.id, QUERY, 7);
  assert.equal(afterFirst.length, 1, "The first search is kept once.");
  const first = afterFirst[0];
  assert.ok(first, "The first search is recalled.");
  assert.equal(first.query, QUERY, "The recalled query is the searched one.");
  assert.equal(first.url, null, "A search item has no page url.");
  assert.equal(first.snippetHash.length, 64, "The snippet is kept as a SHA-256 digest.");
  assert.ok(!Number.isNaN(Date.parse(first.fetchedAt)), "The fetch time is a date.");
  assert.ok(first.ageDays >= 0 && first.ageDays < 1, "A source fetched in this run is less than a day old.");
  report.firstSearch = first;

  // 2. A second turn asks the same query; the first source is still returned with the fetch time it had.
  await send(agent.id, `WEB-SEARCH <<${QUERY}>>`);
  const afterSecond = research.recall(agent.id, QUERY, 7);
  assert.equal(afterSecond.length, 2, "The second search is kept as its own source.");
  assert.notEqual(afterSecond[0]?.id, first.id, "The newest source comes first.");
  const kept = afterSecond.find((source) => source.id === first.id);
  assert.ok(kept, "The first source is still recalled after the second turn.");
  assert.equal(kept.fetchedAt, first.fetchedAt, "The first source keeps its fetch time.");
  assert.ok(kept.ageDays >= first.ageDays, "The first source is older after the second turn.");
  report.secondTurnSources = afterSecond;

  // 3. A query with a known secret pattern is kept redacted, and the secret is not in the table.
  const rowsBeforeSecret = storedRows().length;
  await send(agent.id, `WEB-SEARCH <<${SEEDED_SECRET} lisbon weather>>`);
  const rowsAfterSecret = storedRows();
  assert.equal(rowsAfterSecret.length, rowsBeforeSecret + 1, "The search with the seeded secret is kept.");
  assert.ok(!JSON.stringify(rowsAfterSecret).includes(SEEDED_SECRET), "The seeded secret is not in the table.");
  const redactedRow = rowsAfterSecret.find((row) => String(row.query).includes("[redacted]"));
  assert.ok(redactedRow, "The query with the seeded secret is stored redacted.");
  report.seededSecretQuery = String(redactedRow.query);

  // 4. A query with a registered secret is refused: the turn completes and no row is added.
  registerSecretValue(REGISTERED_SECRET);
  const rowsBeforeRefusal = storedRows().length;
  await send(agent.id, `WEB-SEARCH <<find ${REGISTERED_SECRET}>>`);
  const rowsAfterRefusal = storedRows();
  assert.equal(rowsAfterRefusal.length, rowsBeforeRefusal, "A search with a registered secret adds no row.");
  assert.ok(
    !JSON.stringify(rowsAfterRefusal).includes(REGISTERED_SECRET),
    "The registered secret is not in the table.",
  );
  report.rowCountAfterRefusal = rowsAfterRefusal.length;

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
