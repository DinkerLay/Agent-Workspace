import type {
  AgentCardId,
  CardSessionSlotId,
  ConductorPlanningFenceId,
  HumanInterventionId,
  LogicalSessionId,
  RuntimeCommandId,
  SessionControlAuditId,
  SessionInboxItemId,
  SessionMessageId,
  SessionTurnId,
  TaskId,
  TaskRunId,
  WorkspaceFileObservationId,
  WorkspaceEffectIntentId,
} from "./ids";
import type { JsonObject } from "./json";
import type { InteractionChoiceId, InteractionId } from "./session-execution-runtime";

export const CONDUCTOR_ORCHESTRATION_TOOL_NAMES = Object.freeze([
  "invoke_agent",
  "send_to_session",
  "interrupt_session",
  "close_session",
] as const);

export type ConductorOrchestrationToolName = typeof CONDUCTOR_ORCHESTRATION_TOOL_NAMES[number];

export type SessionMessageReference =
  | Readonly<{ kind: "full_message"; sourceMessageId: SessionMessageId }>
  | Readonly<{ kind: "relay_block"; sourceMessageId: SessionMessageId; relayBlockId: string }>;

export type SendToSessionPayload = Readonly<{
  content?: string;
  messageRefs?: readonly SessionMessageReference[];
}>;

export type ConductorOrchestrationToolCall =
  | Readonly<{ name: "invoke_agent"; arguments: Readonly<{ agentCardId: AgentCardId }> }>
  | Readonly<{ name: "send_to_session"; arguments: Readonly<{ sessionId: LogicalSessionId; payload: SendToSessionPayload }> }>
  | Readonly<{ name: "interrupt_session"; arguments: Readonly<{ sessionId: LogicalSessionId }> }>
  | Readonly<{ name: "close_session"; arguments: Readonly<{ sessionId: LogicalSessionId }> }>;

export type ConductorOrchestrationToolResult =
  | Readonly<{ sessionId: LogicalSessionId }>
  | Readonly<{ status: "accepted" | "closed" }>
  | Readonly<{ status: "rejected"; reason: string }>;

export type OrchestrationCommandScope = Readonly<{
  taskId: TaskId;
  runId: TaskRunId;
  expectedRevision: number;
  conductorSessionId: LogicalSessionId;
  conductorSessionTurnId: SessionTurnId;
  commandId: RuntimeCommandId;
  idempotencyKey: string;
}>;

export type InvokeAgentSessionCommand = OrchestrationCommandScope & Readonly<{
  type: "orchestration.invoke_agent";
  agentCardId: AgentCardId;
}>;

export type SendToSessionCommand = OrchestrationCommandScope & Readonly<{
  type: "orchestration.send_to_session";
  sessionId: LogicalSessionId;
  payload: SendToSessionPayload;
}>;

export type InterruptSessionCommand = OrchestrationCommandScope & Readonly<{
  type: "orchestration.interrupt_session";
  sessionId: LogicalSessionId;
}>;

export type CloseSessionCommand = OrchestrationCommandScope & Readonly<{
  type: "orchestration.close_session";
  sessionId: LogicalSessionId;
}>;

export type SessionIdOrchestrationCommand =
  | InvokeAgentSessionCommand
  | SendToSessionCommand
  | InterruptSessionCommand
  | CloseSessionCommand;

export type CardSessionLifecycle = "current" | "closed" | "faulted";

export interface CardSessionSlotRecord {
  readonly cardSessionSlotId: CardSessionSlotId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly agentCardId: AgentCardId;
  readonly currentSessionId?: LogicalSessionId;
  readonly latestGeneration: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CardSessionGenerationRecord {
  readonly sessionId: LogicalSessionId;
  readonly cardSessionSlotId: CardSessionSlotId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly agentCardId: AgentCardId;
  readonly executionProfileId: string;
  readonly generation: number;
  readonly lifecycle: CardSessionLifecycle;
  readonly createdAt: string;
  readonly closedAt?: string;
}

export interface ConductorPlanningFenceRecord {
  readonly planningFenceId: ConductorPlanningFenceId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly sourceCommandId: RuntimeCommandId;
  readonly previousConductorSessionTurnId?: SessionTurnId;
  readonly currentConductorSessionTurnId?: SessionTurnId;
  readonly createdAt: string;
}

export type SessionControlKind = "conductor_interrupt" | "human_interrupt" | "task_stop" | "close";
export type SessionControlState = "requested" | "accepted" | "confirmed" | "unknown" | "rejected" | "closed";

export interface SessionControlAuditRecord {
  readonly sessionControlAuditId: SessionControlAuditId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly sessionId: LogicalSessionId;
  readonly commandId: RuntimeCommandId;
  readonly idempotencyKey: string;
  readonly kind: SessionControlKind;
  readonly state: SessionControlState;
  readonly affectedInboxItemIds: readonly SessionInboxItemId[];
  readonly requestedAt: string;
  readonly settledAt?: string;
  readonly reason?: string;
}

/**
 * Coordinator-owned durable projection of one Provider Attention request.
 *
 * The original Input/Turn and Binding revision are immutable provenance.  A
 * response continues that Turn; it never creates a parallel routing owner or
 * a second SessionTurn.
 */
export type SessionIdAttentionStatus =
  | "requested"
  | "response_staged"
  | "effect_accepted"
  | "resolved"
  | "stale"
  | "unknown";

export interface SessionIdAttentionRecord {
  readonly attentionId: string;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly sessionId: LogicalSessionId;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly sessionTurnId: SessionTurnId;
  readonly inputSubmissionId: string;
  readonly nativeRequestId: string;
  readonly sourceProviderFactId: string;
  readonly request: JsonObject;
  readonly response?: JsonObject;
  readonly responseCommandId?: RuntimeCommandId;
  readonly humanInterventionId?: string;
  readonly conductorMirrorMessageId?: SessionMessageId;
  readonly responseOutboxId?: string;
  readonly status: SessionIdAttentionStatus;
  readonly revision: number;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
}

/** Renderer command; Host supplies the authenticated user separately. */
export type SessionIdRespondAttentionCommand = Readonly<{
  type: "session.respond_attention";
  commandId: RuntimeCommandId;
  taskId: TaskId;
  runId: TaskRunId;
  expectedRevision: number;
  targetLogicalSessionId: LogicalSessionId;
  attentionId: string;
  response: string;
  issuedAt?: string;
}>;

export type SessionIdRespondAttentionResult = Readonly<{
  attentionId: string;
  status: "response_staged";
}>;

/**
 * Authenticated human response to one SR-owned, ACP-safe interaction choice.
 *
 * The Renderer never supplies Provider text, a raw ACP option/request id, an
 * Attempt id or a Binding id. The Runtime resolves all of those correlations
 * from the current durable interaction and injects the authenticated user.
 */
export type SessionIdRespondInteractionCommand = Readonly<{
  type: "session.respond_interaction";
  commandId: RuntimeCommandId;
  taskId: TaskId;
  runId: TaskRunId;
  expectedRevision: number;
  targetLogicalSessionId: LogicalSessionId;
  interactionId: InteractionId;
  expectedInteractionRevision: number;
  choiceId: InteractionChoiceId;
}>;

export type SessionIdRespondInteractionResult = Readonly<{
  interactionResponse: Readonly<{
    humanInterventionId: HumanInterventionId;
    state: "accepted";
    targetLogicalSessionId: LogicalSessionId;
    interactionId: InteractionId;
    choiceId: InteractionChoiceId;
    /** Safe label resolved from the persisted interaction; never caller text. */
    label: string;
  }>;
}>;

/** Authenticated Renderer intent; Host supplies and verifies the user identity. */
export type SessionIdHumanMessageTarget =
  | Readonly<{
      targetAgentCardId: AgentCardId;
      targetLogicalSessionId?: never;
    }>
  | Readonly<{
      targetLogicalSessionId: LogicalSessionId;
      targetAgentCardId?: never;
    }>;

type SessionIdHumanMessageCommandScope = Readonly<{
  commandId: RuntimeCommandId;
  taskId: TaskId;
  runId: TaskRunId;
  expectedRevision: number;
  humanInterventionId: HumanInterventionId;
  idempotencyKey: string;
  issuedAt?: string;
}>;

export type SessionIdSendHumanMessageCommand = SessionIdHumanMessageCommandScope
  & SessionIdHumanMessageTarget
  & Readonly<{
    type: "session.send_human_message";
    content: string;
  }>;

export type SessionIdAbandonHumanMessageCommand = SessionIdHumanMessageCommandScope & Readonly<{
  type: "session.abandon_human_message";
}>;

export type SessionIdHumanMessageCommand =
  | SessionIdSendHumanMessageCommand
  | SessionIdAbandonHumanMessageCommand;

export type SessionIdHumanMessageResult = Readonly<{
  humanInterventionId: HumanInterventionId;
  state: "sent" | "held" | "suppressed" | "abandoned";
  targetLogicalSessionId: LogicalSessionId;
  materializedGeneration?: number;
}>;

/** Typed payload persisted before ProviderPort.respondAttention is called. */
export interface SessionIdRespondAttentionEffectPayload extends JsonObject {
  readonly attentionId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly nativeRequestId: string;
  readonly inputSubmissionId: string;
  readonly sessionTurnId: string;
  readonly response: JsonObject;
}

export interface SessionLaneItemRecord {
  readonly inboxItemId: SessionInboxItemId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly sessionId: LogicalSessionId;
  readonly renderedMessageId: SessionMessageId;
  readonly sequence: number;
  readonly priority: "notice" | "human" | "ordinary";
  readonly state: "pending" | "held_by_human_intervention" | "leased" | "handed" | "handled" | "ambiguous" | "suppressed";
  readonly causalPredecessorInboxItemId?: SessionInboxItemId;
  readonly humanInterventionId?: string;
  readonly forwardId?: string;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageReferenceSnapshot {
  readonly ordinal: number;
  readonly kind: SessionMessageReference["kind"];
  readonly sourceMessageId: SessionMessageId;
  readonly relayBlockId?: string;
  readonly contentDigest: string;
}

export interface SessionIdMessageForwardRecord {
  readonly forwardId: string;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly commandId: RuntimeCommandId;
  readonly idempotencyKey: string;
  readonly decidedBySessionTurnId: SessionTurnId;
  readonly targetSessionId: LogicalSessionId;
  readonly newContentDigest?: string;
  readonly orderedReferenceSnapshots: readonly MessageReferenceSnapshot[];
  readonly renderedMessageId: SessionMessageId;
  readonly createdAt: string;
}

export type CanonicalContentNode =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "relay";
      relayBlockId: string;
      suggestedTargetAgentCardIds: readonly AgentCardId[];
      suggestedAudience?: "one" | "publish";
      topic?: string;
      format: "text/markdown" | "application/json";
      content: string;
    }>;

export type CanonicalContent = readonly CanonicalContentNode[];

export type FinalForConductor = Readonly<{
  messageId: SessionMessageId;
  sourceSessionId: LogicalSessionId;
  content: CanonicalContent;
}>;

export type HumanInterventionForConductor = Readonly<{
  messageId: SessionMessageId;
  sessionId: LogicalSessionId;
  content: string;
}>;

export type SessionNoticeForConductor = Readonly<{
  messageId: SessionMessageId;
  sessionId: LogicalSessionId;
  content: string;
}>;

export interface WorkspaceFileObservationRecord {
  readonly workspaceFileObservationId: WorkspaceFileObservationId;
  readonly taskId: TaskId;
  readonly runId?: TaskRunId;
  readonly workspaceRelativePath: string;
  readonly contentDigest?: string;
  readonly byteLength?: number;
  readonly state: "available" | "missing" | "changed" | "too_large" | "unsupported";
  readonly source: "verified_tool" | "unverified";
  readonly observedAt: string;
}

export interface WorkspaceEffectIntentRecord {
  readonly workspaceEffectIntentId: WorkspaceEffectIntentId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly publisherSessionId: LogicalSessionId;
  readonly publisherSessionTurnId: SessionTurnId;
  readonly providerCallId: string;
  readonly idempotencyKey: string;
  readonly workspaceRelativePath: string;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly state: "pending" | "applied" | "unknown" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly observationId?: WorkspaceFileObservationId;
  readonly reason?: string;
}

export type FileStateAnchor = Readonly<{
  workspaceRelativePath: string;
  observedDigest: string;
  label?: string;
}>;

export const CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS = Object.freeze([
  tool("invoke_agent", "Create a new current Session generation for one Agent Card.", {
    type: "object", additionalProperties: false, required: ["agentCardId"], properties: { agentCardId: { type: "string" } },
  }),
  tool("send_to_session", "Send new content and/or selected Message references to one current Session.", {
    type: "object", additionalProperties: false, required: ["sessionId", "payload"], properties: {
      sessionId: { type: "string" },
      payload: {
        type: "object",
        additionalProperties: false,
        anyOf: [{ required: ["content"] }, { required: ["messageRefs"] }],
        properties: {
          content: { type: "string", minLength: 1 },
          messageRefs: {
            type: "array",
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "sourceMessageId"],
                  properties: {
                    kind: { const: "full_message" },
                    sourceMessageId: { type: "string" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "sourceMessageId", "relayBlockId"],
                  properties: {
                    kind: { const: "relay_block" },
                    sourceMessageId: { type: "string" },
                    relayBlockId: { type: "string" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  }),
  tool("interrupt_session", "Request interruption of the active Turn previously sent by this Conductor.", {
    type: "object", additionalProperties: false, required: ["sessionId"], properties: { sessionId: { type: "string" } },
  }),
  tool("close_session", "Safely close the current Session generation.", {
    type: "object", additionalProperties: false, required: ["sessionId"], properties: { sessionId: { type: "string" } },
  }),
] as const);

export function parseConductorOrchestrationToolCall(value: unknown): ConductorOrchestrationToolCall {
  const call = exactRecord(value, ["name", "arguments"]);
  const name = text(call.name, "orchestration_tool_name_invalid") as ConductorOrchestrationToolName;
  if (!CONDUCTOR_ORCHESTRATION_TOOL_NAMES.includes(name)) throw new Error("orchestration_tool_name_invalid");
  const args = record(call.arguments, "orchestration_tool_arguments_invalid");
  if (name === "invoke_agent") {
    assertExactKeys(args, ["agentCardId"]);
    return freeze({ name, arguments: freeze({ agentCardId: text(args.agentCardId, "orchestration_agent_card_id_required") }) });
  }
  if (name === "send_to_session") {
    assertExactKeys(args, ["sessionId", "payload"]);
    const payloadValue = record(args.payload, "orchestration_send_payload_invalid");
    assertExactKeys(payloadValue, ["content", "messageRefs"]);
    const content = optionalText(payloadValue.content, "orchestration_send_content_invalid");
    const messageRefs = payloadValue.messageRefs === undefined ? undefined : parseMessageRefs(payloadValue.messageRefs);
    if (!content && (!messageRefs || messageRefs.length === 0)) throw new Error("orchestration_send_payload_empty");
    return freeze({
      name,
      arguments: freeze({
        sessionId: text(args.sessionId, "orchestration_session_id_required"),
        payload: freeze({ ...(content ? { content } : {}), ...(messageRefs ? { messageRefs } : {}) }),
      }),
    });
  }
  assertExactKeys(args, ["sessionId"]);
  return freeze({ name, arguments: freeze({ sessionId: text(args.sessionId, "orchestration_session_id_required") }) }) as ConductorOrchestrationToolCall;
}

function parseMessageRefs(value: unknown): readonly SessionMessageReference[] {
  if (!Array.isArray(value)) throw new Error("orchestration_message_refs_invalid");
  return Object.freeze(value.map<SessionMessageReference>((entry) => {
    const ref = record(entry, "orchestration_message_ref_invalid");
    const kind = text(ref.kind, "orchestration_message_ref_kind_invalid");
    if (kind === "full_message") {
      assertExactKeys(ref, ["kind", "sourceMessageId"]);
      return freeze<SessionMessageReference>({
        kind: "full_message",
        sourceMessageId: text(ref.sourceMessageId, "orchestration_source_message_id_required"),
      });
    }
    if (kind === "relay_block") {
      assertExactKeys(ref, ["kind", "sourceMessageId", "relayBlockId"]);
      return freeze<SessionMessageReference>({
        kind: "relay_block",
        sourceMessageId: text(ref.sourceMessageId, "orchestration_source_message_id_required"),
        relayBlockId: text(ref.relayBlockId, "orchestration_relay_block_id_required"),
      });
    }
    throw new Error("orchestration_message_ref_kind_invalid");
  }));
}

function tool(name: ConductorOrchestrationToolName, description: string, inputSchema: Readonly<Record<string, unknown>>) {
  return Object.freeze({ name, description, inputSchema: Object.freeze(inputSchema) });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value, "orchestration_tool_call_invalid");
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error("orchestration_tool_call_invalid");
  }
  return result;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("orchestration_tool_arguments_invalid");
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function optionalText(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, code);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
