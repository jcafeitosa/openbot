/**
 * The two tools that write the workstate of an agent: its working memory in the thread it runs in, and the
 * preferences of the person. A preference is written only for a person's message, as a Vault key is, so an agent
 * that acts on a teammate's message or a routine cannot set one. The handler reads the router's person check
 * through `personRequest` and never imports the router.
 */

import { z } from "zod";
import type { ConversationRuntime } from "../agent/conversation-runtime";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { OpenBotDatabase } from "../openbot-database";
import type { DynamicToolCallParams } from "../protocol";
import {
  LOCAL_PERSON_ID,
  PersonPreferencesStore,
  PREFERENCE_KEY_LIMIT,
  PREFERENCE_VALUE_LIMIT,
} from "./person-preferences-store";
import { WORKING_MEMORY_BODY_LIMIT, WORKING_MEMORY_SLOTS, WorkingMemoryStore } from "./working-memory-store";
import { WorkstateTextRefused } from "./workstate-text";

export const WORKING_MEMORY_TOOL = "set_working_memory";
export const PREFERENCE_TOOL = "set_preference";

export const setWorkingMemoryToolSchema = z.strictObject({
  slot: z.enum(WORKING_MEMORY_SLOTS).describe("goal, facts, open_questions or next_step."),
  body: z.string().max(WORKING_MEMORY_BODY_LIMIT).describe("The slot's text, replacing the old one. Empty clears it."),
});

export const setPreferenceToolSchema = z.strictObject({
  key: z.string().trim().min(1).max(PREFERENCE_KEY_LIMIT).describe("A short name, such as 'reply language'."),
  value: z.string().trim().min(1).max(PREFERENCE_VALUE_LIMIT).describe("What the person asked for."),
});

export interface WorkstateToolsOptions {
  database: OpenBotDatabase;
  conversation: Pick<ConversationRuntime, "publicThreadId">;
  /** Whether a person's message, not a teammate's, a routine's or a web page's, asked for this turn. */
  personRequest: (agentId: string, turnId: string, threadId: string) => boolean;
}

export class WorkstateTools {
  readonly #working: WorkingMemoryStore;
  readonly #preferences: PersonPreferencesStore;
  readonly #conversation: WorkstateToolsOptions["conversation"];
  readonly #personRequest: WorkstateToolsOptions["personRequest"];

  constructor(options: WorkstateToolsOptions) {
    this.#working = new WorkingMemoryStore(options.database);
    this.#preferences = new PersonPreferencesStore(options.database);
    this.#conversation = options.conversation;
    this.#personRequest = options.personRequest;
  }

  /** The answer to a workstate tool call, or null for every other tool. */
  handle(params: DynamicToolCallParams, senderAgentId: string): OpenBotToolResponse | null {
    if (params.tool === WORKING_MEMORY_TOOL) return this.#setWorkingMemory(params, senderAgentId);
    if (params.tool === PREFERENCE_TOOL) return this.#setPreference(params, senderAgentId);
    return null;
  }

  #setWorkingMemory(params: DynamicToolCallParams, agentId: string): OpenBotToolResponse {
    const parsed = setWorkingMemoryToolSchema.safeParse(params.arguments);
    if (!parsed.success)
      return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
    const threadId = this.#conversation.publicThreadId(agentId, params.threadId);
    try {
      this.#working.set(agentId, threadId, parsed.data.slot, parsed.data.body);
    } catch (error) {
      if (error instanceof WorkstateTextRefused) return openBotToolFailure(error.message);
      throw error;
    }
    return openBotToolResult({ status: "saved", slot: parsed.data.slot });
  }

  #setPreference(params: DynamicToolCallParams, agentId: string): OpenBotToolResponse {
    const parsed = setPreferenceToolSchema.safeParse(params.arguments);
    if (!parsed.success)
      return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
    const threadId = this.#conversation.publicThreadId(agentId, params.threadId);
    if (!this.#personRequest(agentId, params.turnId, threadId))
      return openBotToolFailure(
        "Only a person's message, in your OpenBot chat or a thread they opened, can set a preference. Ask the user to state it there.",
      );
    try {
      this.#preferences.set(LOCAL_PERSON_ID, parsed.data.key, parsed.data.value);
    } catch (error) {
      if (error instanceof WorkstateTextRefused) return openBotToolFailure(error.message);
      throw error;
    }
    return openBotToolResult({ status: "saved", key: parsed.data.key });
  }
}
