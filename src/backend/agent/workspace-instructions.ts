// The instruction file at the root of an agent's workspace: `AGENTS.md`, or `CLAUDE.md` in an older
// workspace. The user edits it in the agent's settings, and the agent keeps its standing rules in it.

import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_INSTRUCTION_FILE_NAMES,
  AGENT_INSTRUCTIONS_READ_LIMIT,
  type AgentInstructionFileName,
  type AgentInstructionsFile,
} from "@openbot/contracts/ipc";
import { Effect, Option, Schema } from "effect";
import { writeFileAtomically } from "../atomic-json-file";
import {
  ABSENT_INSTRUCTIONS_SHA256,
  ABSENT_INSTRUCTIONS_TEXT,
  findInstructionsSnapshot,
  recordInstructionsSnapshot,
} from "../instructions-history-store";
import { isPathInside } from "../path-containment";

/**
 * The file is larger than the editor reads, it links to a place outside the workspace, or its text
 * changed after the editor read it.
 */
export class AgentInstructionsFileRefused extends Schema.TaggedError<AgentInstructionsFileRefused>()(
  "AgentInstructionsFileRefused",
  { reason: Schema.Literals(["too-large", "outside", "changed"]) },
) {}

/** The native cause stays here; callers must not export it without redaction. */
export class AgentInstructionsFileFailed extends Schema.TaggedError<AgentInstructionsFileFailed>()(
  "AgentInstructionsFileFailed",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {}

/** No snapshot of the file has this hash: it was never kept, or the newest 50 no longer hold it. */
export class InstructionsSnapshotMissing extends Schema.TaggedError<InstructionsSnapshotMissing>()(
  "InstructionsSnapshotMissing",
  { sha256: Schema.String },
) {}

interface FoundFile {
  fileName: AgentInstructionFileName;
  /** The real path. A link can name a file in a folder of the workspace. */
  path: string;
  size: number;
  /** The permission bits, which a save keeps. */
  mode: number;
}

const fileIo = <A>(operation: "read" | "write", run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AgentInstructionsFileFailed({ operation, cause }) });

/** A missing name counts as no file. */
const optionalIo = <A>(run: () => Promise<A>) => fileIo("read", run).pipe(Effect.option);

/**
 * The first instruction file in the workspace. A folder with the name is not a file. A link that
 * goes outside the workspace is refused: the editor must not write through it to a file of the user.
 */
const findFile = Effect.fn("WorkspaceInstructions.find")(function* (workspace: string) {
  const root = yield* optionalIo(() => realpath(workspace));
  if (Option.isNone(root)) return Option.none<FoundFile>();
  for (const fileName of AGENT_INSTRUCTION_FILE_NAMES) {
    const entry = yield* optionalIo(() => lstat(join(root.value, fileName)));
    if (Option.isNone(entry) || !(entry.value.isFile() || entry.value.isSymbolicLink())) continue;
    const path = entry.value.isFile()
      ? Option.some(join(root.value, fileName))
      : yield* optionalIo(() => realpath(join(root.value, fileName)));
    if (Option.isNone(path)) continue;
    if (!isPathInside(root.value, path.value)) return yield* new AgentInstructionsFileRefused({ reason: "outside" });
    const target = yield* optionalIo(() => lstat(path.value));
    if (Option.isNone(target) || !target.value.isFile()) continue;
    return Option.some<FoundFile>({
      fileName,
      path: path.value,
      size: target.value.size,
      mode: target.value.mode & 0o777,
    });
  }
  return Option.none<FoundFile>();
});

/** At most `limit` bytes from the start of the file. */
const readStart = (file: FoundFile, limit: number) =>
  fileIo("read", async () => {
    const handle = await open(file.path, "r");
    try {
      // The file can grow after `findFile`; the text stops at the size it had then.
      const length = Math.min(file.size, limit);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  });

/** The whole text of a file that the editor can show. */
const editorText = Effect.fn("WorkspaceInstructions.editorText")(function* (found: Option.Option<FoundFile>) {
  if (Option.isNone(found)) return "";
  if (found.value.size > AGENT_INSTRUCTIONS_READ_LIMIT)
    return yield* new AgentInstructionsFileRefused({ reason: "too-large" });
  return yield* readStart(found.value, AGENT_INSTRUCTIONS_READ_LIMIT);
});

/** The file for the editor. With no file, the editor shows an empty `AGENTS.md`, which a save creates. */
export const readAgentInstructionsFile = Effect.fn("WorkspaceInstructions.read")(function* (workspace: string) {
  const found = yield* findFile(workspace);
  return {
    fileName: Option.isSome(found) ? found.value.fileName : "AGENTS.md",
    exists: Option.isSome(found),
    text: yield* editorText(found),
  } satisfies AgentInstructionsFile;
});

/** The file that Show in Finder selects: the instruction file, or the workspace when it has none. */
export const agentInstructionsRevealPath = Effect.fn("WorkspaceInstructions.revealPath")(function* (workspace: string) {
  const found = yield* findFile(workspace);
  return Option.isSome(found) ? found.value.path : workspace;
});

/** The agent whose history keeps the texts that its writes replace, and the connection that holds them. */
export interface InstructionsHistory {
  readonly agentId: string;
  readonly database: DatabaseSync;
}

/** Keeps the text that a write is about to replace. A write that replaces nothing keeps nothing. */
const snapshotBeforeWrite = (history: InstructionsHistory, fileName: string, replaced: string) =>
  Effect.try({
    try: () =>
      recordInstructionsSnapshot(history.database, { agentId: history.agentId, filePath: fileName, text: replaced }),
    catch: (cause) => new AgentInstructionsFileFailed({ operation: "write", cause }),
  });

/**
 * Replaces the text of the first instruction file, or creates `AGENTS.md`. The file keeps its
 * permission bits; a new file is readable only by the user. An empty text keeps an empty file: a
 * save never deletes the file. The save is refused when the text is not `expected` now, because the
 * agent changed the file after the editor read it. A change between this check and the write is
 * still possible, but the window is short. With `history`, the text that the write replaces is kept
 * first, unless the write replaces nothing. A new file keeps the absent state first, so creating it can be
 * reversed by its hash.
 */
export const saveAgentInstructionsFile = Effect.fn("WorkspaceInstructions.save")(function* (
  workspace: string,
  text: string,
  expected: string,
  history?: InstructionsHistory,
) {
  const found = yield* findFile(workspace);
  if ((yield* editorText(found)) !== expected) return yield* new AgentInstructionsFileRefused({ reason: "changed" });
  const fileName = Option.isSome(found) ? found.value.fileName : "AGENTS.md";
  const path = Option.isSome(found)
    ? found.value.path
    : join(yield* fileIo("write", () => realpath(workspace)), fileName);
  if (history && (Option.isNone(found) || text !== expected))
    yield* snapshotBeforeWrite(history, fileName, Option.isSome(found) ? expected : ABSENT_INSTRUCTIONS_TEXT);
  yield* writeFileAtomically(path, text).pipe(
    Effect.mapError((error) => new AgentInstructionsFileFailed({ operation: "write", cause: error.cause })),
  );
  if (Option.isSome(found) && found.value.mode !== 0o600) {
    const { mode } = found.value;
    yield* fileIo("write", () => chmod(path, mode));
  }
  return { fileName, exists: true, text } satisfies AgentInstructionsFile;
});

/**
 * The kept state of the instruction file that has this hash, from the newest snapshot of the file that holds
 * it: its text, or null for the absent state. Fails with `InstructionsSnapshotMissing` when none is kept.
 */
export const findAgentInstructionsSnapshot = Effect.fn("WorkspaceInstructions.findSnapshot")(function* (
  workspace: string,
  sha256: string,
  history: InstructionsHistory,
) {
  const found = yield* findFile(workspace);
  const fileName = Option.isSome(found) ? found.value.fileName : "AGENTS.md";
  const snapshot = yield* Effect.try({
    try: () => findInstructionsSnapshot(history.database, { agentId: history.agentId, filePath: fileName, sha256 }),
    catch: (cause) => new AgentInstructionsFileFailed({ operation: "read", cause }),
  });
  if (!snapshot) return yield* new InstructionsSnapshotMissing({ sha256 });
  const text = snapshot.sha256 === ABSENT_INSTRUCTIONS_SHA256 ? null : snapshot.text;
  return { fileName, text, sha256: snapshot.sha256 };
});

/**
 * Removes the instruction file, which restores the absent state. The text it replaces is kept first. A
 * workspace with no file is left as it is. The entry is removed, not the file it links to.
 */
const removeAgentInstructionsFile = Effect.fn("WorkspaceInstructions.remove")(function* (
  workspace: string,
  history: InstructionsHistory,
) {
  const found = yield* findFile(workspace);
  if (Option.isNone(found)) return { fileName: "AGENTS.md", exists: false, text: "" } satisfies AgentInstructionsFile;
  const { fileName } = found.value;
  yield* snapshotBeforeWrite(history, fileName, yield* editorText(found));
  const entry = join(yield* fileIo("write", () => realpath(workspace)), fileName);
  yield* fileIo("write", () => unlink(entry));
  return { fileName, exists: false, text: "" } satisfies AgentInstructionsFile;
});

/**
 * Restores the instruction file to the kept state that has this hash: its text, or the absent state, which
 * removes the file. The state that the restore replaces is kept first, as any write keeps it, so a restore
 * can itself be undone.
 */
export const restoreAgentInstructionsSnapshot = Effect.fn("WorkspaceInstructions.restore")(function* (
  workspace: string,
  sha256: string,
  history: InstructionsHistory,
) {
  const target = yield* findAgentInstructionsSnapshot(workspace, sha256, history);
  if (target.text === null) return yield* removeAgentInstructionsFile(workspace, history);
  const found = yield* findFile(workspace);
  return yield* saveAgentInstructionsFile(workspace, target.text, yield* editorText(found), history);
});

/** The instruction file as the prompt carries it. */
export interface PromptInstructionsFile {
  fileName: AgentInstructionFileName;
  text: string;
  /** The file was longer than the prompt carries. */
  truncated: boolean;
  /** The CLI reads the file by itself, under its own name or through a link with another name. */
  readByCli: boolean;
}

/**
 * The bytes that hold the longest file the editor saves: a UTF-8 character takes at most 4 bytes, and
 * the editor counts characters.
 */
export const AGENT_INSTRUCTIONS_FILE_BYTES = INPUT_LIMITS.agentInstructionsFile * 4;

/** `CLAUDE.md` can be a link to `AGENTS.md`, or the reverse: a CLI that reads one name reads both. */
const cliReadsFile = Effect.fn("WorkspaceInstructions.cliReads")(function* (
  workspace: string,
  file: FoundFile,
  cliReads: readonly AgentInstructionFileName[],
) {
  if (cliReads.includes(file.fileName)) return true;
  for (const fileName of cliReads) {
    const path = yield* optionalIo(() => realpath(join(workspace, fileName)));
    if (Option.isSome(path) && path.value === file.path) return true;
  }
  return false;
});

/**
 * The file for the prompt, trimmed and cut at the editor limit. An empty file keeps its name. A file
 * that cannot be read, or a link outside the workspace, gives none: the workspace belongs to the
 * agent, and its session must still start.
 */
export const promptInstructionsFile = Effect.fn("WorkspaceInstructions.prompt")(function* (
  workspace: string,
  cliReads: readonly AgentInstructionFileName[],
) {
  const found = yield* findFile(workspace).pipe(Effect.orElseSucceed(() => Option.none<FoundFile>()));
  if (Option.isNone(found)) return null;
  const limit = INPUT_LIMITS.agentInstructionsFile;
  const bytes = AGENT_INSTRUCTIONS_FILE_BYTES;
  const read = yield* readStart(found.value, bytes).pipe(Effect.option);
  if (Option.isNone(read)) return null;
  const text = read.value.trim();
  return {
    fileName: found.value.fileName,
    text: text.slice(0, limit),
    truncated: text.length > limit || found.value.size > bytes,
    readByCli: yield* cliReadsFile(workspace, found.value, cliReads),
  } satisfies PromptInstructionsFile;
});
