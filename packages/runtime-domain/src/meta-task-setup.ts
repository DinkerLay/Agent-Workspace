import type {
  MetaPatchOperation,
  MetaMessageRecord,
  MetaPatchProposalRecord,
  MetaPatchProposalRecordFor,
  MetaPatchValidationIssue,
  MetaProfileDefinition,
  MetaProfileDefinitionV2,
  MetaProfileDefinitionV3,
  MetaProfileSnapshot,
  MetaSessionRecord,
  MetaSessionRecordFor,
  MetaSessionRecordV2,
  MetaSessionRecordV3,
  MetaSessionTarget,
  TaskInputSchema,
  TaskInputValue,
  TaskSetupDraftRecord,
  TemplateDraftRecord,
} from "@agent-workspace/runtime-contracts";
import {
  hashDefinition,
  isMetaProfileDefinitionV3,
  isTemplateDefinitionV3,
  renderTaskGoalContentV1,
  validateMetaProfileDefinitionV2,
  validateMetaProfileDefinitionV3,
  validateTemplateDefinitionSnapshot,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";

const MAX_PATCH_OPERATIONS = 64;
export const TASK_GOAL_COMPILER_VERSION = "task-goal/v1" as const;

export function createTaskSetupDraft(input: Readonly<{
  taskSetupDraftId: string;
  ownerId: string;
  templateVersionId: string;
  workspaceId: string;
  title: string;
  goal: string;
  schema?: TaskInputSchema;
  taskInputValues: readonly TaskInputValue[];
  now: string;
}>): TaskSetupDraftRecord {
  invariant(input.taskSetupDraftId.startsWith("task_setup_draft_"), "task_setup_draft_id_invalid");
  invariant(input.templateVersionId.startsWith("template_version_"), "task_setup_template_version_id_invalid");
  invariant(input.workspaceId.startsWith("workspace_"), "task_setup_workspace_id_invalid");
  return {
    taskSetupDraftId: input.taskSetupDraftId,
    ownerId: requiredText(input.ownerId, "task_setup_owner_required", 300),
    templateVersionId: input.templateVersionId,
    workspaceId: input.workspaceId,
    title: requiredSingleLineText(input.title, "task_setup_title_required", 300),
    goal: requiredNormalizedText(input.goal, "task_setup_goal_required", 16_000),
    taskInputValues: normalizeTaskInputValues(input.schema, input.taskInputValues),
    state: "draft",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function saveTaskSetupDraft(
  draft: TaskSetupDraftRecord,
  input: Readonly<{
    expectedRevision: number;
    workspaceId: string;
    title: string;
    goal: string;
    schema?: TaskInputSchema;
    taskInputValues: readonly TaskInputValue[];
    now: string;
  }>,
): TaskSetupDraftRecord {
  assertDraftEditable(draft, input.expectedRevision);
  invariant(input.workspaceId.startsWith("workspace_"), "task_setup_workspace_id_invalid");
  return {
    ...draft,
    workspaceId: input.workspaceId,
    title: requiredSingleLineText(input.title, "task_setup_title_required", 300),
    goal: requiredNormalizedText(input.goal, "task_setup_goal_required", 16_000),
    taskInputValues: normalizeTaskInputValues(input.schema, input.taskInputValues),
    revision: draft.revision + 1,
    updatedAt: input.now,
  };
}

export function abandonTaskSetupDraft(
  draft: TaskSetupDraftRecord,
  expectedRevision: number,
  now: string,
): TaskSetupDraftRecord {
  assertDraftEditable(draft, expectedRevision);
  return { ...draft, state: "abandoned", revision: draft.revision + 1, updatedAt: now };
}

export function consumeTaskSetupDraft(
  draft: TaskSetupDraftRecord,
  taskId: string,
  expectedRevision: number,
  now: string,
): TaskSetupDraftRecord {
  assertDraftEditable(draft, expectedRevision);
  invariant(taskId.startsWith("task_"), "task_setup_created_task_id_invalid");
  return {
    ...draft,
    state: "consumed",
    createdTaskId: taskId,
    revision: draft.revision + 1,
    updatedAt: now,
  };
}

export function assertTaskSetupReadyForCreate(draft: TaskSetupDraftRecord, schema?: TaskInputSchema): void {
  invariant(draft.state === "draft", "task_setup_draft_not_editable");
  assertTaskInputValuesComplete(schema, normalizeTaskInputValues(schema, draft.taskInputValues));
}

export function compileTaskGoal(
  input: Readonly<{ title: string; goal: string; taskInputValues: readonly TaskInputValue[] }>,
  schema?: TaskInputSchema,
): string {
  const title = requiredSingleLineText(input.title, "task_setup_title_required", 300);
  const goal = requiredNormalizedText(input.goal, "task_setup_goal_required", 16_000);
  const values = normalizeTaskInputValues(schema, input.taskInputValues);
  assertTaskInputValuesComplete(schema, values);
  return renderTaskGoalContentV1({ title, goal, taskInputValues: values }, schema);
}

/** @deprecated Constructs historical v2 fixtures only; every durable writer rejects the result. */
export function createMetaSession(input: Readonly<{
  metaSessionId: string;
  ownerId: string;
  target: MetaSessionTarget;
  metaProfileOptionId: string;
  metaProfile: MetaProfileDefinition;
  now: string;
}>): MetaSessionRecordV2 {
  return constructMetaSession({
    ...input,
    metaProfile: validateMetaProfileDefinitionV2(input.metaProfile),
  });
}

/** New configuration effects freeze only a validated portable ACP profile. */
export function createMetaSessionV3(input: Readonly<{
  metaSessionId: string;
  ownerId: string;
  target: MetaSessionTarget;
  metaProfileOptionId: string;
  metaProfile: MetaProfileDefinitionV3;
  now: string;
}>): MetaSessionRecordV3 {
  return constructMetaSession({
    ...input,
    metaProfile: validateMetaProfileDefinitionV3(input.metaProfile),
  });
}

function constructMetaSession<Profile extends MetaProfileSnapshot>(input: Readonly<{
  metaSessionId: string;
  ownerId: string;
  target: MetaSessionTarget;
  metaProfileOptionId: string;
  metaProfile: Profile;
  now: string;
}>): MetaSessionRecordFor<Profile> {
  invariant(input.metaSessionId.startsWith("meta_session_"), "meta_session_id_invalid");
  const base = {
    metaSessionId: input.metaSessionId,
    ownerId: requiredText(input.ownerId, "meta_session_owner_required", 300),
    metaProfileOptionId: requiredOpaqueId(input.metaProfileOptionId, "meta_profile_option_", "meta_profile_option_id_invalid"),
    metaProfile: input.metaProfile,
    state: "active" as const,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (input.target.kind === "template_draft") {
    invariant(input.target.templateDraftId.startsWith("template_draft_"), "meta_session_template_draft_id_invalid");
    return { ...base, mode: "template_design", target: { ...input.target } };
  }
  invariant(input.target.taskSetupDraftId.startsWith("task_setup_draft_"), "meta_session_task_setup_draft_id_invalid");
  return { ...base, mode: "task_setup", target: { ...input.target } };
}

export function appendMetaMessage(input: Readonly<{
  session: MetaSessionRecord;
  metaMessageId: string;
  expectedSessionRevision: number;
  role: MetaMessageRecord["role"];
  content: string;
  now: string;
}>): Readonly<{ session: MetaSessionRecord; message: MetaMessageRecord }> {
  invariant(input.session.state === "active", "meta_session_not_active");
  invariant(input.session.revision === input.expectedSessionRevision, "meta_session_revision_stale");
  invariant(input.metaMessageId.startsWith("meta_message_"), "meta_message_id_invalid");
  invariant(input.role === "user" || input.role === "assistant", "meta_message_role_invalid");
  invariant(typeof input.content === "string" && Boolean(input.content.trim()), "meta_message_content_required");
  invariant(input.content.length <= 50_000, "meta_message_content_too_long");
  const message: MetaMessageRecord = {
    metaMessageId: input.metaMessageId,
    metaSessionId: input.session.metaSessionId,
    ownerId: input.session.ownerId,
    role: input.role,
    content: input.content,
    contentDigest: hashDefinition(input.content),
    createdAt: input.now,
  };
  return {
    message,
    session: {
      ...input.session,
      revision: input.session.revision + 1,
      updatedAt: input.now,
    },
  };
}

export function abandonMetaSession(session: MetaSessionRecord, expectedRevision: number, now: string): MetaSessionRecord {
  invariant(session.state === "active", "meta_session_not_active");
  invariant(session.revision === expectedRevision, "meta_session_revision_stale");
  return { ...session, state: "abandoned", revision: session.revision + 1, updatedAt: now };
}

export function consumeMetaSession(session: MetaSessionRecord, expectedRevision: number, now: string): MetaSessionRecord {
  invariant(session.state === "active", "meta_session_not_active");
  invariant(session.revision === expectedRevision, "meta_session_revision_stale");
  return { ...session, state: "consumed", revision: session.revision + 1, updatedAt: now };
}

export function createMetaPatchProposal(input: Readonly<{
  metaPatchProposalId: string;
  session: MetaSessionRecord;
  targetRevision: number;
  operations: readonly MetaPatchOperation[];
  summary: string;
  rationale: string;
  validationIssues: readonly MetaPatchValidationIssue[];
  now: string;
}>): MetaPatchProposalRecord {
  return isMetaSessionV3(input.session)
    ? constructMetaPatchProposal(
        { ...input, session: input.session },
        validateMetaProfileDefinitionV3(input.session.metaProfile),
      )
    : constructMetaPatchProposal(
        { ...input, session: input.session },
        validateMetaProfileDefinitionV2(input.session.metaProfile),
      );
}

function constructMetaPatchProposal<Profile extends MetaProfileSnapshot>(
  input: Readonly<{
    metaPatchProposalId: string;
    session: MetaSessionRecordFor<Profile>;
    targetRevision: number;
    operations: readonly MetaPatchOperation[];
    summary: string;
    rationale: string;
    validationIssues: readonly MetaPatchValidationIssue[];
    now: string;
  }>,
  sourceMetaProfile: Profile,
): MetaPatchProposalRecordFor<Profile> {
  invariant(input.metaPatchProposalId.startsWith("meta_patch_proposal_"), "meta_patch_proposal_id_invalid");
  invariant(input.session.state === "active", "meta_session_not_active");
  invariant(Number.isSafeInteger(input.targetRevision) && input.targetRevision > 0, "meta_patch_target_revision_invalid");
  invariant(input.operations.length > 0 && input.operations.length <= MAX_PATCH_OPERATIONS, "meta_patch_operations_invalid");
  assertOperationsMatchMode(input.session, input.operations);
  return {
    metaPatchProposalId: input.metaPatchProposalId,
    metaSessionId: input.session.metaSessionId,
    ownerId: input.session.ownerId,
    mode: input.session.mode,
    target: { ...input.session.target },
    sourceMetaProfileOptionId: input.session.metaProfileOptionId,
    sourceMetaProfile,
    sourceMetaSessionRevision: input.session.revision,
    targetRevision: input.targetRevision,
    operations: input.operations.map(cloneOperation),
    summary: requiredText(input.summary, "meta_patch_summary_required", 1_000),
    rationale: requiredText(input.rationale, "meta_patch_rationale_required", 4_000),
    validationIssues: input.validationIssues.map((issue) => ({
      code: requiredText(issue.code, "meta_patch_validation_issue_code_required", 160),
      message: requiredText(issue.message, "meta_patch_validation_issue_message_required", 1_000),
      ...(issue.operationIndex === undefined ? {} : { operationIndex: issue.operationIndex }),
    })),
    state: "pending",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function applyMetaPatchProposalToTemplateDraft(input: Readonly<{
  draft: TemplateDraftRecord;
  session: MetaSessionRecord;
  proposal: MetaPatchProposalRecord;
  expectedTargetRevision: number;
  now: string;
}>): Readonly<{ draft: TemplateDraftRecord; proposal: MetaPatchProposalRecord }> {
  assertProposalApplicable(input.session, input.proposal, input.expectedTargetRevision, input.draft.revision, "template_design");
  invariant(input.session.target.kind === "template_draft" && input.session.target.templateDraftId === input.draft.templateDraftId, "meta_patch_target_mismatch");
  let metadata = { ...input.draft.metadata };
  let definition = input.draft.definition;
  for (const operation of input.proposal.operations) {
    switch (operation.kind) {
      case "template_metadata_set": {
        if (operation.field === "description" && operation.value === null) {
          metadata = {
            title: metadata.title,
            ...(metadata.slug === undefined ? {} : { slug: metadata.slug }),
          };
        } else {
          invariant(operation.value !== null, "meta_patch_metadata_value_required");
          metadata = { ...metadata, [operation.field]: requiredText(operation.value, "meta_patch_metadata_value_required", operation.field === "description" ? 2_000 : 300) };
        }
        break;
      }
      case "template_conductor_prompt_set":
        definition = { ...definition, conductor: { ...definition.conductor, systemPrompt: requiredText(operation.value, "meta_patch_prompt_required", 32_000) } };
        break;
      case "template_card_prompt_set": {
        let matched = false;
        const agentCards = definition.agentCards.map((card) => {
          if (card.agentCardId !== operation.agentCardId) return card;
          matched = true;
          return { ...card, systemPrompt: requiredText(operation.value, "meta_patch_prompt_required", 32_000) };
        });
        invariant(matched, "meta_patch_agent_card_not_found");
        definition = { ...definition, agentCards };
        break;
      }
      case "template_profile_model_set": {
        let matched = false;
        const model = requiredText(operation.value, "meta_patch_profile_model_required", 500);
        const executionProfiles = isTemplateDefinitionV3(definition)
          ? definition.executionProfiles.map((profile) => {
              if (profile.executionProfileId !== operation.executionProfileId) return profile;
              matched = true;
              return { ...profile, model };
            })
          : definition.executionProfiles.map((profile) => {
              if (profile.executionProfileId !== operation.executionProfileId) return profile;
              matched = true;
              return { ...profile, model };
            });
        invariant(matched, "meta_patch_execution_profile_not_found");
        definition = isTemplateDefinitionV3(definition)
          ? { ...definition, executionProfiles: executionProfiles as typeof definition.executionProfiles }
          : { ...definition, executionProfiles: executionProfiles as typeof definition.executionProfiles };
        break;
      }
      case "template_card_profile_set": {
        invariant(definition.executionProfiles.some((profile) => profile.executionProfileId === operation.executionProfileId), "meta_patch_execution_profile_not_found");
        if (definition.conductor.agentCardId === operation.agentCardId) {
          definition = { ...definition, conductor: { ...definition.conductor, executionProfileId: operation.executionProfileId } };
          break;
        }
        let matched = false;
        const agentCards = definition.agentCards.map((card) => {
          if (card.agentCardId !== operation.agentCardId) return card;
          matched = true;
          return { ...card, executionProfileId: operation.executionProfileId };
        });
        invariant(matched, "meta_patch_agent_card_not_found");
        definition = { ...definition, agentCards };
        break;
      }
      case "template_deliverable_upsert": {
        const deliverable = {
          artifactPath: requiredArtifactPath(operation.artifactPath),
          ownerAgentCardId: operation.ownerAgentCardId,
          ...(operation.description === undefined ? {} : { description: requiredText(operation.description, "meta_patch_deliverable_description_required", 2_000) }),
        };
        const index = definition.deliverables.findIndex((candidate) => candidate.artifactPath === deliverable.artifactPath);
        const deliverables = [...definition.deliverables];
        if (index === -1) deliverables.push(deliverable);
        else deliverables[index] = deliverable;
        definition = { ...definition, deliverables };
        break;
      }
      default:
        throw new Error("meta_session_mode_mismatch");
    }
  }
  definition = validateTemplateDefinitionSnapshot(definition);
  const draft: TemplateDraftRecord = {
    ...input.draft,
    metadata,
    definition,
    revision: input.draft.revision + 1,
    updatedAt: input.now,
  };
  return { draft, proposal: markProposalApplied(input.proposal, draft.revision, input.now) };
}

export function applyMetaPatchProposalToTaskSetup(input: Readonly<{
  draft: TaskSetupDraftRecord;
  schema?: TaskInputSchema;
  session: MetaSessionRecord;
  proposal: MetaPatchProposalRecord;
  expectedTargetRevision: number;
  now: string;
}>): Readonly<{ draft: TaskSetupDraftRecord; proposal: MetaPatchProposalRecord }> {
  assertProposalApplicable(input.session, input.proposal, input.expectedTargetRevision, input.draft.revision, "task_setup");
  invariant(input.session.target.kind === "task_setup_draft" && input.session.target.taskSetupDraftId === input.draft.taskSetupDraftId, "meta_patch_target_mismatch");
  let title = input.draft.title;
  let goal = input.draft.goal;
  const values = new Map(input.draft.taskInputValues.map((value) => [value.fieldId, value.value] as const));
  for (const operation of input.proposal.operations) {
    switch (operation.kind) {
      case "task_setup_title_set":
        title = requiredSingleLineText(operation.value, "task_setup_title_required", 300);
        break;
      case "task_setup_goal_set":
        goal = requiredNormalizedText(operation.value, "task_setup_goal_required", 16_000);
        break;
      case "task_setup_input_set":
        invariant((input.schema?.fields ?? []).some((field) => field.fieldId === operation.fieldId), "meta_patch_task_input_not_found");
        values.set(operation.fieldId, operation.value);
        break;
      default:
        throw new Error("meta_session_mode_mismatch");
    }
  }
  const draft: TaskSetupDraftRecord = {
    ...input.draft,
    title,
    goal,
    taskInputValues: normalizeTaskInputValues(input.schema, [...values].map(([fieldId, value]) => ({ fieldId, value }))),
    revision: input.draft.revision + 1,
    updatedAt: input.now,
  };
  return { draft, proposal: markProposalApplied(input.proposal, draft.revision, input.now) };
}

export function rejectMetaPatchProposal(input: Readonly<{
  proposal: MetaPatchProposalRecord;
  session: MetaSessionRecord;
  now: string;
}>): MetaPatchProposalRecord {
  assertProposalSession(input.session, input.proposal);
  invariant(input.proposal.state === "pending", "meta_patch_not_pending");
  return {
    ...input.proposal,
    state: "rejected",
    revision: input.proposal.revision + 1,
    updatedAt: input.now,
    resolvedAt: input.now,
  };
}

function normalizeTaskInputValues(schema: TaskInputSchema | undefined, input: readonly TaskInputValue[]): readonly TaskInputValue[] {
  const fields = schema?.fields ?? [];
  const byFieldId = new Map<string, string>();
  for (const item of input) {
    invariant(typeof item.fieldId === "string" && typeof item.value === "string", "task_setup_input_value_invalid");
    invariant(!byFieldId.has(item.fieldId), `task_setup_input_duplicate:${item.fieldId}`);
    invariant(fields.some((field) => field.fieldId === item.fieldId), `task_setup_input_unknown:${item.fieldId}`);
    byFieldId.set(item.fieldId, item.value);
  }
  return fields.flatMap((field) => {
    const rawValue = byFieldId.get(field.fieldId);
    if (rawValue === undefined) return [];
    const value = normalizeLineEndings(rawValue).trim();
    if (!value) return [];
    if (field.kind === "choice" && !field.options.some((option) => option.optionId === value)) {
      throw new Error(`task_setup_choice_invalid:${field.fieldId}`);
    }
    const maximum = field.kind === "short_text" ? 1_000 : 16_000;
    invariant(value.length <= maximum, `task_setup_input_too_long:${field.fieldId}`);
    if (field.kind === "short_text") {
      invariant(!value.includes("\n"), `task_setup_short_text_multiline:${field.fieldId}`);
    }
    return [{ fieldId: field.fieldId, value }];
  });
}

function assertTaskInputValuesComplete(schema: TaskInputSchema | undefined, values: readonly TaskInputValue[]): void {
  const provided = new Set(values.map((value) => value.fieldId));
  for (const field of schema?.fields ?? []) {
    if (field.required) invariant(provided.has(field.fieldId), `task_setup_required_input_missing:${field.fieldId}`);
  }
}

function assertDraftEditable(draft: TaskSetupDraftRecord, expectedRevision: number): void {
  invariant(draft.state === "draft", "task_setup_draft_not_editable");
  invariant(draft.revision === expectedRevision, "task_setup_draft_revision_stale");
}

function assertProposalApplicable(
  session: MetaSessionRecord,
  proposal: MetaPatchProposalRecord,
  expectedTargetRevision: number,
  currentTargetRevision: number,
  mode: MetaSessionRecord["mode"],
): void {
  assertProposalSession(session, proposal);
  invariant(session.mode === mode && proposal.mode === mode, "meta_session_mode_mismatch");
  invariant(proposal.state === "pending", "meta_patch_not_pending");
  invariant(proposal.validationIssues.length === 0, "meta_patch_validation_issues_unresolved");
  invariant(proposal.targetRevision === expectedTargetRevision && currentTargetRevision === expectedTargetRevision, "meta_patch_target_revision_stale");
}

function assertProposalSession(session: MetaSessionRecord, proposal: MetaPatchProposalRecord): void {
  invariant(session.state === "active", "meta_session_not_active");
  invariant(proposal.metaSessionId === session.metaSessionId && proposal.ownerId === session.ownerId, "meta_patch_session_mismatch");
  invariant(JSON.stringify(proposal.target) === JSON.stringify(session.target), "meta_patch_target_mismatch");
  invariant(proposal.sourceMetaProfileOptionId === session.metaProfileOptionId, "meta_patch_profile_option_mismatch");
  invariant(JSON.stringify(proposal.sourceMetaProfile) === JSON.stringify(session.metaProfile), "meta_patch_profile_snapshot_mismatch");
}

function assertOperationsMatchMode(
  session: Pick<MetaSessionRecordFor<MetaProfileSnapshot>, "mode">,
  operations: readonly MetaPatchOperation[],
): void {
  const prefix = session.mode === "template_design" ? "template_" : "task_setup_";
  invariant(operations.every((operation) => operation.kind.startsWith(prefix)), "meta_session_mode_mismatch");
}

function markProposalApplied(proposal: MetaPatchProposalRecord, appliedTargetRevision: number, now: string): MetaPatchProposalRecord {
  return {
    ...proposal,
    state: "applied",
    appliedTargetRevision,
    revision: proposal.revision + 1,
    updatedAt: now,
    resolvedAt: now,
  };
}

function requiredText(value: string, code: string, maximum: number): string {
  invariant(typeof value === "string" && Boolean(value.trim()), code);
  const normalized = value.trim();
  invariant(normalized.length <= maximum, code);
  return normalized;
}

function requiredNormalizedText(value: string, code: string, maximum: number): string {
  return requiredText(normalizeLineEndings(value), code, maximum);
}

function requiredSingleLineText(value: string, code: string, maximum: number): string {
  const normalized = requiredNormalizedText(value, code, maximum);
  invariant(!normalized.includes("\n"), code);
  return normalized;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function requiredArtifactPath(value: string): string {
  const normalized = requiredText(value, "meta_patch_deliverable_path_required", 1_000).replaceAll("\\", "/");
  invariant(!normalized.startsWith("/") && !normalized.split("/").includes(".."), "meta_patch_deliverable_path_invalid");
  return normalized;
}

function isMetaSessionV3(session: MetaSessionRecord): session is MetaSessionRecordV3 {
  return isMetaProfileDefinitionV3(session.metaProfile);
}

function cloneOperation(operation: MetaPatchOperation): MetaPatchOperation {
  return { ...operation };
}

function requiredOpaqueId(value: string, prefix: string, code: string): string {
  invariant(typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length, code);
  return value;
}
