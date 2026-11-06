// The turn outcome ledger: one row in `turn_outcomes` for each turn that ends. `TurnLifecycle` writes it at
// the end of the turn, and `AttentionRegistry` counts the approval decisions of the turns while they run.
// A row keeps codes and counts only. It never keeps a message, a tool's command or output, an approval's
// request or a reason that a person gave, so no user text reaches the database through this path.
import type { CauseCode } from "@openbot/telemetry";
import type { OpenBotDatabase } from "../openbot-database";
import { getString, type ThreadItem } from "../protocol";

/** How a turn ended. */
export type TurnOutcome = "completed" | "failed" | "interrupted";

/** The approval decisions that count: accepted, or declined. A cancelled request is not a decision. */
export type ApprovalDecision = "accept" | "decline";

export interface ApprovalCounts {
  accepted: number;
  declined: number;
}

/** Approval counts of turns that have not ended yet. Past this many, the oldest go first. */
const APPROVAL_LIMIT = 256;

export interface TurnOutcomeInput {
  agentId: string;
  /** The public thread of the turn: the agent's own chat or a task. */
  threadId: string;
  turnId: string;
  outcome: TurnOutcome;
  /** The cause of a failed turn; null for any other outcome. */
  causeCode: CauseCode | null;
  /** The failed tool steps of the turn, counted by their code. */
  toolFailures: ReadonlyMap<string, number>;
  /** The messages of the turn. A reaction on any of them marks the row. */
  messageIds: readonly string[];
  /** The memories that the turn changed. */
  memoryChanges: number;
  approvals: ApprovalCounts;
  createdAt: string;
}

/**
 * Owns the approval counts of running turns and the outcome rows. It holds the database facade and
 * reads its connection at each use, so a handle cached before `initialize()` never addresses a closed file.
 */
export class TurnLedger {
  readonly #database: OpenBotDatabase;
  readonly #approvals = new Map<string, ApprovalCounts>();

  constructor(options: { database: OpenBotDatabase }) {
    this.#database = options.database;
  }

  /** Counts one approval decision of a turn. A request that belongs to no turn is not counted. */
  noteApproval(agentId: string, turnId: string | null, decision: ApprovalDecision): void {
    if (turnId === null) return;
    const key = approvalKey(agentId, turnId);
    const counts = this.#approvals.get(key) ?? { accepted: 0, declined: 0 };
    this.#approvals.delete(key);
    if (decision === "accept") counts.accepted += 1;
    else counts.declined += 1;
    this.#approvals.set(key, counts);
    for (const oldest of this.#approvals.keys()) {
      if (this.#approvals.size <= APPROVAL_LIMIT) break;
      this.#approvals.delete(oldest);
    }
  }

  /** Takes the approval counts of a turn that ends. A turn takes them once. */
  takeApprovals(agentId: string, turnId: string): ApprovalCounts {
    const key = approvalKey(agentId, turnId);
    const counts = this.#approvals.get(key) ?? { accepted: 0, declined: 0 };
    this.#approvals.delete(key);
    return counts;
  }

  /** Writes the row of a turn that ended. A turn that already has a row keeps the first one. */
  record(input: TurnOutcomeInput): void {
    const connection = this.#database.connection;
    const reactions = connection
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM projection_reactions
           WHERE agent_id = ? AND message_id IN (SELECT value FROM json_each(?))
         ) AS present`,
      )
      .get(input.agentId, JSON.stringify(input.messageIds));
    const skills = connection
      .prepare("SELECT COUNT(*) AS count FROM agent_usage_skill_loads WHERE agent_id = ? AND turn_id = ?")
      .get(input.agentId, input.turnId);
    const codes = Object.fromEntries(input.toolFailures);
    const failures = Object.values(codes).reduce((sum, count) => sum + count, 0);
    connection
      .prepare(
        `INSERT INTO turn_outcomes (
           agent_id, thread_id, turn_id, outcome, cause_code, tool_failures, tool_failure_codes_json,
           approvals_accepted, approvals_declined, reactions_present, memory_changes, skill_loads, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, turn_id) DO NOTHING`,
      )
      .run(
        input.agentId,
        input.threadId,
        input.turnId,
        input.outcome,
        input.causeCode,
        failures,
        JSON.stringify(codes),
        input.approvals.accepted,
        input.approvals.declined,
        Number(reactions?.present) === 1 ? 1 : 0,
        input.memoryChanges,
        Number(skills?.count ?? 0),
        input.createdAt,
      );
  }
}

/** The code of a failed tool step. */
export type ToolFailureCode = "declined" | "exit_nonzero" | "failed";

/**
 * It names how the step failed, and never its command or output: a command can hold a secret, and the
 * ledger keeps no text.
 */
export function toolFailureCode(item: ThreadItem): ToolFailureCode {
  if (getString(item, "status") === "declined") return "declined";
  const exitCode = item.exitCode;
  return typeof exitCode === "number" && exitCode !== 0 ? "exit_nonzero" : "failed";
}

function approvalKey(agentId: string, turnId: string): string {
  return JSON.stringify([agentId, turnId]);
}
