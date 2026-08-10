import type {
  ArtifactReference,
  AttentionRecord,
  InputSubmissionRecord,
  InvocationRecord,
  HumanInterventionRecord,
  MessageForwardRecord,
  ProviderFact,
  ProviderSessionBindingRecord,
  RelayBlockRecord,
  SessionInboxItemRecord,
  SessionMessageRecord,
  SessionTurnRecord,
  TaskRecord,
  TaskRunRecord,
  TaskTimelineItem,
  TaskTimelineItemKind,
} from "@agent-workspace/runtime-contracts";

/**
 * Builds the renderer Timeline only from durable Runtime records. It projects
 * immutable Messages and Inbox state; it never turns a Provider payload into
 * an Agent message or a user acceptance decision.
 */
export function deriveTaskTimeline(input: {
  readonly task: TaskRecord;
  readonly activeRun?: TaskRunRecord;
  readonly bindings: readonly ProviderSessionBindingRecord[];
  readonly inputs: readonly InputSubmissionRecord[];
  readonly invocations: readonly InvocationRecord[];
  readonly sessionTurns?: readonly SessionTurnRecord[];
  readonly messages: readonly SessionMessageRecord[];
  readonly relayBlocks: readonly RelayBlockRecord[];
  readonly messageForwards?: readonly MessageForwardRecord[];
  readonly humanInterventions?: readonly HumanInterventionRecord[];
  readonly inboxItems: readonly SessionInboxItemRecord[];
  readonly attentions: readonly AttentionRecord[];
  readonly artifacts: readonly ArtifactReference[];
  readonly providerFacts: readonly ProviderFact[];
}): readonly TaskTimelineItem[] {
  const items: TaskTimelineItem[] = [{
    timelineItemId: `task:${input.task.taskId}:created`,
    kind: "task_created",
    occurredAt: input.task.createdAt,
    taskId: input.task.taskId,
    title: "Task 已创建",
    detail: input.task.goal,
    status: input.task.status,
  }];
  const sessionByBinding = new Map(input.bindings.map((binding) => [binding.bindingId, binding.logicalSessionId]));

  if (input.activeRun) {
    items.push({
      timelineItemId: `run:${input.activeRun.runId}:started`,
      kind: "run_started",
      occurredAt: input.activeRun.startedAt,
      taskId: input.task.taskId,
      runId: input.activeRun.runId,
      logicalSessionId: input.activeRun.conductorLogicalSessionId,
      title: "Task Run 已启动",
      status: input.activeRun.status,
    });
  }

  for (const message of input.messages) {
    items.push({
      timelineItemId: `message:${message.messageId}`,
      kind: "message_created",
      occurredAt: message.createdAt,
      taskId: message.taskId,
      runId: message.runId,
      logicalSessionId: message.sourceLogicalSessionId,
      invocationId: message.invocationId,
      title: messageTitle(message.kind),
      detail: message.content,
      status: message.kind,
    });
  }

  for (const relayBlock of input.relayBlocks) {
    items.push({
      timelineItemId: `relay-block:${relayBlock.relayBlockId}`,
      kind: "relay_block_extracted",
      occurredAt: relayBlock.createdAt,
      taskId: input.task.taskId,
      runId: input.activeRun?.runId,
      title: "转递块已提取",
      detail: [relayBlock.topic, relayBlock.suggestedAudience].filter(Boolean).join(" · ") || undefined,
      status: relayBlock.suggestedAudience ? `suggested:${relayBlock.suggestedAudience}` : "candidate",
    });
  }

  for (const forward of input.messageForwards ?? []) {
    items.push({
      timelineItemId: `forward:${forward.forwardId}`,
      kind: "message_forwarded",
      occurredAt: forward.createdAt,
      taskId: forward.taskId,
      runId: forward.runId,
      logicalSessionId: forward.targetLogicalSessionId,
      sessionTurnId: forward.decidedBySessionTurnId,
      forwardId: forward.forwardId,
      title: "Conductor 已明确转递消息",
      detail: forward.selections.map((selection) => selection.kind === "full_message"
        ? selection.sourceMessageId
        : selection.relayBlockId).join(" → "),
      status: forward.mode,
    });
  }

  for (const intervention of input.humanInterventions ?? []) {
    items.push({
      timelineItemId: `human-intervention:${intervention.humanInterventionId}:${intervention.state}`,
      kind: "human_intervention_changed",
      occurredAt: intervention.updatedAt,
      taskId: intervention.taskId,
      runId: intervention.runId,
      logicalSessionId: intervention.targetLogicalSessionId,
      sessionTurnId: intervention.affectedSessionTurnId,
      invocationId: intervention.affectedInvocationId,
      humanInterventionId: intervention.humanInterventionId,
      title: "用户直接介入 Session",
      detail: intervention.content,
      status: `${intervention.mode}:${intervention.state}`,
    });
  }

  for (const inbox of input.inboxItems) {
    items.push({
      timelineItemId: `inbox:${inbox.inboxItemId}:created`,
      kind: "inbox_state_changed",
      occurredAt: inbox.createdAt,
      taskId: inbox.taskId,
      runId: inbox.runId,
      logicalSessionId: inbox.targetLogicalSessionId,
      title: "消息已进入 Session 收件箱",
      detail: inbox.renderedMessageId,
      status: "pending",
    });
    if (inbox.updatedAt !== inbox.createdAt || inbox.state !== "pending") {
      items.push({
        timelineItemId: `inbox:${inbox.inboxItemId}:state:${inbox.revision}`,
        kind: "inbox_state_changed",
        occurredAt: inbox.updatedAt,
        taskId: inbox.taskId,
        runId: inbox.runId,
        logicalSessionId: inbox.targetLogicalSessionId,
        inputSubmissionId: inbox.deliveryInputSubmissionId,
        title: "Session 收件箱状态已更新",
        status: inbox.state,
      });
    }
  }

  for (const entry of input.inputs) {
    items.push({
      timelineItemId: `input:${entry.inputSubmissionId}:submitted`,
      kind: "input_submitted",
      occurredAt: entry.createdAt,
      taskId: entry.taskId,
      runId: entry.runId,
      logicalSessionId: entry.logicalSessionId,
      bindingId: entry.bindingId,
      inputSubmissionId: entry.inputSubmissionId,
      title: "收件箱消息已提交给 Provider",
      detail: entry.content,
      status: entry.status,
    });
  }

  for (const turn of input.sessionTurns ?? []) {
    items.push({
      timelineItemId: `session-turn:${turn.sessionTurnId}:${turn.status}:${turn.updatedAt}`,
      kind: "session_turn_changed",
      occurredAt: turn.updatedAt,
      taskId: turn.taskId,
      runId: turn.runId,
      logicalSessionId: turn.targetLogicalSessionId,
      inputSubmissionId: turn.inputSubmissionId,
      invocationId: turn.invocationId,
      sessionTurnId: turn.sessionTurnId,
      humanInterventionId: turn.humanInterventionId,
      title: "Session Turn 状态已更新",
      detail: `${turn.initiator} · ${turn.trigger}`,
      status: turn.status,
    });
  }

  for (const invocation of input.invocations) {
    items.push({
      timelineItemId: `invocation:${invocation.invocationId}:requested`,
      kind: "invocation_requested",
      occurredAt: invocation.createdAt,
      taskId: invocation.taskId,
      runId: invocation.runId,
      logicalSessionId: invocation.targetLogicalSessionId,
      bindingId: invocation.bindingId,
      invocationId: invocation.invocationId,
      title: "Session 调用已请求",
      detail: invocation.instruction,
      status: invocation.status,
    });
    if (invocation.updatedAt !== invocation.createdAt) {
      items.push({
        timelineItemId: `invocation:${invocation.invocationId}:state:${invocation.status}:${invocation.updatedAt}`,
        kind: "invocation_state_changed",
        occurredAt: invocation.updatedAt,
        taskId: invocation.taskId,
        runId: invocation.runId,
        logicalSessionId: invocation.targetLogicalSessionId,
        bindingId: invocation.bindingId,
        invocationId: invocation.invocationId,
        title: "Session 调用状态已更新",
        status: invocation.status,
      });
    }
  }

  for (const attention of input.attentions) {
    items.push({
      timelineItemId: `attention:${attention.attentionId}:requested`,
      kind: "attention_requested",
      occurredAt: attention.createdAt,
      taskId: attention.taskId,
      runId: attention.runId,
      logicalSessionId: sessionByBinding.get(attention.bindingId),
      bindingId: attention.bindingId,
      inputSubmissionId: attention.activeInputSubmissionId,
      invocationId: attention.activeInvocationId,
      attentionId: attention.attentionId,
      title: "需要用户处理",
      status: attention.status,
    });
    if (attention.updatedAt !== attention.createdAt) {
      items.push({
        timelineItemId: `attention:${attention.attentionId}:state:${attention.status}:${attention.updatedAt}`,
        kind: "attention_state_changed",
        occurredAt: attention.updatedAt,
        taskId: attention.taskId,
        runId: attention.runId,
        logicalSessionId: sessionByBinding.get(attention.bindingId),
        bindingId: attention.bindingId,
        attentionId: attention.attentionId,
        title: "用户处理状态已更新",
        status: attention.status,
      });
    }
  }

  for (const artifact of input.artifacts) {
    items.push({
      timelineItemId: `artifact:${artifact.artifactId}:verified`,
      kind: "artifact_verified",
      occurredAt: artifact.verifiedAt,
      taskId: artifact.taskId,
      runId: artifact.runId,
      invocationId: artifact.sourceInvocationId,
      artifactId: artifact.artifactId,
      title: "产物已验证",
      detail: artifactDisplayName(artifact.workspaceRelativePath),
    });
  }

  for (const fact of input.providerFacts) {
    const kind = timelineKindForProviderFact(fact.kind);
    if (!kind) continue;
    items.push({
      timelineItemId: `provider-fact:${fact.providerFactId}`,
      kind,
      occurredAt: fact.observedAt,
      taskId: input.task.taskId,
      runId: input.activeRun?.runId,
      logicalSessionId: sessionByBinding.get(fact.bindingId),
      bindingId: fact.bindingId,
      inputSubmissionId: fact.correlation.inputSubmissionId,
      invocationId: fact.correlation.invocationId,
      attentionId: fact.correlation.attentionId,
      title: timelineTitleForProviderFact(kind),
    });
  }

  if (input.task.achievement) {
    items.push({
      timelineItemId: `task:${input.task.taskId}:achieved:${input.task.achievement.achievedAt}`,
      kind: "user_achieved",
      occurredAt: input.task.achievement.achievedAt,
      taskId: input.task.taskId,
      title: "用户已 Achieve",
      ...(input.task.achievement.acceptanceNote ? { detail: input.task.achievement.acceptanceNote } : {}),
    });
  }

  return items.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
    || timelineRank(left.kind) - timelineRank(right.kind)
    || left.timelineItemId.localeCompare(right.timelineItemId),
  );
}

export function artifactDisplayName(workspaceRelativePath: string): string {
  const parts = workspaceRelativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? "artifact";
}

function messageTitle(kind: SessionMessageRecord["kind"]): string {
  const labels: Record<SessionMessageRecord["kind"], string> = {
    task_goal: "Task 目标消息已创建",
    user_input: "用户消息已创建",
    agent_assignment: "Agent 派发消息已创建",
    agent_final: "Agent 完整 final 消息已收到",
    relay_forward: "Agent 间转递消息已创建",
    publish_forward: "Agent 发布消息已创建",
    runtime_notice: "Runtime 通知消息已创建",
  };
  return labels[kind];
}

function timelineKindForProviderFact(kind: ProviderFact["kind"]): TaskTimelineItemKind | undefined {
  const kinds: Partial<Record<ProviderFact["kind"], TaskTimelineItemKind>> = {
    binding_observed: "provider_binding_observed",
    binding_unavailable: "provider_binding_unavailable",
    input_received: "provider_input_received",
    input_rejected: "provider_input_rejected",
    transport_unknown: "provider_transport_unknown",
    turn_started: "provider_turn_started",
    // Streaming activity is reduced by deriveProviderActivities into one
    // bounded item per activity. Emitting one Timeline row per native delta
    // would duplicate the execution tree and turn token streams into noise.
    turn_completed: "provider_turn_completed",
    turn_failed: "provider_turn_failed",
    interrupt_confirmed: "provider_interrupt_confirmed",
    native_terminal: "provider_terminal",
    native_child_observed: "provider_activity",
    presentation_available: "provider_activity",
    provider_unavailable: "provider_unavailable",
    assistant_final: "provider_activity",
  };
  return kinds[kind];
}

function timelineTitleForProviderFact(kind: TaskTimelineItemKind): string {
  const labels: Partial<Record<TaskTimelineItemKind, string>> = {
    provider_binding_observed: "Provider Session 已绑定",
    provider_binding_unavailable: "Provider Session 不可用",
    provider_input_received: "Provider 已确认收到输入",
    provider_input_rejected: "Provider 拒绝了输入",
    provider_transport_unknown: "Provider 输入状态未知",
    provider_turn_started: "Provider turn 已开始",
    provider_turn_completed: "Provider turn 已完成",
    provider_turn_failed: "Provider turn 失败",
    attention_requested: "Provider 请求用户处理",
    attention_state_changed: "Provider 请求状态已更新",
    provider_interrupt_confirmed: "Provider 已确认中断",
    provider_terminal: "Provider Session 已终止",
    provider_unavailable: "Provider 当前不可用",
    provider_activity: "Provider 观察到活动",
  };
  return labels[kind] ?? "Provider 事实已记录";
}

function timelineRank(kind: TaskTimelineItemKind): number {
  const ranks: Record<TaskTimelineItemKind, number> = {
    task_created: 10,
    run_started: 20,
    message_created: 30,
    relay_block_extracted: 35,
    message_forwarded: 36,
    human_intervention_changed: 37,
    inbox_state_changed: 40,
    session_turn_changed: 55,
    input_submitted: 50,
    invocation_requested: 60,
    invocation_state_changed: 70,
    provider_binding_observed: 80,
    provider_binding_unavailable: 80,
    provider_input_received: 80,
    provider_input_rejected: 80,
    provider_transport_unknown: 80,
    provider_turn_started: 80,
    provider_turn_completed: 80,
    provider_turn_failed: 80,
    provider_interrupt_confirmed: 80,
    provider_terminal: 80,
    provider_unavailable: 80,
    provider_activity: 80,
    attention_requested: 90,
    attention_state_changed: 100,
    artifact_verified: 110,
    user_achieved: 120,
  };
  return ranks[kind];
}
