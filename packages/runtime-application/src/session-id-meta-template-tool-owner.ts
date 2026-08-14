import {
  TEMPLATE_DRAFT_MCP_TOOL_DEFINITIONS,
  type ExecutionProfileDefinitionV3,
  type MetaSessionRecordV3,
  type TemplateDraftRecord,
} from "@agent-workspace/runtime-contracts";
import {
  normalizeProviderScopedToolRegistration,
  type ProviderScopedToolCall,
  type ProviderScopedToolRegistration,
  type ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type { ConfigurationStore, TemplateTaskStore } from "@agent-workspace/runtime-store";
import {
  parseMetaPatchIntentOperation,
  type MetaPatchIntentOperation,
} from "@agent-workspace/runtime-domain";

export type SessionIdMetaTemplateToolOwnerOptions = Readonly<{
  templates: Pick<TemplateTaskStore, "getDraft">;
  toolOperations: Pick<ConfigurationStore,
    "recordMetaTurnToolOperation" | "listMetaTurnToolOperations">;
  listTemplateProfileRevisions?: (input: Readonly<{
    draft: TemplateDraftRecord;
    executionProfileId: string;
  }>) => readonly ExecutionProfileDefinitionV3[];
}>;

export type SessionIdMetaTemplateToolTurn = Readonly<{
  session: MetaSessionRecordV3;
  metaTurnId: string;
  targetRevision: number;
}>;

export type SessionIdMetaTemplateToolOwner = Readonly<{
  registration: ProviderScopedToolRegistration;
  createTurnContext(turn: SessionIdMetaTemplateToolTurn): ProviderScopedToolTurnContext;
  listTurnOperations(metaTurnId: string): readonly MetaPatchIntentOperation[];
}>;

/**
 * Proposal-only Template Draft tools. Calls read the exact current Draft and
 * return normalized proposal operations; they never persist or apply them.
 */
export function createSessionIdMetaTemplateToolOwner(
  options: SessionIdMetaTemplateToolOwnerOptions,
): SessionIdMetaTemplateToolOwner {
  if (!options?.templates || typeof options.templates.getDraft !== "function") {
    throw new Error("meta_template_tool_options_invalid");
  }
  if (!options.toolOperations
    || typeof options.toolOperations.recordMetaTurnToolOperation !== "function"
    || typeof options.toolOperations.listMetaTurnToolOperations !== "function") {
    throw new Error("meta_template_tool_operation_store_invalid");
  }
  if (options.listTemplateProfileRevisions !== undefined
    && typeof options.listTemplateProfileRevisions !== "function") {
    throw new Error("meta_template_tool_profile_resolver_invalid");
  }
  const registration = normalizeProviderScopedToolRegistration({
    capabilityClass: "template_draft",
    tools: TEMPLATE_DRAFT_MCP_TOOL_DEFINITIONS,
  });

  return Object.freeze({
    registration,
    createTurnContext(turn) {
      if (turn.session.mode !== "template_design"
        || turn.session.target.kind !== "template_draft"
        || turn.session.state !== "active") {
        throw new Error("meta_template_tool_scope_invalid");
      }
      if (!turn.metaTurnId.startsWith("meta_turn_")
        || !Number.isSafeInteger(turn.targetRevision)
        || turn.targetRevision < 0) {
        throw new Error("meta_template_tool_turn_invalid");
      }
      const lease = Object.freeze(Object.create(null));
      return Object.freeze({
        capabilityClass: "template_draft" as const,
        lease,
        async handleCall(call: ProviderScopedToolCall) {
          if (call.lease !== lease) throw new Error("meta_template_tool_lease_invalid");
          const draft = requireDraft(turn.session, turn.targetRevision, options.templates);
          const result = dispatch(
            call.name,
            call.arguments,
            draft,
            options,
            new Set(readTurnOperations(options, turn.metaTurnId)
              .filter((entry) => entry.kind === "template_card_create")
              .map((entry) => entry.proposalRef)),
          );
          const operation = proposalOperation(result);
          if (operation) {
            options.toolOperations.recordMetaTurnToolOperation({
              metaTurnId: turn.metaTurnId,
              targetRevision: turn.targetRevision,
              providerCallId: call.providerCallId,
              operation: JSON.parse(JSON.stringify(operation)),
            });
          }
          return Object.freeze({
            providerCallId: call.providerCallId,
            result,
          });
        },
      });
    },
    listTurnOperations(metaTurnId) {
      if (!/^meta_turn_[A-Za-z0-9_-]+$/u.test(metaTurnId)) {
        throw new Error("meta_template_tool_turn_invalid");
      }
      return readTurnOperations(options, metaTurnId);
    },
  });
}

function readTurnOperations(
  options: SessionIdMetaTemplateToolOwnerOptions,
  metaTurnId: string,
): readonly MetaPatchIntentOperation[] {
  return Object.freeze(options.toolOperations.listMetaTurnToolOperations(metaTurnId)
    .map(parseMetaPatchIntentOperation));
}

function proposalOperation(value: unknown): MetaPatchIntentOperation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = (value as { operation?: unknown }).operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return undefined;
  return operation as MetaPatchIntentOperation;
}

function dispatch(
  name: string,
  value: unknown,
  draft: TemplateDraftRecord,
  options: SessionIdMetaTemplateToolOwnerOptions,
  proposalRefs: ReadonlySet<string>,
): unknown {
  switch (name) {
    case "template_draft_read": return readTarget(draft, exactRecord(value, ["target"]).target, options);
    case "template_draft_update_metadata": return updateMetadata(draft, value);
    case "template_draft_create_card": return createCard(draft, value);
    case "template_draft_update_card": return updateCard(draft, value);
    case "template_draft_edit_prompt": return editPrompt(draft, value);
    case "template_draft_delete_card": return deleteCard(draft, value);
    case "template_draft_reorder_cards": return reorderCards(draft, value, proposalRefs);
    case "template_draft_select_profile": return selectProfile(draft, value, options);
    case "template_draft_upsert_deliverable": return upsertDeliverable(draft, value);
    case "template_draft_delete_deliverable": return deleteDeliverable(draft, value);
    default: throw new Error("meta_template_tool_not_registered");
  }
}

function updateMetadata(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["field", "value"]);
  const field = requiredText(input.field, "meta_template_tool_metadata_field_invalid", 40);
  if (field !== "title" && field !== "slug" && field !== "description") {
    throw new Error("meta_template_tool_metadata_field_invalid");
  }
  if (input.value !== null && typeof input.value !== "string") {
    throw new Error("meta_template_tool_metadata_value_invalid");
  }
  if (field !== "description" && input.value === null) {
    throw new Error("meta_template_tool_metadata_value_invalid");
  }
  const maximum = field === "description" ? 2_000 : 300;
  const normalized = input.value === null
    ? null
    : requiredText(input.value, "meta_template_tool_metadata_value_invalid", maximum);
  return operationResult(draft, { kind: "template_metadata_set", field, value: normalized });
}

function readTarget(
  draft: TemplateDraftRecord,
  value: unknown,
  options: SessionIdMetaTemplateToolOwnerOptions,
): unknown {
  const target = exactRecord(value, ["kind", "agentCardId", "executionProfileId"]);
  const kind = requiredText(target.kind, "meta_template_tool_target_invalid", 40);
  if (kind === "template") {
    exactOptionalAbsent(target, ["agentCardId", "executionProfileId"]);
    return Object.freeze({
      targetRevision: draft.revision,
      metadata: Object.freeze({ ...draft.metadata }),
      conductor: safeCard(draft.definition.conductor),
      agentCards: Object.freeze(draft.definition.agentCards.map(safeCard)),
      executionProfiles: Object.freeze(draft.definition.executionProfiles.map(safeProfile)),
      deliverables: Object.freeze(draft.definition.deliverables.map((entry) => Object.freeze({ ...entry }))),
    });
  }
  if (kind === "conductor") {
    exactOptionalAbsent(target, ["agentCardId", "executionProfileId"]);
    return Object.freeze({ targetRevision: draft.revision, conductor: safeCard(draft.definition.conductor) });
  }
  if (kind === "card") {
    if (target.executionProfileId !== undefined) throw new Error("meta_template_tool_target_invalid");
    const agentCardId = opaqueId(target.agentCardId, "agent_card_");
    const card = draft.definition.agentCards.find((candidate) => candidate.agentCardId === agentCardId);
    if (!card) throw new Error("meta_patch_agent_card_not_found");
    return Object.freeze({ targetRevision: draft.revision, card: safeCard(card) });
  }
  if (kind === "profile") {
    if (target.agentCardId !== undefined) throw new Error("meta_template_tool_target_invalid");
    const executionProfileId = opaqueId(target.executionProfileId, "profile_");
    const current = draft.definition.executionProfiles.find((candidate) => candidate.executionProfileId === executionProfileId);
    if (!current) throw new Error("meta_patch_execution_profile_not_found");
    const revisions = options.listTemplateProfileRevisions?.({ draft, executionProfileId }) ?? [];
    return Object.freeze({
      targetRevision: draft.revision,
      profile: safeProfile(current),
      availableRevisions: Object.freeze(revisions.map(safeProfile)),
    });
  }
  throw new Error("meta_template_tool_target_invalid");
}

function createCard(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, [
    "proposalRef", "cardKind", "title", "role", "executionProfileId", "systemPrompt", "dispatchProfile",
  ]);
  const executionProfileId = opaqueId(input.executionProfileId, "profile_");
  if (!draft.definition.executionProfiles.some((profile) => profile.executionProfileId === executionProfileId)) {
    throw new Error("meta_patch_execution_profile_not_found");
  }
  const cardKind = requiredText(input.cardKind, "meta_template_tool_card_kind_invalid", 40);
  if (!["general", "researcher", "implementer", "reviewer", "publisher"].includes(cardKind)) {
    throw new Error("meta_template_tool_card_kind_invalid");
  }
  const dispatchProfile = exactRecord(input.dispatchProfile, ["title", "description"]);
  const proposalRef = requiredText(input.proposalRef, "meta_template_tool_proposal_ref_invalid", 80);
  if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(proposalRef) || proposalRef.startsWith("agent_card_")) {
    throw new Error("meta_template_tool_proposal_ref_invalid");
  }
  return operationResult(draft, {
    kind: "template_card_create",
    proposalRef,
    cardKind,
    title: requiredText(input.title, "meta_template_tool_title_invalid", 160),
    ...(input.role === undefined ? {} : { role: requiredText(input.role, "meta_template_tool_role_invalid", 500) }),
    executionProfileId,
    systemPrompt: requiredText(input.systemPrompt, "meta_template_tool_prompt_invalid", 50_000),
    dispatchProfile: {
      title: requiredText(dispatchProfile.title, "meta_template_tool_dispatch_invalid", 160),
      description: requiredText(dispatchProfile.description, "meta_template_tool_dispatch_invalid", 2_000),
    },
  });
}

function updateCard(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["agentCardId", "changes"]);
  const agentCardId = opaqueId(input.agentCardId, "agent_card_");
  if (!draft.definition.agentCards.some((card) => card.agentCardId === agentCardId)) {
    throw new Error("meta_patch_agent_card_not_found");
  }
  const changes = exactRecord(input.changes, ["title", "role", "executionProfileId", "dispatchProfile"]);
  if (Object.values(changes).every((entry) => entry === undefined)) {
    throw new Error("meta_template_tool_changes_required");
  }
  const executionProfileId = changes.executionProfileId === undefined
    ? undefined
    : opaqueId(changes.executionProfileId, "profile_");
  if (executionProfileId && !draft.definition.executionProfiles.some((profile) => profile.executionProfileId === executionProfileId)) {
    throw new Error("meta_patch_execution_profile_not_found");
  }
  const dispatchProfile = changes.dispatchProfile === undefined
    ? undefined
    : exactRecord(changes.dispatchProfile, ["title", "description"]);
  return operationResult(draft, {
    kind: "template_card_update",
    agentCardId,
    ...(changes.title === undefined ? {} : { title: requiredText(changes.title, "meta_template_tool_title_invalid", 160) }),
    ...(changes.role === undefined ? {} : { role: changes.role === null ? null : requiredText(changes.role, "meta_template_tool_role_invalid", 500) }),
    ...(executionProfileId ? { executionProfileId } : {}),
    ...(dispatchProfile ? { dispatchProfile: {
      title: requiredText(dispatchProfile.title, "meta_template_tool_dispatch_invalid", 160),
      description: requiredText(dispatchProfile.description, "meta_template_tool_dispatch_invalid", 2_000),
    } } : {}),
  });
}

function editPrompt(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["target", "oldText", "newText"]);
  const target = exactRecord(input.target, ["kind", "agentCardId"]);
  const oldText = rawText(input.oldText, false);
  const newText = rawText(input.newText, true);
  const kind = requiredText(target.kind, "meta_template_tool_target_invalid", 40);
  if (kind === "conductor") {
    if (target.agentCardId !== undefined) throw new Error("meta_template_tool_target_invalid");
    assertExactTextMatch(draft.definition.conductor.systemPrompt, oldText);
    return operationResult(draft, { kind: "template_conductor_prompt_edit", oldText, newText });
  }
  if (kind === "card") {
    const agentCardId = opaqueId(target.agentCardId, "agent_card_");
    const card = draft.definition.agentCards.find((candidate) => candidate.agentCardId === agentCardId);
    if (!card) throw new Error("meta_patch_agent_card_not_found");
    assertExactTextMatch(card.systemPrompt, oldText);
    return operationResult(draft, { kind: "template_card_prompt_edit", agentCardId, oldText, newText });
  }
  throw new Error("meta_template_tool_target_invalid");
}

function deleteCard(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["agentCardId"]);
  const agentCardId = opaqueId(input.agentCardId, "agent_card_");
  if (!draft.definition.agentCards.some((card) => card.agentCardId === agentCardId)) {
    throw new Error("meta_patch_agent_card_not_found");
  }
  if (draft.definition.deliverables.some((entry) => entry.ownerAgentCardId === agentCardId)) {
    throw new Error("meta_patch_agent_card_in_use");
  }
  return operationResult(draft, { kind: "template_card_remove", agentCardId });
}

function reorderCards(
  draft: TemplateDraftRecord,
  value: unknown,
  proposalRefs: ReadonlySet<string>,
): unknown {
  const input = exactRecord(value, ["cardRefs"]);
  if (!Array.isArray(input.cardRefs)) throw new Error("meta_patch_agent_card_reorder_invalid");
  const cardRefs = input.cardRefs.map((entry) => requiredText(entry, "meta_patch_agent_card_reorder_invalid", 120));
  const current = draft.definition.agentCards.map((card) => card.agentCardId);
  if (cardRefs.length !== current.length + proposalRefs.size
    || new Set(cardRefs).size !== cardRefs.length
    || cardRefs.some((reference) => !current.includes(reference) && !proposalRefs.has(reference))
    || current.some((agentCardId) => !cardRefs.includes(agentCardId))
    || [...proposalRefs].some((proposalRef) => !cardRefs.includes(proposalRef))) {
    throw new Error("meta_patch_agent_card_reorder_invalid");
  }
  return operationResult(draft, { kind: "template_card_reorder", cardRefs });
}

function selectProfile(
  draft: TemplateDraftRecord,
  value: unknown,
  options: SessionIdMetaTemplateToolOwnerOptions,
): unknown {
  const input = exactRecord(value, ["executionProfileId", "profileRevisionId"]);
  const executionProfileId = opaqueId(input.executionProfileId, "profile_");
  const profileRevisionId = opaqueId(input.profileRevisionId, "profile_revision_");
  if (!draft.definition.executionProfiles.some((profile) => profile.executionProfileId === executionProfileId)) {
    throw new Error("meta_patch_execution_profile_not_found");
  }
  const selected = options.listTemplateProfileRevisions?.({ draft, executionProfileId })
    .find((profile) => profile.profileRevisionId === profileRevisionId);
  if (!selected || selected.executionProfileId !== executionProfileId) {
    throw new Error("meta_patch_profile_revision_not_host_issued");
  }
  return Object.freeze({
    ...operationResult(draft, { kind: "template_profile_revision_select", executionProfileId, profileRevisionId }),
    selectedProfile: safeProfile(selected),
  });
}

function upsertDeliverable(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["artifactPath", "ownerAgentCardId", "description"]);
  const artifactPath = requiredArtifactPath(input.artifactPath);
  const ownerAgentCardId = opaqueId(input.ownerAgentCardId, "agent_card_");
  if (draft.definition.conductor.agentCardId !== ownerAgentCardId
    && !draft.definition.agentCards.some((card) => card.agentCardId === ownerAgentCardId)) {
    throw new Error("meta_patch_agent_card_not_found");
  }
  return operationResult(draft, {
    kind: "template_deliverable_upsert",
    artifactPath,
    ownerAgentCardId,
    ...(input.description === undefined
      ? {}
      : { description: requiredText(input.description, "meta_template_tool_deliverable_invalid", 2_000) }),
  });
}

function deleteDeliverable(draft: TemplateDraftRecord, value: unknown): unknown {
  const input = exactRecord(value, ["artifactPath"]);
  const artifactPath = requiredArtifactPath(input.artifactPath);
  if (!draft.definition.deliverables.some((entry) => entry.artifactPath === artifactPath)) {
    throw new Error("meta_patch_deliverable_not_found");
  }
  return operationResult(draft, { kind: "template_deliverable_remove", artifactPath });
}

function operationResult(draft: TemplateDraftRecord, operation: unknown) {
  return Object.freeze({ targetRevision: draft.revision, operation: Object.freeze(operation as object) });
}

function safeCard(card: TemplateDraftRecord["definition"]["conductor"]) {
  return Object.freeze({
    agentCardId: card.agentCardId,
    kind: card.kind,
    title: card.title,
    ...(card.role === undefined ? {} : { role: card.role }),
    executionProfileId: card.executionProfileId,
    systemPrompt: card.systemPrompt,
    ...(card.dispatchProfile ? { dispatchProfile: Object.freeze({ ...card.dispatchProfile }) } : {}),
  });
}

function safeProfile(profile: TemplateDraftRecord["definition"]["executionProfiles"][number]) {
  return Object.freeze("profileRevisionId" in profile ? {
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    model: profile.model,
    configIntent: Object.freeze({ ...profile.configIntent }),
  } : {
    executionProfileId: profile.executionProfileId,
    provider: profile.provider,
    model: profile.model,
  });
}

function requireDraft(
  session: MetaSessionRecordV3,
  targetRevision: number,
  templates: Pick<TemplateTaskStore, "getDraft">,
): TemplateDraftRecord {
  if (session.target.kind !== "template_draft") throw new Error("meta_template_tool_scope_invalid");
  const draft = templates.getDraft(session.target.templateDraftId);
  if (!draft || draft.status !== "editing") throw new Error("meta_session_target_not_editable");
  if (draft.ownerId !== session.ownerId || draft.revision !== targetRevision) {
    throw new Error("meta_patch_target_revision_stale");
  }
  return draft;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("meta_template_tool_input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error("meta_template_tool_input_invalid");
  }
  return input;
}

function exactOptionalAbsent(input: Record<string, unknown>, keys: readonly string[]) {
  if (keys.some((key) => input[key] !== undefined)) throw new Error("meta_template_tool_target_invalid");
}

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw new Error(code);
  return value;
}

function rawText(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > 8_000 || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new Error("meta_template_tool_text_invalid");
  }
  return value;
}

function opaqueId(value: unknown, prefix: string): string {
  const id = requiredText(value, "meta_template_tool_id_invalid", 300);
  if (!id.startsWith(prefix)) throw new Error("meta_template_tool_id_invalid");
  return id;
}

function requiredArtifactPath(value: unknown): string {
  const normalized = requiredText(value, "meta_template_tool_deliverable_invalid", 512)
    .replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("meta_template_tool_deliverable_invalid");
  }
  return normalized;
}

function assertExactTextMatch(source: string, oldText: string): void {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error("meta_patch_text_match_not_found");
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error("meta_patch_text_match_ambiguous");
}
