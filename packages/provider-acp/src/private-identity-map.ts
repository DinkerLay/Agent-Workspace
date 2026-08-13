import { AcpBoundaryError, failAcp } from "./errors.js";
import type { AcpOpaqueIdKind, AcpPermissionChoiceKind } from "./types.js";

interface PermissionRecord {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly rawToolCallId: string;
  readonly choices: Map<string, string>;
  pending: boolean;
}

export interface GenerationPrivateIdentityMapOptions {
  readonly generationId: string;
  readonly createOpaqueId: (kind: AcpOpaqueIdKind) => string;
}

export interface CreatePermissionInput {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly rawToolCallId: string;
  readonly options: readonly {
    readonly rawOptionId: string;
    readonly name: string;
    readonly kind: AcpPermissionChoiceKind;
  }[];
}

/**
 * Host-private identity state for exactly one process generation.
 *
 * This class is deliberately absent from `src/index.ts`. Its private fields
 * also make accidental JSON serialization produce no raw mapping contents.
 */
export class GenerationPrivateIdentityMap {
  readonly #generationId: string;
  readonly #createOpaqueId: (kind: AcpOpaqueIdKind) => string;
  readonly #sessions = new Map<string, string>();
  readonly #bindingsByRawSession = new Map<string, string>();
  readonly #tools = new Map<string, string>();
  readonly #permissions = new Map<string, PermissionRecord>();
  readonly #privateValues = new Set<string>();
  readonly #issuedOpaqueIds = new Set<string>();
  #active = true;

  constructor(options: GenerationPrivateIdentityMapOptions) {
    if (!options.generationId.trim()) failAcp("acp_generation_id_invalid");
    this.#generationId = options.generationId;
    this.#createOpaqueId = options.createOpaqueId;
  }

  assertActive(): void {
    if (!this.#active) failAcp("acp_generation_inactive");
  }

  bindSession(bindingHandle: string, rawSessionId: string): void {
    this.assertActive();
    requireWorkspaceId(bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    requireRawId(rawSessionId, "acp_raw_session_invalid");
    if (bindingHandle === rawSessionId) {
      failAcp("acp_binding_handle_collides_with_private_value");
    }
    if (this.#sessions.has(bindingHandle)) failAcp("acp_binding_already_bound");
    if (this.#bindingsByRawSession.has(rawSessionId)) {
      failAcp("acp_raw_session_already_bound");
    }
    this.#sessions.set(bindingHandle, rawSessionId);
    this.#bindingsByRawSession.set(rawSessionId, bindingHandle);
    this.#privateValues.add(rawSessionId);
  }

  rawSessionFor(bindingHandle: string): string {
    this.assertActive();
    const rawSessionId = this.#sessions.get(bindingHandle);
    if (!rawSessionId) failAcp("acp_binding_not_mapped");
    return rawSessionId;
  }

  bindingForRawSession(rawSessionId: string): string {
    this.assertActive();
    const bindingHandle = this.#bindingsByRawSession.get(rawSessionId);
    if (!bindingHandle) failAcp("acp_raw_session_not_mapped");
    return bindingHandle;
  }

  toolHandleFor(input: {
    readonly bindingHandle: string;
    readonly attemptId: string;
    readonly rawToolCallId: string;
    readonly create: boolean;
  }): string {
    this.assertActive();
    this.rawSessionFor(input.bindingHandle);
    requireWorkspaceId(
      input.attemptId,
      "session_execution_attempt",
      "acp_attempt_id_invalid",
    );
    requireRawId(input.rawToolCallId, "acp_raw_tool_call_invalid");
    const key = identityKey(input.bindingHandle, input.attemptId, input.rawToolCallId);
    const existing = this.#tools.get(key);
    if (existing) return existing;
    if (!input.create) failAcp("acp_tool_call_not_mapped");
    this.#privateValues.add(input.rawToolCallId);
    const handle = this.#newOpaqueId("tool_handle", "acp_tool_call_handle_invalid");
    this.#tools.set(key, handle);
    return handle;
  }

  createPermission(input: CreatePermissionInput): {
    readonly interactionId: string;
    readonly toolCallHandle: string;
    readonly choices: readonly {
      readonly choiceId: string;
      readonly name: string;
      readonly kind: AcpPermissionChoiceKind;
    }[];
  } {
    this.assertActive();
    if (input.options.length === 0) failAcp("acp_permission_options_empty");
    const rawOptionIds = new Set<string>();
    for (const option of input.options) {
      requireRawId(option.rawOptionId, "acp_raw_permission_option_invalid");
      if (rawOptionIds.has(option.rawOptionId)) {
        failAcp("acp_raw_permission_option_duplicate");
      }
      rawOptionIds.add(option.rawOptionId);
      this.#privateValues.add(option.rawOptionId);
    }
    const toolCallHandle = this.toolHandleFor({
      bindingHandle: input.bindingHandle,
      attemptId: input.attemptId,
      rawToolCallId: input.rawToolCallId,
      create: true,
    });
    const interactionId = this.#newOpaqueId("interaction", "acp_interaction_id_invalid");
    const choices = new Map<string, string>();
    const safeChoices = input.options.map((option) => {
      const choiceId = this.#newOpaqueId("choice", "acp_choice_id_invalid");
      choices.set(choiceId, option.rawOptionId);
      return { choiceId, name: option.name, kind: option.kind };
    });
    this.#permissions.set(interactionId, {
      bindingHandle: input.bindingHandle,
      attemptId: input.attemptId,
      rawToolCallId: input.rawToolCallId,
      choices,
      pending: true,
    });
    return { interactionId, toolCallHandle, choices: safeChoices };
  }

  selectPermission(input: {
    readonly bindingHandle: string;
    readonly attemptId: string;
    readonly interactionId: string;
    readonly choiceId: string;
  }): { readonly rawOptionId: string } {
    this.assertActive();
    requireWorkspaceId(input.bindingHandle, "binding_handle", "acp_binding_handle_invalid");
    requireWorkspaceId(
      input.attemptId,
      "session_execution_attempt",
      "acp_attempt_id_invalid",
    );
    requireWorkspaceId(input.interactionId, "interaction", "acp_interaction_id_invalid");
    requireWorkspaceId(input.choiceId, "choice", "acp_choice_id_invalid");
    const permission = this.#permissions.get(input.interactionId);
    if (!permission) failAcp("acp_interaction_not_mapped");
    if (!permission.pending) failAcp("acp_interaction_not_pending");
    if (
      permission.bindingHandle !== input.bindingHandle
      || permission.attemptId !== input.attemptId
    ) {
      failAcp("acp_interaction_fence_mismatch");
    }
    const rawOptionId = permission.choices.get(input.choiceId);
    if (!rawOptionId) failAcp("acp_interaction_choice_not_mapped");
    permission.pending = false;
    return { rawOptionId };
  }

  pendingPermissionIdsForAttempt(bindingHandle: string, attemptId: string): readonly string[] {
    this.assertActive();
    return [...this.#permissions.entries()]
      .filter(([, permission]) => (
        permission.pending
        && permission.bindingHandle === bindingHandle
        && permission.attemptId === attemptId
      ))
      .map(([interactionId]) => interactionId);
  }

  markPermissionCancelled(interactionId: string): void {
    this.assertActive();
    const permission = this.#permissions.get(interactionId);
    if (!permission || !permission.pending) return;
    permission.pending = false;
  }

  releaseBinding(bindingHandle: string): void {
    this.assertActive();
    const rawSessionId = this.#sessions.get(bindingHandle);
    if (!rawSessionId) failAcp("acp_binding_not_mapped");
    this.#sessions.delete(bindingHandle);
    this.#bindingsByRawSession.delete(rawSessionId);
    this.#privateValues.delete(rawSessionId);
    for (const [key] of this.#tools) {
      if (key.startsWith(`${bindingHandle}\u0000`)) this.#tools.delete(key);
    }
    for (const [interactionId, permission] of this.#permissions) {
      if (permission.bindingHandle === bindingHandle) this.#permissions.delete(interactionId);
    }
  }

  rememberPrivateValue(value: string | undefined | null): void {
    this.assertActive();
    if (typeof value === "string" && value) this.#privateValues.add(value);
  }

  redact(text: string, additionalPrivateValues: readonly string[] = []): string {
    this.assertActive();
    const values = [...this.#privateValues, ...additionalPrivateValues]
      .filter((value) => Boolean(value))
      .sort((left, right) => right.length - left.length);
    return values.reduce(
      (safe, privateValue) => safe.split(privateValue).join("<workspace>"),
      text,
    );
  }

  invalidate(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#sessions.clear();
    this.#bindingsByRawSession.clear();
    this.#tools.clear();
    this.#permissions.clear();
    this.#privateValues.clear();
    this.#issuedOpaqueIds.clear();
  }

  #newOpaqueId(kind: AcpOpaqueIdKind, code: string): string {
    const id = this.#createOpaqueId(kind);
    requireWorkspaceId(id, kind, code);
    if (this.#privateValues.has(id)) failAcp("acp_opaque_id_collides_with_private_value");
    if (this.#issuedOpaqueIds.has(id)) failAcp("acp_opaque_id_duplicate");
    this.#issuedOpaqueIds.add(id);
    return id;
  }
}

function identityKey(bindingHandle: string, attemptId: string, rawId: string): string {
  return `${bindingHandle}\u0000${attemptId}\u0000${rawId}`;
}

function requireWorkspaceId(value: string, prefix: string, code: string): void {
  if (
    typeof value !== "string"
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)
  ) {
    throw new AcpBoundaryError(code);
  }
}

function requireRawId(value: string, code: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new AcpBoundaryError(code);
  }
}
