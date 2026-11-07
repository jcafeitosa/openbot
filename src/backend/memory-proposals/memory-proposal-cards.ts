/**
 * The attention cards of memory proposals. A promotion from an agent memory is a proposal that waits for a person:
 * this class shows it as an approval card of its channel or chat, and answers the card. It is the only caller of
 * `MemoryProposalStore.approve` and `reject` that holds a person's decision: it mints the decision only after the
 * responder passes the check here, so an agent path or a local script never reaches the collective memory.
 *
 * A card lives as long as its proposal is pending, not as long as a turn: it stays up when the turn that proposed it
 * ends. The cards keep no state of their own. Each card is built from its pending proposal row, so a restart lists the
 * same card with the same proposal id. A proposal with no thread or turn (one recorded before they were stored) has no
 * card to build, so it is not listed.
 * It never imports the agent service facade.
 */

import type { AgentApproval, AgentEvent } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { ForbiddenAttentionAnswer, InactiveAttentionRequest } from "../agent/inactive-attention-request";
import {
  type MemoryProposal,
  type MemoryProposalScope,
  type MemoryProposalStore,
  mintPersonDecision,
} from "./memory-proposals";

/**
 * Who answers a card. Absent is the person at this computer; `owner` is the Team owner; `chat` is a press in an
 * external chat app, which counts as the person. A local script or a Team member who is not the owner has
 * `owner: false` and no `chat`, and is refused.
 */
export interface MemoryCardResponder {
  owner: boolean;
  chat?: boolean;
}

export interface MemoryCardPromotion {
  sourceAgentId: string;
  sourceMemoryId: string;
  targetScope: MemoryProposalScope;
  targetId: string;
  text: string;
  /** The public thread the promotion came from, where the card is shown. */
  threadId: string;
  turnId: string;
}

export interface MemoryProposalCardsOptions {
  store: MemoryProposalStore;
  emit(event: AgentEvent): void;
}

export class MemoryProposalCards {
  readonly #store: MemoryProposalStore;
  readonly #emit: (event: AgentEvent) => void;

  constructor(options: MemoryProposalCardsOptions) {
    this.#store = options.store;
    this.#emit = options.emit;
  }

  /**
   * Records the promotion as a proposal and shows its card when it has none yet: a new proposal, or a pending one
   * that had no thread to show in. A duplicate of a pending proposal with its card shows no second card. Nothing is
   * written to the collective memory here.
   */
  promote(input: MemoryCardPromotion): MemoryProposal {
    const { proposal, needsCard } = this.#store.record({
      sourceAgentId: input.sourceAgentId,
      sourceMemoryId: input.sourceMemoryId,
      targetScope: input.targetScope,
      targetId: input.targetId,
      text: input.text,
      threadId: input.threadId,
      turnId: input.turnId,
    });
    const approval = needsCard ? approvalOf(proposal) : null;
    if (approval) this.#emit({ type: "approval", approval });
    return proposal;
  }

  /** Whether a pending proposal card has this id. */
  has(requestId: string): boolean {
    return this.#card(requestId) !== null;
  }

  /** The cards that are waiting for a person, oldest first. */
  approvals(): AgentApproval[] {
    const cards: AgentApproval[] = [];
    for (const proposal of this.#store.pendingProposals()) {
      const approval = approvalOf(proposal);
      if (approval) cards.push(approval);
    }
    return cards;
  }

  /**
   * Answers a card for a responder. A responder that is neither the owner nor a chat press is refused and the
   * proposal stays pending. An approval that the store refuses (for example a full collective memory) also
   * leaves the card up.
   */
  respond(requestId: string, decision: "accept" | "decline", responder: MemoryCardResponder | undefined): void {
    const card = this.#card(requestId);
    if (!card) throw new InactiveAttentionRequest(sourceText("error.backend.approvalInactive"));
    if (responder && !responder.owner && !responder.chat)
      throw new ForbiddenAttentionAnswer(sourceText("error.backend.approvalOwnerOnly"));
    const person = mintPersonDecision();
    if (decision === "accept") this.#store.approve(requestId, person);
    else this.#store.reject(requestId, person);
    this.#emit({ type: "agent-input-resolved", kind: "approval", requestId, agentId: card.agentId });
  }

  /** The card of a pending proposal that has a thread and a turn to show in; null for any other id. */
  #card(requestId: string): AgentApproval | null {
    const proposal = this.#store.findPending(requestId);
    return proposal ? approvalOf(proposal) : null;
  }
}

/** The card of a proposal, or null when the proposal has no thread or turn to show it in. */
function approvalOf(proposal: MemoryProposal): AgentApproval | null {
  if (proposal.threadId === null || proposal.turnId === null) return null;
  return {
    requestId: proposal.proposalId,
    agentId: proposal.sourceAgentId,
    threadId: proposal.threadId,
    turnId: proposal.turnId,
    kind: "permissions",
    command: null,
    cwd: null,
    reason: proposal.text,
    grantRoot: null,
    permissions: null,
  };
}
