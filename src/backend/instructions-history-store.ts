// The earlier texts of an agent's instruction file (`agent_instructions_snapshots`). The write path
// keeps the text that a write replaces, so the user can restore one by its hash. The texts are the
// user's own rules, so a text that holds a registered secret is never stored.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { databaseRow, requiredStringColumn } from "./database/database-rows";

const logger = createOpenBotLogger("instructions-history");

/** The newest snapshots kept for one agent and one file. */
export const INSTRUCTIONS_SNAPSHOT_LIMIT = 50;

const SAVEPOINT = "instructions_snapshot";

export interface InstructionsSnapshot {
  snapshotId: string;
  agentId: string;
  /** The file's name in the workspace, such as `AGENTS.md`. */
  filePath: string;
  text: string;
  sha256: string;
  createdAt: string;
}

export function instructionsTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Keeps `text` as an earlier text of the file, then drops the snapshots past the newest
 * `INSTRUCTIONS_SNAPSHOT_LIMIT` of that agent and file. Both run in one savepoint, so a failure leaves
 * the table as it was. A text that matches a registered secret is refused: nothing is stored, and the
 * log names no text. Returns whether it was stored.
 */
export function recordInstructionsSnapshot(
  db: DatabaseSync,
  input: { agentId: string; filePath: string; text: string; createdAt?: string },
): "recorded" | "refused" {
  // The redaction also masks the patterns of a token that no secret is registered for. Refusing those
  // too is the safe side: an instruction file that looks like it holds a credential is not kept.
  if (redactText(input.text) !== input.text) {
    logger.warn("Agent instructions snapshot refused: the text holds a secret.");
    return "refused";
  }
  const sha256 = instructionsTextSha256(input.text);
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    db.prepare(
      `INSERT INTO agent_instructions_snapshots (snapshot_id, agent_id, file_path, text, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.agentId, input.filePath, input.text, sha256, createdAt);
    db.prepare(
      `DELETE FROM agent_instructions_snapshots
       WHERE agent_id = ? AND file_path = ? AND snapshot_id NOT IN (
         SELECT snapshot_id FROM agent_instructions_snapshots
         WHERE agent_id = ? AND file_path = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )`,
    ).run(input.agentId, input.filePath, input.agentId, input.filePath, INSTRUCTIONS_SNAPSHOT_LIMIT);
    db.exec(`RELEASE ${SAVEPOINT}`);
  } catch (error) {
    db.exec(`ROLLBACK TO ${SAVEPOINT}`);
    db.exec(`RELEASE ${SAVEPOINT}`);
    throw error;
  }
  return "recorded";
}

/** The newest snapshot of the file whose text has this hash, or null when none is kept. */
export function findInstructionsSnapshot(
  db: DatabaseSync,
  input: { agentId: string; filePath: string; sha256: string },
): InstructionsSnapshot | null {
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) return null;
  const row = databaseRow(
    db
      .prepare(
        `SELECT snapshot_id, agent_id, file_path, text, sha256, created_at
         FROM agent_instructions_snapshots
         WHERE agent_id = ? AND file_path = ? AND sha256 = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(input.agentId, input.filePath, input.sha256),
  );
  return row ? snapshotFromRow(row) : null;
}

function snapshotFromRow(row: DynamicRecord): InstructionsSnapshot {
  return {
    snapshotId: requiredStringColumn(row, "snapshot_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    filePath: requiredStringColumn(row, "file_path"),
    text: requiredStringColumn(row, "text"),
    sha256: requiredStringColumn(row, "sha256"),
    createdAt: requiredStringColumn(row, "created_at"),
  };
}
