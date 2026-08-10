import type {
  MetaAgentCapabilityReport,
  MetaAgentPort,
  MetaAgentTurnAcceptance,
  MetaAgentTurnReconciliation,
  MetaAgentTurnRequest,
} from "@agent-workspace/provider-port";
import type { MetaProfileDefinition, MetaTurnId, ProviderKind } from "@agent-workspace/runtime-contracts";

export type FakeMetaAgentOptions = Readonly<{
  provider?: ProviderKind;
  capabilities?: Partial<MetaAgentCapabilityReport>;
}>;

/** Controllable configuration-only Provider fixture. It never fabricates Task state. */
export class FakeMetaAgent implements MetaAgentPort {
  readonly provider: ProviderKind;
  readonly started: MetaAgentTurnRequest[] = [];
  readonly reconciled: MetaAgentTurnRequest[] = [];
  readonly #capabilities: MetaAgentCapabilityReport;
  readonly #reconciliation = new Map<MetaTurnId, MetaAgentTurnReconciliation>();
  #nextAcceptance: MetaAgentTurnAcceptance = "accepted";

  constructor(options: FakeMetaAgentOptions = {}) {
    this.provider = options.provider ?? "codex";
    this.#capabilities = {
      provider: this.provider,
      available: true,
      providerVersion: "fake-meta-agent/1",
      protocolFingerprint: "fake-meta-agent-contract/v1",
      unavailableReasons: [],
      ...options.capabilities,
    };
  }

  async describeMetaCapabilities(_profile: MetaProfileDefinition): Promise<MetaAgentCapabilityReport> {
    return {
      ...this.#capabilities,
      unavailableReasons: [...this.#capabilities.unavailableReasons],
    };
  }

  async startMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnAcceptance> {
    this.started.push(request);
    const acceptance = this.#nextAcceptance;
    this.#nextAcceptance = "accepted";
    return acceptance;
  }

  async reconcileMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation> {
    this.reconciled.push(request);
    return this.#reconciliation.get(request.metaTurnId) ?? { state: "absent" };
  }

  setNextAcceptance(acceptance: MetaAgentTurnAcceptance): void {
    this.#nextAcceptance = acceptance;
  }

  setReconciliation(metaTurnId: MetaTurnId, reconciliation: MetaAgentTurnReconciliation): void {
    this.#reconciliation.set(metaTurnId, reconciliation);
  }
}

export function createFakeMetaAgent(options: FakeMetaAgentOptions = {}): FakeMetaAgent {
  return new FakeMetaAgent(options);
}
