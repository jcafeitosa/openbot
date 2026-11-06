import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentModelOption,
  type AgentSummary,
  type ConversationMessage,
  isContextResetMarker,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Exit, Fiber, Schema, Scope } from "effect";
import type { AgentClient } from "../agent-client";
import { extractJsonObject } from "../structured-output";
import type { AgentMemories, MemoryReviewBase } from "./agent-memories";
import { backgroundModel } from "./background-model";
import { memoryChangesMessage } from "./memory-changes-message";
import { MemoryReviewResult, memoryReflectionPrompt, memoryReviewPrompt } from "./memory-review-prompt";
import type { ProfileClients } from "./profile-clients";
import { type GenerationObserver, GenerationUsageLimitError, generateTextWithoutTools } from "./profile-generation";
import type { ProviderOperationFailed } from "./provider-runtime";

const logger = createOpenBotLogger("memory-review");

/** The completed turns of one conversation between two reviews, by default. */
const MEMORY_REVIEW_INTERVAL = 20;
/** A conversation with no turn for this long gets its review early, when it has enough new turns. */
const MEMORY_REVIEW_IDLE_MS = 15 * 60_000;
/** The fewest new turns for a review after a pause or when a side thread closes. */
const MEMORY_REVIEW_IDLE_TURNS = 3;
/** The latest chat messages that a review reads when the chat is not loaded. */
export const MEMORY_REVIEW_MESSAGES = 200;

class MemoryReviewFailed extends Schema.TaggedError<MemoryReviewFailed>()("MemoryReviewFailed", {
  cause: Schema.Defect(),
}) {}

export interface MemoryReviewOptions {
  memories: AgentMemories;
  profileClients: ProfileClients;
  listAgents(): AgentSummary[];
  /** The models that the agent's provider lists once it is ready. */
  models(agent: AgentSummary): Effect.Effect<readonly AgentModelOption[], ProviderOperationFailed>;
  /** A client signed in to the agent's own provider account. */
  createProfileClient(agent: AgentSummary): AgentClient;
  /** Records the token usage of one review under its agent. */
  usageObserver(agent: AgentSummary, model: AgentModelOption): GenerationObserver;
  /** The latest messages of the agent's own chat, or of its side thread, oldest first. */
  chat(agentId: string, threadId: string | null): readonly ConversationMessage[];
  /** Whether a turn of the conversation runs and holds its cached snapshot. */
  turnActive(agentId: string, threadId: string | null): boolean;
  appendSystemMessage(agentId: string, threadId: string | null, message: ConversationMessage): void;
  redact(text: string): string;
  stopping(): boolean;
  /** The pause before an early review. Omitted, `MEMORY_REVIEW_IDLE_MS`. */
  idleMs?: number;
  /**
   * The app setting: the completed turns between two reviews, read at each use. `0` turns off all
   * reviews, also after a pause, a clear and a closed side thread. Omitted, `MEMORY_REVIEW_INTERVAL`.
   */
  interval?(): number;
}

/** One conversation that a review reads: the agent's own chat (`threadId` null) or one side thread. */
interface ReviewedConversation {
  readonly key: string;
  readonly agentId: string;
  readonly threadId: string | null;
  turns: number;
  /** The last message that a review read, or that the agent's own memory change made old. */
  cursor: string | null;
  /** A review's line that waits for the running turn to end, so the turn does not write over it. */
  heldLine: ConversationMessage | null;
  idle: Fiber.Fiber<void> | null;
  /** A review was due while another review ran or no profile client was free: it runs next. */
  waiting: boolean;
  /** A failed turn that waits for its reflection. Null when none does. */
  failedTurn: FailedTurn | null;
}

/** The failed turn that a reflection reads: where its lesson goes, its error class and its tool steps. */
interface FailedTurn {
  readonly source: string;
  readonly errorClass: string;
  readonly toolSteps: readonly string[];
}

/**
 * Owns the background memory reviews: every few completed turns of an agent's
 * own chat or side thread, after a pause in it, when the chat is cleared and when a side thread
 * closes, one generation without tools reads the new part of the conversation and the agent's
 * memories, and proposes changes that `AgentMemories` applies with the checks of the memory tools.
 * One review runs at a time, and only when a profile client stays free for the user. A review that
 * cannot start waits, and starts when the running review ends or at the next turn. The counts live
 * in memory only. A turn that ends failed also starts a reflection: one lesson from its error class and
 * redacted tool steps, saved as a searchable automatic memory with the reflection as its source.
 *
 * It never imports the agent service facade.
 */
export class MemoryReview {
  readonly #options: MemoryReviewOptions;
  readonly #conversations = new Map<string, ReviewedConversation>();
  #running: { key: string; agentId: string; fiber: Fiber.Fiber<void> } | null = null;
  #scope = Scope.makeUnsafe();

  constructor(options: MemoryReviewOptions) {
    this.#options = options;
  }

  /**
   * A turn of the agent's own chat (`threadId` null) or of its side thread ended. A completed turn
   * that counts brings the next review closer. A turn in which the agent changed its memories itself
   * starts the count again.
   */
  readonly turnEnded = Effect.fn("MemoryReview.turnEnded")(function* (
    this: MemoryReview,
    agentId: string,
    threadId: string | null,
    counts: boolean,
    memoryCommitted: boolean,
  ) {
    const conversation = this.#conversation(agentId, threadId);
    yield* this.#stopIdle(conversation);
    this.#flush(conversation);
    if (!counts && !this.#off()) yield* this.#noteFailedTurn(conversation);
    if (counts && memoryCommitted) {
      conversation.turns = 0;
      const messages = yield* Effect.try(() => this.#options.chat(agentId, threadId)).pipe(
        Effect.orElseSucceed(() => []),
      );
      this.#moveCursor(conversation, messages);
      return;
    }
    if (counts) conversation.turns += 1;
    if (conversation.turns >= this.#interval()) yield* this.#start(conversation);
    yield* this.#startWaiting();
    // A review that could not start now runs after a pause instead.
    yield* this.#startIdle(conversation);
  }).bind(this);

  /** The agent's chat was cleared: the chat that the clear ended gets its review now. */
  readonly chatCleared = Effect.fn("MemoryReview.chatCleared")(function* (this: MemoryReview, agentId: string) {
    const conversation = this.#conversation(agentId, null);
    yield* this.#stopIdle(conversation);
    this.#flush(conversation);
    yield* this.#start(conversation);
  }).bind(this);

  /** A side thread closed: its new turns get their review now. */
  readonly threadClosed = Effect.fn("MemoryReview.threadClosed")(function* (
    this: MemoryReview,
    agentId: string,
    threadId: string,
  ) {
    const conversation = this.#conversations.get(conversationKey(agentId, threadId));
    if (!conversation) return;
    yield* this.#stopIdle(conversation);
    this.#flush(conversation);
    if (conversation.turns > 0) yield* this.#start(conversation);
  }).bind(this);

  /** Ends the side thread's review and forgets its counts, before the thread is deleted. */
  readonly forgetThread = Effect.fn("MemoryReview.forgetThread")(function* (
    this: MemoryReview,
    agentId: string,
    threadId: string,
  ) {
    const key = conversationKey(agentId, threadId);
    const conversation = this.#conversations.get(key);
    this.#conversations.delete(key);
    if (conversation) yield* this.#stopIdle(conversation);
    const running = this.#running;
    if (running?.key === key) yield* Fiber.interrupt(running.fiber);
  }).bind(this);

  /** Ends the agent's reviews and forgets its counts, before the agent is deleted. */
  readonly cancel = Effect.fn("MemoryReview.cancel")(function* (this: MemoryReview, agentId: string) {
    for (const conversation of [...this.#conversations.values()]) {
      if (conversation.agentId !== agentId) continue;
      this.#conversations.delete(conversation.key);
      yield* this.#stopIdle(conversation);
    }
    const running = this.#running;
    if (running?.agentId === agentId) yield* Fiber.interrupt(running.fiber);
  }).bind(this);

  readonly dispose = Effect.fn("MemoryReview.dispose")(function* (this: MemoryReview) {
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
    this.#running = null;
    this.#conversations.clear();
  }).bind(this);

  #interval(): number {
    return this.#options.interval?.() ?? MEMORY_REVIEW_INTERVAL;
  }

  /** Off, the turns still count, so a review after the user turns it on again reads them. */
  #off(): boolean {
    return this.#interval() <= 0;
  }

  #conversation(agentId: string, threadId: string | null): ReviewedConversation {
    const key = conversationKey(agentId, threadId);
    const known = this.#conversations.get(key);
    if (known) return known;
    const conversation = {
      key,
      agentId,
      threadId,
      turns: 0,
      cursor: null,
      heldLine: null,
      idle: null,
      waiting: false,
      failedTurn: null,
    };
    this.#conversations.set(key, conversation);
    return conversation;
  }

  readonly #stopIdle = Effect.fn("MemoryReview.stopIdle")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ) {
    const idle = conversation.idle;
    conversation.idle = null;
    if (idle) yield* Fiber.interrupt(idle);
  }).bind(this);

  /** After a pause with no turn, a conversation with enough new turns gets its review. */
  readonly #startIdle = Effect.fn("MemoryReview.startIdle")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ) {
    if (conversation.turns < MEMORY_REVIEW_IDLE_TURNS || this.#off() || this.#options.stopping()) return;
    conversation.idle = yield* Effect.sleep(this.#options.idleMs ?? MEMORY_REVIEW_IDLE_MS).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          conversation.idle = null;
          if (this.#conversations.get(conversation.key) !== conversation) return Effect.void;
          if (conversation.turns < MEMORY_REVIEW_IDLE_TURNS) return Effect.void;
          if (this.#options.turnActive(conversation.agentId, conversation.threadId)) return Effect.void;
          return this.#start(conversation);
        }),
      ),
      Effect.forkIn(this.#scope),
    );
  }).bind(this);

  readonly #start = Effect.fn("MemoryReview.start")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ): Effect.fn.Return<void> {
    if (this.#off() || this.#options.stopping()) return;
    if (this.#running || !this.#options.profileClients.hasSpare()) {
      conversation.waiting = true;
      return;
    }
    yield* this.#run(conversation, this.#review(conversation));
  }).bind(this);

  /** A reflection on a failed turn runs like a review: one at a time, on a free profile client. */
  readonly #startReflection = Effect.fn("MemoryReview.startReflection")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ): Effect.fn.Return<void> {
    if (!conversation.failedTurn) return;
    if (this.#off() || this.#options.stopping()) {
      conversation.failedTurn = null;
      return;
    }
    if (this.#running || !this.#options.profileClients.hasSpare()) return;
    yield* this.#run(conversation, this.#reflect(conversation));
  }).bind(this);

  /** Makes `work` the running review of the conversation. Its end starts the next one that waits. */
  readonly #run = Effect.fn("MemoryReview.run")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
    work: Effect.Effect<void, MemoryReviewFailed>,
  ): Effect.fn.Return<void> {
    conversation.waiting = false;
    const fiber = yield* work.pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          // A usage limit belongs to the user's own turns: the review does not mark the model.
          if (failure.cause instanceof GenerationUsageLimitError) return;
          logger.warn("Could not review the agent's memories.", { error: failure.cause });
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          if (this.#running?.key === conversation.key) this.#running = null;
          return this.#startWaiting();
        }),
      ),
      Effect.forkIn(this.#scope),
    );
    this.#running = { key: conversation.key, agentId: conversation.agentId, fiber };
  }).bind(this);

  /**
   * Starts the first review that waits. A clear's review that waits reads the chat after the clear
   * when new turns came first: it usually starts within seconds, before the next turn.
   */
  readonly #startWaiting = Effect.fn("MemoryReview.startWaiting")(function* (
    this: MemoryReview,
  ): Effect.fn.Return<void> {
    if (this.#running) return;
    for (const conversation of this.#conversations.values()) {
      if (!conversation.waiting) continue;
      yield* this.#start(conversation);
      return;
    }
    for (const conversation of this.#conversations.values()) {
      if (!conversation.failedTurn) continue;
      yield* this.#startReflection(conversation);
      return;
    }
  }).bind(this);

  readonly #review = Effect.fn("MemoryReview.review")(
    function* (this: MemoryReview, conversation: ReviewedConversation) {
      const options = this.#options;
      const { agentId, threadId } = conversation;
      const messages = yield* Effect.try(() => options.chat(agentId, threadId));
      // The count starts again also when the review fails, so a failing model is not asked each turn.
      const before = { turns: conversation.turns, cursor: conversation.cursor };
      conversation.turns = 0;
      const excerpt = reviewExcerpt(messages, conversation.cursor);
      this.#moveCursor(conversation, messages);
      if (!excerpt.some((message) => message.author === "user")) return;
      const agent = options.listAgents().find((candidate) => candidate.id === agentId);
      if (!agent) return;
      const model = backgroundModel(agent, yield* options.models(agent));
      if (!model || options.stopping()) return;
      if (!options.profileClients.hasSpare()) {
        // A user turn took the spare client while the model list loaded: wait, and read these turns then.
        conversation.turns += before.turns;
        conversation.cursor = before.cursor;
        conversation.waiting = true;
        return;
      }
      const base = yield* Effect.try(() => options.memories.reviewBase(agentId));
      const redacted = redactedBase(base, options.redact);
      const prompt = memoryReviewPrompt(
        agent,
        redacted.base,
        excerpt.map((message) => ({ ...message, text: options.redact(message.text) })),
      );
      const result = yield* this.#answer(agent, model, prompt);
      const operations = result.operations.filter(
        (operation) => operation.type === "add" || !redacted.hidden.has(operation.memoryId),
      );
      if (operations.length === 0 || options.stopping()) return;
      if (!options.listAgents().some((candidate) => candidate.id === agentId)) return;
      const turnId = `memory-review-${randomUUID()}`;
      const source = provenance(
        "review",
        conversation.threadId ?? agent.threadId,
        lastTurnId(excerpt) ?? lastTurnId(messages),
      );
      const changes = yield* Effect.try(() => options.memories.applyReview(agentId, base, operations, turnId, source));
      const line = memoryChangesMessage(turnId, changes, options.redact);
      if (!line) return;
      if (options.turnActive(agentId, threadId)) conversation.heldLine = line;
      else yield* Effect.try(() => options.appendSystemMessage(agentId, threadId, line));
    },
    Effect.mapError((failure) => new MemoryReviewFailed({ cause: failure })),
  ).bind(this);

  /**
   * A turn of the agent's chat or side thread ended failed. Its reflection waits for a free profile
   * client, and reads the failed turn that the chat holds now. Other turns end here.
   */
  readonly #noteFailedTurn = Effect.fn("MemoryReview.noteFailedTurn")(function* (
    this: MemoryReview,
    conversation: ReviewedConversation,
  ) {
    const messages = yield* Effect.try(() => this.#options.chat(conversation.agentId, conversation.threadId)).pipe(
      Effect.orElseSucceed(() => []),
    );
    const turn = failedTurnOf(messages);
    if (!turn) return;
    const agent = this.#options.listAgents().find((candidate) => candidate.id === conversation.agentId);
    conversation.failedTurn = {
      source: provenance("reflection", conversation.threadId ?? agent?.threadId ?? null, turn.turnId),
      errorClass: turn.failed ? "tool_failed" : "turn_failed",
      toolSteps: turn.toolSteps,
    };
    yield* this.#startReflection(conversation);
  }).bind(this);

  /**
   * One lesson from a failed turn: a generation without tools reads the agent's memories and the turn's
   * error class and tool steps, redacted. The lesson is saved as a searchable memory, whatever the
   * model says about its inclusion, and it shows in the chat like a review's changes.
   */
  readonly #reflect = Effect.fn("MemoryReview.reflect")(
    function* (this: MemoryReview, conversation: ReviewedConversation) {
      const options = this.#options;
      const { agentId, threadId } = conversation;
      const failed = conversation.failedTurn;
      if (!failed) return;
      conversation.failedTurn = null;
      const agent = options.listAgents().find((candidate) => candidate.id === agentId);
      if (!agent) return;
      const model = backgroundModel(agent, yield* options.models(agent));
      if (!model || options.stopping()) return;
      if (!options.profileClients.hasSpare()) {
        // A user turn took the spare client while the model list loaded: the reflection waits for it.
        conversation.failedTurn ??= failed;
        return;
      }
      const base = yield* Effect.try(() => options.memories.reviewBase(agentId));
      const prompt = memoryReflectionPrompt(agent, redactedBase(base, options.redact).base, {
        errorClass: failed.errorClass,
        toolSteps: failed.toolSteps.map((step) => options.redact(step)),
      });
      const result = yield* this.#answer(agent, model, prompt);
      const lesson = result.operations.flatMap((operation) => (operation.type === "add" ? [operation] : []))[0];
      if (!lesson || options.stopping()) return;
      if (!options.listAgents().some((candidate) => candidate.id === agentId)) return;
      const operations = [
        { type: "add" as const, text: options.redact(lesson.text), inclusion: "searchable" as const },
      ];
      const turnId = `memory-review-${randomUUID()}`;
      const changes = yield* Effect.try(() =>
        options.memories.applyReview(agentId, base, operations, turnId, failed.source),
      );
      const line = memoryChangesMessage(turnId, changes, options.redact);
      if (!line) return;
      if (options.turnActive(agentId, threadId)) conversation.heldLine = line;
      else yield* Effect.try(() => options.appendSystemMessage(agentId, threadId, line));
    },
    Effect.mapError((failure) => new MemoryReviewFailed({ cause: failure })),
  ).bind(this);

  /** One generation without tools, answered as the JSON object of changes that the review decodes. */
  readonly #answer = Effect.fn("MemoryReview.answer")(function* (
    this: MemoryReview,
    agent: AgentSummary,
    model: AgentModelOption,
    prompt: string,
  ) {
    const options = this.#options;
    const client = yield* Effect.try(() => options.createProfileClient(agent));
    const answer = yield* options.profileClients.run(client, (cancelled) =>
      generateTextWithoutTools(
        client,
        model.id === agent.model ? { ...model, defaultReasoningEffort: agent.reasoningEffort } : model,
        prompt,
        cancelled,
        options.usageObserver(agent, model),
      ),
    );
    return yield* Effect.try(() => extractJsonObject(answer)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MemoryReviewResult)),
    );
  }).bind(this);

  #moveCursor(conversation: ReviewedConversation, messages: readonly ConversationMessage[]): void {
    const last = messages.at(-1);
    if (last) conversation.cursor = last.id;
  }

  #flush(conversation: ReviewedConversation): void {
    const line = conversation.heldLine;
    if (!line || this.#options.turnActive(conversation.agentId, conversation.threadId)) return;
    conversation.heldLine = null;
    try {
      this.#options.appendSystemMessage(conversation.agentId, conversation.threadId, line);
    } catch (error) {
      logger.warn("Could not show the memory review's changes.", { error });
    }
  }
}

function conversationKey(agentId: string, threadId: string | null): string {
  return threadId === null ? agentId : `${agentId}\u0000${threadId}`;
}

/**
 * The part of the chat that a review reads: after the last reviewed message and after the last clear
 * of the context. A clear that just happened is passed over, so its review reads the chat it ended.
 * After a restart the cursor is gone, and the review reads the latest messages.
 */
function reviewExcerpt(messages: readonly ConversationMessage[], cursor: string | null) {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || !isContextResetMarker(message)) break;
    end -= 1;
  }
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && (message.id === cursor || isContextResetMarker(message))) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start, end);
}

/** The turn-id prefix of the memory-changes lines of reviews, which name no turn of the chat. */
const MEMORY_REVIEW_TURN_PREFIX = "memory-review-";

/** The last turn of the chat that a review's own lines do not name. */
function lastTurnId(messages: readonly ConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = messages[index]?.turnId;
    if (turnId && !turnId.startsWith(MEMORY_REVIEW_TURN_PREFIX)) return turnId;
  }
  return undefined;
}

/**
 * The turn that the chat's last turn is, when one of its messages failed: its id, whether one of its
 * tool steps failed, and its tool steps as text. Null when the last turn did not fail.
 */
function failedTurnOf(
  messages: readonly ConversationMessage[],
): { turnId: string; failed: boolean; toolSteps: string[] } | null {
  const turnId = lastTurnId(messages);
  if (!turnId) return null;
  const turn = messages.filter((message) => message.turnId === turnId);
  if (!turn.some((message) => message.status === "failed")) return null;
  const steps = turn.flatMap((message) => message.trace?.steps ?? []).filter((step) => step.kind === "tool");
  return {
    turnId,
    failed: steps.some((step) => step.failed === true),
    toolSteps: steps.map(
      (step) =>
        `${(step.command ?? step.text ?? "tool").slice(0, 200)} (${step.endedAt === null ? "interrupted" : step.failed ? "failed" : "completed"})`,
    ),
  };
}

/**
 * The source that a memory records: the kind of change, the thread of the reviewed conversation and
 * the last turn of the chat it read. A source over the identifier bound keeps the thread only.
 * The `review:` and `reflection:` prefixes are temporary debt: the source kind has no column yet. Phase 4
 * adds `source_kind` (migration S1); move these values to it then, and add no other prefix.
 */
function provenance(kind: "review" | "reflection", threadId: string | null, turnId: string | undefined): string {
  const full = `${kind}:${threadId ?? ""}:${turnId ?? ""}`;
  return full.length <= INPUT_LIMITS.identifier ? full : `${kind}:${threadId ?? ""}`.slice(0, INPUT_LIMITS.identifier);
}

/**
 * The memories of a review with their texts redacted, and the ids of those whose text the redaction
 * changed. The model sees only the redacted text of these, so it must not write or forget them.
 */
function redactedBase(base: MemoryReviewBase, redact: (text: string) => string) {
  const memories = base.memories.map((entry) => ({
    ...entry,
    memory: { ...entry.memory, text: redact(entry.memory.text) },
  }));
  const hidden = new Set(
    memories
      .filter((entry, index) => entry.memory.text !== base.memories[index]?.memory.text)
      .map((entry) => entry.memory.id),
  );
  return { base: { ...base, memories }, hidden };
}
