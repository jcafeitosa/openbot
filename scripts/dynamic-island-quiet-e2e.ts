// Checks quiet mode of the Dynamic Island (the `muted` choice) through the real window controller and
// the real preference file. Only the Electron window is replaced: a stand-in records what main sends
// to the island page. It sends nothing outside this process. Run it with
// `bun scripts/dynamic-island-quiet-e2e.ts`. Writes .openbot-build/dynamic-island-quiet-e2e/report.json.
//
// It covers: work in progress and replies stay out in quiet mode while a question, an approval and a
// failure stay; turning quiet mode off shows the last published state again; haptic feedback stops;
// a saved choice survives a restart together with the other settings; a file from before the choice
// keeps its settings.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_DYNAMIC_ISLAND_PREFERENCE,
  type DynamicIslandAgentIdentity,
  type DynamicIslandPresentation,
  IPC_ENDPOINTS,
  isDynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { BrowserWindow, Display } from "electron";
import { DynamicIslandWindowController } from "../src/main/dynamic-island-window";

const logger = createOpenBotLogger("dynamic-island-quiet-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/dynamic-island-quiet-e2e");
const PRESENTATION_CHANNEL = IPC_ENDPOINTS.dynamicIsland.presentation.channel;

/** The built-in display of a 14-inch MacBook, which has a notch. */
const displayShape = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 } };

// Type guards say what the stand-ins are. Electron builds its classes in the app, so a stand-in
// cannot be one, and a guard checks the members that the controller calls.
function isDisplay(value: unknown): value is Display {
  return typeof value === "object" && value !== null && "bounds" in value && "internal" in value && "id" in value;
}

function isBrowserWindow(value: unknown): value is BrowserWindow {
  return typeof value === "object" && value !== null && "showInactive" in value && "webContents" in value;
}

const display: Display = (() => {
  if (!isDisplay(displayShape)) throw new Error("The display stand-in is not a display.");
  return displayShape;
})();
const agent: DynamicIslandAgentIdentity = {
  id: "agent-1",
  name: "Ada",
  avatarSeed: "ada",
  avatarHue: null,
  avatarUrl: null,
};

const working: DynamicIslandPresentation = {
  serverId: "local",
  mode: "working",
  working: [{ agent, task: "Reading files", turnId: "turn-1" }],
};
const message: DynamicIslandPresentation = {
  serverId: "local",
  mode: "message",
  unreadCount: 2,
  message: { agent, messageId: "m-1", text: "Done.", createdAt: "2026-01-01T00:00:00.000Z" },
};
const question: DynamicIslandPresentation = {
  serverId: "local",
  mode: "question",
  remainingCount: 0,
  item: { requestId: 1, agent, title: "Pick one", detail: null, questions: [] },
};
const approval: DynamicIslandPresentation = {
  serverId: "local",
  mode: "approval",
  remainingCount: 0,
  item: {
    requestId: 2,
    agent,
    title: "Run a command",
    detail: null,
    truncated: false,
    approval: { kind: "command", command: "ls", cwd: null, reason: null, grantRoot: null, permissions: null },
  },
};
const failed: DynamicIslandPresentation = {
  serverId: "local",
  mode: "failed",
  item: { turnId: "turn-9", agent, title: "The task stopped", detail: null },
};

/** A window that records each presentation that main sends to the page. */
function fakeWindow(sent: DynamicIslandPresentation[]): BrowserWindow {
  const noop = () => undefined;
  const window = {
    excludedFromShownWindowsMenu: false,
    isDestroyed: () => false,
    isFocused: () => false,
    focus: noop,
    destroy: noop,
    showInactive: noop,
    setBounds: noop,
    setHasShadow: noop,
    setWindowButtonVisibility: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setHiddenInMissionControl: noop,
    setFocusable: noop,
    setIgnoreMouseEvents: noop,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    on: noop,
    once: noop,
    webContents: {
      id: 1,
      on: noop,
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      mainFrame: { isDestroyed: () => false, detached: false },
      send(channel: string, payload: unknown) {
        if (channel === PRESENTATION_CHANNEL && isDynamicIslandPresentation(payload)) sent.push(payload);
      },
    },
  };
  if (!isBrowserWindow(window)) throw new Error("The window stand-in is not a window.");
  return window;
}

async function createController(preferencePath: string) {
  const sent: DynamicIslandPresentation[] = [];
  let haptics = 0;
  const controller = new DynamicIslandWindowController({
    platform: "darwin",
    preferencePath,
    createWindow: () => fakeWindow(sent),
    loadWindow: async () => undefined,
    getDisplays: () => [display],
    getMainWindow: () => null,
    presentMainWindow: () => undefined,
    performHaptic: () => {
      haptics += 1;
    },
    performCriticalAction: () => Effect.void,
  });
  await Effect.runPromise(controller.initialize());
  await Effect.runPromise(controller.reconcileWindow());
  return { controller, sent, haptics: () => haptics };
}

const modes = (sent: DynamicIslandPresentation[]) => sent.map((presentation) => presentation.mode);
const results: Array<{ check: string; passed: boolean; detail?: string }> = [];

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    results.push({ check: name, passed: true });
  } catch (error) {
    results.push({ check: name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

const directory = mkdtempSync(join(tmpdir(), "island-quiet-"));
try {
  const preferencePath = join(directory, "dynamic-island.json");
  const first = await createController(preferencePath);
  const base = { ...DEFAULT_DYNAMIC_ISLAND_PREFERENCE };

  await check("Work in progress shows when quiet mode is off", () => {
    first.controller.publish(working);
    assert.deepEqual(modes(first.sent), ["working"]);
  });

  await check("Quiet mode turns work in progress into idle at once", async () => {
    await Effect.runPromise(first.controller.setPreference({ ...base, muted: true, hapticsEnabled: false }));
    assert.equal(first.sent.at(-1)?.mode, "idle");
  });

  await check("A reply stays out in quiet mode", () => {
    const before = first.sent.length;
    first.controller.publish(message);
    assert.equal(first.sent.length, before, "The island page got a presentation for a reply.");
    assert.equal(first.controller.presentation.mode, "idle");
  });

  for (const [name, presentation] of [
    ["question", question],
    ["approval", approval],
    ["failure", failed],
  ] as const) {
    await check(`A ${name} still shows in quiet mode`, () => {
      first.controller.publish(presentation);
      assert.equal(first.sent.at(-1)?.mode, presentation.mode);
    });
  }

  await check("Quiet mode stops haptic feedback", async () => {
    await Effect.runPromise(first.controller.setPreference({ ...base, muted: true, hapticsEnabled: true }));
    first.controller.performHaptic();
    assert.equal(first.haptics(), 0);
  });

  await check("Turning quiet mode off shows the last published state again", async () => {
    first.controller.publish(message);
    await Effect.runPromise(first.controller.setPreference({ ...base, muted: false, hapticsEnabled: true }));
    assert.equal(first.sent.at(-1)?.mode, "message");
    first.controller.performHaptic();
    assert.equal(first.haptics(), 1);
  });

  await check("A saved choice survives a restart with the other settings", async () => {
    await Effect.runPromise(
      first.controller.setPreference({
        ...base,
        muted: true,
        hapticsEnabled: false,
        idleVisible: false,
        widthPercent: 60,
      }),
    );
    first.controller.destroy();
    const second = await createController(preferencePath);
    assert.equal(second.controller.preference.muted, true);
    assert.equal(second.controller.preference.hapticsEnabled, false);
    assert.equal(second.controller.preference.idleVisible, false);
    assert.equal(second.controller.preference.widthPercent, 60);
    second.controller.destroy();
  });

  await check("A file from before the choice keeps its settings and is not quiet", async () => {
    const oldPath = join(directory, "old.json");
    writeFileSync(
      oldPath,
      JSON.stringify({
        version: 3,
        enabled: true,
        hapticsEnabled: false,
        idleVisible: false,
        additionalDisplaysEnabled: true,
        widthPercent: 60,
        heightPercent: 100,
        serverVisibility: {},
        newServersVisible: true,
      }),
    );
    const old = await createController(oldPath);
    assert.equal(old.controller.preference.muted, false);
    assert.equal(old.controller.preference.hapticsEnabled, false);
    assert.equal(old.controller.preference.widthPercent, 60);
    old.controller.destroy();
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) {
  logger.info(`${result.passed ? "PASS" : "FAIL"}  ${result.check}${result.detail ? `: ${result.detail}` : ""}`);
}
if (results.some((result) => !result.passed)) process.exit(1);
