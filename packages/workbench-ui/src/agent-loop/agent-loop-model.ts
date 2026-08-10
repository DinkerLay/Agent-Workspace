import type {
  RuntimeReadModel,
  TaskRuntimeReadModel,
  TaskTimelineItem,
} from "@agent-workspace/runtime-contracts";

/**
 * Renderer-only projection for the preserved AgentLoop interaction.  It is
 * deliberately richer than the former generic Workbench list, while still
 * containing only Runtime read-model facts.  In particular, it has no native
 * Provider session id, raw Provider payload, terminal stream, filesystem path
 * authority, or lifecycle mutation capability.
 */
export type AgentLoopTemplateListItem = Readonly<{
  templateId: string;
  title: string;
  slug: string;
  description?: string;
  revision: number;
  archivedAt?: string;
  activeVersion?: Readonly<{
    templateVersionId: string;
    version: number;
    createdAt: string;
  }>;
}>;

/**
 * Renderer-safe workspace choice for Task creation.  A canonical directory is
 * intentionally not present: the Host owns it after `workspace.authorize`.
 */
export type AgentLoopWorkspaceListItem = Readonly<{
  workspaceId: string;
  displayName: string;
  authorizedAt: string;
}>;

export type AgentLoopTaskListItem = Readonly<{
  taskId: string;
  title: string;
  goal: string;
  status: string;
  revision: number;
  activeRunId?: string;
  achievement?: Readonly<{
    achievedAt: string;
    acceptedArtifactIds: readonly string[];
    acceptanceNote?: string;
  }>;
  createdAt: string;
  /** Recycle-bin membership is independent from lifecycle status and Achieve. */
  trashedAt?: string;
  updatedAt: string;
}>;

export type AgentLoopSessionItem = Readonly<{
  logicalSessionId: string;
  agentCardId: string;
  title: string;
  kind: "conductor" | "card";
  status: string;
  executionProfileId: string;
  binding?: Readonly<{
    bindingId: string;
    provider: string;
    status: string;
    recoverable: boolean;
  }>;
}>;

export type AgentLoopAttentionItem = Readonly<{
  attentionId: string;
  bindingId: string;
  bindingRevision: number;
  nativeRequestId: string;
  status: string;
  title: string;
  prompt?: string;
  options?: readonly string[];
  activeInputSubmissionId?: string;
  activeInvocationId?: string;
}>;

export type AgentLoopArtifactItem = Readonly<{
  artifactId: string;
  /** Host-supplied display label; private workspace path is never projected. */
  displayName: string;
  contentDigest: string;
  verifiedAt: string;
  sourceInvocationId?: string;
}>;

/**
 * A renderer-safe delivery projection.  The Inbox remains Runtime-owned: the
 * UI can show the durable state but cannot claim, stage, resend, or settle it.
 */
export type AgentLoopInboxDeliveryItem = Readonly<{
  inboxItemId: string;
  targetLogicalSessionId: string;
  route: "message" | "forward" | "human";
  forwardId?: string;
  humanInterventionId?: string;
  state: "pending" | "leased" | "delivery_staged" | "delivered" | "ambiguous" | "suppressed";
  deliveryInputSubmissionId?: string;
  createdAt: string;
  updatedAt: string;
}>;

/** A deterministic RelayBlock already extracted by the Runtime, never by the Renderer. */
export type AgentLoopRelayBlockItem = Readonly<{
  relayBlockId: string;
  ordinal: number;
  suggestedTargetAgentCardIds: readonly string[];
  suggestedAudience?: "one" | "publish";
  topic?: string;
  format: "text/markdown" | "application/json";
  content: string;
  contentDigest: string;
  parserVersion: number;
  createdAt: string;
}>;

/**
 * The immutable collaboration content shown in a Session workspace.  The full
 * `content` is retained even when it contains RelayBlocks; the optional
 * structured blocks below are only a Runtime-produced, collapsible view.
 */
export type AgentLoopSessionMessageItem = Readonly<{
  messageId: string;
  kind: "task_goal" | "user_input" | "agent_assignment" | "agent_final" | "relay_forward" | "publish_forward" | "runtime_notice";
  content: string;
  contentDigest: string;
  sourceLogicalSessionId?: string;
  sourceSessionTurnId?: string;
  sourceHumanInterventionId?: string;
  /** Human-readable source derived only from the Task's logical-session projection. */
  sourceLabel?: string;
  invocationId?: string;
  createdAt: string;
  relayBlocks: readonly AgentLoopRelayBlockItem[];
  inboxDeliveries: readonly AgentLoopInboxDeliveryItem[];
}>;

export type AgentLoopProviderActivityItem = Readonly<{
  activityId: string;
  category: "assistant_progress" | "tool" | "change" | "web";
  status: "running" | "completed" | "failed";
  title: string;
  detail?: string;
  content?: string;
  startedAt: string;
  updatedAt: string;
}>;

/** One Provider turn's human-only execution trace; it is never routable chat content. */
export type AgentLoopExecutionGroup = Readonly<{
  executionGroupId: string;
  logicalSessionId: string;
  provider: string;
  sessionTurnId?: string;
  inputSubmissionId?: string;
  finalMessageId?: string;
  status: "running" | "awaiting_final" | "ambiguous" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  activities: readonly AgentLoopProviderActivityItem[];
}>;

export type AgentLoopTaskDetail = Readonly<{
  task: AgentLoopTaskListItem;
  /** Exact immutable Task snapshot's Conductor profile; absence is fail-closed in launch controls. */
  conductorReadiness?: Readonly<{
    status: "checking" | "available" | "unavailable" | "version_mismatch" | "capability_missing";
    unavailableReasons: readonly string[];
    missingCapabilities: readonly string[];
  }>;
  activeRun?: Readonly<{
    runId: string;
    status: string;
    conductorLogicalSessionId: string;
    runNumber: number;
  }>;
  sessions: readonly AgentLoopSessionItem[];
  /** All caller-visible immutable messages for this Task/Run. */
  messages: readonly AgentLoopSessionMessageItem[];
  /** Human-only Provider execution groups, kept separate from Messages. */
  executionGroups: readonly AgentLoopExecutionGroup[];
  timeline: readonly TaskTimelineItem[];
  attentions: readonly AgentLoopAttentionItem[];
  artifacts: readonly AgentLoopArtifactItem[];
}>;

export type AgentLoopRuntimeViewModel = Readonly<{
  generatedAt: string;
  workspaces: readonly AgentLoopWorkspaceListItem[];
  templates: readonly AgentLoopTemplateListItem[];
  tasks: readonly AgentLoopTaskListItem[];
  selectedTask?: AgentLoopTaskDetail;
}>;

/**
 * One pure projection boundary between Runtime facts and the AgentLoop UI.
 * It is intentionally not an adapter for the historical OpenCode data shape.
 */
export function toAgentLoopRuntimeViewModel(model: RuntimeReadModel): AgentLoopRuntimeViewModel {
  return Object.freeze({
    generatedAt: model.generatedAt,
    workspaces: Object.freeze(model.workspaceLibrary.authorizations.map((workspace) => Object.freeze({
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      authorizedAt: workspace.authorizedAt,
    }))),
    templates: Object.freeze(model.templateLibrary.templates.map(({ template, activeVersion }) => Object.freeze({
      templateId: template.templateId,
      title: template.title,
      slug: template.slug,
      ...(template.description ? { description: template.description } : {}),
      revision: template.revision,
      ...(template.archivedAt ? { archivedAt: template.archivedAt } : {}),
      ...(activeVersion ? {
        activeVersion: Object.freeze({
          templateVersionId: activeVersion.templateVersionId,
          version: activeVersion.version,
          createdAt: activeVersion.createdAt,
        }),
      } : {}),
    }))),
    tasks: Object.freeze(model.taskLibrary.tasks.map(toTaskListItem)),
    ...(model.task ? { selectedTask: toTaskDetail(model.task) } : {}),
  });
}

function toTaskListItem(task: RuntimeReadModel["taskLibrary"]["tasks"][number]): AgentLoopTaskListItem {
  return Object.freeze({
    taskId: task.taskId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    revision: task.revision,
    ...(task.activeRunId ? { activeRunId: task.activeRunId } : {}),
    ...(task.achievement ? {
      achievement: Object.freeze({
        achievedAt: task.achievement.achievedAt,
        acceptedArtifactIds: Object.freeze([...task.achievement.acceptedArtifactIds]),
        ...(task.achievement.acceptanceNote ? { acceptanceNote: task.achievement.acceptanceNote } : {}),
      }),
    } : {}),
    createdAt: task.createdAt,
    ...(task.trashedAt ? { trashedAt: task.trashedAt } : {}),
    updatedAt: task.updatedAt,
  });
}

function toTaskDetail(taskRuntime: TaskRuntimeReadModel): AgentLoopTaskDetail {
  const bindingsBySessionId = new Map(taskRuntime.bindings.map((binding) => [binding.logicalSessionId, binding] as const));
  const sessionLabelById = new Map(taskRuntime.logicalSessions.map((session) => [
    session.logicalSessionId,
    session.kind === "conductor" ? "Conductor" : session.agentCardId,
  ] as const));
  const relayBlocksByMessageId = new Map<string, AgentLoopRelayBlockItem[]>();
  for (const relayBlock of taskRuntime.relayBlocks) {
    const blocks = relayBlocksByMessageId.get(relayBlock.sourceMessageId) ?? [];
    blocks.push(toRelayBlockItem(relayBlock));
    relayBlocksByMessageId.set(relayBlock.sourceMessageId, blocks);
  }
  const inboxDeliveriesByMessageId = new Map<string, AgentLoopInboxDeliveryItem[]>();
  for (const inboxItem of taskRuntime.inboxItems) {
    const deliveries = inboxDeliveriesByMessageId.get(inboxItem.renderedMessageId) ?? [];
    deliveries.push(Object.freeze({
      inboxItemId: inboxItem.inboxItemId,
      targetLogicalSessionId: inboxItem.targetLogicalSessionId,
      route: inboxItem.humanInterventionId ? "human" : inboxItem.forwardId ? "forward" : "message",
      ...(inboxItem.forwardId ? { forwardId: inboxItem.forwardId } : {}),
      ...(inboxItem.humanInterventionId ? { humanInterventionId: inboxItem.humanInterventionId } : {}),
      state: inboxItem.state,
      ...(inboxItem.deliveryInputSubmissionId ? { deliveryInputSubmissionId: inboxItem.deliveryInputSubmissionId } : {}),
      createdAt: inboxItem.createdAt,
      updatedAt: inboxItem.updatedAt,
    }));
    inboxDeliveriesByMessageId.set(inboxItem.renderedMessageId, deliveries);
  }
  const turnById = new Map(taskRuntime.sessionTurns.map((turn) => [turn.sessionTurnId, turn] as const));
  const turnByInputId = new Map(taskRuntime.sessionTurns.map((turn) => [turn.inputSubmissionId, turn] as const));
  const turnByInvocationId = new Map(taskRuntime.sessionTurns.flatMap((turn) => turn.invocationId
    ? [[turn.invocationId, turn] as const]
    : []));
  const messageContentById = new Map(taskRuntime.messages.map((message) => [message.messageId, message.content] as const));
  const executionGroups = new Map<string, {
    logicalSessionId: string;
    provider: string;
    sessionTurnId?: string;
    inputSubmissionId?: string;
    finalMessageId?: string;
    turnStatus?: string;
    startedAt: string;
    updatedAt: string;
    activities: AgentLoopProviderActivityItem[];
  }>();
  for (const turn of taskRuntime.sessionTurns) {
    if (turn.status === "staged") continue;
    const binding = bindingsBySessionId.get(turn.targetLogicalSessionId);
    if (!binding) continue;
    executionGroups.set(turn.sessionTurnId, {
      logicalSessionId: turn.targetLogicalSessionId,
      provider: binding.provider,
      sessionTurnId: turn.sessionTurnId,
      inputSubmissionId: turn.inputSubmissionId,
      ...(turn.finalMessageId ? { finalMessageId: turn.finalMessageId } : {}),
      turnStatus: turn.status,
      startedAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      activities: [],
    });
  }
  for (const activity of taskRuntime.providerActivities) {
    const turn = activity.sessionTurnId
      ? turnById.get(activity.sessionTurnId)
      : activity.inputSubmissionId
        ? turnByInputId.get(activity.inputSubmissionId)
        : activity.invocationId
          ? turnByInvocationId.get(activity.invocationId)
          : undefined;
    const executionGroupId = turn?.sessionTurnId ?? activity.inputSubmissionId ?? activity.activityId;
    const current = executionGroups.get(executionGroupId);
    const item: AgentLoopProviderActivityItem = Object.freeze({
      activityId: activity.activityId,
      category: activity.category,
      status: activity.status,
      title: activity.title,
      ...(activity.detail ? { detail: activity.detail } : {}),
      ...(activity.content !== undefined ? { content: activity.content } : {}),
      startedAt: activity.startedAt,
      updatedAt: activity.updatedAt,
    });
    executionGroups.set(executionGroupId, {
      logicalSessionId: activity.logicalSessionId,
      provider: activity.provider,
      sessionTurnId: turn?.sessionTurnId ?? activity.sessionTurnId ?? current?.sessionTurnId,
      inputSubmissionId: turn?.inputSubmissionId ?? activity.inputSubmissionId ?? current?.inputSubmissionId,
      finalMessageId: turn?.finalMessageId ?? current?.finalMessageId,
      turnStatus: turn?.status ?? current?.turnStatus,
      startedAt: current && current.startedAt < activity.startedAt ? current.startedAt : activity.startedAt,
      updatedAt: current && current.updatedAt > activity.updatedAt ? current.updatedAt : activity.updatedAt,
      activities: [...(current?.activities ?? []), item],
    });
  }
  return Object.freeze({
    task: toTaskListItem(taskRuntime.task),
    ...(taskRuntime.conductorExecutionProfileReadiness ? {
      conductorReadiness: Object.freeze({
        status: taskRuntime.conductorExecutionProfileReadiness.status,
        unavailableReasons: Object.freeze([...taskRuntime.conductorExecutionProfileReadiness.unavailableReasons]),
        missingCapabilities: Object.freeze([...taskRuntime.conductorExecutionProfileReadiness.missingCapabilities]),
      }),
    } : {}),
    ...(taskRuntime.activeRun ? {
      activeRun: Object.freeze({
        runId: taskRuntime.activeRun.runId,
        status: taskRuntime.activeRun.status,
        conductorLogicalSessionId: taskRuntime.activeRun.conductorLogicalSessionId,
        runNumber: taskRuntime.activeRun.runNumber,
      }),
    } : {}),
    sessions: Object.freeze(taskRuntime.logicalSessions.map((session) => {
      const binding = bindingsBySessionId.get(session.logicalSessionId);
      return Object.freeze({
        logicalSessionId: session.logicalSessionId,
        agentCardId: session.agentCardId,
        title: session.kind === "conductor" ? "Conductor" : session.agentCardId,
        kind: session.kind,
        status: session.status,
        executionProfileId: session.executionProfileId,
        ...(binding ? {
          binding: Object.freeze({
            bindingId: binding.bindingId,
            provider: binding.provider,
            status: binding.status,
            recoverable: binding.recoverable,
          }),
        } : {}),
      });
    })),
    messages: Object.freeze([...taskRuntime.messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((message) => Object.freeze({
      messageId: message.messageId,
      kind: message.kind,
      content: message.content,
      contentDigest: message.contentDigest,
      ...(message.sourceLogicalSessionId ? { sourceLogicalSessionId: message.sourceLogicalSessionId } : {}),
      ...(message.sourceSessionTurnId ? { sourceSessionTurnId: message.sourceSessionTurnId } : {}),
      ...(message.sourceHumanInterventionId ? { sourceHumanInterventionId: message.sourceHumanInterventionId } : {}),
      ...(message.sourceLogicalSessionId && sessionLabelById.get(message.sourceLogicalSessionId)
        ? { sourceLabel: sessionLabelById.get(message.sourceLogicalSessionId)! }
        : {}),
      ...(message.invocationId ? { invocationId: message.invocationId } : {}),
      createdAt: message.createdAt,
      relayBlocks: Object.freeze([...(relayBlocksByMessageId.get(message.messageId) ?? [])].sort((left, right) => left.ordinal - right.ordinal)),
      inboxDeliveries: Object.freeze([...(inboxDeliveriesByMessageId.get(message.messageId) ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt))),
    }))),
    executionGroups: Object.freeze([...executionGroups.entries()]
      .map(([executionGroupId, group]) => Object.freeze({
        executionGroupId,
        logicalSessionId: group.logicalSessionId,
        provider: group.provider,
        ...(group.sessionTurnId ? { sessionTurnId: group.sessionTurnId } : {}),
        ...(group.inputSubmissionId ? { inputSubmissionId: group.inputSubmissionId } : {}),
        ...(group.finalMessageId ? { finalMessageId: group.finalMessageId } : {}),
        status: executionGroupStatus(group.turnStatus, group.finalMessageId),
        startedAt: group.startedAt,
        updatedAt: group.updatedAt,
        activities: Object.freeze(presentableExecutionActivities(
          group.activities,
          group.finalMessageId ? messageContentById.get(group.finalMessageId) : undefined,
        )),
      }))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.executionGroupId.localeCompare(right.executionGroupId))),
    timeline: Object.freeze([...taskRuntime.timeline]),
    attentions: Object.freeze(taskRuntime.attentions.map((attention) => Object.freeze({
      attentionId: attention.attentionId,
      bindingId: attention.bindingId,
      bindingRevision: attention.bindingRevision,
      nativeRequestId: attention.nativeRequestId,
      status: attention.status,
      title: stringField(attention.request, "title") ?? "需要你的确认",
      ...(stringField(attention.request, "prompt") ? { prompt: stringField(attention.request, "prompt") } : {}),
      ...(stringArrayField(attention.request, "options") ? { options: stringArrayField(attention.request, "options") } : {}),
      ...(attention.activeInputSubmissionId ? { activeInputSubmissionId: attention.activeInputSubmissionId } : {}),
      ...(attention.activeInvocationId ? { activeInvocationId: attention.activeInvocationId } : {}),
    }))),
    artifacts: Object.freeze(taskRuntime.artifacts.map((artifact) => Object.freeze({
      artifactId: artifact.artifactId,
      displayName: artifact.displayName,
      contentDigest: artifact.contentDigest,
      verifiedAt: artifact.verifiedAt,
      ...(artifact.sourceInvocationId ? { sourceInvocationId: artifact.sourceInvocationId } : {}),
    }))),
  });
}

function presentableExecutionActivities(
  activities: readonly AgentLoopProviderActivityItem[],
  finalMessageContent: string | undefined,
): readonly AgentLoopProviderActivityItem[] {
  const normalizedFinal = finalMessageContent?.trim();
  const seenAssistantSnapshots = new Set<string>();
  return [...activities]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
      || left.activityId.localeCompare(right.activityId))
    .filter((activity) => {
      if (activity.category !== "assistant_progress") return true;
      const content = activity.content?.trim();
      // Once Runtime has materialized the canonical final Message, it remains
      // the one visible copy. Provider live/recovery assistant snapshots stay
      // useful while running but must not duplicate that final in the audit tree.
      if (content && normalizedFinal && content === normalizedFinal) return false;
      if (!content) return true;
      const snapshotKey = [activity.title, activity.detail ?? "", content, activity.status].join("\u0000");
      if (seenAssistantSnapshots.has(snapshotKey)) return false;
      seenAssistantSnapshots.add(snapshotKey);
      return true;
    });
}

function executionGroupStatus(
  turnStatus: string | undefined,
  finalMessageId: string | undefined,
): AgentLoopExecutionGroup["status"] {
  // Auto-collapse only after Runtime has materialized the canonical final from
  // correlated assistant_final + terminal facts. A failed tool row remains
  // visible when reopened, but does not override a Turn that recovered and
  // returned its canonical final.
  if (finalMessageId && ["returned", "completed"].includes(turnStatus ?? "")) return "completed";
  if (["failed", "interrupted", "cancelled"].includes(turnStatus ?? "")) return "failed";
  if (turnStatus === "ambiguous") return "ambiguous";
  if (["awaiting_final", "returned", "completed"].includes(turnStatus ?? "")) return "awaiting_final";
  return "running";
}

function toRelayBlockItem(relayBlock: TaskRuntimeReadModel["relayBlocks"][number]): AgentLoopRelayBlockItem {
  return Object.freeze({
    relayBlockId: relayBlock.relayBlockId,
    ordinal: relayBlock.ordinal,
    suggestedTargetAgentCardIds: Object.freeze([...relayBlock.suggestedTargetAgentCardIds]),
    ...(relayBlock.suggestedAudience ? { suggestedAudience: relayBlock.suggestedAudience } : {}),
    ...(relayBlock.topic ? { topic: relayBlock.topic } : {}),
    format: relayBlock.format,
    content: relayBlock.content,
    contentDigest: relayBlock.contentDigest,
    parserVersion: relayBlock.parserVersion,
    createdAt: relayBlock.createdAt,
  });
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): readonly string[] | undefined {
  const candidate = value[key];
  if (!Array.isArray(candidate)) return undefined;
  const options = candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return options.length ? Object.freeze(options.map((item) => item.trim())) : undefined;
}
