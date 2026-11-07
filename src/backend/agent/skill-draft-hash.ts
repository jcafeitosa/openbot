// The identity of a skill draft. The gate hashes the files of the folder that its card shows; the local skill
// library hashes the archive that it publishes. The two must match, so the install publishes exactly the files that
// the person approved, and a folder that changed after the approval installs nothing.

import { createHash } from "node:crypto";
import { Schema } from "effect";

/** One file of a skill draft: its path inside the folder, with `/` between the parts, and its bytes. */
export interface DraftEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Names that a skill package never carries: version-control data, installed dependencies and Finder metadata.
 * The archive leaves them out, so a card that shows them would show files that no install publishes.
 */
export function isSkippedDraftEntry(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".DS_Store";
}

/** The sha256 in hex of a draft's entries: each path and the sha256 of its bytes, in path order. */
export function draftSha256(entries: readonly DraftEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const bytesHash = createHash("sha256").update(entry.bytes).digest("hex");
    hash.update(`${entry.path}\0${bytesHash}\n`);
  }
  return hash.digest("hex");
}

/** The files of a skill draft that the publish holds are not the files that the person approved. Nothing is installed. */
export class SkillDraftChanged extends Schema.TaggedError<SkillDraftChanged>()("SkillDraftChanged", {}) {}
