import type {
  ArtifactReference,
  AttentionRecord,
  HumanInterventionRecord,
  InputSubmissionRecord,
  InvocationRecord,
  MessageForwardRecord,
  ProviderFact,
  ProviderSessionBindingRecord,
  RelayBlockRecord,
  SessionInboxItemRecord,
  SessionMessageRecord,
  SessionTurnRecord,
  TaskRecord,
  TaskRunRecord,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { deriveTaskTimeline } from "./task-timeline.js";

const occurredAt = "2026-08-06T01:00:00.000Z";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task_timeline",
    architectureSnapshotId: "architecture_timeline",
    title: "Timeline task",
    goal: "Project only durable collaboration records.",
    status: "running",
    revision: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...overrides,
  };
}

const run: TaskRunRecord = {
  runId: "run_timeline",
  taskId: "task_timeline",
  conductorLogicalSessionId: "logical_session_conductor",
  status: "running",
  runNumber: 1,
  startedAt: "2026-08-06T01:01:00.000Z",
  revision: 1,
};

const binding: ProviderSessionBindingRecord = {
  bindingId: "binding_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  logicalSessionId: "logical_session_worker",
  executionProfileId: "profile_opencode",
  provider: "opencode",
  bindingRevision: 1,
  status: "active",
  recoverable: true,
  createdAt: occurredAt,
  updatedAt: occurredAt,
};

const message: SessionMessageRecord = {
  messageId: "message_assignment",
  taskId: "task_timeline",
  runId: "run_timeline",
  sourceLogicalSessionId: "logical_session_conductor",
  sourceSessionTurnId: "session_turn_conductor",
  invocationId: "invocation_timeline",
  kind: "agent_assignment",
  content: "Please produce a verified result.",
  contentDigest: "sha256:message",
  createdAt: "2026-08-06T01:02:00.000Z",
};

const relayBlock: RelayBlockRecord = {
  relayBlockId: "relay_block_timeline",
  sourceMessageId: message.messageId,
  ordinal: 0,
  suggestedTargetAgentCardIds: ["agent_card_researcher"],
  suggestedAudience: "one",
  topic: "review",
  format: "text/markdown",
  content: "Verify the result.",
  contentDigest: "sha256:relay",
  parserVersion: 1,
  sourceRange: { start: 0, end: 18 },
  createdAt: message.createdAt,
};

const forward: MessageForwardRecord = {
  forwardId: "forward_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  commandId: "command_timeline",
  idempotencyKey: "command_timeline",
  expectedTaskRevision: 1,
  targetIdempotencyKey: "command_timeline:worker",
  decidedByLogicalSessionId: "logical_session_conductor",
  decidedBySessionTurnId: "session_turn_conductor",
  targetLogicalSessionId: "logical_session_worker",
  mode: "invoke",
  selections: [{
    forwardSelectionId: "forward_selection_timeline",
    forwardId: "forward_timeline",
    ordinal: 0,
    kind: "relay_block",
    sourceMessageId: message.messageId,
    relayBlockId: relayBlock.relayBlockId,
    contentDigest: relayBlock.contentDigest,
  }],
  renderedMessageId: message.messageId,
  createdAt: message.createdAt,
};

const inbox: SessionInboxItemRecord = {
  inboxItemId: "inbox_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  targetLogicalSessionId: "logical_session_worker",
  renderedMessageId: message.messageId,
  forwardId: forward.forwardId,
  replyToLogicalSessionId: "logical_session_conductor",
  state: "delivered",
  deliveryInputSubmissionId: "input_timeline",
  revision: 2,
  createdAt: message.createdAt,
  updatedAt: "2026-08-06T01:03:00.000Z",
};

const input: InputSubmissionRecord = {
  inputSubmissionId: "input_timeline",
  sourceInboxItemId: inbox.inboxItemId,
  taskId: "task_timeline",
  runId: "run_timeline",
  logicalSessionId: "logical_session_worker",
  bindingId: "binding_timeline",
  contentMessageId: message.messageId,
  deliveryRole: "user",
  content: message.content,
  contentDigest: message.contentDigest,
  sequenceNumber: 1,
  idempotencyKey: "input-key",
  status: "provider_received",
  createdAt: message.createdAt,
  updatedAt: "2026-08-06T01:03:00.000Z",
};

const turn: SessionTurnRecord = {
  sessionTurnId: "session_turn_worker",
  taskId: "task_timeline",
  runId: "run_timeline",
  inputSubmissionId: input.inputSubmissionId,
  targetLogicalSessionId: "logical_session_worker",
  kind: "session_agent",
  initiator: "conductor",
  trigger: "conductor_invocation",
  replyToLogicalSessionId: "logical_session_conductor",
  invocationId: "invocation_timeline",
  status: "running",
  createdAt: message.createdAt,
  updatedAt: "2026-08-06T01:04:00.000Z",
};

const invocation: InvocationRecord = {
  invocationId: "invocation_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  replyToLogicalSessionId: "logical_session_conductor",
  targetLogicalSessionId: "logical_session_worker",
  targetAgentCardId: "agent_card_researcher",
  bindingId: "binding_timeline",
  assignmentMessageId: message.messageId,
  instruction: "Research the requested change.",
  acceptanceCriteria: ["Return evidence."],
  requestedArtifacts: ["reports/result.md"],
  status: "running",
  createdAt: "2026-08-06T01:04:00.000Z",
  updatedAt: "2026-08-06T01:05:00.000Z",
};

const intervention: HumanInterventionRecord = {
  humanInterventionId: "human_intervention_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  commandId: "command_human",
  idempotencyKey: "human:1",
  expectedTaskRevision: 1,
  targetLogicalSessionId: "logical_session_worker",
  content: "Pause and check the artifact.",
  contentDigest: "sha256:human",
  affectedSessionTurnId: turn.sessionTurnId,
  affectedInvocationId: invocation.invocationId,
  mode: "interrupt_then_send",
  state: "awaiting_turn_close",
  createdAt: "2026-08-06T01:06:00.000Z",
  updatedAt: "2026-08-06T01:06:00.000Z",
};

const attention: AttentionRecord = {
  attentionId: "attention_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  bindingId: "binding_timeline",
  bindingRevision: 1,
  nativeRequestId: "native-request",
  request: { prompt: "Approve artifact?" },
  status: "requested",
  createdAt: "2026-08-06T01:07:00.000Z",
  updatedAt: "2026-08-06T01:07:00.000Z",
};

const artifact: ArtifactReference = {
  artifactId: "artifact_timeline",
  taskId: "task_timeline",
  runId: "run_timeline",
  workspaceRelativePath: "reports/result.md",
  contentDigest: "sha256:artifact",
  evidenceReferenceIds: [],
  verifiedAt: "2026-08-06T01:08:00.000Z",
};

function providerFact(kind: ProviderFact["kind"]): ProviderFact {
  return {
    providerFactId: `provider_fact_${kind}`,
    provider: "opencode",
    bindingId: "binding_timeline",
    bindingRevision: 1,
    kind,
    deduplication: { providerEventId: `event-${kind}` },
    correlation: { inputSubmissionId: input.inputSubmissionId, sessionTurnId: turn.sessionTurnId },
    payload: { rawProviderSecret: "must-not-reach-renderer" },
    observedAt: "2026-08-06T01:03:30.000Z",
  };
}

describe("deriveTaskTimeline", () => {
  it("projects durable Message, Forward, Inbox, Turn, and intervention facts without Provider payloads", () => {
    const timeline = deriveTaskTimeline({
      task: task(), activeRun: run, bindings: [binding], inputs: [input], invocations: [invocation],
      sessionTurns: [turn], messages: [message], relayBlocks: [relayBlock], messageForwards: [forward],
      humanInterventions: [intervention], inboxItems: [inbox], attentions: [attention], artifacts: [artifact],
      providerFacts: [providerFact("input_received"), providerFact("activity_observed"), providerFact("turn_completed")],
    });

    expect(timeline.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "message_created", "relay_block_extracted", "message_forwarded", "inbox_state_changed",
      "input_submitted", "session_turn_changed", "invocation_requested", "human_intervention_changed",
      "provider_input_received", "provider_turn_completed", "attention_requested", "artifact_verified",
    ]));
    expect(timeline.some((item) => item.kind === "user_achieved")).toBe(false);
    expect(timeline.some((item) => item.timelineItemId === "provider-fact:provider_fact_activity_observed")).toBe(false);
    expect(JSON.stringify(timeline)).not.toContain("must-not-reach-renderer");
  });

  it("records Achieve only after an explicit user decision", () => {
    const timeline = deriveTaskTimeline({
      task: task({ achievement: {
        achievedAt: "2026-08-06T01:09:00.000Z",
        acceptedArtifactIds: [artifact.artifactId],
        acceptanceNote: "User reviewed this evidence.",
      } }),
      activeRun: run, bindings: [binding], inputs: [], invocations: [], sessionTurns: [], messages: [],
      relayBlocks: [], messageForwards: [], humanInterventions: [], inboxItems: [], attentions: [], artifacts: [],
      providerFacts: [providerFact("turn_completed")],
    });

    expect(timeline.find((item) => item.kind === "user_achieved")).toMatchObject({
      title: "用户已 Achieve",
      detail: "User reviewed this evidence.",
    });
  });
});
