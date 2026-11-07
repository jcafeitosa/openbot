import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";
import { z } from "zod";
import type { MemoryCardPromotion } from "../memory-proposals/memory-proposal-cards";
import type { MemoryProposal, MemoryProposalScope } from "../memory-proposals/memory-proposals";
import type { DynamicToolCallParams } from "../protocol";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";

export const PROMOTE_MEMORY_TOOL = "promote_memory";

export const promoteMemoryToolSchema = z.strictObject({
  memoryId: z.string().trim().min(1).max(INPUT_LIMITS.identifier),
});

export interface MemoryPromotionOptions {
  /** The agent's own memories. A promotion copies the text of one of them. */
  memories: { listFor(agentId: string): Array<{ id: string; text: string }> };
  /** Records the proposal and shows its card. Nothing is written to the collective memory here. */
  attention: { proposeMemory(input: MemoryCardPromotion): MemoryProposal };
  /** The channel whose execution thread this is, or null. */
  channelForThread(threadId: string): string | null;
  /** The external chat connection whose thread this is, or null. */
  connectionForThread(threadId: string): string | null;
}

export interface MemoryPromotionCaller {
  agentId: string;
  /** The public execution thread of the calling turn: the channel or chat thread the card is shown in. */
  threadId: string;
  turnId: string;
}

/**
 * Answers `promote_memory`: an agent proposes that one of its memories becomes the memory of the channel or chat
 * it is answering in. The target is the channel or connection of the calling thread, never a value the model
 * names, so an agent cannot promote into a conversation it is not in. The proposal waits for a person.
 *
 * It never imports the agent service facade.
 */
export class MemoryPromotion {
  readonly #options: MemoryPromotionOptions;

  constructor(options: MemoryPromotionOptions) {
    this.#options = options;
  }

  /** Answers `promote_memory`; null for every other tool. */
  handleTool(params: DynamicToolCallParams, caller: MemoryPromotionCaller): OpenBotToolResponse | null {
    if (params.tool !== PROMOTE_MEMORY_TOOL) return null;
    const parsed = promoteMemoryToolSchema.safeParse(params.arguments);
    if (!parsed.success) return openBotToolFailure(z.prettifyError(parsed.error));
    const target = this.#target(caller.threadId);
    if (!target) return openBotToolFailure(sourceText("error.backend.memoryPromotionTarget"));
    const memory = this.#options.memories.listFor(caller.agentId).find((entry) => entry.id === parsed.data.memoryId);
    if (!memory) return openBotToolFailure(sourceText("error.backend.memoryGone"));
    try {
      const proposal = this.#options.attention.proposeMemory({
        sourceAgentId: caller.agentId,
        sourceMemoryId: memory.id,
        targetScope: target.scope,
        targetId: target.targetId,
        text: memory.text,
        threadId: caller.threadId,
        turnId: caller.turnId,
      });
      return openBotToolResult({
        proposalId: proposal.proposalId,
        status: proposal.status,
        next: "The proposal waits for the person in OpenBot. Nothing is saved to the shared memory until they approve it. Do not promote it again.",
      });
    } catch (error) {
      if (error instanceof Error) return openBotToolFailure(error.message);
      throw error;
    }
  }

  #target(threadId: string): { scope: MemoryProposalScope; targetId: string } | null {
    const channelId = this.#options.channelForThread(threadId);
    if (channelId) return { scope: "channel", targetId: channelId };
    const connectionId = this.#options.connectionForThread(threadId);
    return connectionId ? { scope: "messaging", targetId: connectionId } : null;
  }
}
