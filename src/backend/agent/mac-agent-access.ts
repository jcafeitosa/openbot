import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import { z } from "zod";
import type { OpenBotToolResponse } from "./routine-tools";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

/** A protected folder. The names are the folders macOS guards. Full Disk Access is not one of them. */
export const macFolders = ["desktop", "documents", "downloads"] as const;
export type MacFolder = (typeof macFolders)[number];

export const allowMacFolderShape = {
  folder: z.enum(macFolders).describe("desktop, documents, or downloads. The user must choose that folder."),
};
export const searchMacFolderShape = {
  folder: z.enum(macFolders),
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Words in the file name. The search stays inside the allowed folder."),
};
export const readImageTextShape = {
  attachmentId: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.identifier)
    .describe("The id of an image that is already in this chat."),
};

const MAC_ACCESS_TOOLS = [
  "read_mac_location",
  "read_mac_weather",
  "allow_mac_folder",
  "search_mac_folder",
  "list_running_apps",
  "read_image_text",
  "read_focus_status",
] as const;

export type MacAccessTool = (typeof MAC_ACCESS_TOOLS)[number];

const MAC_ACCESS_TOOL_NAMES: ReadonlySet<string> = new Set(MAC_ACCESS_TOOLS);

export function isMacAccessTool(tool: string): tool is MacAccessTool {
  return MAC_ACCESS_TOOL_NAMES.has(tool);
}

/** The reading failed. `code` selects the text the agent and the user can read. */
export class MacAccessFailed extends Schema.TaggedError<MacAccessFailed>()("MacAccessFailed", {
  code: Schema.String,
}) {}

export interface MacLocationReading {
  latitude: number;
  longitude: number;
  /** Meters. This is the accuracy Core Location returned. */
  horizontalAccuracyMeters: number;
  timestamp: string;
}

export interface MacWeatherReading {
  attribution: "Apple Weather";
  location: MacLocationReading;
  current: { condition: string; temperatureCelsius: number };
  daily: Array<{
    date: string;
    condition: string;
    highCelsius: number;
    lowCelsius: number;
    precipitationChance: number;
  }>;
}

export interface MacAppRecord {
  name: string;
  bundleId: string;
  processId: number;
}

/**
 * Reads this Mac for an agent. The main process owns the program and the permission prompts.
 * A server that is not this Mac has no host.
 */
export interface MacAgentAccessHost {
  location(): Effect.Effect<MacLocationReading, MacAccessFailed>;
  weather(): Effect.Effect<MacWeatherReading, MacAccessFailed>;
  allowFolder(folder: MacFolder): Effect.Effect<{ folder: MacFolder }, MacAccessFailed>;
  searchFolder(folder: MacFolder, query: string): Effect.Effect<{ files: Array<{ name: string }> }, MacAccessFailed>;
  apps(): Effect.Effect<
    { frontmost: MacAppRecord | null; running: Array<MacAppRecord & { frontmost: boolean }> },
    MacAccessFailed
  >;
  recognizeText(path: string): Effect.Effect<{ text: string }, MacAccessFailed>;
  focus(): Effect.Effect<{ focused: boolean }, MacAccessFailed>;
}

/** The folder kind a tool result may name. The absolute path stays in the bookmark file. */
export const macFolderLabel = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
} as const satisfies Record<MacFolder, string>;

function failureText(code: string, folder?: MacFolder): string {
  switch (code) {
    case "denied":
      return sourceText("error.agent.macAccessDenied");
    case "helper_missing":
      return sourceText("error.agent.macAccessHelperMissing");
    case "weatherkit_unavailable":
      return sourceText("error.agent.macWeatherUnavailable");
    case "focus_profile_required":
      return sourceText("error.agent.macFocusProfileRequired");
    case "folder_mismatch":
      return sourceText("error.agent.macFolderMismatch", { folder: macFolderLabel[folder ?? "desktop"] });
    case "bookmark_missing":
      return sourceText("error.agent.macBookmarkMissing", { folder: macFolderLabel[folder ?? "desktop"] });
    case "timeout":
      return sourceText("error.agent.macAccessTimeout");
    case "failed":
      return sourceText("error.agent.macAccessFailed");
    default:
      return sourceText("error.agent.macAccessFailed");
  }
}

function approvalReason(tool: MacAccessTool, folder: MacFolder | undefined, channelName: string | null): string {
  const base = (() => {
    switch (tool) {
      case "read_mac_location":
        return sourceText("status.agent.macLocation");
      case "read_mac_weather":
        return sourceText("status.agent.macWeather");
      case "allow_mac_folder":
      case "search_mac_folder":
        return sourceText("status.agent.macFolder", { folder: macFolderLabel[folder ?? "desktop"] });
      case "list_running_apps":
        return sourceText("status.agent.macApps");
      case "read_focus_status":
        return sourceText("status.agent.macFocus");
      case "read_image_text":
        return sourceText("status.agent.macImageText");
      default: {
        const neverTool: never = tool;
        return neverTool;
      }
    }
  })();
  if (!channelName) return base;
  return `${base} ${sourceText("status.agent.macAccessChannel", { channel: channelName })}`;
}

export interface MacAccessToolInput {
  host: MacAgentAccessHost | null;
  tool: MacAccessTool;
  args: unknown;
  shared: boolean;
  channelName: string | null;
  imageFile: (attachmentId: string) => { path: string } | null;
  approve: (reason: string) => Effect.Effect<boolean>;
}

/** Runs one Mac access tool. The result can go to the model provider because it enters the chat. */
export const handleMacAccessTool = Effect.fn("handleMacAccessTool")(function* (input: MacAccessToolInput) {
  if (input.shared) return openBotToolFailure(sourceText("error.agent.macAccessShared"));
  const host = input.host;
  if (!host) return openBotToolFailure(sourceText("error.agent.macAccessUnavailable"));
  const folder = folderArgument(input.tool, input.args);
  const allowed = yield* input.approve(approvalReason(input.tool, folder, input.channelName));
  if (!allowed) return openBotToolFailure(sourceText("error.agent.macAccessDenied"));
  const reading = yield* Effect.result(runTool(host, input));
  if (Result.isFailure(reading)) {
    return openBotToolFailure(failureText(reading.failure.code, folderArgument(input.tool, input.args)));
  }
  return reading.success;
});

function folderArgument(tool: MacAccessTool, args: unknown): MacFolder | undefined {
  if (tool !== "allow_mac_folder" && tool !== "search_mac_folder") return undefined;
  const parsed = z.object({ folder: z.enum(macFolders) }).safeParse(args);
  return parsed.success ? parsed.data.folder : "desktop";
}

function runTool(
  host: MacAgentAccessHost,
  input: MacAccessToolInput,
): Effect.Effect<OpenBotToolResponse, MacAccessFailed> {
  switch (input.tool) {
    case "read_mac_location":
      return host.location().pipe(
        Effect.map((location) =>
          openBotToolResult({
            ...location,
            note: sourceText("status.agent.macLocationAccuracy"),
          }),
        ),
      );
    case "read_mac_weather":
      return host.weather().pipe(
        Effect.map((weather) =>
          openBotToolResult({
            ...weather,
            attribution: "Apple Weather",
            note: sourceText("status.agent.appleWeather"),
          }),
        ),
      );
    case "allow_mac_folder": {
      const parsed = z.strictObject(allowMacFolderShape).safeParse(input.args);
      if (!parsed.success) return Effect.succeed(openBotToolFailure(sourceText("error.agent.toolRequestInvalid")));
      return host
        .allowFolder(parsed.data.folder)
        .pipe(Effect.map((saved) => openBotToolResult({ folder: macFolderLabel[saved.folder] })));
    }
    case "search_mac_folder": {
      const parsed = z.strictObject(searchMacFolderShape).safeParse(input.args);
      if (!parsed.success) return Effect.succeed(openBotToolFailure(sourceText("error.agent.toolRequestInvalid")));
      return host.searchFolder(parsed.data.folder, parsed.data.query).pipe(
        Effect.map((found) =>
          openBotToolResult({
            folder: macFolderLabel[parsed.data.folder],
            query: parsed.data.query,
            files: found.files.map((file) => ({ name: file.name, folder: macFolderLabel[parsed.data.folder] })),
          }),
        ),
      );
    }
    case "list_running_apps":
      return host.apps().pipe(Effect.map((apps) => openBotToolResult(apps)));
    case "read_image_text": {
      const parsed = z.strictObject(readImageTextShape).safeParse(input.args);
      if (!parsed.success) return Effect.succeed(openBotToolFailure(sourceText("error.agent.toolRequestInvalid")));
      const image = input.imageFile(parsed.data.attachmentId);
      if (!image) return Effect.succeed(openBotToolFailure(sourceText("error.agent.macImageMissing")));
      return host
        .recognizeText(image.path)
        .pipe(Effect.map((recognized) => openBotToolResult({ text: recognized.text.slice(0, 8_000) })));
    }
    case "read_focus_status":
      return host.focus().pipe(
        Effect.map((focus) =>
          openBotToolResult({
            focused: focus.focused,
            note: sourceText("status.agent.macFocusNameHidden"),
          }),
        ),
      );
    default: {
      const neverTool: never = input.tool;
      return neverTool;
    }
  }
}
