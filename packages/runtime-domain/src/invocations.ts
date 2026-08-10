import type {
  InvocationRecord,
  ProviderEffect,
  ProviderFact,
  SessionMessageRecord,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

export interface CreateInvocationInput {
  readonly invocationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly replyToLogicalSessionId: string;
  readonly targetLogicalSessionId: string;
  readonly targetAgentCardId: string;
  readonly bindingId: string;
  /** The immutable body that will eventually be delivered through an Inbox. */
  readonly assignmentMessage: SessionMessageRecord;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requestedArtifacts?: readonly string[];
  readonly priority?: "low" | "normal" | "high";
  readonly now: string;
}

export function createInvocation(input: CreateInvocationInput): InvocationRecord {
  invariant(input.invocationId.startsWith("invocation_"), "invocation_id_invalid");
  invariant(input.taskId.startsWith("task_"), "invocation_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "invocation_run_id_invalid");
  invariant(input.replyToLogicalSessionId.startsWith("logical_session_"), "invocation_reply_session_invalid");
  invariant(input.targetLogicalSessionId.startsWith("logical_session_"), "invocation_target_session_invalid");
  invariant(input.bindingId.startsWith("binding_"), "invocation_binding_id_invalid");
  invariant(input.assignmentMessage.kind === "agent_assignment", "invocation_assignment_message_kind_invalid");
  invariant(input.assignmentMessage.taskId === input.taskId && input.assignmentMessage.runId === input.runId, "invocation_assignment_scope_mismatch");
  invariant(input.assignmentMessage.invocationId === input.invocationId, "invocation_assignment_message_mismatch");
  invariant(Boolean(input.instruction.trim()), "invocation_instruction_required");
  invariant(input.acceptanceCriteria.length > 0 && input.acceptanceCriteria.every((criterion) => Boolean(criterion.trim())), "invocation_acceptance_criteria_required");
  return {
    invocationId: input.invocationId,
    taskId: input.taskId,
    runId: input.runId,
    replyToLogicalSessionId: input.replyToLogicalSessionId,
    targetLogicalSessionId: input.targetLogicalSessionId,
    targetAgentCardId: input.targetAgentCardId,
    bindingId: input.bindingId,
    assignmentMessageId: input.assignmentMessage.messageId,
    instruction: input.instruction,
    acceptanceCriteria: [...input.acceptanceCriteria],
    requestedArtifacts: [...(input.requestedArtifacts ?? [])],
    ...(input.priority ? { priority: input.priority } : {}),
    status: "staged",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Effect acceptance only records transport handoff; a Provider fact starts a turn. */
export function recordInvocationDeliveryEffect(
  invocation: InvocationRecord,
  effect: ProviderEffect,
  now: string,
): InvocationRecord {
  invariant(effect.kind === "submit_delivery", "invocation_effect_kind_invalid");
  invariant(effect.bindingId === invocation.bindingId, "invocation_effect_binding_mismatch");
  invariant(effect.invocationId === invocation.invocationId, "invocation_effect_id_mismatch");
  if (effect.acceptance === "accepted") return { ...invocation, status: "effect_accepted", updatedAt: now };
  if (effect.acceptance === "rejected") return { ...invocation, status: "failed", updatedAt: now };
  // An unknown transport outcome is represented by its Inbox/Input as
  // ambiguous.  Do not invent a Provider lifecycle conclusion here.
  return invocation;
}

export function applyProviderFactToInvocation(invocation: InvocationRecord, fact: ProviderFact, now: string): InvocationRecord {
  if (fact.bindingId !== invocation.bindingId || fact.correlation.invocationId !== invocation.invocationId) return invocation;
  if (invocation.finalMessageId) return invocation;
  if (fact.kind === "turn_started") return { ...invocation, status: "running", updatedAt: now };
  if (fact.kind === "assistant_final" || fact.kind === "turn_completed") {
    if (invocation.status === "cancelled") return invocation;
    return invocation.finalMessageId
      ? { ...invocation, status: "returned", updatedAt: now }
      : { ...invocation, status: "awaiting_final", updatedAt: now };
  }
  if (fact.kind === "turn_failed") return { ...invocation, status: "failed", updatedAt: now };
  if (fact.kind === "interrupt_confirmed") {
    return invocation.status === "returned" ? invocation : { ...invocation, status: "cancelled", updatedAt: now };
  }
  if (fact.kind === "transport_unknown" && invocation.status === "cancel_requested") {
    return { ...invocation, status: "cancellation_unknown", updatedAt: now };
  }
  return invocation;
}

/** The sole transition that connects a child Invocation to an actual final Message. */
export function recordInvocationFinalMessage(
  invocation: InvocationRecord,
  finalMessage: SessionMessageRecord,
  now: string,
): InvocationRecord {
  invariant(finalMessage.kind === "agent_final", "invocation_final_message_kind_invalid");
  invariant(finalMessage.invocationId === invocation.invocationId, "invocation_final_message_mismatch");
  invariant(finalMessage.taskId === invocation.taskId && finalMessage.runId === invocation.runId, "invocation_final_message_scope_mismatch");
  invariant(!invocation.finalMessageId || invocation.finalMessageId === finalMessage.messageId, "invocation_final_message_already_recorded");
  invariant(!["failed", "cancellation_unknown"].includes(invocation.status), "invocation_not_returnable");
  return {
    ...invocation,
    finalMessageId: finalMessage.messageId,
    status: invocation.status === "cancelled" ? "cancelled" : "returned",
    updatedAt: now,
  };
}

export function requestInvocationCancellation(invocation: InvocationRecord, now: string): InvocationRecord {
  invariant(["staged", "effect_accepted", "running", "awaiting_final"].includes(invocation.status), "invocation_not_cancellable");
  return { ...invocation, status: "cancel_requested", updatedAt: now };
}

/**
 * Provider facts are evidence only.  A complete worker return exists only if
 * exactly one nonblank assistant_final and at least one terminal completion
 * are correlated to this Invocation. Arrival order is intentionally irrelevant.
 */
export function resolveInvocationFinalContent(
  invocation: InvocationRecord,
  facts: readonly ProviderFact[],
): string | undefined {
  const correlated = facts.filter((fact) => fact.bindingId === invocation.bindingId && fact.correlation.invocationId === invocation.invocationId);
  if (!correlated.some((fact) => fact.kind === "turn_completed")) return undefined;
  const finalContents = correlated
    .filter((fact) => fact.kind === "assistant_final")
    .map((fact) => typeof fact.payload.content === "string" ? fact.payload.content : undefined)
    .filter((content): content is string => Boolean(content?.trim()));
  if (finalContents.length !== 1) return undefined;
  return finalContents[0];
}

export function hasInvocationTerminalFailure(invocation: InvocationRecord, facts: readonly ProviderFact[]): boolean {
  return facts.some((fact) => fact.bindingId === invocation.bindingId
    && fact.correlation.invocationId === invocation.invocationId
    && (fact.kind === "turn_failed" || fact.kind === "interrupt_confirmed" || fact.kind === "transport_unknown"));
}
