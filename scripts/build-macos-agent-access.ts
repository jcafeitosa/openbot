/**
 * Builds the Mac agent-access program. The desktop process starts this program.
 * The default signature is ad hoc and has no restricted entitlement. macOS kills an ad hoc
 * program at load when the signature contains Focus or WeatherKit.
 * Set OPENBOT_MACOS_AGENT_ACCESS_IDENTITY to a Developer ID Application or Apple Distribution
 * identity to sign with native/macos-agent-access/entitlements.plist. That file holds both keys.
 * The program still requests Focus and calls WeatherKit when those keys are present.
 * This script adds no API key.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "native/macos-agent-access/main.swift");
const info = resolve(root, "native/macos-agent-access/Info.plist");
const entitlements = resolve(root, "native/macos-agent-access/entitlements.plist");
const output = resolve(root, ".openbot-build/macos-agent-access/openbot-macos-access");

mkdirSync(dirname(output), { recursive: true });

const compile = spawnSync(
  "swiftc",
  [
    "-O",
    "-o",
    output,
    source,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    info,
    "-framework",
    "CoreLocation",
    "-framework",
    "WeatherKit",
    "-framework",
    "Security",
    "-framework",
    "AppKit",
    "-framework",
    "Vision",
    "-framework",
    "Intents",
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const identity = process.env.OPENBOT_MACOS_AGENT_ACCESS_IDENTITY?.trim() ?? "";
const distributionIdentity =
  identity.startsWith("Developer ID Application:") || identity.startsWith("Apple Distribution:");
if (identity.length > 0 && !distributionIdentity) {
  process.stderr.write(
    "OPENBOT_MACOS_AGENT_ACCESS_IDENTITY must be a Developer ID Application or Apple Distribution identity.\n",
  );
  process.exit(1);
}

const signArguments = ["--force", "--sign", distributionIdentity ? identity : "-"];
if (distributionIdentity) {
  signArguments.push("--timestamp", "--options", "runtime", "--entitlements", entitlements);
}
const sign = spawnSync("codesign", signArguments.concat(output), { stdio: "inherit" });
if (sign.status !== 0) process.exit(sign.status ?? 1);
