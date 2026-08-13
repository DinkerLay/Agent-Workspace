import {
  createId,
  type ExecutionProfileDefinition,
  type InputSubmissionId,
  type ProviderCapabilities,
  type ProviderEffect,
  type ProviderEffectKind,
  type ProviderFact,
  type ProviderKind,
  type ProviderSessionBindingId,
  type SessionPresentation,
} from "../../runtime-contracts/src";

export interface FakeProviderPort {
  describeCapabilities(profile: ExecutionProfileDefinition): Promise<ProviderCapabilities>;
  ensureHost(request: FakeEnsureHostRequest): Promise<ProviderEffect>;
  ensureBinding(request: FakeEnsureBindingRequest): Promise<ProviderEffect>;
  submitDelivery(request: FakeSubmitDeliveryRequest): Promise<ProviderEffect>;
  observeBinding(request: FakeObserveBindingRequest): AsyncIterable<ProviderFact>;
  reconcileBinding(request: FakeObserveBindingRequest): Promise<readonly ProviderFact[]>;
  requestInterrupt(request: FakeInterruptRequest): Promise<ProviderEffect>;
  respondAttention(request: FakeAttentionResponseRequest): Promise<ProviderEffect>;
  openPresentation(request: FakeOpenPresentationRequest): Promise<SessionPresentation>;
  releaseBinding(request: { readonly bindingId: ProviderSessionBindingId }): Promise<void>;
}

export interface FakeEnsureHostRequest {
  readonly providerHostId?: string;
  readonly effectId?: string;
}

export interface FakeEnsureBindingRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly effectId?: string;
}

export interface FakeSubmitDeliveryRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly inputSubmissionId: InputSubmissionId;
  readonly effectId?: string;
}

export interface FakeObserveBindingRequest {
  readonly bindingId: ProviderSessionBindingId;
}

export interface FakeInterruptRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly effectId?: string;
}

export interface FakeAttentionResponseRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly attentionId: string;
  readonly effectId?: string;
}

export interface FakeOpenPresentationRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly presentationLeaseId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface FakeProviderOptions {
  readonly provider?: ProviderKind;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly now?: () => string;
}

/**
 * A controllable Provider contract fixture. It deliberately never synthesizes
 * a ProviderFact after any effect. Tests must call emitFact() to prove the
 * application reacts only to observed/reconciled Provider state.
 */
export class FakeProvider implements FakeProviderPort {
  readonly provider: ProviderKind;
  readonly effects: ProviderEffect[] = [];
  readonly facts: ProviderFact[] = [];
  readonly releasedBindings: ProviderSessionBindingId[] = [];
  private readonly now: () => string;
  private readonly capabilityValue: ProviderCapabilities;
  private readonly nextAcceptance = new Map<ProviderEffectKind, "accepted" | "rejected" | "unknown">();
  private readonly streams = new Set<FactStream>();

  constructor(options: FakeProviderOptions = {}) {
    this.provider = options.provider ?? "opencode";
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilityValue = {
      provider: this.provider,
      available: true,
      providerVersion: "fake-provider/1",
      protocolFingerprint: "fake-provider-contract/v1",
      capabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
        "attention_reply",
        "native_child",
        "presentation",
      ],
      unavailableReasons: [],
      ...options.capabilities,
    };
  }

  async describeCapabilities(_profile: ExecutionProfileDefinition): Promise<ProviderCapabilities> {
    return { ...this.capabilityValue, capabilities: [...this.capabilityValue.capabilities], unavailableReasons: [...this.capabilityValue.unavailableReasons] };
  }

  async ensureHost(request: FakeEnsureHostRequest): Promise<ProviderEffect> {
    return this.recordEffect("ensure_host", request.effectId);
  }

  async ensureBinding(request: FakeEnsureBindingRequest): Promise<ProviderEffect> {
    return this.recordEffect("ensure_binding", request.effectId, { bindingId: request.bindingId });
  }

  async submitDelivery(request: FakeSubmitDeliveryRequest): Promise<ProviderEffect> {
    return this.recordEffect("submit_delivery", request.effectId, {
      bindingId: request.bindingId,
      inputSubmissionId: request.inputSubmissionId,
    });
  }

  async *observeBinding(request: FakeObserveBindingRequest): AsyncIterable<ProviderFact> {
    for (const fact of this.facts) {
      if (fact.bindingId === request.bindingId) yield fact;
    }
    const stream: FactStream = { bindingId: request.bindingId, pending: [] };
    this.streams.add(stream);
    try {
      while (true) {
        const fact = await nextFact(stream);
        yield fact;
      }
    } finally {
      this.streams.delete(stream);
      stream.resolve?.({ done: true, value: undefined });
    }
  }

  async reconcileBinding(request: FakeObserveBindingRequest): Promise<readonly ProviderFact[]> {
    return this.facts.filter((fact) => fact.bindingId === request.bindingId);
  }

  async requestInterrupt(request: FakeInterruptRequest): Promise<ProviderEffect> {
    return this.recordEffect("request_interrupt", request.effectId, {
      bindingId: request.bindingId,
    });
  }

  async respondAttention(request: FakeAttentionResponseRequest): Promise<ProviderEffect> {
    return this.recordEffect("respond_attention", request.effectId, {
      bindingId: request.bindingId,
      attentionId: request.attentionId,
    });
  }

  async openPresentation(request: FakeOpenPresentationRequest): Promise<SessionPresentation> {
    return {
      presentationLeaseId: request.presentationLeaseId,
      bindingId: request.bindingId,
      kind: "workspace_transcript_and_composer",
      title: `Fake ${this.provider} presentation`,
      expiresAt: request.expiresAt,
    };
  }

  async releaseBinding(request: { readonly bindingId: ProviderSessionBindingId }): Promise<void> {
    this.releasedBindings.push(request.bindingId);
  }

  /** Changes only the next local effect outcome; it never injects a fact. */
  setNextAcceptance(kind: ProviderEffectKind, acceptance: "accepted" | "rejected" | "unknown"): void {
    this.nextAcceptance.set(kind, acceptance);
  }

  /** Adapter facts can intentionally be repeated/out of order for reconciliation tests. */
  emitFact(fact: ProviderFact): void {
    if (fact.provider !== this.provider) throw new Error("fake_provider_fact_provider_mismatch");
    this.facts.push(fact);
    for (const stream of this.streams) {
      if (stream.bindingId !== fact.bindingId) continue;
      if (stream.resolve) {
        const resolve = stream.resolve;
        stream.resolve = undefined;
        resolve({ done: false, value: fact });
      } else {
        stream.pending.push(fact);
      }
    }
  }

  effectsForBinding(bindingId: ProviderSessionBindingId): readonly ProviderEffect[] {
    return this.effects.filter((effect) => effect.bindingId === bindingId);
  }

  factsForBinding(bindingId: ProviderSessionBindingId): readonly ProviderFact[] {
    return this.facts.filter((fact) => fact.bindingId === bindingId);
  }

  private recordEffect(
    kind: ProviderEffectKind,
    effectId?: string,
    correlation: Omit<ProviderEffect, "effectId" | "kind" | "provider" | "acceptance" | "acceptedAt"> = {},
  ): ProviderEffect {
    const acceptance = this.nextAcceptance.get(kind) ?? "accepted";
    this.nextAcceptance.delete(kind);
    const effect: ProviderEffect = {
      effectId: effectId ?? createId("command"),
      kind,
      provider: this.provider,
      acceptance,
      acceptedAt: this.now(),
      ...correlation,
    };
    this.effects.push(effect);
    return effect;
  }
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  return new FakeProvider(options);
}

/** Useful contract assertion without coupling tests to a particular test framework. */
export function providerEffectHasNoFact(provider: FakeProvider, effect: ProviderEffect): boolean {
  return !provider.facts.some((fact) =>
    (effect.inputSubmissionId !== undefined && fact.correlation.inputSubmissionId === effect.inputSubmissionId)
    || (effect.attentionId !== undefined && fact.correlation.attentionId === effect.attentionId),
  );
}

interface FactStream {
  readonly bindingId: ProviderSessionBindingId;
  readonly pending: ProviderFact[];
  resolve?: (result: IteratorResult<ProviderFact>) => void;
}

function nextFact(stream: FactStream): Promise<ProviderFact> {
  const pending = stream.pending.shift();
  if (pending) return Promise.resolve(pending);
  return new Promise<ProviderFact>((resolve) => {
    stream.resolve = (result) => {
      if (result.done || !result.value) throw new Error("fake_provider_stream_closed");
      resolve(result.value);
    };
  });
}
