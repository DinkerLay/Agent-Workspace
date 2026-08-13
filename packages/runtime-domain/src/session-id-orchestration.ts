import {
  hashDefinition,
  type CanonicalContent,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type FinalForConductor,
  type ExecutionProfileId,
  type HumanInterventionForConductor,
  type JsonValue,
  type MessageReferenceSnapshot,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type SessionMessageReference,
  type SessionNoticeForConductor,
  type SendToSessionPayload,
} from "../../runtime-contracts/src";
import { materializeCardSessionGeneration, retireCardSessionGeneration } from "./card-session-slots";
import { invariant } from "./errors";
import { extractCanonicalRelayBlocks } from "./canonical-session-content";
import { appendSessionLaneItem, assertSessionLaneCanClose, suppressPendingOrdinaryLaneItems } from "./session-lanes";
import { createSessionControlAudit } from "./session-controls";

export type SessionIdOrchestrationKernelOptions = Readonly<{
  now: () => string;
  createSessionId: (input: Readonly<{ runId: string; agentCardId: string; generation: number }>) => string;
  executionProfileIdForAgentCard: (input: Readonly<{
    runId: string;
    agentCardId: string;
  }>) => ExecutionProfileId;
  taskIdForRun?: (runId: string) => string;
  resolveMessageReference?: (reference: SessionMessageReference, runId: string) => Readonly<{
    content: string;
    contentDigest: string;
  }>;
}>;

type InvokeInput = Readonly<{ runId: string; agentCardId: string; idempotencyKey: string }>;
type SendInput = Readonly<{
  runId: string;
  sessionId: string;
  idempotencyKey: string;
  payload: SendToSessionPayload;
  commandId?: string;
  decidedBySessionTurnId?: string;
}>;
type CloseInput = Readonly<{ runId: string; sessionId: string; idempotencyKey: string; commandId?: string }>;

type KernelMessage = Readonly<{
  messageId: string;
  runId: string;
  sessionId: string;
  content: string;
  contentDigest: string;
  createdAt: string;
}>;

type KernelIdempotency = Readonly<{ fingerprint: string; result: unknown }>;

export function createSessionIdOrchestrationKernel(options: SessionIdOrchestrationKernelOptions) {
  const slots = new Map<string, CardSessionSlotRecord>();
  const generations = new Map<string, CardSessionGenerationRecord>();
  const messages: KernelMessage[] = [];
  let inboxItems: SessionLaneItemRecord[] = [];
  const forwards: SessionIdMessageForwardRecord[] = [];
  const bindings: readonly unknown[] = Object.freeze([]);
  const inputSubmissions: readonly unknown[] = Object.freeze([]);
  const turns: readonly unknown[] = Object.freeze([]);
  const controls: ReturnType<typeof createSessionControlAudit>[] = [];
  const idempotency = new Map<string, KernelIdempotency>();
  let internalSequence = 0;

  const nextId = (prefix: string): string => `${prefix}_kernel${String(++internalSequence).padStart(6, "0")}`;
  const taskIdForRun = options.taskIdForRun ?? ((runId: string) => `task_${runId.replace(/^run_/, "")}`);

  function invokeAgent(input: InvokeInput): Readonly<{ sessionId: string }> {
    assertRunId(input.runId);
    invariant(input.agentCardId.startsWith("agent_card_"), "orchestration_agent_card_id_invalid");
    const executionProfileId = options.executionProfileIdForAgentCard({
      runId: input.runId,
      agentCardId: input.agentCardId,
    });
    const fingerprint = fingerprintFor("invoke", {
      runId: input.runId,
      agentCardId: input.agentCardId,
      executionProfileId,
    });
    const replay = idempotentReplay<Readonly<{ sessionId: string }>>(input.idempotencyKey, fingerprint);
    if (replay) return replay;
    const key = slotKey(input.runId, input.agentCardId);
    const previous = slots.get(key);
    invariant(!previous?.currentSessionId, "card_session_slot_current_exists");
    const generation = (previous?.latestGeneration ?? 0) + 1;
    const sessionId = options.createSessionId({ runId: input.runId, agentCardId: input.agentCardId, generation });
    const materialized = materializeCardSessionGeneration({
      slot: previous,
      taskId: taskIdForRun(input.runId),
      runId: input.runId,
      agentCardId: input.agentCardId,
      executionProfileId,
      cardSessionSlotId: previous?.cardSessionSlotId ?? nextId("card_session_slot"),
      sessionId,
      now: options.now(),
    });
    slots.set(key, materialized.slot);
    generations.set(sessionId, materialized.generation);
    const result = Object.freeze({ sessionId });
    remember(input.idempotencyKey, fingerprint, result);
    return result;
  }

  function sendToSession(input: SendInput): Readonly<{ status: "accepted" }> {
    assertRunId(input.runId);
    const fingerprint = fingerprintFor("send", {
      runId: input.runId,
      sessionId: input.sessionId,
      payload: payloadJson(input.payload),
    });
    const replay = idempotentReplay<Readonly<{ status: "accepted" }>>(input.idempotencyKey, fingerprint);
    if (replay) return replay;
    const generation = requireCurrentGeneration(input.runId, input.sessionId);
    const resolved = renderSendPayload(input.payload, input.runId, options.resolveMessageReference);
    const now = options.now();
    const messageId = nextId("message");
    const inboxItemId = nextId("inbox");
    const forwardId = nextId("message_forward");
    const commandId = input.commandId ?? nextId("command");
    const decidedBySessionTurnId = input.decidedBySessionTurnId ?? nextId("session_turn");
    const message: KernelMessage = Object.freeze({
      messageId,
      runId: input.runId,
      sessionId: input.sessionId,
      content: resolved.renderedContent,
      contentDigest: hashDefinition(resolved.renderedContent),
      createdAt: now,
    });
    const forward: SessionIdMessageForwardRecord = Object.freeze({
      forwardId,
      taskId: generation.taskId,
      runId: input.runId,
      commandId,
      idempotencyKey: input.idempotencyKey,
      decidedBySessionTurnId,
      targetSessionId: input.sessionId,
      ...(input.payload.content ? { newContentDigest: hashDefinition(input.payload.content) } : {}),
      orderedReferenceSnapshots: resolved.referenceSnapshots,
      renderedMessageId: messageId,
      createdAt: now,
    });
    const inbox = appendSessionLaneItem({
      items: inboxItems,
      item: {
        inboxItemId,
        taskId: generation.taskId,
        runId: input.runId,
        sessionId: input.sessionId,
        renderedMessageId: messageId,
        priority: "ordinary",
        forwardId,
      },
      now,
    });
    // These three pushes model one owner transaction. The Store implementation
    // persists the same immutable values atomically before any Provider effect.
    forwards.push(forward);
    messages.push(message);
    inboxItems.push(inbox);
    const result = Object.freeze({ status: "accepted" as const });
    remember(input.idempotencyKey, fingerprint, result);
    return result;
  }

  function closeSession(input: CloseInput): Readonly<{ status: "closed" }> {
    assertRunId(input.runId);
    const fingerprint = fingerprintFor("close", { runId: input.runId, sessionId: input.sessionId });
    const replay = idempotentReplay<Readonly<{ status: "closed" }>>(input.idempotencyKey, fingerprint);
    if (replay) return replay;
    const generation = requireCurrentGeneration(input.runId, input.sessionId);
    assertSessionLaneCanClose(inboxItems, input.sessionId);
    const now = options.now();
    const suppressed = suppressPendingOrdinaryLaneItems({
      items: inboxItems,
      sessionId: input.sessionId,
      now,
      reason: "session_closed_before_handoff",
    });
    inboxItems = [...suppressed.items];
    const slot = requireSlotForGeneration(generation);
    const retired = retireCardSessionGeneration({ slot, generation, now });
    slots.set(slotKey(input.runId, generation.agentCardId), retired.slot);
    generations.set(input.sessionId, retired.generation);
    controls.push(createSessionControlAudit({
      sessionControlAuditId: nextId("session_control"),
      taskId: generation.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      commandId: input.commandId ?? nextId("command"),
      idempotencyKey: input.idempotencyKey,
      kind: "close",
      affectedInboxItemIds: suppressed.affectedInboxItemIds,
      now,
    }));
    const result = Object.freeze({ status: "closed" as const });
    remember(input.idempotencyKey, fingerprint, result);
    return result;
  }

  function snapshot() {
    return Object.freeze({
      slots: Object.freeze([...slots.values()].map((slot) => Object.freeze({
        agentCardId: slot.agentCardId,
        ...(slot.currentSessionId ? { currentSessionId: slot.currentSessionId } : {}),
        generation: slot.latestGeneration,
        revision: slot.revision,
      }))),
      generations: Object.freeze([...generations.values()].map((generation) => Object.freeze({ ...generation }))),
      messages: Object.freeze(messages.map((message) => Object.freeze({ ...message }))),
      forwards: Object.freeze(forwards.map((forward) => Object.freeze({ ...forward }))),
      bindings,
      inboxItems: Object.freeze(inboxItems.map((item) => Object.freeze({
        ...item,
        renderedContent: messages.find((message) => message.messageId === item.renderedMessageId)?.content,
      }))),
      inputSubmissions,
      turns,
      controls: Object.freeze(controls.map((control) => Object.freeze({ ...control }))),
    });
  }

  return Object.freeze({
    invokeAgent,
    sendToSession,
    closeSession,
    snapshot,
    canonicalizeFinal,
    projectFinalForConductor,
    projectHumanInterventionForConductor,
    projectSessionNoticeForConductor,
  });

  function requireCurrentGeneration(runId: string, sessionId: string): CardSessionGenerationRecord {
    const generation = generations.get(sessionId);
    invariant(Boolean(generation), "orchestration_session_unknown");
    invariant(generation?.runId === runId, "orchestration_session_scope_mismatch");
    invariant(generation?.lifecycle === "current", "orchestration_session_not_current");
    const slot = slots.get(slotKey(runId, generation!.agentCardId));
    invariant(slot?.currentSessionId === sessionId, "orchestration_session_not_current");
    return generation!;
  }

  function requireSlotForGeneration(generation: CardSessionGenerationRecord): CardSessionSlotRecord {
    const slot = slots.get(slotKey(generation.runId, generation.agentCardId));
    invariant(Boolean(slot), "card_session_slot_missing");
    return slot!;
  }

  function idempotentReplay<T>(key: string, fingerprint: string): T | undefined {
    invariant(Boolean(key.trim()), "orchestration_idempotency_key_required");
    const prior = idempotency.get(key);
    if (!prior) return undefined;
    invariant(prior.fingerprint === fingerprint, "orchestration_idempotency_payload_conflict");
    return prior.result as T;
  }

  function remember(key: string, fingerprint: string, result: unknown): void {
    idempotency.set(key, Object.freeze({ fingerprint, result }));
  }
}

export function projectFinalForConductor(input: FinalForConductor & Record<string, unknown>): FinalForConductor {
  return Object.freeze({ messageId: input.messageId, sourceSessionId: input.sourceSessionId, content: input.content });
}

export function projectHumanInterventionForConductor(
  input: HumanInterventionForConductor & Record<string, unknown>,
): HumanInterventionForConductor {
  return Object.freeze({ messageId: input.messageId, sessionId: input.sessionId, content: input.content });
}

export function projectSessionNoticeForConductor(
  input: SessionNoticeForConductor & Record<string, unknown>,
): SessionNoticeForConductor {
  return Object.freeze({ messageId: input.messageId, sessionId: input.sessionId, content: input.content });
}

export function canonicalizeFinal(input: Readonly<{ messageId: string; content: string }>): CanonicalContent {
  const blocks = extractCanonicalRelayBlocks({
    messageId: input.messageId,
    content: input.content,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  if (blocks.length === 0) return Object.freeze([{ kind: "text", text: input.content }]);
  const content: Array<CanonicalContent[number]> = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.sourceRange.start > cursor) {
      content.push(Object.freeze({ kind: "text", text: input.content.slice(cursor, block.sourceRange.start) }));
    }
    content.push(Object.freeze({
      kind: "relay",
      relayBlockId: block.relayBlockId,
      suggestedTargetAgentCardIds: block.suggestedTargetAgentCardIds,
      ...(block.suggestedAudience ? { suggestedAudience: block.suggestedAudience } : {}),
      ...(block.topic ? { topic: block.topic } : {}),
      format: block.format,
      content: block.content,
    }));
    cursor = block.sourceRange.end;
  }
  if (cursor < input.content.length) content.push(Object.freeze({ kind: "text", text: input.content.slice(cursor) }));
  return Object.freeze(content);
}

function renderSendPayload(
  payload: SendToSessionPayload,
  runId: string,
  resolver?: SessionIdOrchestrationKernelOptions["resolveMessageReference"],
): Readonly<{ renderedContent: string; referenceSnapshots: readonly MessageReferenceSnapshot[] }> {
  const content = payload.content?.trim() ? payload.content : undefined;
  const references = payload.messageRefs ?? [];
  invariant(Boolean(content) || references.length > 0, "orchestration_send_payload_empty");
  invariant(new Set(references.map(referenceIdentity)).size === references.length, "orchestration_message_reference_duplicate");
  const rendered: string[] = content ? [content] : [];
  const snapshots = references.map((reference, ordinal): MessageReferenceSnapshot => {
    invariant(Boolean(resolver), "orchestration_message_reference_resolver_required");
    const resolved = resolver!(reference, runId);
    invariant(Boolean(resolved.content.trim()), "orchestration_message_reference_content_empty");
    rendered.push(reference.kind === "full_message"
      ? `[完整消息 ${reference.sourceMessageId}]\n${resolved.content}\n[完整消息结束 ${reference.sourceMessageId}]`
      : `[转递块 ${reference.relayBlockId}；来源 ${reference.sourceMessageId}]\n${resolved.content}\n[转递块结束 ${reference.relayBlockId}]`);
    return Object.freeze({
      ordinal,
      kind: reference.kind,
      sourceMessageId: reference.sourceMessageId,
      ...(reference.kind === "relay_block" ? { relayBlockId: reference.relayBlockId } : {}),
      contentDigest: resolved.contentDigest,
    });
  });
  return Object.freeze({ renderedContent: rendered.join("\n\n"), referenceSnapshots: Object.freeze(snapshots) });
}

function payloadJson(payload: SendToSessionPayload): JsonValue {
  return {
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.messageRefs === undefined ? {} : {
      messageRefs: payload.messageRefs.map((reference) => ({
        kind: reference.kind,
        sourceMessageId: reference.sourceMessageId,
        ...(reference.kind === "relay_block" ? { relayBlockId: reference.relayBlockId } : {}),
      })),
    }),
  };
}

function fingerprintFor(operation: string, payload: JsonValue): string {
  return hashDefinition({ operation, payload });
}

function referenceIdentity(reference: SessionMessageReference): string {
  return reference.kind === "full_message"
    ? `message:${reference.sourceMessageId}`
    : `relay:${reference.sourceMessageId}:${reference.relayBlockId}`;
}

function assertRunId(runId: string): void {
  invariant(runId.startsWith("run_"), "orchestration_run_id_invalid");
}

function slotKey(runId: string, agentCardId: string): string {
  return `${runId}\u0000${agentCardId}`;
}
