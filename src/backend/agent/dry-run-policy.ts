import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";

/** The tools whose effect a person cannot undo, each with the catalog key of its action. */
const IRREVERSIBLE_ACTIONS = {
  messaging_post: "status.agent.dryRunPostMessage",
  messaging_forget_memory: "status.agent.dryRunForgetExternalMemory",
  forget_memory: "status.agent.dryRunForgetMemory",
  uninstall_skill: "status.agent.dryRunUninstallSkill",
  delete_routine: "status.agent.dryRunDeleteRoutine",
} as const;

export type IrreversibleTool = keyof typeof IRREVERSIBLE_ACTIONS;

/**
 * The router holds such a call until a person approves its dry-run preview, and runs the call only after
 * "accept".
 */
export function isIrreversibleTool(tool: string): tool is IrreversibleTool {
  return Object.hasOwn(IRREVERSIBLE_ACTIONS, tool);
}

/**
 * The preview of one call: what it would do and which arguments it carries. The arguments are summarized,
 * never echoed: each shows its name with its kind and size, so a secret in a value reaches neither the
 * approval card nor the agent.
 */
export function dryRunPreview(tool: IrreversibleTool, args: unknown): string {
  return sourceText("status.agent.dryRunPreview", {
    action: sourceText(IRREVERSIBLE_ACTIONS[tool]),
    tool,
    summary: summarizeArguments(args),
  });
}

function summarizeArguments(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return sourceText("status.agent.dryRunNoArguments");
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return sourceText("status.agent.dryRunNoArguments");
  return entries
    .map(([name, value]) =>
      sourceText("status.agent.dryRunArgument", { name: redactText(name), value: summarizeValue(value) }),
    )
    .join("; ");
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return sourceText("status.agent.dryRunTextValue", { count: Array.from(value).length });
  }
  if (Array.isArray(value)) return sourceText("status.agent.dryRunListValue", { count: value.length });
  if (value === null) return sourceText("status.agent.dryRunEmptyValue");
  if (typeof value === "object") {
    return sourceText("status.agent.dryRunObjectValue", { count: Object.keys(value).length });
  }
  return sourceText("status.agent.dryRunOtherValue");
}
