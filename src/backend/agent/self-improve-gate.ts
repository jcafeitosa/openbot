// The gate for an agent's own changes: its instruction file, and a skill draft that it makes from a
// finished task. A change waits for a person. Its approval card is owner-only, so no local script and no
// agent answers it. Then a replay of the agent's recorded turns must show no rise in failed turns. Only a
// change that passes both is written or installed; a change that fails either changes nothing. The replay
// reads recorded outcomes only: no model runs, so it cannot predict what a change does to one turn.

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { ConversationPlan, MarketplaceSkillDetail } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { instructionsTextSha256 } from "../instructions-history-store";
import type { OpenBotDatabase } from "../openbot-database";
import type { LocalSkillTools } from "./skill-tools";
import { ToolOperationFailed } from "./tool-operation";
import type { TurnLedger } from "./turn-ledger";
import { readAgentInstructionsFile, saveAgentInstructionsFile } from "./workspace-instructions";

/** The newest recorded turns that a replay counts, and the window of turns before them. */
export const REPLAY_WINDOW = 10;
/** A diff with more changed lines than this is too long for one card, so the change is refused. */
const DIFF_LINE_LIMIT = 400;
/** The cells of the diff table. A larger pair of texts is refused before the table is built. */
const DIFF_CELL_LIMIT = 1_000_000;
/** The bytes and files of a skill draft that a person reviews in one card. */
const DRAFT_BYTE_LIMIT = 512 * 1024;
const DRAFT_FILE_LIMIT = 200;

export type SelfImproveDecision = "accept" | "decline" | "cancel";

/** Asks the person about one change. The answer comes from the owner-only approval card. */
export type SelfImproveApproval = (reason: string) => Effect.Effect<SelfImproveDecision, ToolOperationFailed>;

export type SelfImproveRefusal =
  | "secret"
  | "too-large"
  | "unchanged"
  | "changed"
  | "outside"
  | "replay"
  | "plan"
  | "folder";

export type SelfImproveResult =
  | { status: "applied"; fileName: string; sha256: string; previousSha256: string }
  | { status: "installed"; skill: MarketplaceSkillDetail }
  | { status: "declined" }
  | { status: "refused"; reason: SelfImproveRefusal };

export interface InstructionsProposal {
  agentId: string;
  workspace: string;
  /** The whole new text of the instruction file. */
  text: string;
  approve: SelfImproveApproval;
}

export interface SkillProposal {
  agentId: string;
  workspace: string;
  /** A folder inside the workspace, relative to it, that holds `SKILL.md`. */
  sourcePath: string;
  /** The plan of the turn that proposes the draft, or null when that turn has none. */
  plan: ConversationPlan | null;
  approve: SelfImproveApproval;
  skills: LocalSkillTools;
}

const refused = (reason: SelfImproveRefusal) => ({ status: "refused" as const, reason });

/**
 * Whether a text holds a secret. The redaction also masks a token that looks like a credential, so such a
 * text is refused too: the same rule as the instruction history, which keeps no text that looks secret.
 */
export function holdsSecret(text: string): boolean {
  return redactText(text) !== text;
}

/**
 * Whether the newest `REPLAY_WINDOW` recorded turns hold more failed turns than the `REPLAY_WINDOW` before
 * them. A replay needs both full windows: with less recorded history it finds no regression. Recorded
 * outcomes are the only input, so this refuses a change while the agent's failures are already rising.
 */
export function replayRegresses(outcomesNewestFirst: readonly string[]): boolean {
  if (outcomesNewestFirst.length < REPLAY_WINDOW * 2) return false;
  const recent = outcomesNewestFirst.slice(0, REPLAY_WINDOW);
  const prior = outcomesNewestFirst.slice(REPLAY_WINDOW, REPLAY_WINDOW * 2);
  return (
    recent.filter((outcome) => outcome === "failed").length > prior.filter((outcome) => outcome === "failed").length
  );
}

/** A plan that a skill draft may come from: at least two steps, all of them completed. */
export function planCompleted(plan: ConversationPlan | null): boolean {
  return plan !== null && plan.steps.length >= 2 && plan.steps.every((step) => step.status === "completed");
}

/**
 * The changed lines between two texts: `- ` for a line that goes, `+ ` for a line that comes. Null when
 * the change is too long to show in one card.
 */
export function changedLines(before: string, after: string): string[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > DIFF_CELL_LIMIT) return null;
  const width = b.length + 1;
  // `common[i * width + j]` is the longest common run of `a` from `i` and of `b` from `j`.
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const changes: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (j < b.length && (i >= a.length || (common[i * width + j + 1] ?? 0) >= (common[(i + 1) * width + j] ?? 0))) {
      changes.push(`+ ${b[j]}`);
      j += 1;
    } else {
      changes.push(`- ${a[i]}`);
      i += 1;
    }
    if (changes.length > DIFF_LINE_LIMIT) return null;
  }
  return changes;
}

interface DraftFile {
  /** The path inside the folder, with `/` between the parts. */
  path: string;
  text: string;
}

type DraftRead = { files: DraftFile[] } | { refused: "folder" | "too-large" };

/**
 * The files of a skill folder inside the workspace. A path that leaves the workspace, a link, or a folder
 * with no `SKILL.md` is `folder`; a folder that is too big to review in one card is `too-large`. Nothing
 * in the folder is run.
 */
async function readDraft(workspace: string, sourcePath: string): Promise<DraftRead> {
  if (
    !sourcePath ||
    isAbsolute(sourcePath) ||
    sourcePath.includes("\\") ||
    sourcePath.split("/").some((part) => part === ".." || !part)
  )
    return { refused: "folder" };
  try {
    const root = await realpath(workspace);
    const folder = resolve(root, sourcePath);
    if (!folder.startsWith(`${root}${sep}`)) return { refused: "folder" };
    if (!(await lstat(folder)).isDirectory()) return { refused: "folder" };
    if (!(await lstat(join(folder, "SKILL.md"))).isFile()) return { refused: "folder" };
    const files: DraftFile[] = [];
    const budget = { bytes: 0 };
    const outcome = await collectDraft(folder, folder, files, budget);
    if (outcome !== "ok") return { refused: outcome };
    return { files };
  } catch {
    return { refused: "folder" };
  }
}

async function collectDraft(
  root: string,
  directory: string,
  files: DraftFile[],
  budget: { bytes: number },
): Promise<"ok" | "folder" | "too-large"> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return "folder";
    if (entry.isDirectory()) {
      const outcome = await collectDraft(root, path, files, budget);
      if (outcome !== "ok") return outcome;
      continue;
    }
    if (!entry.isFile()) return "folder";
    const info = await lstat(path);
    budget.bytes += info.size;
    if (budget.bytes > DRAFT_BYTE_LIMIT || files.length >= DRAFT_FILE_LIMIT) return "too-large";
    const bytes = await readFile(path);
    files.push({ path: relative(root, path).split(sep).join("/"), text: new TextDecoder().decode(bytes) });
  }
  return "ok";
}

/**
 * Proposes changes to an agent's own instructions and skills. The gate keeps the database facade and
 * reads its connection at each use, as the turn ledger does, so a handle cached before startup never
 * addresses a closed file.
 */
export class SelfImproveGate {
  readonly #database: OpenBotDatabase;
  readonly #ledger: TurnLedger;

  constructor(options: { database: OpenBotDatabase; ledger: TurnLedger }) {
    this.#database = options.database;
    this.#ledger = options.ledger;
  }

  /**
   * Proposes the whole new text of the instruction file. Writes it only when the person accepts the
   * diff and the replay shows no regression. A write keeps the replaced text in the instruction history,
   * so the change can be rolled back by hash.
   */
  readonly proposeInstructions = (input: InstructionsProposal) =>
    this.#instructions(input).pipe(
      Effect.catchTag("AgentInstructionsFileRefused", (failure) =>
        Effect.succeed({ status: "refused" as const, reason: failure.reason }),
      ),
      Effect.catchTag("AgentInstructionsFileFailed", (failure) =>
        Effect.fail(new ToolOperationFailed({ cause: failure.cause })),
      ),
    );

  /**
   * Proposes a skill draft from a folder of the workspace. Installs it for the agent only when the turn
   * has a finished plan, the person accepts the card, and the replay shows no regression.
   */
  readonly proposeSkill = (input: SkillProposal) => this.#skill(input);

  readonly #instructions = Effect.fn("SelfImproveGate.instructions")(function* (
    this: SelfImproveGate,
    input: InstructionsProposal,
  ) {
    if (holdsSecret(input.text)) return refused("secret");
    const current = yield* readAgentInstructionsFile(input.workspace);
    // The replaced text is kept in the instruction history, so it must not hold a secret either.
    if (holdsSecret(current.text)) return refused("secret");
    if (current.text === input.text) return refused("unchanged");
    const changes = changedLines(current.text, input.text);
    if (changes === null) return refused("too-large");
    const diff = changes.join("\n");
    const reason = `${sourceText("status.agent.selfImproveInstructionsPreview", { file: current.fileName })}\n\n${diff}`;
    if (holdsSecret(diff)) return refused("secret");
    if (reason.length > INPUT_LIMITS.messageText) return refused("too-large");
    const decision = yield* input.approve(reason);
    if (decision !== "accept") return { status: "declined" as const };
    if (replayRegresses(this.#ledger.recentOutcomes(input.agentId, REPLAY_WINDOW * 2))) return refused("replay");
    yield* saveAgentInstructionsFile(input.workspace, input.text, current.text, {
      agentId: input.agentId,
      database: this.#database.connection,
    });
    return {
      status: "applied" as const,
      fileName: current.fileName,
      sha256: instructionsTextSha256(input.text),
      previousSha256: instructionsTextSha256(current.text),
    };
  }).bind(this);

  readonly #skill = Effect.fn("SelfImproveGate.skill")(function* (this: SelfImproveGate, input: SkillProposal) {
    if (!planCompleted(input.plan)) return refused("plan");
    const draft = yield* Effect.promise(() => readDraft(input.workspace, input.sourcePath));
    if ("refused" in draft) return refused(draft.refused);
    if (draft.files.some((file) => holdsSecret(file.text))) return refused("secret");
    const name = input.sourcePath.split("/").at(-1) ?? input.sourcePath;
    const reason = sourceText("status.agent.selfImproveSkillPreview", {
      name,
      files: draft.files.map((file) => file.path).join(", "),
    });
    if (reason.length > INPUT_LIMITS.messageText) return refused("too-large");
    const decision = yield* input.approve(reason);
    if (decision !== "accept") return { status: "declined" as const };
    if (replayRegresses(this.#ledger.recentOutcomes(input.agentId, REPLAY_WINDOW * 2))) return refused("replay");
    // `create` publishes the draft as a new local skill revision and installs it for this agent.
    const skill = yield* input.skills.create({ agentId: input.agentId, sourcePath: input.sourcePath });
    return { status: "installed" as const, skill };
  }).bind(this);
}
