/**
 * The goal table: an objective an agent works toward, with a run budget and an optional deadline. The
 * routine scheduler asks `admitRun` before each run of the agent, so a run either counts once against
 * the goal or is refused and the goal is exhausted. It reads and writes its own table through the
 * connection read at each use, and never imports the facade.
 */

import { randomUUID } from "node:crypto";
import {
  checkedColumn,
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

export const AGENT_GOAL_STATUSES = ["open", "paused", "done", "exhausted", "failed"] as const;
export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number];

export interface AgentGoal {
  id: string;
  agentId: string;
  objective: string;
  status: AgentGoalStatus;
  maxRuns: number;
  runsUsed: number;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentGoalInput {
  agentId: string;
  objective: string;
  maxRuns: number;
  deadlineAt?: string | null;
}

export class AgentGoalStore {
  readonly #database: OpenBotDatabase;

  constructor(database: OpenBotDatabase) {
    this.#database = database;
  }

  create(input: CreateAgentGoalInput, now = new Date()): AgentGoal {
    // An unparsable deadline compares as never passed, so the goal would never expire: refuse it here.
    const deadline = input.deadlineAt === undefined || input.deadlineAt === null ? null : Date.parse(input.deadlineAt);
    if (deadline !== null && Number.isNaN(deadline)) throw new Error("The agent goal deadline is not a date.");
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.#database.connection
      .prepare(
        `INSERT INTO agent_goals
           (goal_id, agent_id, objective, status, max_runs, runs_used, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.objective,
        input.maxRuns,
        deadline === null ? null : new Date(deadline).toISOString(),
        timestamp,
        timestamp,
      );
    const goal = this.get(id);
    if (!goal) throw new Error("The agent goal was not saved.");
    return goal;
  }

  get(goalId: string): AgentGoal | null {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT * FROM agent_goals WHERE goal_id = ?").get(goalId),
    );
    return row ? toGoal(row) : null;
  }

  /**
   * The goal that governs an agent's runs: its newest goal, while that goal is open or exhausted. An
   * exhausted goal stays governing, so its runs keep being refused until a newer goal replaces it.
   * A paused, done or failed newest goal governs nothing.
   */
  governing(agentId: string): AgentGoal | null {
    const newest = databaseRows(
      this.#database.connection
        .prepare("SELECT * FROM agent_goals WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .all(agentId),
    )[0];
    if (!newest) return null;
    const goal = toGoal(newest);
    return goal.status === "open" || goal.status === "exhausted" ? goal : null;
  }

  /**
   * Decides one run of an agent before it is enqueued. Null admits it, and the run has counted once
   * against the governing goal. A reason refuses it: the goal is past its deadline or has no runs left,
   * and it is now exhausted, so the runs after it are refused as well.
   */
  admitRun(agentId: string, now = new Date()): string | null {
    const goal = this.governing(agentId);
    if (!goal) return null;
    const pastDeadline = goal.deadlineAt !== null && Date.parse(goal.deadlineAt) <= now.getTime();
    if (goal.status === "open" && !pastDeadline && this.recordRun(goal.id, now)) return null;
    this.#database.connection
      .prepare("UPDATE agent_goals SET status = 'exhausted', updated_at = ? WHERE goal_id = ? AND status = 'open'")
      .run(now.toISOString(), goal.id);
    return pastDeadline
      ? "The agent goal's deadline has passed, so the run was refused."
      : `The agent goal has used all ${goal.maxRuns} of its runs, so the run was refused.`;
  }

  /**
   * Counts one run against an open goal with runs left, and exhausts the goal when that run is its last.
   * The check and the increment are one guarded UPDATE, so a run the budget has refused is never counted,
   * and no transaction is opened inside the caller's, where SQLite would reject a nested BEGIN.
   */
  recordRun(goalId: string, now = new Date()): boolean {
    const result = this.#database.connection
      .prepare(
        `UPDATE agent_goals SET runs_used = runs_used + 1,
           status = CASE WHEN runs_used + 1 >= max_runs THEN 'exhausted' ELSE status END,
           updated_at = ?
         WHERE goal_id = ? AND status = 'open' AND runs_used < max_runs`,
      )
      .run(now.toISOString(), goalId);
    return Number(result.changes) === 1;
  }

  finish(goalId: string, status: "done" | "failed", now = new Date()): void {
    const result = this.#database.connection
      .prepare("UPDATE agent_goals SET status = ?, updated_at = ? WHERE goal_id = ?")
      .run(status, now.toISOString(), goalId);
    if (Number(result.changes) !== 1) throw new Error("The agent goal does not exist.");
  }
}

function toGoal(value: unknown): AgentGoal {
  const row = databaseRow(value);
  if (!row) throw new Error("Invalid SQLite row for an agent goal.");
  return {
    id: requiredStringColumn(row, "goal_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    objective: requiredStringColumn(row, "objective"),
    status: checkedColumn(row, "status", AGENT_GOAL_STATUSES),
    maxRuns: requiredNumberColumn(row, "max_runs"),
    runsUsed: requiredNumberColumn(row, "runs_used"),
    deadlineAt: optionalStringColumn(row, "deadline_at"),
    createdAt: requiredStringColumn(row, "created_at"),
    updatedAt: requiredStringColumn(row, "updated_at"),
  };
}
