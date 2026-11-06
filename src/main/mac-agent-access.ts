import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { AppTranslate } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import {
  MacAccessFailed,
  type MacAgentAccessHost,
  type MacAppRecord,
  type MacFolder,
  type MacLocationReading,
  type MacWeatherReading,
  macFolderLabel,
} from "../backend/agent/mac-agent-access";

/**
 * Starts the Mac agent-access program and reads one JSON result.
 * The program is a child of this process. This module does not ask for Full Disk Access.
 *
 * Called from `src/main/application-services.ts` when it builds `AgentService` on macOS.
 * Stdin command: `{ command, folder?, query?, path?, prompt?, button?, bookmarkDirectory? }`.
 * Stdout result: `{ ok, code?, result? }`. Bookmark files are opaque bytes at
 * `{userData}/mac-folder-bookmarks/{desktop|documents|downloads}`. Dates are ISO-8601.
 */

const logger = createOpenBotLogger("mac-agent-access");
const COMMAND_TIMEOUT_MS = 30_000;
/** These commands wait on a system panel. A timer must not kill that panel. */
const PANEL_COMMANDS = new Set<HelperCommand["command"]>(["location", "weather", "allowFolder", "focus"]);

interface HelperCommand {
  command: "location" | "weather" | "allowFolder" | "spotlight" | "apps" | "recognizeText" | "focus";
  folder?: MacFolder;
  query?: string;
  path?: string;
  prompt?: string;
  button?: string;
  bookmarkDirectory?: string;
}

interface HelperSuccess {
  ok: true;
  result: unknown;
}

interface HelperFailure {
  ok: false;
  code: string;
}

export interface MacAgentAccessOptions {
  /** True in a packaged app. The program then lives in the app resources. */
  packaged: boolean;
  /** `app.getPath("userData")`. Bookmarks for Desktop, Documents and Downloads stay here. */
  userDataPath: string;
  /** The folder panel follows the interface language. */
  translate: AppTranslate;
}

export class MacAgentAccess implements MacAgentAccessHost {
  readonly #binary: string | null;
  readonly #bookmarkDirectory: string;
  readonly #translate: AppTranslate;

  constructor(options: MacAgentAccessOptions) {
    const packaged = join(process.resourcesPath, "macos-agent-access", "openbot-macos-access");
    const development = resolve(__dirname, "../../.openbot-build/macos-agent-access/openbot-macos-access");
    const binary = options.packaged ? packaged : development;
    this.#binary = existsSync(binary) ? binary : null;
    this.#bookmarkDirectory = join(options.userDataPath, "mac-folder-bookmarks");
    this.#translate = options.translate;
  }

  location(): Effect.Effect<MacLocationReading, MacAccessFailed> {
    return this.#run({ command: "location" }).pipe(Effect.flatMap(decodeLocation));
  }

  weather(): Effect.Effect<MacWeatherReading, MacAccessFailed> {
    return this.#run({ command: "weather" }).pipe(Effect.flatMap(decodeWeather));
  }

  allowFolder(folder: MacFolder): Effect.Effect<{ folder: MacFolder }, MacAccessFailed> {
    return this.#run({
      command: "allowFolder",
      folder,
      prompt: this.#translate("status.agent.macFolderPanel", { folder: macFolderLabel[folder] }),
      button: this.#translate("status.agent.macFolderAllow"),
      bookmarkDirectory: this.#bookmarkDirectory,
    }).pipe(Effect.flatMap((value) => decodeFolder(value, folder)));
  }

  searchFolder(folder: MacFolder, query: string): Effect.Effect<{ files: Array<{ name: string }> }, MacAccessFailed> {
    return this.#run({
      command: "spotlight",
      folder,
      query,
      bookmarkDirectory: this.#bookmarkDirectory,
    }).pipe(Effect.flatMap(decodeFiles));
  }

  apps(): Effect.Effect<
    { frontmost: MacAppRecord | null; running: Array<MacAppRecord & { frontmost: boolean }> },
    MacAccessFailed
  > {
    return this.#run({ command: "apps" }).pipe(Effect.flatMap(decodeApps));
  }

  recognizeText(path: string): Effect.Effect<{ text: string }, MacAccessFailed> {
    return this.#run({ command: "recognizeText", path }).pipe(Effect.flatMap(decodeText));
  }

  focus(): Effect.Effect<{ focused: boolean }, MacAccessFailed> {
    return this.#run({ command: "focus" }).pipe(Effect.flatMap(decodeFocus));
  }

  #run(command: HelperCommand): Effect.Effect<unknown, MacAccessFailed> {
    const binary = this.#binary;
    if (!binary) return Effect.fail(new MacAccessFailed({ code: "helper_missing" }));
    return Effect.tryPromise({
      try: (signal) => runProgram(binary, command, signal),
      catch: (error) => {
        logger.warn("The Mac access program stopped.", { command: command.command, error: String(error) });
        return new MacAccessFailed({ code: "failed" });
      },
    }).pipe(
      Effect.flatMap((value) =>
        isFailure(value) ? Effect.fail(new MacAccessFailed({ code: value.code })) : Effect.succeed(value.result),
      ),
    );
  }
}

function runProgram(
  binary: string,
  command: HelperCommand,
  signal: AbortSignal,
): Promise<HelperSuccess | HelperFailure> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  if (command.bookmarkDirectory !== undefined) mkdirSync(command.bookmarkDirectory, { recursive: true });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // A folder, location or Focus panel stays until the person answers. The other commands keep a bound.
    const timer = PANEL_COMMANDS.has(command.command)
      ? undefined
      : setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error("timeout")));
        }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", () => {
      const text = Buffer.concat(stdout).toString("utf8").trim();
      finish(() => {
        try {
          resolvePromise(parseHelper(text));
        } catch {
          reject(new Error("invalid"));
        }
      });
    });
    child.stdin.end(JSON.stringify(command));
  });
}

function isFailure(value: HelperSuccess | HelperFailure): value is HelperFailure {
  return value.ok === false;
}

function parseHelper(text: string): HelperSuccess | HelperFailure {
  const value = JSON.parse(text);
  if (!isDynamicRecord(value) || !isBoolean(value.ok)) throw new Error("invalid");
  if (!value.ok) {
    if (!isString(value.code)) throw new Error("invalid");
    return { ok: false, code: value.code };
  }
  return { ok: true, result: value.result };
}

function decodeLocation(value: unknown): Effect.Effect<MacLocationReading, MacAccessFailed> {
  if (
    !isDynamicRecord(value) ||
    typeof value.latitude !== "number" ||
    typeof value.longitude !== "number" ||
    typeof value.horizontalAccuracyMeters !== "number" ||
    typeof value.timestamp !== "string"
  ) {
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  }
  return Effect.succeed({
    latitude: value.latitude,
    longitude: value.longitude,
    horizontalAccuracyMeters: value.horizontalAccuracyMeters,
    timestamp: value.timestamp,
  });
}

function decodeWeather(value: unknown): Effect.Effect<MacWeatherReading, MacAccessFailed> {
  const days = isDynamicRecord(value) ? value.daily : undefined;
  if (!isDynamicRecord(value) || value.attribution !== "Apple Weather" || !Array.isArray(days)) {
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  }
  return decodeLocation(value.location).pipe(
    Effect.flatMap((location) => {
      const current = value.current;
      if (
        !isDynamicRecord(current) ||
        typeof current.condition !== "string" ||
        typeof current.temperatureCelsius !== "number"
      ) {
        return Effect.fail(new MacAccessFailed({ code: "failed" }));
      }
      const daily = days.flatMap((day: unknown) => {
        if (
          !isDynamicRecord(day) ||
          typeof day.date !== "string" ||
          typeof day.condition !== "string" ||
          typeof day.highCelsius !== "number" ||
          typeof day.lowCelsius !== "number" ||
          typeof day.precipitationChance !== "number"
        ) {
          return [];
        }
        return [
          {
            date: day.date,
            condition: day.condition,
            highCelsius: day.highCelsius,
            lowCelsius: day.lowCelsius,
            precipitationChance: day.precipitationChance,
          },
        ];
      });
      return Effect.succeed({
        attribution: "Apple Weather" as const,
        location,
        current: { condition: current.condition, temperatureCelsius: current.temperatureCelsius },
        daily,
      });
    }),
  );
}

function decodeFolder(value: unknown, folder: MacFolder): Effect.Effect<{ folder: MacFolder }, MacAccessFailed> {
  if (!isDynamicRecord(value) || value.folder !== folder) return Effect.fail(new MacAccessFailed({ code: "failed" }));
  return Effect.succeed({ folder });
}

function decodeFiles(value: unknown): Effect.Effect<{ files: Array<{ name: string }> }, MacAccessFailed> {
  if (!isDynamicRecord(value) || !Array.isArray(value.files))
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  const files = value.files.flatMap((file) => {
    if (!isDynamicRecord(file) || typeof file.name !== "string" || file.name.length === 0) return [];
    return [{ name: file.name }];
  });
  return Effect.succeed({ files });
}

function decodeApps(
  value: unknown,
): Effect.Effect<
  { frontmost: MacAppRecord | null; running: Array<MacAppRecord & { frontmost: boolean }> },
  MacAccessFailed
> {
  if (!isDynamicRecord(value) || !Array.isArray(value.running))
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  const running = value.running.flatMap((app) => {
    const record = decodeApp(app);
    if (!record || !isDynamicRecord(app) || typeof app.frontmost !== "boolean") return [];
    return [{ ...record, frontmost: app.frontmost }];
  });
  return Effect.succeed({ frontmost: decodeApp(value.frontmost), running });
}

function decodeApp(value: unknown): MacAppRecord | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.bundleId !== "string" ||
    typeof value.processId !== "number"
  ) {
    return null;
  }
  return { name: value.name, bundleId: value.bundleId, processId: value.processId };
}

function decodeText(value: unknown): Effect.Effect<{ text: string }, MacAccessFailed> {
  if (!isDynamicRecord(value) || typeof value.text !== "string")
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  return Effect.succeed({ text: value.text });
}

function decodeFocus(value: unknown): Effect.Effect<{ focused: boolean }, MacAccessFailed> {
  if (!isDynamicRecord(value) || typeof value.focused !== "boolean") {
    return Effect.fail(new MacAccessFailed({ code: "failed" }));
  }
  return Effect.succeed({ focused: value.focused });
}
