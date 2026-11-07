// The tools by which an agent proposes a change to its own instruction file or a skill. The gate in
// `self-improve-gate.ts` decides them; this file declares the tools and says how each result reads to
// the agent. The messages are English because the agent reads them, not the user.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { z } from "zod";
import { ABSENT_INSTRUCTIONS_SHA256 } from "../instructions-history-store";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";
import type { SelfImproveRefusal, SelfImproveResult } from "./self-improve-gate";

export const proposeInstructionsSchema = z
  .object({
    text: z
      .string()
      .max(INPUT_LIMITS.agentInstructionsFile)
      .describe("The whole new text of your instruction file, not a patch."),
  })
  .strict();

export const proposeInstructionsRollbackSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .describe("The sha256 of the earlier text to restore: a previousSha256 from an applied change."),
  })
  .strict();

export const proposeSkillSchema = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .max(INPUT_LIMITS.path)
      .describe("A folder inside your workspace, relative to it, that holds SKILL.md."),
  })
  .strict();

export const SELF_IMPROVE_TOOL_DEFINITIONS = [
  {
    name: "propose_instructions_change",
    description:
      "Propose a new full text of your instruction file (AGENTS.md, or CLAUDE.md in an older workspace) when the user asks for a standing rule change, or when a rule you follow keeps failing. OpenBot offers the diff only after 20 recorded turns. A person must approve the diff in OpenBot, and the change applies only when recent turns show no rise in failed turns. Returns status applied, or an error that says why nothing changed.",
    shape: proposeInstructionsSchema.shape,
  },
  {
    name: "propose_instructions_rollback",
    description: `Propose restoring your instruction file to an earlier text that OpenBot kept, by its sha256: a previousSha256 from an applied change. Use ${ABSENT_INSTRUCTIONS_SHA256} to remove the file as it was before it was first created. OpenBot offers a restore only after 20 recorded turns. A person must approve the restore in OpenBot, and nothing changes until they do. Returns status applied, or an error that says why nothing changed.`,
    shape: proposeInstructionsRollbackSchema.shape,
  },
  {
    name: "propose_skill",
    description:
      "Propose a skill from a folder inside your workspace that holds SKILL.md, after a task whose plan has at least two steps, all of them completed in this turn, and whose plan the person started with its card in this same turn. OpenBot offers the draft only after 20 recorded turns. A person must approve it in OpenBot, and it installs for you only after approval. Never run the folder's scripts.",
    shape: proposeSkillSchema.shape,
  },
];

export const SELF_IMPROVE_TOOL_NAMES: ReadonlySet<string> = new Set(
  SELF_IMPROVE_TOOL_DEFINITIONS.map((tool) => tool.name),
);

const DECLINED_MESSAGE = "The person did not approve this change, so nothing was applied.";

const REFUSAL_MESSAGES: Record<SelfImproveRefusal, string> = {
  secret:
    "The change holds a secret, so OpenBot did not show it to the person or keep it. Remove the secret and propose the change again.",
  nul: "The change holds a NUL character, which an instruction file cannot hold. Remove it and propose the change again.",
  "too-large": "The change is too long for the person to review in one card. Propose a smaller change.",
  unchanged: "The instruction file already has this text, so there is nothing to change.",
  changed: "The instruction file changed while the change waited for approval. Read it, then propose the change again.",
  "draft-changed":
    "The skill folder changed while the draft waited for approval, so nothing was installed. Read the folder, then propose the draft again.",
  evidence:
    "Insufficient evidence: OpenBot offers a change to your instructions or skills only after 20 recorded turns, so this change was not offered to the person. Tell the user what you wanted to change.",
  outside: "The instruction file is a link to a file outside the workspace, so OpenBot does not change it.",
  replay:
    "Recent turns show more failed turns than before, so OpenBot did not apply the change. Tell the user what you wanted to change.",
  plan: "A skill draft needs a finished task: a plan of at least two steps, all completed in this turn.",
  unapproved:
    "A skill draft needs the person's approval of your plan: the person must press start on your plan card in a task, in this turn. Ask the person to approve the plan first.",
  folder: "The skill folder must be a folder inside your workspace with a SKILL.md file, and it must hold no links.",
  missing:
    "OpenBot kept no earlier text of your instruction file with this hash, so nothing was restored. Use a previousSha256 from an applied change, or the absent-file hash from the tool description.",
};

/** The tool answer for one gate result. A declined or refused change is a failed call, not a crash. */
export function selfImproveToolResponse(result: SelfImproveResult): OpenBotToolResponse {
  switch (result.status) {
    case "applied":
      return openBotToolResult({
        status: "applied",
        fileName: result.fileName,
        sha256: result.sha256,
        previousSha256: result.previousSha256,
      });
    case "installed":
      return openBotToolResult({
        status: "installed",
        skillId: result.skill.id,
        revision: result.skill.version,
        name: result.skill.name,
      });
    case "declined":
      return openBotToolFailure(DECLINED_MESSAGE, {
        code: "approval_required",
        retryable: false,
        hint: "Tell the user that this change needs their approval in OpenBot. Do not call it again unless they ask.",
      });
    case "refused":
      return openBotToolFailure(REFUSAL_MESSAGES[result.reason], {
        code: "denied",
        retryable: result.reason === "changed" || result.reason === "draft-changed",
      });
  }
}
