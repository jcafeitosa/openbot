/**
 * The approval queue for promoting an agent's memory into a channel or messaging memory. A promotion is a proposal
 * that waits for a person: only an approved proposal writes to the collective memory, through that memory's own store,
 * with a pointer to the source memory. The store owns the `memory_proposals` rows and their decisions. It reads and
 * writes through the connection read at each use, and never imports the facade.
 */

import { createHash, randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { containsRegisteredSecret, redactText } from "@openbot/logging";
import type { ChannelMemoryStore } from "../channel-memory-store";
import {
  checkedColumn,
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { MessagingMemoryStore } from "../messaging/messaging-memory-store";
import type { OpenBotDatabase } from "../openbot-database";

export const MEMORY_PROPOSAL_SCOPES = ["channel", "messaging"] as const;
export type MemoryProposalScope = (typeof MEMORY_PROPOSAL_SCOPES)[number];

export const MEMORY_PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type MemoryProposalStatus = (typeof MEMORY_PROPOSAL_STATUSES)[number];

/**
 * Who decides a proposal, as proof rather than a name. Only `mintPersonDecision` makes one, and the store
 * accepts nothing else, so a string from an agent path or a script cannot approve or reject a proposal.
 */
export interface PersonDecision {
  readonly decidedBy: "person";
}

const mintedDecisions = new WeakSet<object>();

/**
 * The capability of a person's decision. Only the card response path calls it, after it has checked that
 * the responder is the person: the owner, the person at this computer, or a chat press of the person.
 */
export function mintPersonDecision(): PersonDecision {
  const decision: PersonDecision = Object.freeze({ decidedBy: "person" });
  mintedDecisions.add(decision);
  return decision;
}

export interface MemoryProposalInput {
  sourceAgentId: string;
  sourceMemoryId: string | null;
  targetScope: MemoryProposalScope;
  targetId: string;
  text: string;
  /** The thread the card of the proposal shows in, and the turn that proposed it. A card is rebuilt from these. */
  threadId?: string;
  turnId?: string;
}

export interface MemoryProposal {
  proposalId: string;
  sourceAgentId: string;
  sourceMemoryId: string | null;
  targetScope: MemoryProposalScope;
  targetId: string;
  text: string;
  fingerprint: string;
  status: MemoryProposalStatus;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface MemoryProposalStoreOptions {
  database: OpenBotDatabase;
  channelMemories: ChannelMemoryStore;
  messagingMemories: MessagingMemoryStore;
}

const PROPOSAL_COLUMNS = `proposal_id, source_agent_id, source_memory_id, target_scope, target_id, text, fingerprint,
  status, decided_by, created_at, decided_at, thread_id, turn_id`;

export class MemoryProposalStore {
  readonly #database: OpenBotDatabase;
  readonly #channelMemories: ChannelMemoryStore;
  readonly #messagingMemories: MessagingMemoryStore;

  constructor(options: MemoryProposalStoreOptions) {
    this.#database = options.database;
    this.#channelMemories = options.channelMemories;
    this.#messagingMemories = options.messagingMemories;
  }

  /**
   * Records a proposal and writes nothing to the collective memory. A proposal for the same scope, target and text as
   * one still pending returns that pending proposal.
   */
  propose(input: MemoryProposalInput): MemoryProposal {
    return this.record(input).proposal;
  }

  /**
   * `propose`, and whether the caller must show the card. That is a new proposal with a thread and a turn, or a pending
   * proposal that had no thread and gets one now. A pending proposal that already has a thread keeps its card.
   */
  record(input: MemoryProposalInput): { proposal: MemoryProposal; needsCard: boolean } {
    const text = proposalText(input.text);
    const fingerprint = textFingerprint(text);
    const { threadId = null, turnId = null } = input;
    const pending = this.#pendingProposal(input.targetScope, input.targetId, fingerprint);
    if (pending) {
      if (pending.threadId !== null || threadId === null || turnId === null)
        return { proposal: pending, needsCard: false };
      this.#database.connection
        .prepare(
          "UPDATE memory_proposals SET thread_id = ?, turn_id = ? WHERE proposal_id = ? AND status = 'pending' AND thread_id IS NULL",
        )
        .run(threadId, turnId, pending.proposalId);
      return { proposal: this.#require(pending.proposalId), needsCard: true };
    }
    const proposalId = randomUUID();
    this.#database.connection
      .prepare(
        `INSERT INTO memory_proposals (
           proposal_id, source_agent_id, source_memory_id, target_scope, target_id, text, fingerprint,
           status, decided_by, created_at, decided_at, thread_id, turn_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?)`,
      )
      .run(
        proposalId,
        input.sourceAgentId,
        input.sourceMemoryId,
        input.targetScope,
        input.targetId,
        text,
        fingerprint,
        new Date().toISOString(),
        threadId,
        turnId,
      );
    return { proposal: this.#require(proposalId), needsCard: threadId !== null && turnId !== null };
  }

  /**
   * Writes the text to the collective memory and marks the proposal approved, in one transaction. A full collective
   * memory, or a text that now holds a registered secret, refuses the approval and leaves the proposal pending.
   */
  approve(proposalId: string, decision: PersonDecision): MemoryProposal {
    return this.#decide(proposalId, decision, "approved");
  }

  /** Marks the proposal rejected. Nothing is written to the collective memory. */
  reject(proposalId: string, decision: PersonDecision): MemoryProposal {
    return this.#decide(proposalId, decision, "rejected");
  }

  #decide(proposalId: string, decision: PersonDecision, status: "approved" | "rejected"): MemoryProposal {
    if (typeof decision !== "object" || decision === null || !mintedDecisions.has(decision))
      throw new Error("Only a person can decide a memory proposal.");
    return this.#transaction(() => {
      const proposal = this.#require(proposalId);
      if (proposal.status !== "pending") throw new Error(`The memory proposal is already ${proposal.status}.`);
      if (status === "approved") this.#writeCollective(proposal);
      this.#database.connection
        .prepare(
          "UPDATE memory_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE proposal_id = ? AND status = 'pending'",
        )
        .run(status, decision.decidedBy, new Date().toISOString(), proposalId);
      return this.#require(proposalId);
    });
  }

  #writeCollective(proposal: MemoryProposal): void {
    // The pointer names the source memory. A proposal without one points at the proposal itself.
    const sourceTurnId =
      proposal.sourceMemoryId === null
        ? `memory-proposal:${proposal.proposalId}`
        : `agent-memory:${proposal.sourceMemoryId}`;
    const commandId = `memory-proposal:${proposal.proposalId}:approve`;
    if (proposal.targetScope === "channel") {
      this.#channelMemories.saveFromTool(proposal.targetId, proposal.text, sourceTurnId, commandId);
      return;
    }
    this.#messagingMemories.saveFromTool(proposal.targetId, { text: proposal.text, sourceTurnId, commandId });
  }

  /**
   * Runs `write` in one transaction. Only the caller that finds no open transaction opens and closes one, so the
   * collective memory's own dispatch nests inside it and the proposal row and the memory row commit together.
   */
  #transaction<T>(write: () => T): T {
    const db = this.#database.connection;
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      if (ownsTransaction) db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  #require(proposalId: string): MemoryProposal {
    const row = databaseRow(
      this.#database.connection
        .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE proposal_id = ?`)
        .get(proposalId),
    );
    if (!row) throw new Error("The memory proposal was not found.");
    return proposalFromRow(row);
  }

  #pendingProposal(scope: MemoryProposalScope, targetId: string, fingerprint: string): MemoryProposal | null {
    const row = databaseRow(
      this.#database.connection
        .prepare(
          `SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals
           WHERE target_scope = ? AND target_id = ? AND fingerprint = ? AND status = 'pending'`,
        )
        .get(scope, targetId, fingerprint),
    );
    return row ? proposalFromRow(row) : null;
  }

  /** The proposal with this id, when it still waits for a person. */
  findPending(proposalId: string): MemoryProposal | null {
    const row = databaseRow(
      this.#database.connection
        .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE proposal_id = ? AND status = 'pending'`)
        .get(proposalId),
    );
    return row ? proposalFromRow(row) : null;
  }

  /** Every proposal that waits for a person, oldest first. The cards of the attention list are built from them. */
  pendingProposals(): MemoryProposal[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE status = 'pending' ORDER BY created_at, proposal_id`,
        )
        .all(),
    ).map((row) => proposalFromRow(row));
  }
}

/**
 * The text a proposal holds: trimmed and within the memory limit, refused when it holds a registered secret, and then
 * redacted the way a memory is redacted before it is stored.
 */
function proposalText(value: string): string {
  const text = requireText(value);
  if (containsRegisteredSecret(text)) throw new Error(sourceText("error.backend.memorySecretRefused"));
  return requireText(redactText(text));
}

function requireText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error(sourceText("error.backend.memoryTextRequired"));
  if (text.length > INPUT_LIMITS.agentMemoryText) throw new Error(sourceText("error.backend.memoryTextTooLong"));
  return text;
}

/** Whitespace runs count once, so two spellings of one sentence are one proposal. Case is kept, as memory dedupe keeps it. */
function textFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ")).digest("hex");
}

function proposalFromRow(row: DynamicRecord): MemoryProposal {
  return {
    proposalId: requiredStringColumn(row, "proposal_id"),
    sourceAgentId: requiredStringColumn(row, "source_agent_id"),
    sourceMemoryId: optionalStringColumn(row, "source_memory_id"),
    targetScope: checkedColumn(row, "target_scope", MEMORY_PROPOSAL_SCOPES),
    targetId: requiredStringColumn(row, "target_id"),
    text: requiredStringColumn(row, "text"),
    fingerprint: requiredStringColumn(row, "fingerprint"),
    status: checkedColumn(row, "status", MEMORY_PROPOSAL_STATUSES),
    decidedBy: optionalStringColumn(row, "decided_by"),
    createdAt: requiredStringColumn(row, "created_at"),
    decidedAt: optionalStringColumn(row, "decided_at"),
    threadId: optionalStringColumn(row, "thread_id"),
    turnId: optionalStringColumn(row, "turn_id"),
  };
}
