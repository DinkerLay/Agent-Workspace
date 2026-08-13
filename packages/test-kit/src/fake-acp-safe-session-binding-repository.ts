import {
  cloneAcpSafeSessionBindingRecordV3,
  type AcpSafeSessionBindingRecordV3,
} from "@agent-workspace/runtime-contracts";

/** Binding-owner fake for v3 contract tests; it is not a SQLite compatibility facade. */
export class InMemoryAcpSafeSessionBindingRepository {
  #bindings = new Map<string, AcpSafeSessionBindingRecordV3>();
  #currentByLogicalSession = new Map<string, string>();

  insert(binding: AcpSafeSessionBindingRecordV3): void {
    const valid = cloneAcpSafeSessionBindingRecordV3(binding);
    if (this.#bindings.has(valid.bindingId)) throw new Error("acp_safe_binding_v3_duplicate");
    this.#bindings.set(valid.bindingId, valid);
  }

  update(binding: AcpSafeSessionBindingRecordV3, expectedRevision: number): void {
    const valid = cloneAcpSafeSessionBindingRecordV3(binding);
    const current = this.#bindings.get(valid.bindingId);
    if (!current) throw new Error("acp_safe_binding_v3_not_found");
    if (current.revision !== expectedRevision || valid.revision !== expectedRevision + 1) {
      throw new Error("acp_safe_binding_v3_revision_stale");
    }
    if (current.taskId !== valid.taskId
      || current.runId !== valid.runId
      || current.logicalSessionId !== valid.logicalSessionId
      || current.agentCardId !== valid.agentCardId
      || current.executionProfileId !== valid.executionProfileId
      || current.profileRevisionId !== valid.profileRevisionId
      || current.providerFamily !== valid.providerFamily
      || current.bindingHandle !== valid.bindingHandle) {
      throw new Error("acp_safe_binding_v3_scope_immutable");
    }
    this.#bindings.set(valid.bindingId, valid);
  }

  get(bindingId: string): AcpSafeSessionBindingRecordV3 | undefined {
    const binding = this.#bindings.get(bindingId);
    return binding ? cloneAcpSafeSessionBindingRecordV3(binding) : undefined;
  }

  setCurrent(logicalSessionId: string, bindingId: string): void {
    const binding = this.#bindings.get(bindingId);
    if (!binding || binding.logicalSessionId !== logicalSessionId) {
      throw new Error("acp_safe_binding_v3_current_scope_mismatch");
    }
    if (binding.status !== "active" && binding.status !== "recovering") {
      throw new Error("acp_safe_binding_v3_current_not_live");
    }
    this.#currentByLogicalSession.set(logicalSessionId, bindingId);
  }

  getCurrentForLogicalSession(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined {
    const bindingId = this.#currentByLogicalSession.get(logicalSessionId);
    return bindingId ? this.get(bindingId) : undefined;
  }

  snapshot(): Readonly<{
    bindings: readonly AcpSafeSessionBindingRecordV3[];
    currentBindings: readonly Readonly<{ logicalSessionId: string; bindingId: string }>[];
  }> {
    return Object.freeze({
      bindings: Object.freeze([...this.#bindings.values()]
        .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
        .map(cloneAcpSafeSessionBindingRecordV3)),
      currentBindings: Object.freeze([...this.#currentByLogicalSession.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([logicalSessionId, bindingId]) => Object.freeze({ logicalSessionId, bindingId }))),
    });
  }
}
