// Checks the Settings › Agents capability switches through the desktop IPC handler, not the renderer
// DOM. The real `app` group registrar binds `app:get-agent-capability-switches` and
// `app:set-agent-capability-switches` through `registerIpcGroup`, so each call runs the trusted sender
// check, the payload parser and the handler that the window uses. The store is the production one, on a
// temporary userData folder, and every write is read back from the file.
// Run: `bun scripts/capability-switches-ui-e2e.ts`.
// Writes .openbot-build/capability-switches-ui-e2e/report.json.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentCapabilitySwitches,
  DEFAULT_AGENT_CAPABILITY_SWITCHES,
  IPC_ENDPOINTS,
  isAgentCapabilitySwitches,
} from "@openbot/contracts/ipc";
import { plugin } from "bun";

const OUT = resolve(import.meta.dirname, "../.openbot-build/capability-switches-ui-e2e");
// The file name that `application-services.ts` gives the switch store in userData.
const SWITCHES_FILE = "openbot-agent-capability-switches-v1.json";
const TRUSTED = { senderFrame: { url: "openbot-app://app/index.html" } };
const UNTRUSTED = { senderFrame: { url: "https://evil.example/index.html" } };
const ALL_ON: AgentCapabilitySwitches = { crossProviderCheck: true, recurrenceNote: true, planVerifier: true };

/** The userData file: the switches plus the version the store writes. */
type SwitchFile = AgentCapabilitySwitches & { version: number };

type Listener = (event: unknown, payload?: unknown) => unknown;
const registrations = new Map<string, Listener>();

// Electron is imported for its windows and `ipcMain`. This check opens no window: `ipcMain.handle`
// records each listener, so the check calls it the way the trusted renderer does.
plugin({
  name: "capability-switches-electron-boundary",
  setup(build) {
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-e2e", isPackaged: false, on: () => undefined },
        dialog: {},
        ipcMain: {
          handle: (channel: string, listener: Listener) => {
            registrations.set(channel, listener);
          },
          removeHandler: () => undefined,
          on: () => undefined,
        },
      },
    }));
  },
});

// Loaded after the electron stub above is registered: the app modules import electron when they load.
const { appIpcHandlers } = await import("../src/main/ipc/app-handlers");
const { registerIpcGroup } = await import("../src/main/ipc/define-ipc-group");
const { createAgentCapabilitySwitchesStore } = await import("../src/main/agent-capability-switches-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: CheckResult[] = [];
const startedAt = new Date().toISOString();
let failure: string | null = null;
const userData = await mkdtemp(join(tmpdir(), "capability-switches-ui-e2e-"));
const file = join(userData, SWITCHES_FILE);

const get = IPC_ENDPOINTS.app.getAgentCapabilitySwitches.channel;
const set = IPC_ENDPOINTS.app.setAgentCapabilitySwitches.channel;

/** Calls a bound handler as the window would. A switches answer is checked against its contract type. */
function call(channel: string, payload: unknown, event: unknown = TRUSTED): Promise<AgentCapabilitySwitches> {
  const listener = registrations.get(channel);
  assert.ok(listener, `no handler is bound to ${channel}`);
  return Promise.resolve()
    .then(() => listener(event, payload))
    .then((value) => {
      assert.ok(isAgentCapabilitySwitches(value), "the handler answered with something other than the switches");
      return value;
    });
}

function readFile(): SwitchFile {
  return JSON.parse(readFileSync(file, "utf8"));
}

function record(name: string, detail: string): void {
  checks.push({ name, ok: true, detail });
}

try {
  const store = createAgentCapabilitySwitchesStore(file);
  await runCauseEffect(store.load());
  // The `app` group takes about forty dependencies. These two channels read only the switch store,
  // so the others are never read here.
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the other app dependencies are not read by the switch channels.
  const deps = { agentCapabilitySwitches: store } as unknown as Parameters<typeof appIpcHandlers>[0];
  registerIpcGroup("app", appIpcHandlers(deps).app);

  assert.equal(existsSync(file), false);
  assert.deepEqual(await call(get, undefined), DEFAULT_AGENT_CAPABILITY_SWITCHES);
  record("read before any write", "no userData file yet; the read returns all three switches on");

  const off = { ...ALL_ON, crossProviderCheck: false };
  assert.deepEqual(await call(set, off), off);
  assert.deepEqual(readFile(), { version: 1, ...off });
  assert.deepEqual(await call(get, undefined), off);
  record("switch off", "set returned crossProviderCheck:false; the file holds it; the read back agrees");

  const reloaded = createAgentCapabilitySwitchesStore(file);
  await runCauseEffect(reloaded.load());
  assert.deepEqual(reloaded.get(), off);
  record("reload from file", "a new store on the same file reads the saved switches");

  assert.deepEqual(await call(set, ALL_ON), ALL_ON);
  assert.deepEqual(readFile(), { version: 1, ...ALL_ON });
  assert.deepEqual(await call(get, undefined), ALL_ON);
  record("switch on", "set returned all three on; the file and the read back agree");

  const before = readFileSync(file, "utf8");
  const refused = /Agent capability switches are required/;
  await assert.rejects(call(set, { ...ALL_ON, crossProviderCheck: "off" }), refused);
  await assert.rejects(call(set, { crossProviderCheck: true, recurrenceNote: true }), refused);
  await assert.rejects(call(set, null), refused);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(await call(get, undefined), ALL_ON);
  record("invalid value refused", "a string, a missing switch and null are each refused; the file is unchanged");

  await assert.rejects(call(set, { ...ALL_ON, planVerifier: false }, UNTRUSTED));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(await call(get, undefined), ALL_ON);
  record("untrusted sender refused", "a frame outside the app is refused before the payload is read");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ script: "capability-switches-ui-e2e", startedAt, ok: failure === null, checks, failure }, null, 2)}\n`,
  );
  await rm(userData, { recursive: true, force: true });
}

if (failure !== null) {
  process.stderr.write(`capability-switches-ui-e2e failed: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`capability-switches-ui-e2e: ${checks.length} checks passed\n`);
