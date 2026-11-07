/**
 * The attention cards of memory proposals. A promotion from an agent memory is a proposal that waits for a person:
 * this class shows it as an approval card of its channel or chat, and answers the card. It is the only caller of
 * `MemoryProposalStore.approve` and `reject` that holds a person's decision: it mints the decision only after the
 * responder passes the check here, so an agent path or a local script never reaches the collective memory.
 *
 * A card lives as long as its proposal is pending, not as long as a turn: it stays up when the turn that
 * proposed it ends. It is kept in memory, so a restart drops it while its proposal stays pending in the store; the
 * next promotion of the same text shows the card again.
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
  readonly #cards = new Map<string, AgentApproval>();

  constructor(options: MemoryProposalCardsOptions) {
    this.#store = options.store;
    this.#emit = options.emit;
  }

  /**
   * Records the promotion as a proposal and shows its card once. A duplicate of a pending proposal returns that
   * proposal and shows no second card. Nothing is written to the collective memory here.
   */
  promote(input: MemoryCardPromotion): MemoryProposal {
    const proposal = this.#store.propose({
      sourceAgentId: input.sourceAgentId,
      sourceMemoryId: input.sourceMemoryId,
      targetScope: input.targetScope,
      targetId: input.targetId,
      text: input.text,
    });
    if (proposal.status === "pending" && !this.#cards.has(proposal.proposalId)) {
      const approval: AgentApproval = {
        requestId: proposal.proposalId,
        agentId: input.sourceAgentId,
        threadId: input.threadId,
        turnId: input.turnId,
        kind: "permissions",
        command: null,
        cwd: null,
        reason: proposal.text,
        grantRoot: null,
        permissions: null,
      };
      this.#cards.set(proposal.proposalId, approval);
      this.#emit({ type: "approval", approval });
    }
    return proposal;
  }

  /** Whether a pending proposal card has this id. */
  has(requestId: string): boolean {
    return this.#cards.has(requestId);
  }

  /** The cards that are waiting for a person, oldest first. */
  approvals(): AgentApproval[] {
    return [...this.#cards.values()].map((approval) => structuredClone(approval));
  }

  /**
   * Answers a card for a responder. A responder that is neither the owner nor a chat press is refused and the
   * proposal stays pending. An approval that the store refuses (for example a full collective memory) also
   * leaves the card up.
   */
  respond(requestId: string, decision: "accept" | "decline", responder: MemoryCardResponder | undefined): void {
    const approval = this.#cards.get(requestId);
    if (!approval) throw new InactiveAttentionRequest(sourceText("error.backend.approvalInactive"));
    if (responder && !responder.owner && !responder.chat)
      throw new ForbiddenAttentionAnswer(sourceText("error.backend.approvalOwnerOnly"));
    const person = mintPersonDecision();
    if (decision === "accept") this.#store.approve(requestId, person);
    else this.#store.reject(requestId, person);
    this.#cards.delete(requestId);
    this.#emit({ type: "agent-input-resolved", kind: "approval", requestId, agentId: approval.agentId });
  }
}
