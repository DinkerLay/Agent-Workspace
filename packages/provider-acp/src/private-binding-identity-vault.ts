import { failAcp } from "./errors.js";

interface BindingIdentityEntry {
  readonly rawSessionId: string;
  activeGenerationId?: string;
}

export interface HostPrivateBindingIdentityVault {
  bindNew(input: {
    readonly bindingHandle: string;
    readonly generationId: string;
    readonly rawSessionId: string;
  }): void;
  checkout(input: {
    readonly bindingHandle: string;
    readonly generationId: string;
  }): string;
  detachGeneration(generationId: string): void;
  detachBinding(input: {
    readonly bindingHandle: string;
    readonly generationId: string;
  }): void;
  delete(input: {
    readonly bindingHandle: string;
    readonly generationId: string;
  }): void;
}

/**
 * Host-memory seam between child process generations. Phase 6 may replace this
 * with a permission-restricted Host-private store; it must never be an owner DB.
 */
export class InMemoryHostPrivateBindingIdentityVault
implements HostPrivateBindingIdentityVault {
  readonly #entries = new Map<string, BindingIdentityEntry>();

  bindNew(input: {
    readonly bindingHandle: string;
    readonly generationId: string;
    readonly rawSessionId: string;
  }): void {
    validate(input.bindingHandle, "acp_binding_handle_invalid");
    validate(input.generationId, "acp_generation_id_invalid");
    validate(input.rawSessionId, "acp_raw_session_invalid");
    if (this.#entries.has(input.bindingHandle)) {
      failAcp("acp_binding_identity_already_exists");
    }
    this.#entries.set(input.bindingHandle, {
      rawSessionId: input.rawSessionId,
      activeGenerationId: input.generationId,
    });
  }

  checkout(input: { readonly bindingHandle: string; readonly generationId: string }): string {
    validate(input.bindingHandle, "acp_binding_handle_invalid");
    validate(input.generationId, "acp_generation_id_invalid");
    const entry = this.#entries.get(input.bindingHandle);
    if (!entry) failAcp("acp_binding_identity_not_found");
    if (entry.activeGenerationId && entry.activeGenerationId !== input.generationId) {
      failAcp("acp_binding_identity_generation_conflict");
    }
    entry.activeGenerationId = input.generationId;
    return entry.rawSessionId;
  }

  detachGeneration(generationId: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.activeGenerationId === generationId) entry.activeGenerationId = undefined;
    }
  }

  detachBinding(input: { readonly bindingHandle: string; readonly generationId: string }): void {
    const entry = this.#entries.get(input.bindingHandle);
    if (!entry) failAcp("acp_binding_identity_not_found");
    if (entry.activeGenerationId !== input.generationId) {
      failAcp("acp_binding_identity_generation_conflict");
    }
    entry.activeGenerationId = undefined;
  }

  delete(input: { readonly bindingHandle: string; readonly generationId: string }): void {
    const entry = this.#entries.get(input.bindingHandle);
    if (!entry) failAcp("acp_binding_identity_not_found");
    if (entry.activeGenerationId !== input.generationId) {
      failAcp("acp_binding_identity_generation_conflict");
    }
    this.#entries.delete(input.bindingHandle);
  }
}

export function createHostPrivateBindingIdentityVault(): HostPrivateBindingIdentityVault {
  return new InMemoryHostPrivateBindingIdentityVault();
}

function validate(value: string, code: string): void {
  if (typeof value !== "string" || !value.trim()) failAcp(code);
}
