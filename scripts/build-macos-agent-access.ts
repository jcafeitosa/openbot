/**
 * Builds the Mac agent-access program. The desktop process starts this program.
 * The program calls WeatherKit. This script does not put that entitlement on the signature.
 * An ad hoc signature does not grant a restricted entitlement, and the main app stays free of it
 * until the Apple portal profile includes it for this program. The Focus entitlement is on this
 * program. The portal step for both entitlements is still unverified. This script adds no API key.
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
    "AppKit",
    "-framework",
    "Vision",
    "-framework",
    "Intents",
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const sign = spawnSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, output], {
  stdio: "inherit",
});
if (sign.status !== 0) process.exit(sign.status ?? 1);
