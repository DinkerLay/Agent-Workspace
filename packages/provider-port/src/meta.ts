import type {
  JsonValue,
  MetaMessageId,
  MetaProfileDefinition,
  MetaSessionMode,
  MetaTurnId,
  ProviderKind,
} from "@agent-workspace/runtime-contracts";

/** A provider-neutral transcript entry. It carries configuration chat only. */
export interface MetaAgentTranscriptEntry {
  readonly metaMessageId: MetaMessageId;
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Frozen, configuration-only input. Deliberately absent are every Task,
 * Binding, workspace, filesystem, routing, tool and credential capability.
 */
export interface MetaAgentTurnRequest {
  readonly metaTurnId: MetaTurnId;
  readonly userMetaMessageId: MetaMessageId;
  readonly idempotencyKey: string;
  readonly mode: MetaSessionMode;
  readonly profile: MetaProfileDefinition;
  readonly targetRevision: number;
  readonly systemInstructions: string;
  readonly outputSchema: JsonValue;
  readonly context: JsonValue;
  readonly transcript: readonly MetaAgentTranscriptEntry[];
  readonly content: string;
}

export interface MetaAgentCapabilityReport {
  readonly provider: ProviderKind;
  readonly available: boolean;
  readonly providerVersion?: string;
  readonly protocolFingerprint?: string;
  readonly unavailableReasons: readonly string[];
}

export type MetaAgentTurnAcceptance = "accepted" | "rejected" | "unknown";

export type MetaAgentTurnReconciliation =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "running" }>
  | Readonly<{ state: "returned"; finalText: string; observedAt: string }>
  | Readonly<{ state: "failed"; failureCode: string; observedAt: string }>
  | Readonly<{ state: "unknown" }>;

/** Sibling to the Task ProviderPort. It never accepts a Task-shaped request. */
export interface MetaAgentPort {
  readonly provider: ProviderKind;
  describeMetaCapabilities(profile: MetaProfileDefinition): Promise<MetaAgentCapabilityReport>;
  startMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnAcceptance>;
  reconcileMetaTurn(request: MetaAgentTurnRequest): Promise<MetaAgentTurnReconciliation>;
  close?(): Promise<void>;
}
