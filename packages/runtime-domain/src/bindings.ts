import {
  providerFactDedupKey,
  type ProviderEffect,
  type ProviderFact,
  type ProviderSessionBindingRecord,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

export interface CreateBindingInput {
  readonly bindingId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly executionProfileId: string;
  readonly provider: ProviderSessionBindingRecord["provider"];
  readonly providerHostId?: string;
  readonly now: string;
}

export function createProviderSessionBinding(input: CreateBindingInput): ProviderSessionBindingRecord {
  invariant(input.bindingId.startsWith("binding_"), "binding_id_invalid");
  invariant(input.taskId.startsWith("task_"), "binding_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "binding_run_id_invalid");
  invariant(input.logicalSessionId.startsWith("logical_session_"), "binding_logical_session_id_invalid");
  invariant(input.executionProfileId.startsWith("profile_"), "binding_profile_id_invalid");
  return {
    bindingId: input.bindingId,
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.logicalSessionId,
    executionProfileId: input.executionProfileId,
    provider: input.provider,
    ...(input.providerHostId ? { providerHostId: input.providerHostId } : {}),
    bindingRevision: 1,
    status: "unbound",
    recoverable: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Local acceptance only makes a binding pending; it never makes it active. */
export function recordEnsureBindingEffect(
  binding: ProviderSessionBindingRecord,
  effect: ProviderEffect,
  now: string,
): ProviderSessionBindingRecord {
  invariant(effect.kind === "ensure_binding", "binding_effect_kind_invalid");
  invariant(effect.bindingId === binding.bindingId, "binding_effect_binding_mismatch");
  invariant(binding.status === "unbound" || binding.status === "binding_effect_accepted" || binding.status === "recovering", "binding_effect_state_invalid");
  if (effect.acceptance === "accepted") {
    return { ...binding, status: "binding_effect_accepted", updatedAt: now };
  }
  if (effect.acceptance === "unknown") return { ...binding, status: "recovering", updatedAt: now };
  return binding;
}

export function applyProviderFactToBinding(
  binding: ProviderSessionBindingRecord,
  fact: ProviderFact,
  now: string,
): ProviderSessionBindingRecord {
  if (fact.bindingId !== binding.bindingId) return binding;
  if (fact.bindingRevision < binding.bindingRevision) return binding;
  invariant(fact.bindingRevision === binding.bindingRevision, "provider_fact_binding_revision_future");
  if (fact.kind === "binding_observed") {
    const nativeBindingRef = readNativeBindingRef(fact);
    invariant(nativeBindingRef, "provider_binding_native_ref_required");
    return {
      ...binding,
      nativeBindingRef,
      status: "active",
      recoverable: true,
      updatedAt: now,
    };
  }
  if (fact.kind === "binding_unavailable" || fact.kind === "provider_unavailable") {
    return { ...binding, status: "unrecoverable", recoverable: false, updatedAt: now };
  }
  if (fact.kind === "native_terminal") {
    return { ...binding, status: "released", recoverable: false, updatedAt: now };
  }
  return binding;
}

export function requestBindingRelease(binding: ProviderSessionBindingRecord, now: string): ProviderSessionBindingRecord {
  invariant(["active", "recovering", "binding_effect_accepted"].includes(binding.status), "binding_not_releasable");
  return { ...binding, status: "release_requested", updatedAt: now };
}

/** A successful ProviderPort.releaseBinding call is the Binding owner's durable release fact. */
export function completeBindingRelease(binding: ProviderSessionBindingRecord, now: string): ProviderSessionBindingRecord {
  if (binding.status === "released") return binding;
  invariant(binding.status === "release_requested", "binding_release_not_requested");
  return { ...binding, status: "released", recoverable: false, updatedAt: now };
}

export function isProviderFactCurrent(binding: ProviderSessionBindingRecord, fact: ProviderFact): boolean {
  return fact.bindingId === binding.bindingId
    && fact.provider === binding.provider
    && fact.bindingRevision === binding.bindingRevision;
}

export interface ProviderFactDedupResult {
  readonly dedupKey: string;
  readonly duplicate: boolean;
  readonly nextDedupKeys: ReadonlySet<string>;
}

/** The Store persists these keys; this pure helper makes duplicate handling deterministic. */
export function deduplicateProviderFact(existingDedupKeys: ReadonlySet<string>, fact: ProviderFact): ProviderFactDedupResult {
  const dedupKey = providerFactDedupKey(fact);
  if (existingDedupKeys.has(dedupKey)) {
    return { dedupKey, duplicate: true, nextDedupKeys: new Set(existingDedupKeys) };
  }
  const nextDedupKeys = new Set(existingDedupKeys);
  nextDedupKeys.add(dedupKey);
  return { dedupKey, duplicate: false, nextDedupKeys };
}

function readNativeBindingRef(fact: ProviderFact): string | undefined {
  const value = fact.payload.nativeBindingRef;
  return typeof value === "string" && value.trim() ? value : undefined;
}
