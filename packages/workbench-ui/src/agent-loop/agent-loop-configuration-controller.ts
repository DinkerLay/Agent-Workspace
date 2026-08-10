import {
  createId,
  type ExecutionProfileReadinessReadModel,
  type MetaPatchOperation,
  type MetaPatchProposalRecord,
  type MetaSessionRecord,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeReadModel,
  type TaskInputFieldDefinition,
  type TaskInputValue,
  type TaskSetupDraftRecord,
  type TemplateDraftRecord,
  type TemplateVersionReadModel,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient } from "@agent-workspace/runtime-client";
import type {
  AgentLoopMetaPanelController,
  AgentLoopMetaPanelViewModel,
  AgentLoopMetaPatchFieldDiff,
  AgentLoopMetaScope,
} from "./AgentLoopMetaPanel";
import type {
  AgentLoopTaskSetupController,
  AgentLoopTaskSetupDraftInput,
  AgentLoopTaskSetupSchemaField,
  AgentLoopTaskSetupViewModel,
} from "./AgentLoopTaskSetupSurface";

export type AgentLoopCreateTaskSetupDraftInput = Readonly<{
  templateVersionId: string;
  workspaceId: string;
  title: string;
  goal: string;
}>;

export type AgentLoopConfigurationController = Readonly<{
  meta: AgentLoopMetaPanelController;
  createTaskSetupDraft(input: AgentLoopCreateTaskSetupDraftInput): Promise<string>;
  taskSetup(taskSetupDraftId: string): AgentLoopTaskSetupController;
}>;

export type AgentLoopConfigurationControllerOptions = Readonly<{
  client: RuntimeClient;
  ownerId: string;
  now?: () => string;
  /** Test seam only; production uses opaque Runtime ids. */
  createRuntimeId?: typeof createId;
}>;

type RuntimeCommandInput = RuntimeCommand extends infer Command
  ? Command extends { readonly commandId: string; readonly issuedAt: string }
    ? Omit<Command, "commandId" | "issuedAt">
    : never
  : never;

type ExactVersion = Readonly<{
  templateId: string;
  templateTitle: string;
  version: TemplateVersionReadModel;
  profileReadiness: readonly ExecutionProfileReadinessReadModel[];
}>;

/**
 * Configuration-only Renderer adapter. It can mutate Template/Task Setup
 * Drafts through typed commands, but exposes no Task lifecycle, Provider,
 * filesystem, transcript, Publish, or Start capability to Meta UI.
 */
export function createAgentLoopConfigurationController(
  options: AgentLoopConfigurationControllerOptions,
): AgentLoopConfigurationController {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const pendingCommands = new Map<string, RuntimeCommand>();
  const pendingTaskIds = new Map<string, string>();

  const issue = async (
    key: string,
    command: RuntimeCommandInput | ((commandId: string) => RuntimeCommandInput),
  ): Promise<RuntimeCommandResult> => {
    let envelope = pendingCommands.get(key);
    if (!envelope) {
      const commandId = createRuntimeId("command");
      const input = typeof command === "function" ? command(commandId) : command;
      envelope = withCommandEnvelope(input, now, commandId);
      pendingCommands.set(key, envelope);
    }
    try {
      const result = await options.client.command(envelope);
      pendingCommands.delete(key);
      return result;
    } catch (error) {
      // Retain the same id across an explicit retry after an ambiguous bridge
      // outcome. Runtime remains the idempotency authority.
      throw error;
    }
  };

  const readOwnedSetup = async (taskSetupDraftId: string): Promise<Readonly<{
    model: RuntimeReadModel;
    draft: TaskSetupDraftRecord;
    exactVersion: ExactVersion;
  }>> => {
    const model = await options.client.read();
    const draft = model.configuration.taskSetupDrafts.find((candidate) =>
      candidate.taskSetupDraftId === taskSetupDraftId && candidate.ownerId === options.ownerId,
    );
    if (!draft) throw new Error("agent_loop_task_setup_draft_unavailable");
    return Object.freeze({ model, draft, exactVersion: await resolveExactVersion(options.client, model, draft.templateVersionId) });
  };

  const meta: AgentLoopMetaPanelController = Object.freeze({
    async load(scope) {
      const model = await options.client.read();
      return toMetaPanelViewModel(model, options.ownerId, scope);
    },
    subscribe(onChanged) {
      return options.client.subscribe({}, (invalidation) => {
        if (invalidation.reasons.includes("configuration_changed")) onChanged();
      });
    },
    async createSession(input) {
      const target = metaTarget(input.scope);
      await issue(`meta.create_session:${targetKey(target)}:${input.metaProfileOptionId}`, {
        type: "meta.create_session",
        ownerId: options.ownerId,
        metaProfileOptionId: requiredText(input.metaProfileOptionId, "meta profile option id"),
        target,
      });
    },
    async sendMessage(input) {
      const content = requiredText(input.content, "meta message");
      const key = JSON.stringify([
        "meta.send_message",
        input.scope.kind,
        input.scope.draftId,
        input.scope.draftRevision,
        input.metaSessionId,
        input.expectedSessionRevision,
        content,
      ]);
      await issue(key, (commandId) => ({
        type: "meta.send_message",
        ownerId: options.ownerId,
        metaSessionId: requiredText(input.metaSessionId, "meta session id"),
        expectedSessionRevision: input.expectedSessionRevision,
        expectedTargetRevision: input.scope.draftRevision,
        idempotencyKey: commandId,
        content,
      }));
    },
    async applyPatch(input) {
      const { session, proposal } = await requireMetaProposal(options.client, options.ownerId, input.scope, input.proposalId);
      await issue(`meta.apply_patch:${proposal.metaPatchProposalId}:${input.expectedDraftRevision}`, {
        type: "meta.apply_patch",
        ownerId: options.ownerId,
        metaSessionId: session.metaSessionId,
        metaPatchProposalId: proposal.metaPatchProposalId,
        expectedTargetRevision: input.expectedDraftRevision,
      });
    },
    async rejectPatch(input) {
      const { session, proposal } = await requireMetaProposal(options.client, options.ownerId, input.scope, input.proposalId);
      await issue(`meta.reject_patch:${proposal.metaPatchProposalId}`, {
        type: "meta.reject_patch",
        ownerId: options.ownerId,
        metaSessionId: session.metaSessionId,
        metaPatchProposalId: proposal.metaPatchProposalId,
      });
    },
    async abandonSession(input) {
      await issue(`meta.abandon_session:${input.metaSessionId}:${input.expectedSessionRevision}`, {
        type: "meta.abandon_session",
        ownerId: options.ownerId,
        metaSessionId: requiredText(input.metaSessionId, "meta session id"),
        expectedRevision: input.expectedSessionRevision,
      });
    },
  });

  const taskSetup = (taskSetupDraftId: string): AgentLoopTaskSetupController => {
    const boundDraftId = requiredText(taskSetupDraftId, "task setup draft id");
    const load = async (): Promise<AgentLoopTaskSetupViewModel> => {
      const context = await readOwnedSetup(boundDraftId);
      return toTaskSetupViewModel(context.model, context.draft, context.exactVersion);
    };
    return Object.freeze({
      load,
      subscribe(onChanged) {
        return options.client.subscribe({}, (invalidation) => {
          if (invalidation.reasons.includes("configuration_changed")) onChanged();
        });
      },
      async saveDraft(input: AgentLoopTaskSetupDraftInput) {
        assertBoundSetup(input.taskSetupDraftId, boundDraftId);
        const context = await readOwnedSetup(boundDraftId);
        if (context.draft.revision !== input.expectedRevision) throw new Error("agent_loop_task_setup_revision_stale");
        await issue(`task_setup.save_draft:${boundDraftId}:${input.expectedRevision}`, {
          type: "task_setup.save_draft",
          ownerId: options.ownerId,
          taskSetupDraftId: boundDraftId,
          expectedRevision: input.expectedRevision,
          workspaceId: requiredText(input.workspaceId, "workspace id"),
          title: requiredText(input.title, "task title"),
          goal: requiredText(input.goal, "task goal"),
          taskInputValues: orderedTaskInputValues(context.exactVersion.version.definition.taskInputSchema?.fields ?? [], input.schemaValues),
        });
        return load();
      },
      async createTask(input) {
        assertBoundSetup(input.taskSetupDraftId, boundDraftId);
        const { draft } = await readOwnedSetup(boundDraftId);
        if (draft.revision !== input.expectedRevision) throw new Error("agent_loop_task_setup_revision_stale");
        if (draft.state !== "draft") throw new Error("agent_loop_task_setup_draft_not_editable");
        const key = `task.create:${boundDraftId}:${input.expectedRevision}`;
        const taskId = pendingTaskIds.get(key) ?? createRuntimeId("task");
        pendingTaskIds.set(key, taskId);
        try {
          await issue(key, {
            type: "task.create",
            taskId,
            ownerId: options.ownerId,
            workspaceId: draft.workspaceId,
            taskSetupDraftId: boundDraftId,
            expectedTaskSetupRevision: input.expectedRevision,
          });
        } finally {
          if (!pendingCommands.has(key)) pendingTaskIds.delete(key);
        }
        return taskId;
      },
      async abandonDraft(input) {
        assertBoundSetup(input.taskSetupDraftId, boundDraftId);
        await issue(`task_setup.abandon_draft:${boundDraftId}:${input.expectedRevision}`, {
          type: "task_setup.abandon_draft",
          ownerId: options.ownerId,
          taskSetupDraftId: boundDraftId,
          expectedRevision: input.expectedRevision,
        });
      },
    });
  };

  return Object.freeze({
    meta,
    async createTaskSetupDraft(input) {
      const result = await issue(
        `task_setup.create_draft:${input.templateVersionId}:${input.workspaceId}:${input.title}:${input.goal}`,
        {
          type: "task_setup.create_draft",
          ownerId: options.ownerId,
          templateVersionId: requiredText(input.templateVersionId, "template version id"),
          workspaceId: requiredText(input.workspaceId, "workspace id"),
          title: requiredText(input.title, "task title"),
          goal: requiredText(input.goal, "task goal"),
          taskInputValues: [],
        },
      );
      if (!result.taskSetupDraft || result.taskSetupDraft.ownerId !== options.ownerId) {
        throw new Error("agent_loop_task_setup_create_result_unavailable");
      }
      return result.taskSetupDraft.taskSetupDraftId;
    },
    taskSetup,
  });
}

export function toMetaPanelViewModel(
  model: RuntimeReadModel,
  ownerId: string,
  scope: AgentLoopMetaScope,
): AgentLoopMetaPanelViewModel {
  const target = metaTarget(scope);
  const sessions = model.configuration.metaSessions.filter((candidate) =>
    candidate.ownerId === ownerId && sameTarget(candidate, target),
  );
  const session = sessions.find((candidate) => candidate.state === "active") ?? sessions.at(-1);
  const messages = session
    ? model.configuration.metaMessages
      .filter((message) => message.ownerId === ownerId && message.metaSessionId === session.metaSessionId)
      .map((message) => Object.freeze({
        messageId: message.metaMessageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }))
    : [];
  const proposals = session
    ? model.configuration.metaPatchProposals
      .filter((proposal) => proposal.ownerId === ownerId && proposal.metaSessionId === session.metaSessionId && sameProposalTarget(proposal, target))
      .map((proposal) => proposalView(model, scope, proposal))
    : [];
  const turn = session
    ? model.configuration.metaTurns.filter((candidate) => candidate.metaSessionId === session.metaSessionId).at(-1)
    : undefined;
  return Object.freeze({
    profileOptions: Object.freeze(model.configuration.metaProfileOptions.map((option) => Object.freeze({
      metaProfileOptionId: option.metaProfileOptionId,
      label: option.title,
      detail: `${option.profile.provider} · ${option.profile.model} · ${option.profile.providerVersion}`,
      readiness: option.availability,
      unavailableReasons: Object.freeze(option.unavailableReason ? [option.unavailableReason] : []),
    }))),
    ...(session ? {
      session: Object.freeze({
        metaSessionId: session.metaSessionId,
        revision: session.revision,
        status: metaSessionStatus(session.state, turn?.status),
        messages: Object.freeze(messages),
      }),
    } : {}),
    proposals: Object.freeze(proposals),
  });
}

async function resolveExactVersion(
  client: RuntimeClient,
  model: RuntimeReadModel,
  templateVersionId: string,
): Promise<ExactVersion> {
  if (model.template) {
    const selected = exactVersionFromSelection(model, templateVersionId);
    if (selected) return selected;
  }
  for (const entry of model.templateLibrary.templates) {
    if (entry.activeVersion?.templateVersionId === templateVersionId) {
      return Object.freeze({
        templateId: entry.template.templateId,
        templateTitle: entry.template.title,
        version: entry.activeVersion,
        profileReadiness: model.configuration.executionProfileReadiness,
      });
    }
  }
  // Runtime currently focuses Version history by Template identity. Resolve
  // all independent candidates concurrently so a historical exact Version
  // remains recoverable without serial read waterfalls.
  const selections = await Promise.all(model.templateLibrary.templates.map(({ template }) =>
    client.read({ templateId: template.templateId }),
  ));
  for (const selection of selections) {
    const exact = exactVersionFromSelection(selection, templateVersionId);
    if (exact) return exact;
  }
  throw new Error("agent_loop_task_setup_template_version_unavailable");
}

function exactVersionFromSelection(model: RuntimeReadModel, templateVersionId: string): ExactVersion | undefined {
  const selected = model.template;
  const version = selected?.versions.find((candidate) => candidate.templateVersionId === templateVersionId);
  if (!selected || !version) return undefined;
  return Object.freeze({
    templateId: selected.template.templateId,
    templateTitle: selected.template.title,
    version,
    profileReadiness: model.configuration.executionProfileReadiness,
  });
}

function toTaskSetupViewModel(
  model: RuntimeReadModel,
  draft: TaskSetupDraftRecord,
  exact: ExactVersion,
): AgentLoopTaskSetupViewModel {
  const values = new Map(draft.taskInputValues.map((item) => [item.fieldId, item.value] as const));
  const schemaFields = (exact.version.definition.taskInputSchema?.fields ?? []).map((field): AgentLoopTaskSetupSchemaField => Object.freeze({
    fieldId: field.fieldId,
    label: field.label,
    kind: field.kind,
    required: field.required,
    value: values.get(field.fieldId) ?? "",
    ...(field.kind === "choice" ? { options: Object.freeze(field.options.map((option) => Object.freeze({ ...option }))) } : {}),
    ...(field.description ? { help: field.description } : {}),
  }));
  const validationIssues = taskSetupValidationIssues(draft, exact.version.definition.taskInputSchema?.fields ?? []);
  const profileReadiness = new Map(exact.profileReadiness
    .filter((entry) => entry.templateVersionId === exact.version.templateVersionId)
    .map((entry) => [entry.executionProfileId, entry] as const));
  return Object.freeze({
    draft: Object.freeze({
      taskSetupDraftId: draft.taskSetupDraftId,
      revision: draft.revision,
      state: draft.state,
      templateVersion: Object.freeze({
        templateId: exact.templateId,
        templateVersionId: exact.version.templateVersionId,
        templateTitle: exact.templateTitle,
        version: exact.version.version,
      }),
      workspaceId: draft.workspaceId,
      title: draft.title,
      goal: draft.goal,
      schemaFields: Object.freeze(schemaFields),
      validationIssues: Object.freeze(validationIssues),
      valid: draft.state === "draft" && validationIssues.length === 0,
    }),
    workspaces: Object.freeze(model.workspaceLibrary.authorizations.map((workspace) => Object.freeze({
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
    }))),
    profileOptions: Object.freeze(exact.version.definition.executionProfiles.map((profile) => {
      const readiness = profileReadiness.get(profile.executionProfileId);
      return Object.freeze({
        executionProfileId: profile.executionProfileId,
        provider: profile.provider,
        providerLabel: providerLabel(profile.provider),
        model: profile.model,
        providerVersion: profile.providerVersion,
        permissionMode: profile.capabilityPolicy.permissionMode,
        requiredCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
        readiness: readiness?.status ?? "checking" as const,
        unavailableReasons: Object.freeze(readiness
          ? [...readiness.unavailableReasons]
          : ["provider_profile_readiness_unavailable"]),
      });
    })),
  });
}

function taskSetupValidationIssues(
  draft: TaskSetupDraftRecord,
  fields: readonly TaskInputFieldDefinition[],
): string[] {
  const issues: string[] = [];
  if (!draft.workspaceId.trim()) issues.push("Workspace is required.");
  if (!draft.title.trim()) issues.push("Task title is required.");
  if (!draft.goal.trim()) issues.push("Task goal is required.");
  const values = new Map(draft.taskInputValues.map((item) => [item.fieldId, item.value] as const));
  for (const field of fields) {
    const value = values.get(field.fieldId)?.trim() ?? "";
    if (field.required && !value) issues.push(`${field.label} is required.`);
    if (value && field.kind === "choice" && !field.options.some((option) => option.optionId === value)) {
      issues.push(`${field.label} has an invalid choice.`);
    }
  }
  return issues;
}

function orderedTaskInputValues(
  fields: readonly TaskInputFieldDefinition[],
  values: Readonly<Record<string, string>>,
): readonly TaskInputValue[] {
  return Object.freeze(fields.flatMap((field) => {
    const value = values[field.fieldId]?.trim();
    return value ? [Object.freeze({ fieldId: field.fieldId, value })] : [];
  }));
}

function proposalView(
  model: RuntimeReadModel,
  scope: AgentLoopMetaScope,
  proposal: MetaPatchProposalRecord,
) {
  const status = proposal.state === "pending" && proposal.targetRevision !== scope.draftRevision
    ? "stale" as const
    : proposal.state;
  return Object.freeze({
    proposalId: proposal.metaPatchProposalId,
    baseDraftRevision: proposal.targetRevision,
    status,
    summary: proposal.summary,
    rationale: proposal.rationale,
    fieldDiffs: Object.freeze(proposal.operations.map((operation) => operationDiff(model, scope, operation))),
    validationIssues: Object.freeze(proposal.validationIssues.map((issue) => `${issue.code}: ${issue.message}`)),
    unresolvedItems: Object.freeze([] as string[]),
  });
}

function operationDiff(
  model: RuntimeReadModel,
  scope: AgentLoopMetaScope,
  operation: MetaPatchOperation,
): AgentLoopMetaPatchFieldDiff {
  const templateDraft = scope.kind === "template_design"
    ? model.templateLibrary.drafts.find((draft) => draft.templateDraftId === scope.draftId)
    : undefined;
  const setupDraft = scope.kind === "task_setup"
    ? model.configuration.taskSetupDrafts.find((draft) => draft.taskSetupDraftId === scope.draftId)
    : undefined;
  switch (operation.kind) {
    case "template_metadata_set":
      return diff(`metadata.${operation.field}`, templateMetadataValue(templateDraft, operation.field), operation.value ?? undefined);
    case "template_conductor_prompt_set":
      return diff("definition.conductor.systemPrompt", templateDraft?.definition.conductor.systemPrompt, operation.value);
    case "template_card_prompt_set":
      return diff(`definition.agentCards[${operation.agentCardId}].systemPrompt`, templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId)?.systemPrompt, operation.value);
    case "template_profile_model_set":
      return diff(`definition.executionProfiles[${operation.executionProfileId}].model`, templateDraft?.definition.executionProfiles.find((profile) => profile.executionProfileId === operation.executionProfileId)?.model, operation.value);
    case "template_card_profile_set":
      return diff(`definition.agentCards[${operation.agentCardId}].executionProfileId`, templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId)?.executionProfileId, operation.executionProfileId);
    case "template_deliverable_upsert": {
      const before = templateDraft?.definition.deliverables.find((item) => item.artifactPath === operation.artifactPath);
      return diff(`definition.deliverables[${operation.artifactPath}]`, before ? JSON.stringify(before) : undefined, JSON.stringify(operation));
    }
    case "task_setup_title_set":
      return diff("title", setupDraft?.title, operation.value);
    case "task_setup_goal_set":
      return diff("goal", setupDraft?.goal, operation.value);
    case "task_setup_input_set":
      return diff(`taskInputValues[${operation.fieldId}]`, setupDraft?.taskInputValues.find((value) => value.fieldId === operation.fieldId)?.value, operation.value);
  }
}

function diff(path: string, before: string | undefined, after: string | undefined): AgentLoopMetaPatchFieldDiff {
  return Object.freeze({
    path,
    operation: before === undefined ? "add" : after === undefined ? "remove" : "replace",
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });
}

function templateMetadataValue(
  draft: TemplateDraftRecord | undefined,
  field: "title" | "slug" | "description",
): string | undefined {
  return draft?.metadata[field];
}

async function requireMetaProposal(
  client: RuntimeClient,
  ownerId: string,
  scope: AgentLoopMetaScope,
  proposalId: string,
): Promise<Readonly<{ session: MetaSessionRecord; proposal: MetaPatchProposalRecord }>> {
  const model = await client.read();
  const target = metaTarget(scope);
  const proposal = model.configuration.metaPatchProposals.find((candidate) =>
    candidate.metaPatchProposalId === proposalId
    && candidate.ownerId === ownerId
    && sameProposalTarget(candidate, target),
  );
  if (!proposal) throw new Error("agent_loop_meta_patch_proposal_unavailable");
  const session = model.configuration.metaSessions.find((candidate) =>
    candidate.metaSessionId === proposal.metaSessionId
    && candidate.ownerId === ownerId
    && sameTarget(candidate, target),
  );
  if (!session) throw new Error("agent_loop_meta_session_unavailable");
  return Object.freeze({ session, proposal });
}

function metaTarget(scope: AgentLoopMetaScope) {
  return scope.kind === "template_design"
    ? { kind: "template_draft" as const, templateDraftId: scope.draftId }
    : { kind: "task_setup_draft" as const, taskSetupDraftId: scope.draftId };
}

function sameTarget(session: MetaSessionRecord, target: ReturnType<typeof metaTarget>): boolean {
  return session.target.kind === target.kind
    && (target.kind === "template_draft"
      ? session.target.kind === "template_draft" && session.target.templateDraftId === target.templateDraftId
      : session.target.kind === "task_setup_draft" && session.target.taskSetupDraftId === target.taskSetupDraftId);
}

function sameProposalTarget(proposal: MetaPatchProposalRecord, target: ReturnType<typeof metaTarget>): boolean {
  return proposal.target.kind === target.kind
    && (target.kind === "template_draft"
      ? proposal.target.kind === "template_draft" && proposal.target.templateDraftId === target.templateDraftId
      : proposal.target.kind === "task_setup_draft" && proposal.target.taskSetupDraftId === target.taskSetupDraftId);
}

function targetKey(target: ReturnType<typeof metaTarget>): string {
  return target.kind === "template_draft" ? target.templateDraftId : target.taskSetupDraftId;
}

function metaSessionStatus(
  state: MetaSessionRecord["state"],
  turnStatus?: RuntimeReadModel["configuration"]["metaTurns"][number]["status"],
): "creating" | "active" | "idle" | "failed" | "abandoned" {
  if (state === "active" && (turnStatus === "pending" || turnStatus === "leased" || turnStatus === "provider_accepted")) return "creating";
  if (state === "active" && (turnStatus === "ambiguous" || turnStatus === "failed" || turnStatus === "rejected")) return "failed";
  if (state === "active" && turnStatus === "returned") return "idle";
  if (state === "active") return "active";
  if (state === "abandoned") return "abandoned";
  return "idle";
}

function providerLabel(provider: string): string {
  if (provider === "opencode") return "OpenCode";
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  return provider;
}

function assertBoundSetup(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("agent_loop_task_setup_scope_mismatch");
}

function withCommandEnvelope(command: RuntimeCommandInput, now: () => string, commandId: string): RuntimeCommand {
  return Object.freeze({ ...command, commandId, issuedAt: now() }) as RuntimeCommand;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}
