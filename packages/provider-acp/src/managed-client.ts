import { createHash, randomUUID } from "node:crypto";
import type {
  AcpV1ClientHandlers,
  InjectedAcpV1Connection,
} from "./connection.js";
import { AcpBoundaryError, failAcp } from "./errors.js";
import {
  normalizePermissionRequest,
  normalizeSessionNotification,
  rawMessageIdFromSessionNotification,
  rawSessionIdFromBindingResponse,
  stopReasonFromPromptResponse,
} from "./normalizer.js";
import { GenerationPrivateIdentityMap } from "./private-identity-map.js";
import {
  createHostPrivateBindingIdentityVault,
  type HostPrivateBindingIdentityVault,
} from "./private-binding-identity-vault.js";
import {
  normalizeExtensionPredicates,
  normalizeRequiredCapabilityNames,
  normalizeRequiredExtensionNames,
  qualifyInitializeResponse,
} from "./qualification.js";
import {
  configureAcpV1Session,
  inspectAcpV1SessionModelCatalog,
} from "./session-configuration.js";
import type {
  AcpBindingCommand,
  AcpBindingObservation,
  AcpInteractionResponseCommand,
  AcpInterruptCommand,
  AcpInterruptObservation,
  AcpModelCatalogInspectionCommand,
  AcpModelCatalogInspectionObservation,
  AcpPromptCommand,
  AcpPromptSettlement,
  AcpQualificationObservation,
  AcpReleaseBindingCommand,
  AcpSessionObservation,
  AcpV1QualificationRequirements,
  CreateManagedAcpV1ClientOptions,
  ManagedAcpV1Client,
} from "./types.js";

interface ActivePrompt {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly privateDirectories: readonly string[];
  readonly chunks: string[];
  readonly retiredRawMessageIds: Set<string>;
  candidateLength: number;
  candidateGroupCount: number;
  messageMode?: "anonymous" | "identified";
  currentRawMessageId?: string;
  receiptObserved: boolean;
  receiptDigest?: string;
  observationDeliveryFailed?: boolean;
}

const MAX_SAFE_FINAL_CANDIDATE_LENGTH = 1024 * 1024;

interface PendingPermissionResponse {
  resolve(value: unknown): void;
}

interface PendingCreateBindingEffect {
  readonly bindingHandle: string;
  readonly preBindingRawSessionIds: Set<string>;
}

export function createManagedAcpV1Client(
  options: CreateManagedAcpV1ClientOptions,
): ManagedAcpV1Client {
  return createManagedAcpV1ClientWithPrivateIdentityVault(
    options,
    createHostPrivateBindingIdentityVault(),
  );
}

export function createManagedAcpV1ClientWithPrivateIdentityVault(
  options: CreateManagedAcpV1ClientOptions,
  identityVault: HostPrivateBindingIdentityVault,
): ManagedAcpV1Client {
  validateReverseRpcHandlerSet(options.reverseRpcHandlers);
  const extensionPredicates = normalizeExtensionPredicates(options.extensionPredicates);
  let client: ManagedAcpV1ClientImplementation | undefined;
  const handlers: AcpV1ClientHandlers = {
    ...options.reverseRpcHandlers,
    sessionUpdate: (params) => {
      if (!client) return Promise.reject(new AcpBoundaryError("acp_client_not_ready"));
      return client.handleSessionUpdate(params);
    },
    requestPermission: (params) => {
      if (!client) return Promise.reject(new AcpBoundaryError("acp_client_not_ready"));
      return client.handlePermissionRequest(params);
    },
  };
  const connection = options.connect(handlers);
  client = new ManagedAcpV1ClientImplementation(
    options,
    connection,
    identityVault,
    extensionPredicates,
  );
  return client;
}

class ManagedAcpV1ClientImplementation implements ManagedAcpV1Client {
  readonly #connection: InjectedAcpV1Connection;
  readonly #identities: GenerationPrivateIdentityMap;
  readonly #onObservation?: (
    observation: AcpSessionObservation,
  ) => void | Promise<void>;
  readonly #beforePromptEffect?: () => undefined;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #clientCapabilities: Record<string, unknown>;
  readonly #generationId: string;
  readonly #identityVault: HostPrivateBindingIdentityVault;
  readonly #extensionPredicates: ReturnType<typeof normalizeExtensionPredicates>;
  readonly #activePrompts = new Map<string, ActivePrompt>();
  readonly #privateDirectoriesByBinding = new Map<string, readonly string[]>();
  readonly #pendingPermissions = new Map<string, PendingPermissionResponse>();
  #pendingCreateBindingEffect?: PendingCreateBindingEffect;
  #qualification?: AcpQualificationObservation;
  #requirementsKey?: string;
  #generationActive = true;

  constructor(
    options: CreateManagedAcpV1ClientOptions,
    connection: InjectedAcpV1Connection,
    identityVault: HostPrivateBindingIdentityVault,
    extensionPredicates: ReturnType<typeof normalizeExtensionPredicates>,
  ) {
    this.#connection = connection;
    this.#identities = new GenerationPrivateIdentityMap({
      generationId: options.generationId,
      createOpaqueId: options.createOpaqueId ?? ((kind) => `${kind}_${randomUUID()}`),
    });
    if (options.privateRedactionValues !== undefined
      && (!Array.isArray(options.privateRedactionValues)
        || !options.privateRedactionValues.every((value) => typeof value === "string" && value))) {
      failAcp("acp_private_redaction_values_invalid");
    }
    for (const value of options.privateRedactionValues ?? []) {
      this.#identities.rememberPrivateValue(value);
    }
    this.#onObservation = options.onObservation;
    if (options.beforePromptEffect !== undefined
      && typeof options.beforePromptEffect !== "function") {
      failAcp("acp_prompt_effect_budget_invalid");
    }
    this.#beforePromptEffect = options.beforePromptEffect;
    this.#generationId = options.generationId;
    this.#identityVault = identityVault;
    this.#extensionPredicates = extensionPredicates;
    this.#clientInfo = options.clientInfo ?? {
      name: "agent-workspace",
      version: "development",
    };
    this.#clientCapabilities = deriveClientCapabilities(options.reverseRpcHandlers);
    if (connection.closed) {
      void connection.closed.then(
        () => this.invalidateGeneration(),
        () => this.invalidateGeneration(),
      );
    }
  }

  async initialize(
    requirements: AcpV1QualificationRequirements,
  ): Promise<AcpQualificationObservation> {
    this.#assertGenerationActive();
    if (requirements.protocolMajor !== 1) failAcp("acp_protocol_requirement_invalid");
    const requiredExtensions = normalizeRequiredExtensionNames(
      requirements.requiredExtensions,
    );
    const requiredCapabilities = normalizeRequiredCapabilityNames(
      requirements.requiredCapabilities,
    );
    const requirementsKey = JSON.stringify({
      protocolMajor: requirements.protocolMajor,
      requiredCapabilities,
      requiredExtensions,
    });
    if (this.#qualification) {
      if (this.#requirementsKey !== requirementsKey) {
        failAcp("acp_initialize_requirements_changed");
      }
      return this.#qualification;
    }
    let response: unknown;
    try {
      response = await this.#connection.initialize({
        protocolVersion: requirements.protocolMajor,
        clientCapabilities: this.#clientCapabilities,
        clientInfo: this.#clientInfo,
      });
    } catch (error) {
      failAcp("acp_initialize_failed", safeDiagnosticCode(error));
    }
    const qualification = qualifyInitializeResponse(response, {
      ...requirements,
      requiredCapabilities,
      requiredExtensions,
    }, this.#extensionPredicates);
    this.#requirementsKey = requirementsKey;
    this.#qualification = qualification;
    return qualification;
  }

  async ensureBinding(command: AcpBindingCommand): Promise<AcpBindingObservation> {
    this.#assertReady();
    const snapshot = snapshotBindingCommand(command);
    let pendingCreate: PendingCreateBindingEffect | undefined;
    if (snapshot.disposition === "create") {
      if (this.#pendingCreateBindingEffect) {
        failAcp("acp_binding_create_effect_already_active");
      }
      pendingCreate = {
        bindingHandle: snapshot.bindingHandle,
        preBindingRawSessionIds: new Set<string>(),
      };
      this.#pendingCreateBindingEffect = pendingCreate;
    }
    let response: unknown;
    let rawSessionId: string | undefined;
    let acquired: "none" | "created" | "recovered" = "none";
    let createEffectStarted = false;
    let bindingStageDiagnostic = snapshot.disposition === "create"
      ? "acp_binding_session_create_failed"
      : snapshot.disposition === "load"
        ? "acp_binding_session_load_failed"
        : "acp_binding_session_resume_failed";
    try {
      if (snapshot.disposition === "create") {
        const request = {
          cwd: snapshot.workspaceDirectory,
          ...(snapshot.additionalDirectories
            ? { additionalDirectories: [...snapshot.additionalDirectories] }
            : {}),
          mcpServers: [...snapshot.mcpServers],
        };
        createEffectStarted = true;
        try {
          response = await this.#connection.newSession(request);
        } catch (error) {
          failAcp("acp_binding_effect_failed", safeDiagnosticCode(error));
        }
        bindingStageDiagnostic = "acp_binding_session_identity_failed";
        rawSessionId = rawSessionIdFromBindingResponse(response);
        this.#assertPreBindingSessionUpdates(pendingCreate, rawSessionId);
        bindingStageDiagnostic = "acp_binding_identity_vault_failed";
        this.#identityVault.bindNew({
          bindingHandle: snapshot.bindingHandle,
          generationId: this.#generationId,
          rawSessionId,
        });
        try {
          bindingStageDiagnostic = "acp_binding_private_identity_map_failed";
          this.#identities.bindSession(snapshot.bindingHandle, rawSessionId);
        } catch (error) {
          this.#identityVault.delete({
            bindingHandle: snapshot.bindingHandle,
            generationId: this.#generationId,
          });
          throw error;
        }
        acquired = "created";
      } else {
        const recovered = this.#rawSessionForRecovery(snapshot.bindingHandle);
        rawSessionId = recovered.rawSessionId;
        acquired = recovered.adopted ? "recovered" : "none";
        const request = {
          sessionId: rawSessionId,
          cwd: snapshot.workspaceDirectory,
          ...(snapshot.additionalDirectories
            ? { additionalDirectories: [...snapshot.additionalDirectories] }
            : {}),
          mcpServers: [...snapshot.mcpServers],
        };
        if (snapshot.disposition === "load") {
          if (!this.#connection.loadSession) failAcp("acp_session_load_unavailable");
          try {
            response = await this.#connection.loadSession(request);
          } catch (error) {
            failAcp("acp_binding_effect_failed", safeDiagnosticCode(error));
          }
        } else {
          if (!this.#connection.resumeSession) failAcp("acp_session_resume_unavailable");
          try {
            response = await this.#connection.resumeSession(request);
          } catch (error) {
            failAcp("acp_binding_effect_failed", safeDiagnosticCode(error));
          }
        }
      }
      if (!rawSessionId) failAcp("acp_binding_session_id_invalid");
      bindingStageDiagnostic = "acp_binding_session_configuration_failed";
      const configured = await configureAcpV1Session({
        connection: this.#connection,
        rawSessionId,
        bindingResponse: response,
        intent: snapshot.configuration,
      });
      this.#privateDirectoriesByBinding.set(
        snapshot.bindingHandle,
        Object.freeze([
          snapshot.workspaceDirectory,
          ...(snapshot.additionalDirectories ?? []),
        ]),
      );
      return Object.freeze({
        kind: "binding_ready",
        bindingHandle: snapshot.bindingHandle,
        disposition: snapshot.disposition,
        recoverable: snapshot.disposition !== "create"
          || Boolean(this.#qualification?.capabilities.includes("session_load")
            || this.#qualification?.capabilities.includes("session_resume")),
        ...configured,
      });
    } catch (error) {
      if (snapshot.disposition === "create" && createEffectStarted && !rawSessionId) {
        // Once session/new starts, either a rejected Promise or a malformed
        // response may hide native state that the Agent already created. With
        // no exact raw session ID, targeted cleanup is impossible and nothing
        // in this process generation remains safe to reuse.
        this.invalidateGeneration();
        if (error instanceof AcpBoundaryError) {
          if (error.code === "acp_binding_effect_failed" && !error.diagnosticCode) {
            failAcp(error.code, bindingStageDiagnostic);
          }
          throw error;
        }
        failAcp("acp_binding_session_id_invalid");
      }
      const cleanupFailed = snapshot.disposition === "create" && rawSessionId
        ? !(await this.#closeFailedCreatedSession(rawSessionId))
        : false;
      this.#rollbackBindingAcquisition(snapshot.bindingHandle, acquired);
      if (cleanupFailed) {
        this.invalidateGeneration();
        failAcp("acp_binding_cleanup_required");
      }
      if (error instanceof AcpBoundaryError) {
        if (error.code === "acp_binding_effect_failed" && !error.diagnosticCode) {
          failAcp(error.code, bindingStageDiagnostic);
        }
        throw error;
      }
      failAcp("acp_binding_effect_failed", bindingStageDiagnostic);
    } finally {
      if (pendingCreate && this.#pendingCreateBindingEffect === pendingCreate) {
        this.#pendingCreateBindingEffect = undefined;
      }
    }
    failAcp("acp_binding_effect_failed");
  }

  async inspectModelCatalog(
    command: AcpModelCatalogInspectionCommand,
  ): Promise<AcpModelCatalogInspectionObservation> {
    this.#assertReady();
    if (!command || typeof command !== "object" || Array.isArray(command)
      || Object.keys(command).some((key) => ![
        "bindingHandle",
        "mcpServers",
        "workspaceDirectory",
      ].includes(key))) {
      failAcp("acp_model_catalog_inspection_invalid");
    }
    const bindingHandle = command.bindingHandle;
    validateWorkspaceId(bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    if (typeof command.workspaceDirectory !== "string" || !command.workspaceDirectory
      || !Array.isArray(command.mcpServers)) {
      failAcp("acp_model_catalog_inspection_invalid");
    }
    if (this.#pendingCreateBindingEffect) {
      failAcp("acp_binding_create_effect_already_active");
    }
    const pending: PendingCreateBindingEffect = {
      bindingHandle,
      preBindingRawSessionIds: new Set<string>(),
    };
    this.#pendingCreateBindingEffect = pending;
    let rawSessionId: string | undefined;
    let createEffectStarted = false;
    try {
      createEffectStarted = true;
      let response: unknown;
      try {
        response = await this.#connection.newSession({
          cwd: command.workspaceDirectory,
          mcpServers: [...command.mcpServers],
        });
      } catch (error) {
        failAcp("acp_binding_effect_failed", safeDiagnosticCode(error));
      }
      rawSessionId = rawSessionIdFromBindingResponse(response);
      this.#assertPreBindingSessionUpdates(pending, rawSessionId);
      const observed = inspectAcpV1SessionModelCatalog(response);
      if (!await this.#closeFailedCreatedSession(rawSessionId)) {
        this.invalidateGeneration();
        failAcp("acp_model_catalog_cleanup_unconfirmed");
      }
      return Object.freeze({
        kind: "model_catalog_observed" as const,
        bindingHandle,
        ...observed,
      });
    } catch (error) {
      if (createEffectStarted && !rawSessionId) {
        this.invalidateGeneration();
      } else if (rawSessionId && this.#generationActive) {
        const cleanupConfirmed = await this.#closeFailedCreatedSession(rawSessionId);
        if (!cleanupConfirmed) this.invalidateGeneration();
      }
      if (error instanceof AcpBoundaryError) throw error;
      failAcp("acp_model_catalog_inspection_failed");
    } finally {
      if (this.#pendingCreateBindingEffect === pending) {
        this.#pendingCreateBindingEffect = undefined;
      }
    }
    failAcp("acp_model_catalog_inspection_failed");
  }

  async submitPrompt(command: AcpPromptCommand): Promise<AcpPromptSettlement> {
    this.#assertReady();
    const snapshot = snapshotPromptCommand(command);
    validateWorkspaceId(snapshot.bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    validateWorkspaceId(
      snapshot.attemptId,
      "session_execution_attempt",
      "acp_attempt_id_invalid",
    );
    if (typeof snapshot.content !== "string") failAcp("acp_prompt_content_invalid");
    const rawSessionId = this.#identities.rawSessionFor(snapshot.bindingHandle);
    const privateDirectories = this.#privateDirectoriesByBinding.get(snapshot.bindingHandle);
    if (!privateDirectories) failAcp("acp_binding_workspace_not_mapped");
    if (this.#activePrompts.has(snapshot.bindingHandle)) {
      failAcp("acp_prompt_already_active");
    }
    const active: ActivePrompt = {
      bindingHandle: snapshot.bindingHandle,
      attemptId: snapshot.attemptId,
      privateDirectories,
      chunks: [],
      retiredRawMessageIds: new Set<string>(),
      candidateLength: 0,
      candidateGroupCount: 0,
      receiptObserved: false,
    };
    this.#activePrompts.set(snapshot.bindingHandle, active);
    try {
      const reservation: unknown = (this.#beforePromptEffect as (() => unknown) | undefined)?.();
      if (reservation !== undefined) {
        if (reservation && (typeof reservation === "object" || typeof reservation === "function")
          && typeof (reservation as { then?: unknown }).then === "function") {
          void Promise.resolve(reservation).catch(() => undefined);
        }
        failAcp("acp_prompt_effect_budget_async_forbidden");
      }
      const promptResult = this.#connection.prompt({
        sessionId: rawSessionId,
        prompt: [{ type: "text", text: snapshot.content }],
      });
      const response = await promptResult;
      this.#assertGenerationActive();
      if (active.observationDeliveryFailed) {
        failAcp("acp_prompt_terminal_ambiguous");
      }
      const stopReason = stopReasonFromPromptResponse(response);
      await this.#observeAgentReceipt(active, { kind: "prompt_terminal", stopReason });
      const finalCandidate = active.chunks.join("");
      if (finalCandidate) {
        await this.#emit({
          kind: "final_candidate",
          bindingHandle: snapshot.bindingHandle,
          attemptId: snapshot.attemptId,
          text: finalCandidate,
        });
      }
      await this.#emit({
        kind: "prompt_terminal",
        bindingHandle: snapshot.bindingHandle,
        attemptId: snapshot.attemptId,
        stopReason,
        receiptDigest: requireReceiptDigest(active),
      });
      return deepFreeze({
        bindingHandle: snapshot.bindingHandle,
        attemptId: snapshot.attemptId,
        stopReason,
        receiptDigest: requireReceiptDigest(active),
        finalCandidateGroupCount: active.candidateGroupCount,
        ...(finalCandidate ? { finalCandidate } : {}),
      });
    } catch (error) {
      if (this.#generationActive) {
        this.#cancelPendingPermissions(snapshot.bindingHandle, snapshot.attemptId);
      }
      if (error instanceof AcpBoundaryError) throw error;
      failAcp("acp_prompt_terminal_ambiguous", safeDiagnosticCode(error));
    } finally {
      this.#activePrompts.delete(snapshot.bindingHandle);
    }
  }

  async requestInterrupt(command: AcpInterruptCommand): Promise<AcpInterruptObservation> {
    this.#assertReady();
    const snapshot = Object.freeze({
      bindingHandle: command.bindingHandle,
      ...(command.attemptId ? { attemptId: command.attemptId } : {}),
    });
    validateWorkspaceId(snapshot.bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    if (snapshot.attemptId) {
      validateWorkspaceId(
        snapshot.attemptId,
        "session_execution_attempt",
        "acp_attempt_id_invalid",
      );
    }
    const rawSessionId = this.#identities.rawSessionFor(snapshot.bindingHandle);
    const active = this.#activePrompts.get(snapshot.bindingHandle);
    if (snapshot.attemptId && active?.attemptId !== snapshot.attemptId) {
      failAcp("acp_interrupt_attempt_fence_mismatch");
    }
    if (active) this.#cancelPendingPermissions(active.bindingHandle, active.attemptId);
    try {
      await this.#connection.cancel({ sessionId: rawSessionId });
    } catch {
      failAcp("acp_interrupt_effect_failed");
    }
    return Object.freeze({
      kind: "interrupt_requested",
      bindingHandle: snapshot.bindingHandle,
      ...(snapshot.attemptId ? { attemptId: snapshot.attemptId } : {}),
      acceptance: "accepted",
    });
  }

  async respondToInteraction(command: AcpInteractionResponseCommand): Promise<void> {
    this.#assertReady();
    validateWorkspaceId(command.bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    validateWorkspaceId(
      command.attemptId,
      "session_execution_attempt",
      "acp_attempt_id_invalid",
    );
    validateWorkspaceId(command.interactionId, "interaction", "acp_interaction_id_invalid");
    validateWorkspaceId(command.choiceId, "choice", "acp_choice_id_invalid");
    const selected = this.#identities.selectPermission(command);
    const pending = this.#pendingPermissions.get(command.interactionId);
    if (!pending) failAcp("acp_interaction_response_not_pending");
    this.#pendingPermissions.delete(command.interactionId);
    pending.resolve({ outcome: { outcome: "selected", optionId: selected.rawOptionId } });
  }

  async releaseBinding(command: AcpReleaseBindingCommand): Promise<void> {
    this.#assertReady();
    const bindingHandle = command.bindingHandle;
    validateWorkspaceId(bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    if (this.#activePrompts.has(bindingHandle)) {
      failAcp("acp_binding_release_active_prompt");
    }
    const rawSessionId = this.#identities.rawSessionFor(bindingHandle);
    if (this.#connection.closeSession
      && this.#qualification?.capabilities.includes("session_close")) {
      try {
        await this.#connection.closeSession({ sessionId: rawSessionId });
      } catch {
        failAcp("acp_binding_release_failed");
      }
    }
    this.#identities.releaseBinding(bindingHandle);
    this.#identityVault.delete({
      bindingHandle,
      generationId: this.#generationId,
    });
    this.#privateDirectoriesByBinding.delete(bindingHandle);
  }

  invalidateGeneration(): void {
    if (!this.#generationActive) return;
    this.#generationActive = false;
    for (const pending of this.#pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.#pendingPermissions.clear();
    this.#identityVault.detachGeneration(this.#generationId);
    this.#identities.invalidate();
    this.#privateDirectoriesByBinding.clear();
  }

  async handleSessionUpdate(params: unknown): Promise<void> {
    this.#assertGenerationActive();
    const raw = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : undefined;
    if (typeof raw?.sessionId !== "string") failAcp("acp_session_update_id_invalid");
    let bindingHandle: string;
    try {
      bindingHandle = this.#identities.bindingForRawSession(raw.sessionId);
    } catch (error) {
      if (error instanceof AcpBoundaryError
        && error.code === "acp_raw_session_not_mapped"
        && this.#pendingCreateBindingEffect) {
        this.#pendingCreateBindingEffect.preBindingRawSessionIds.add(raw.sessionId);
        return;
      }
      throw error;
    }
    const active = this.#activePrompts.get(bindingHandle);
    if (!active) return;
    try {
      const observation = normalizeSessionNotification({
        notification: params,
        identities: this.#identities,
        bindingHandle,
        attemptId: active.attemptId,
        privateDirectories: active.privateDirectories,
      });
      if (!observation) return;
      await this.#observeAgentReceipt(active, observation);
      if (observation.kind === "agent_message_chunk") {
        appendAgentMessageChunk(
          active,
          rawMessageIdFromSessionNotification(params),
          observation.text,
        );
      }
      await this.#emit(observation);
    } catch (error) {
      active.observationDeliveryFailed = true;
      throw error;
    }
  }

  async handlePermissionRequest(params: unknown): Promise<unknown> {
    this.#assertGenerationActive();
    const raw = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : undefined;
    if (typeof raw?.sessionId !== "string") failAcp("acp_permission_session_id_invalid");
    const bindingHandle = this.#identities.bindingForRawSession(raw.sessionId);
    const active = this.#activePrompts.get(bindingHandle);
    if (!active) failAcp("acp_permission_without_active_prompt");
    const observation = normalizePermissionRequest({
      request: params,
      identities: this.#identities,
      bindingHandle,
      attemptId: active.attemptId,
      privateDirectories: active.privateDirectories,
    });
    let resolveResponse!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    this.#pendingPermissions.set(observation.interactionId, { resolve: resolveResponse });
    try {
      await this.#observeAgentReceipt(active, observation);
      await this.#emit(observation);
      return response;
    } catch (error) {
      active.observationDeliveryFailed = true;
      this.#pendingPermissions.delete(observation.interactionId);
      this.#identities.markPermissionCancelled(observation.interactionId);
      resolveResponse({ outcome: { outcome: "cancelled" } });
      throw error;
    }
  }

  #assertGenerationActive(): void {
    if (!this.#generationActive) failAcp("acp_generation_inactive");
    this.#identities.assertActive();
  }

  #assertReady(): void {
    this.#assertGenerationActive();
    if (!this.#qualification?.available) failAcp("acp_not_qualified");
  }

  async #emit(observation: AcpSessionObservation): Promise<void> {
    await this.#onObservation?.(deepFreeze(observation));
  }

  async #observeAgentReceipt(active: ActivePrompt, evidence: unknown): Promise<void> {
    if (active.receiptObserved) return;
    active.receiptObserved = true;
    active.receiptDigest = `sha256:${createHash("sha256")
      .update(stableJson({
        bindingHandle: active.bindingHandle,
        attemptId: active.attemptId,
        evidence,
      }))
      .digest("hex")}`;
    await this.#emit({
      kind: "delivery_receipt",
      bindingHandle: active.bindingHandle,
      attemptId: active.attemptId,
      receiptDigest: active.receiptDigest,
    });
  }

  #rawSessionForRecovery(bindingHandle: string): {
    readonly rawSessionId: string;
    readonly adopted: boolean;
  } {
    try {
      return {
        rawSessionId: this.#identities.rawSessionFor(bindingHandle),
        adopted: false,
      };
    } catch (error) {
      if (!(error instanceof AcpBoundaryError) || error.code !== "acp_binding_not_mapped") {
        throw error;
      }
      const rawSessionId = this.#identityVault.checkout({
        bindingHandle,
        generationId: this.#generationId,
      });
      try {
        this.#identities.bindSession(bindingHandle, rawSessionId);
      } catch (bindError) {
        this.#identityVault.detachBinding({
          bindingHandle,
          generationId: this.#generationId,
        });
        throw bindError;
      }
      return { rawSessionId, adopted: true };
    }
  }

  #assertPreBindingSessionUpdates(
    pending: PendingCreateBindingEffect | undefined,
    rawSessionId: string,
  ): void {
    if (!pending || this.#pendingCreateBindingEffect !== pending) {
      this.invalidateGeneration();
      failAcp("acp_binding_create_effect_fence_lost");
    }
    for (const observedRawSessionId of pending.preBindingRawSessionIds) {
      if (observedRawSessionId !== rawSessionId) {
        this.invalidateGeneration();
        failAcp("acp_pre_binding_session_update_mismatch");
      }
    }
  }

  #rollbackBindingAcquisition(
    bindingHandle: string,
    acquired: "none" | "created" | "recovered",
  ): void {
    if (acquired === "none") return;
    try {
      this.#identities.releaseBinding(bindingHandle);
    } catch {
      // The original safe failure remains authoritative.
    }
    try {
      if (acquired === "created") {
        this.#identityVault.delete({
          bindingHandle,
          generationId: this.#generationId,
        });
      } else {
        this.#identityVault.detachBinding({
          bindingHandle,
          generationId: this.#generationId,
        });
      }
    } catch {
      // The original safe failure remains authoritative.
    }
    this.#privateDirectoriesByBinding.delete(bindingHandle);
  }

  #cancelPendingPermissions(bindingHandle: string, attemptId: string): void {
    for (const interactionId of this.#identities.pendingPermissionIdsForAttempt(
      bindingHandle,
      attemptId,
    )) {
      this.#identities.markPermissionCancelled(interactionId);
      const pending = this.#pendingPermissions.get(interactionId);
      this.#pendingPermissions.delete(interactionId);
      pending?.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  async #closeFailedCreatedSession(rawSessionId: string): Promise<boolean> {
    if (
      !this.#connection.closeSession
      || !this.#qualification?.capabilities.includes("session_close")
    ) return false;
    try {
      await this.#connection.closeSession({ sessionId: rawSessionId });
      return true;
    } catch {
      return false;
    }
  }
}

function safeDiagnosticCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const candidate of [
    "diagnosticCode" in value ? (value as { readonly diagnosticCode?: unknown }).diagnosticCode : undefined,
    "code" in value ? (value as { readonly code?: unknown }).code : undefined,
  ]) {
    if (typeof candidate === "string" && /^acp_[a-z0-9_]{1,120}$/u.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function snapshotBindingCommand(command: AcpBindingCommand): AcpBindingCommand {
  validateWorkspaceId(command.bindingHandle, "binding_handle", "acp_binding_handle_invalid");
  if (command.disposition !== "create"
    && command.disposition !== "load"
    && command.disposition !== "resume") {
    failAcp("acp_binding_disposition_invalid");
  }
  if (!isAbsolutePath(command.workspaceDirectory)) failAcp("acp_workspace_directory_invalid");
  for (const directory of command.additionalDirectories ?? []) {
    if (!isAbsolutePath(directory)) failAcp("acp_additional_directory_invalid");
  }
  if (!Array.isArray(command.mcpServers)) failAcp("acp_mcp_servers_invalid");
  return Object.freeze({
    bindingHandle: command.bindingHandle,
    disposition: command.disposition,
    workspaceDirectory: command.workspaceDirectory,
    ...(command.additionalDirectories
      ? { additionalDirectories: Object.freeze([...command.additionalDirectories]) }
      : {}),
    mcpServers: cloneAndFreeze(command.mcpServers, "acp_mcp_servers_invalid"),
    configuration: cloneAndFreeze(command.configuration, "acp_session_config_intent_invalid"),
  });
}

function snapshotPromptCommand(command: AcpPromptCommand): AcpPromptCommand {
  return Object.freeze({
    bindingHandle: command.bindingHandle,
    attemptId: command.attemptId,
    content: command.content,
  });
}

function cloneAndFreeze<T>(value: T, code: string): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    failAcp(code);
  }
}

function deepFreeze<T>(value: T, active = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (active.has(object)) failAcp("acp_safe_value_cycle_invalid");
  active.add(object);
  for (const entry of Object.values(object)) deepFreeze(entry, active);
  active.delete(object);
  return Object.freeze(value);
}

function validateReverseRpcHandlerSet(
  handlers: CreateManagedAcpV1ClientOptions["reverseRpcHandlers"],
): void {
  if (!handlers) return;
  const allowed = new Set([
    "readTextFile",
    "writeTextFile",
    "createTerminal",
    "terminalOutput",
    "waitForTerminalExit",
    "killTerminal",
    "releaseTerminal",
  ]);
  for (const [name, handler] of Object.entries(handlers)) {
    if (!allowed.has(name) || typeof handler !== "function") {
      failAcp("acp_reverse_rpc_handlers_invalid");
    }
  }
  const terminalHandlers = [
    handlers.createTerminal,
    handlers.terminalOutput,
    handlers.waitForTerminalExit,
    handlers.killTerminal,
    handlers.releaseTerminal,
  ];
  const configured = terminalHandlers.filter((handler) => Boolean(handler)).length;
  if (configured !== 0 && configured !== terminalHandlers.length) {
    failAcp("acp_terminal_reverse_rpc_handlers_incomplete");
  }
}

function deriveClientCapabilities(
  handlers: CreateManagedAcpV1ClientOptions["reverseRpcHandlers"],
): Record<string, unknown> {
  if (!handlers) return {};
  const fs = {
    ...(handlers.readTextFile ? { readTextFile: true } : {}),
    ...(handlers.writeTextFile ? { writeTextFile: true } : {}),
  };
  const terminal = Boolean(
    handlers.createTerminal
    && handlers.terminalOutput
    && handlers.waitForTerminalExit
    && handlers.killTerminal
    && handlers.releaseTerminal,
  );
  return {
    ...(Object.keys(fs).length > 0 ? { fs } : {}),
    ...(terminal ? { terminal: true } : {}),
  };
}

function validateWorkspaceId(value: string, prefix: string, code: string): void {
  if (
    typeof value !== "string"
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)
  ) failAcp(code);
}

function isAbsolutePath(value: string): boolean {
  return typeof value === "string"
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value));
}

function requireReceiptDigest(active: ActivePrompt): string {
  if (!active.receiptDigest) failAcp("acp_prompt_receipt_missing");
  return active.receiptDigest;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function appendAgentMessageChunk(
  active: ActivePrompt,
  rawMessageId: string | undefined,
  text: string,
): void {
  const nextMode = rawMessageId === undefined ? "anonymous" : "identified";
  if (!active.messageMode) {
    active.messageMode = nextMode;
    active.currentRawMessageId = rawMessageId;
    beginCandidateGroup(active);
    appendCandidateText(active, text);
    return;
  }
  if (active.messageMode !== nextMode) {
    failAcp("acp_agent_message_sequence_ambiguous");
  }
  if (nextMode === "anonymous") {
    appendCandidateText(active, text);
    return;
  }
  if (rawMessageId === active.currentRawMessageId) {
    appendCandidateText(active, text);
    return;
  }
  if (active.retiredRawMessageIds.has(rawMessageId as string)) {
    failAcp("acp_agent_message_sequence_ambiguous");
  }
  if (active.currentRawMessageId) {
    active.retiredRawMessageIds.add(active.currentRawMessageId);
  }
  active.currentRawMessageId = rawMessageId;
  active.chunks.length = 0;
  active.candidateLength = 0;
  beginCandidateGroup(active);
  appendCandidateText(active, text);
}

function beginCandidateGroup(active: ActivePrompt): void {
  if (active.candidateGroupCount >= Number.MAX_SAFE_INTEGER) {
    failAcp("acp_agent_message_candidate_groups_too_many");
  }
  active.candidateGroupCount += 1;
}

function appendCandidateText(active: ActivePrompt, text: string): void {
  if (active.candidateLength + text.length > MAX_SAFE_FINAL_CANDIDATE_LENGTH) {
    failAcp("acp_agent_message_candidate_too_large");
  }
  active.chunks.push(text);
  active.candidateLength += text.length;
}
