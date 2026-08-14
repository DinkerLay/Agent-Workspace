import {
  hashDefinition,
  isMetaProfileDefinitionV3,
  validateMetaProfileOptionDefinitionV3,
  type ExecutionProfileDefinitionV3,
  type MetaPatchProposalRecord,
  type MetaPatchProposalRecordV3,
  type MetaPatchValidationIssue,
  type MetaProfileOptionDefinitionV3,
  type MetaProfileOptionSnapshot,
  type MetaSessionRecord,
  type MetaSessionRecordV3,
  type TemplateDraftRecord,
} from "@agent-workspace/runtime-contracts";
import {
  appendMetaMessage,
  applyMetaPatchProposalToTaskSetup,
  applyMetaPatchProposalToTemplateDraft,
  createMetaPatchProposal,
  parseMetaAgentOutput,
  type MetaPatchIntentOperation,
} from "@agent-workspace/runtime-domain";
import type { MetaPatchOperation } from "@agent-workspace/runtime-contracts";
import {
  validateAcpMetaAgentTurnRequest,
  type AcpMetaAgentPort,
  type AcpMetaAgentTurnRequest,
} from "@agent-workspace/provider-port";
import type {
  AcpMetaTurnRecordV3,
  ConfigurationStore,
  TemplateTaskStore,
} from "@agent-workspace/runtime-store";
import {
  acpMetaProfileIdentity,
  type AcpMetaAgentRegistry,
} from "./meta-agent.js";
import { sessionIdMetaTargetContext } from "./session-id-configuration-task-lifecycle.js";
import type { SessionIdMetaTemplateToolOwner } from "./session-id-meta-template-tool-owner.js";

export type SessionIdMetaAgentOwnerOptions = Readonly<{
  now: () => string;
  createId: (kind: "agent_card") => string;
  configuration: Pick<ConfigurationStore,
    | "claimMetaTurn" | "releaseMetaTurn" | "settleMetaTurn" | "completeMetaTurn"
    | "getMetaTurn" | "getMetaSession" | "getMetaMessage" | "listMetaMessages" | "getTaskSetupDraft">;
  templates: Pick<TemplateTaskStore, "getDraft" | "getTemplate" | "getTemplateVersion">;
  metaAgents: AcpMetaAgentRegistry;
  resolveMetaProfileOption: (metaProfileOptionId: string) => MetaProfileOptionSnapshot;
  resolveTemplateProfileRevision?: (input: Readonly<{
    draft: TemplateDraftRecord;
    executionProfileId: string;
    profileRevisionId: string;
  }>) => ExecutionProfileDefinitionV3;
  templateDraftTools?: SessionIdMetaTemplateToolOwner;
  leaseMs?: number;
}>;

/** Durable, configuration-only MetaTurn dispatcher for the Session-ID root. */
export function createSessionIdMetaAgentOwner(options: SessionIdMetaAgentOwnerOptions) {
  const leaseMs = options.leaseMs ?? 30_000;

  async function drain(maxItems = 100, signal?: AbortSignal): Promise<number> {
    let handled = 0;
    for (; handled < maxItems; handled += 1) {
      if (signal?.aborted) break;
      const now = options.now();
      const turn = options.configuration.claimMetaTurn(
        now,
        new Date(Date.parse(now) + leaseMs).toISOString(),
      );
      if (!turn) break;
      await dispatch(turn, signal);
    }
    return handled;
  }

  async function dispatch(turn: AcpMetaTurnRecordV3, signal?: AbortSignal): Promise<void> {
    if (turn.status !== "leased" || !turn.leasedFromStatus) throw new Error("meta_turn_not_leased");
    if (releaseIfCancelled(turn, signal)) return;
    const firstNativeSubmit = turn.leasedFromStatus === "pending" && turn.attempts === 1;
    let request: AcpMetaAgentTurnRequest;
    let session: MetaSessionRecordV3;
    let option: MetaProfileOptionDefinitionV3;
    try {
      session = requiredAcpMetaSession(
        required(options.configuration.getMetaSession(turn.metaSessionId), "meta_session_not_found"),
      );
      if (session.state !== "active" || session.mode !== turn.mode) throw new Error("meta_session_not_active");
      if (acpMetaProfileIdentity(session.metaProfile) !== acpMetaProfileIdentity(turn.profile)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      option = requiredAcpMetaOption(options.resolveMetaProfileOption(session.metaProfileOptionId));
      if (acpMetaProfileIdentity(option.profile) !== acpMetaProfileIdentity(turn.profile)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      const context = sessionIdMetaTargetContext(session, turn.targetRevision, options.templates, options.configuration);
      if (hashDefinition(context) !== turn.contextDigest
        || hashDefinition(turn.systemInstructions) !== turn.systemInstructionsDigest
        || hashDefinition(turn.outputSchema) !== turn.outputSchemaDigest) {
        throw new Error("meta_turn_frozen_context_mismatch");
      }
      const userMessage = required(options.configuration.getMetaMessage(turn.userMetaMessageId), "meta_turn_user_message_missing");
      if (userMessage.metaSessionId !== turn.metaSessionId || userMessage.role !== "user") {
        throw new Error("meta_turn_user_message_mismatch");
      }
      request = validateAcpMetaAgentTurnRequest({
        metaSessionId: turn.metaSessionId,
        metaTurnId: turn.metaTurnId,
        userMetaMessageId: turn.userMetaMessageId,
        idempotencyKey: turn.idempotencyKey,
        mode: turn.mode,
        profile: turn.profile,
        targetRevision: turn.targetRevision,
        systemInstructions: turn.systemInstructions,
        outputSchema: turn.outputSchema,
        context: turn.context,
        transcript: Object.freeze(options.configuration.listMetaMessages(turn.metaSessionId)
          .filter((message) => message.metaMessageId !== turn.userMetaMessageId)
          .map((message) => Object.freeze({
            metaMessageId: message.metaMessageId,
            role: message.role,
            content: message.content,
          }))),
        content: userMessage.content,
      });
    } catch (error) {
      settle(turn, "failed", safeFailure(error, "meta_turn_preflight_failed"));
      return;
    }

    let provider: AcpMetaAgentPort;
    try {
      const ensured = await waitForDispatch(() => options.metaAgents.ensureSession({
        metaSessionId: session.metaSessionId,
        metaProfileOptionId: option.metaProfileOptionId,
        profile: turn.profile,
        sessionMode: session.mode,
        mode: firstNativeSubmit ? "first_submit" : "recovery",
      }), signal);
      if (ensured === CANCELLED) {
        releaseIfCancelled(turn, signal);
        return;
      }
      provider = ensured;
    } catch (error) {
      if (releaseIfCancelled(turn, signal)) return;
      if (firstNativeSubmit) {
        settle(turn, "failed", safeFailure(error, "meta_agent_profile_unavailable"));
      } else {
        release(turn);
      }
      return;
    }

    if (!firstNativeSubmit) {
      let reconciliation;
      try {
        reconciliation = await waitForDispatch(() => provider.reconcileMetaTurn(request), signal);
        if (reconciliation === CANCELLED) {
          releaseIfCancelled(turn, signal);
          return;
        }
      } catch {
        if (releaseIfCancelled(turn, signal)) return;
        release(turn);
        return;
      }
      if (releaseIfCancelled(turn, signal)) return;
      switch (reconciliation.state) {
        case "returned": complete(turn, reconciliation.finalText); return;
        case "failed": settle(turn, "failed", safeFailure(reconciliation.failureCode, "meta_provider_failed")); return;
        case "running": settle(turn, "provider_accepted"); return;
        case "unknown": settle(turn, "ambiguous", "meta_provider_reconciliation_unknown"); return;
        case "absent": settle(turn, "ambiguous", "meta_provider_reconciliation_absent"); return;
      }
    }

    try {
      const scopedToolTurnContext = session.mode === "template_design"
        ? options.templateDraftTools?.createTurnContext({
            session,
            metaTurnId: turn.metaTurnId,
            targetRevision: turn.targetRevision,
          })
        : undefined;
      const acceptance = await waitForDispatch(
        () => provider.startMetaTurn(request, scopedToolTurnContext),
        signal,
      );
      if (acceptance === CANCELLED) {
        releaseIfCancelled(turn, signal);
        return;
      }
      if (releaseIfCancelled(turn, signal)) return;
      if (acceptance === "accepted") settle(turn, "provider_accepted");
      else if (acceptance === "rejected") settle(turn, "rejected", "meta_provider_rejected");
      else settle(turn, "ambiguous", "meta_provider_acceptance_unknown");
    } catch {
      if (releaseIfCancelled(turn, signal)) return;
      settle(turn, "ambiguous", "meta_provider_submit_ambiguous");
    }
  }

  function release(turn: AcpMetaTurnRecordV3): void {
    options.configuration.releaseMetaTurn(turn.metaTurnId, turn.attempts, options.now());
  }

  function releaseIfCancelled(turn: AcpMetaTurnRecordV3, signal?: AbortSignal): boolean {
    if (!signal?.aborted) return false;
    const current = options.configuration.getMetaTurn(turn.metaTurnId);
    if (current?.status === "leased" && current.attempts === turn.attempts) {
      try {
        release(turn);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code !== "meta_turn_not_leased" && code !== "stale_meta_turn_attempt") throw error;
      }
    }
    return true;
  }

  function settle(
    turn: AcpMetaTurnRecordV3,
    status: "provider_accepted" | "rejected" | "ambiguous" | "failed",
    failureCode?: string,
  ): void {
    options.configuration.settleMetaTurn({
      metaTurnId: turn.metaTurnId,
      expectedAttempts: turn.attempts,
      status,
      ...(failureCode ? { failureCode } : {}),
      now: options.now(),
    });
  }

  function complete(turn: AcpMetaTurnRecordV3, finalText: string): void {
    let parsed: ReturnType<typeof parseMetaAgentOutput>;
    try {
      parsed = parseMetaAgentOutput(finalText, turn.mode);
    } catch (error) {
      settle(turn, "failed", safeFailure(error, "meta_provider_final_invalid"));
      return;
    }
    try {
      const session = requiredAcpMetaSession(
        required(options.configuration.getMetaSession(turn.metaSessionId), "meta_session_not_found"),
      );
      if (session.state !== "active") throw new Error("meta_session_not_active");
      const context = sessionIdMetaTargetContext(session, turn.targetRevision, options.templates, options.configuration);
      if (hashDefinition(context) !== turn.contextDigest) throw new Error("meta_turn_context_mismatch");
      assertTemplateProposalUsesToolOperations(turn, session, parsed, options.templateDraftTools);
      const completedAt = options.now();
      const appended = appendMetaMessage({
        session,
        metaMessageId: turn.assistantMetaMessageId,
        expectedSessionRevision: session.revision,
        role: "assistant",
        content: parsed.assistantMessage,
        now: completedAt,
      });
      const proposal = parsed.proposal ? validatedProposal(turn, session, parsed.proposal, completedAt) : undefined;
      options.configuration.completeMetaTurn({
        metaTurnId: turn.metaTurnId,
        expectedAttempts: turn.attempts,
        session: requiredAcpMetaSession(appended.session),
        expectedSessionRevision: session.revision,
        assistantMessage: appended.message,
        ...(proposal ? { proposal } : {}),
        completedAt,
      });
    } catch (error) {
      if (options.configuration.getMetaTurn(turn.metaTurnId)?.status === "returned") return;
      settle(turn, "failed", safeFailure(error, "meta_turn_completion_failed"));
    }
  }

  function validatedProposal(
    turn: AcpMetaTurnRecordV3,
    session: MetaSessionRecordV3,
    parsed: NonNullable<ReturnType<typeof parseMetaAgentOutput>["proposal"]>,
    now: string,
  ): MetaPatchProposalRecordV3 {
    const templateDraft = session.mode === "template_design" && session.target.kind === "template_draft"
      ? required(options.templates.getDraft(session.target.templateDraftId), "template_draft_not_found")
      : undefined;
    const operations = materializeMetaPatchOperations(
      parsed.operations,
      options.createId,
      templateDraft && options.resolveTemplateProfileRevision
        ? (executionProfileId, profileRevisionId) => options.resolveTemplateProfileRevision!({
            draft: templateDraft,
            executionProfileId,
            profileRevisionId,
          })
        : undefined,
    );
    const create = (validationIssues: readonly MetaPatchValidationIssue[]) => createMetaPatchProposal({
      metaPatchProposalId: turn.metaPatchProposalId,
      session,
      targetRevision: turn.targetRevision,
      operations,
      summary: parsed.summary,
      rationale: parsed.rationale,
      validationIssues,
      now,
    });
    let proposal = requiredAcpMetaProposal(create(parsed.validationIssues));
    if (proposal.validationIssues.length > 0) return proposal;
    try {
      if (session.mode === "template_design") {
        if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
        const draft = required(options.templates.getDraft(session.target.templateDraftId), "template_draft_not_found");
        applyMetaPatchProposalToTemplateDraft({ draft, session, proposal, expectedTargetRevision: turn.targetRevision, now });
      } else {
        if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
        const draft = required(options.configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
        const version = required(options.templates.getTemplateVersion(draft.templateVersionId), "template_version_not_found");
        applyMetaPatchProposalToTaskSetup({
          draft,
          schema: version.definition.taskInputSchema,
          session,
          proposal,
          expectedTargetRevision: turn.targetRevision,
          now,
        });
      }
    } catch (error) {
      proposal = requiredAcpMetaProposal(create([{
        code: "runtime_dry_run_failed",
        message: safeFailure(error, "meta_patch_dry_run_failed"),
      }]));
    }
    return proposal;
  }

  return Object.freeze({ drain });
}

function assertTemplateProposalUsesToolOperations(
  turn: AcpMetaTurnRecordV3,
  session: MetaSessionRecordV3,
  parsed: ReturnType<typeof parseMetaAgentOutput>,
  tools: SessionIdMetaTemplateToolOwner | undefined,
): void {
  if (session.mode !== "template_design") return;
  const proposed = parsed.proposal?.operations ?? [];
  const recorded = tools?.listTurnOperations(turn.metaTurnId) ?? [];
  if (proposed.length === 0 && recorded.length === 0) return;
  if (!tools || proposed.length === 0 || recorded.length === 0) {
    throw new Error("meta_template_tool_operation_required");
  }
  if (hashDefinition(JSON.parse(JSON.stringify(proposed)))
    !== hashDefinition(JSON.parse(JSON.stringify(recorded)))) {
    throw new Error("meta_template_tool_operation_mismatch");
  }
}

function materializeMetaPatchOperations(
  operations: readonly MetaPatchIntentOperation[],
  createId: SessionIdMetaAgentOwnerOptions["createId"],
  resolveTemplateProfileRevision?: (
    executionProfileId: string,
    profileRevisionId: string,
  ) => ExecutionProfileDefinitionV3,
): readonly MetaPatchOperation[] {
  const allocated = new Map<string, string>();
  for (const operation of operations) {
    if (operation.kind !== "template_card_create") continue;
    if (allocated.has(operation.proposalRef)) throw new Error("meta_patch_agent_card_ref_conflict");
    const agentCardId = createId("agent_card");
    if (!/^agent_card_[A-Za-z0-9-]+$/u.test(agentCardId)) throw new Error("meta_patch_agent_card_id_invalid");
    allocated.set(operation.proposalRef, agentCardId);
  }
  return Object.freeze(operations.map((operation): MetaPatchOperation => {
    if (operation.kind === "template_card_create") {
      return Object.freeze({
        kind: operation.kind,
        agentCardId: required(allocated.get(operation.proposalRef), "meta_patch_agent_card_ref_not_found"),
        cardKind: operation.cardKind,
        title: operation.title,
        ...(operation.role === undefined ? {} : { role: operation.role }),
        executionProfileId: operation.executionProfileId,
        systemPrompt: operation.systemPrompt,
        dispatchProfile: Object.freeze({ ...operation.dispatchProfile }),
      });
    }
    if (operation.kind === "template_card_reorder") {
      return Object.freeze({
        kind: operation.kind,
        agentCardIds: Object.freeze(operation.cardRefs.map((reference) => reference.startsWith("agent_card_")
          ? reference
          : required(allocated.get(reference), "meta_patch_agent_card_ref_not_found"))),
      });
    }
    if (operation.kind === "template_profile_revision_select") {
      if (!resolveTemplateProfileRevision) throw new Error("meta_patch_profile_revision_resolver_required");
      const profile = resolveTemplateProfileRevision(
        operation.executionProfileId,
        operation.profileRevisionId,
      );
      if (profile.executionProfileId !== operation.executionProfileId
        || profile.profileRevisionId !== operation.profileRevisionId) {
        throw new Error("meta_patch_profile_revision_identity_mismatch");
      }
      return Object.freeze({
        kind: "template_profile_revision_set" as const,
        executionProfileId: operation.executionProfileId,
        profile,
      });
    }
    return Object.freeze({
      ...operation,
      ...(operation.kind === "template_card_update" && operation.dispatchProfile
        ? { dispatchProfile: Object.freeze({ ...operation.dispatchProfile }) }
        : {}),
    }) as MetaPatchOperation;
  }));
}

function safeFailure(value: unknown, fallback: string): string {
  const candidate = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const normalized = candidate.trim().slice(0, 160);
  return /^(?:(?:codex|opencode|claude-code)_meta|meta|task_setup|template|runtime|provider)_[a-z0-9_:.-]+$/.test(normalized)
    ? normalized
    : fallback;
}

const CANCELLED = Symbol("meta_turn_dispatch_cancelled");

async function waitForDispatch<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof CANCELLED> {
  if (!signal) return operation();
  if (signal.aborted) return CANCELLED;
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      work();
    };
    const onAbort = () => finish(() => resolve(CANCELLED));
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function requiredAcpMetaOption(
  option: MetaProfileOptionSnapshot,
): MetaProfileOptionDefinitionV3 {
  if (!("readiness" in option) || !isMetaProfileDefinitionV3(option.profile)) {
    throw new Error("meta_profile_v2_read_only");
  }
  return validateMetaProfileOptionDefinitionV3(option);
}

function requiredAcpMetaSession(session: MetaSessionRecord): MetaSessionRecordV3 {
  if (!isAcpMetaSession(session)) throw new Error("meta_profile_v2_read_only");
  return session;
}

function isAcpMetaSession(session: MetaSessionRecord): session is MetaSessionRecordV3 {
  return isMetaProfileDefinitionV3(session.metaProfile);
}

function requiredAcpMetaProposal(
  proposal: MetaPatchProposalRecord,
): MetaPatchProposalRecordV3 {
  if (!isAcpMetaProposal(proposal)) throw new Error("meta_profile_v2_read_only");
  return proposal;
}

function isAcpMetaProposal(
  proposal: MetaPatchProposalRecord,
): proposal is MetaPatchProposalRecordV3 {
  return isMetaProfileDefinitionV3(proposal.sourceMetaProfile);
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
