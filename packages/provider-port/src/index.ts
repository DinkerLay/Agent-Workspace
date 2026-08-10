import type {
  AttentionId,
  ExecutionProfileDefinition,
  InputSubmissionId,
  InvocationId,
  ProviderCapabilities,
  ProviderCapability,
  ProviderEffect,
  ProviderFact,
  ProviderKind,
  ProviderSessionBootstrap,
  ProviderSessionBindingId,
  SessionPresentation,
  WorkspaceId,
} from "../../runtime-contracts/src/index";

// The executable implementation is Node ESM so it can also run directly with
// `node --test`. This typed facade is the monorepo's public import surface.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- implementation declarations are expressed by this facade.
import * as implementation from "./index.mjs";

export * from "./meta.js";

export interface ProtocolPin {
  readonly providerVersion: string;
  readonly protocolFingerprint: string;
}

export type ProviderTransportOperation =
  | "inspect_protocol"
  | "ensure_host"
  | "ensure_binding"
  | "submit_delivery"
  | "observe_binding"
  | "reconcile_binding"
  | "request_interrupt"
  | "respond_attention"
  | "open_presentation"
  | "release_binding";

/** Frozen Task workspace authority supplied by Runtime Host, never by Renderer. */
export interface ProviderWorkspaceContext {
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
}

export interface ProviderPortBindingRequest {
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  /**
   * Opaque native identity previously observed by the Provider and persisted by
   * the Runtime binding projection. It is supplied back to the Provider only
   * for resume, reconciliation, delivery, and interruption; Runtime code never
   * interprets or derives it.
   */
  readonly nativeBindingRef?: string;
  readonly executionProfile: ExecutionProfileDefinition;
  readonly workspace: ProviderWorkspaceContext;
  /** Immutable Session instructions compiled from the Task Architecture. */
  readonly bootstrap: ProviderSessionBootstrap;
  readonly commandId?: string;
  readonly idempotencyKey?: string;
  readonly inputSubmissionId?: InputSubmissionId;
  readonly invocationId?: InvocationId;
}

export interface EnsureBindingRequest extends ProviderPortBindingRequest {
  readonly disposition: "create" | "resume";
}

export interface SubmitDeliveryRequest extends ProviderPortBindingRequest {
  readonly inputSubmissionId: InputSubmissionId;
  readonly idempotencyKey: string;
  readonly content: string;
}

export interface InterruptRequest extends ProviderPortBindingRequest {
  readonly idempotencyKey: string;
  readonly invocationId?: InvocationId;
}

export interface AttentionReplyRequest extends ProviderPortBindingRequest {
  readonly attentionId: AttentionId;
  readonly nativeRequestId: string;
  readonly activeInputSubmissionId?: InputSubmissionId;
  readonly activeInvocationId?: InvocationId;
  readonly response: Record<string, unknown>;
}

/** Optional operations are intentionally not ProviderEffect domain inputs. */
export interface ProviderPortHostEffect {
  readonly effectId: string;
  readonly kind: "ensure_host" | "open_presentation" | "release_binding";
  readonly provider: ProviderKind;
  readonly acceptance: "accepted" | "rejected" | "unknown";
  readonly acceptedAt: string;
}

export interface ProviderPort {
  readonly provider: ProviderKind;
  describeCapabilities(profile: ExecutionProfileDefinition): Promise<ProviderCapabilities>;
  ensureHost?(request: ProviderPortBindingRequest): Promise<ProviderPortHostEffect>;
  ensureBinding(request: EnsureBindingRequest): Promise<ProviderEffect>;
  submitDelivery(request: SubmitDeliveryRequest): Promise<ProviderEffect>;
  observeBinding(request: ProviderPortBindingRequest): AsyncIterable<ProviderFact>;
  reconcileBinding(request: ProviderPortBindingRequest): Promise<readonly ProviderFact[]>;
  requestInterrupt(request: InterruptRequest): Promise<ProviderEffect>;
  respondAttention?(request: AttentionReplyRequest): Promise<ProviderEffect>;
  openPresentation?(request: ProviderPortBindingRequest): Promise<SessionPresentation>;
  releaseBinding(request: ProviderPortBindingRequest): Promise<void>;
  /**
   * Host process lifecycle only. This closes adapter-owned transport resources
   * (for example a persistent CLI child) and never changes Task/Run truth.
   */
  close?(): Promise<void>;
}

export interface NativeProviderFact {
  readonly kind: string;
  readonly providerEventId?: string;
  readonly sourceInstanceId?: string;
  readonly cursor?: string;
  readonly reconciliationWatermark?: string;
  readonly bindingRevision?: number;
  readonly inputSubmissionId?: string;
  readonly sessionTurnId?: string;
  readonly invocationId?: string;
  readonly attentionId?: string;
  readonly nativeMessageId?: string;
  readonly nativeTurnId?: string;
  readonly nativeRequestId?: string;
  readonly evidenceReferenceId?: string;
  readonly historyMarker?: string;
  readonly payload?: Record<string, unknown>;
}

export interface ProviderTransport {
  /** Explicit Host transport declaration; missing means fail-closed capabilities. */
  readonly supportedOperations?: readonly ProviderTransportOperation[];
  /**
   * Optional semantic proof cap for a concrete native transport. Operation
   * presence only proves a route exists; a version spike may establish that a
   * smaller subset is safe to advertise. Omitted keeps conservative
   * operation-derived capability gating for test and future direct transports.
   */
  readonly verifiedCapabilities?: readonly ProviderCapability[];
  inspectProtocol?(): Promise<ProtocolPin>;
  request(input: { readonly operation: string; readonly request: unknown }): Promise<{
    readonly acceptance?: "accepted" | "rejected" | "unknown";
    readonly accepted?: boolean;
    readonly effectId?: string;
    readonly transportRequestId?: string;
    readonly diagnostic?: string;
    readonly reason?: string;
    readonly presentation?: SessionPresentation;
  }>;
  observe?(input: { readonly operation: "observe_binding"; readonly request: ProviderPortBindingRequest }): AsyncIterable<NativeProviderFact> | Promise<AsyncIterable<NativeProviderFact>>;
  reconcile?(input: { readonly operation: "reconcile_binding"; readonly request: ProviderPortBindingRequest }): Promise<readonly NativeProviderFact[] | { readonly facts: readonly NativeProviderFact[] }>;
}

export interface ProviderAdapterConfig {
  readonly provider: ProviderKind;
  readonly declaredProtocol: ProtocolPin;
  readonly capabilities: readonly ProviderCapability[];
  readonly transport: ProviderTransport;
  readonly mapNativeFact?: (nativeFact: unknown, context: {
    readonly provider: ProviderKind;
    readonly bindingId: ProviderSessionBindingId;
    readonly bindingRevision: number;
  }) => NativeProviderFact;
  readonly now?: () => string;
}

export const PROVIDER_PORT_VERSION: number = implementation.PROVIDER_PORT_VERSION;
export const PROVIDER_TRANSPORT_OPERATIONS: readonly ProviderTransportOperation[] = implementation.PROVIDER_TRANSPORT_OPERATIONS;
export const REQUIRED_PROVIDER_CAPABILITIES: readonly ProviderCapability[] = implementation.REQUIRED_PROVIDER_CAPABILITIES;
export const PROVIDER_EFFECT_OPERATIONS: readonly string[] = implementation.PROVIDER_EFFECT_OPERATIONS;
export const PROVIDER_FACT_KINDS: readonly ProviderFact["kind"][] = implementation.PROVIDER_FACT_KINDS;
export const ProviderUnavailableError = implementation.ProviderUnavailableError as typeof Error;
export const ProviderProtocolError = implementation.ProviderProtocolError as typeof Error;
export const ProviderTransportError = implementation.ProviderTransportError as typeof Error;
export const stableJson: (value: unknown) => string = implementation.stableJson;
export const sha256: (value: unknown) => string = implementation.sha256;
export const renderProviderSessionBootstrap: (bootstrap: ProviderSessionBootstrap) => string = implementation.renderProviderSessionBootstrap;
export const providerFactDedupKey: (fact: ProviderFact) => string = implementation.providerFactDedupKey;
export const providerTransportOperations: (transport: ProviderTransport) => readonly ProviderTransportOperation[] = implementation.providerTransportOperations;
export const deriveProviderCapabilitiesFromTransport: (transport: ProviderTransport) => readonly ProviderCapability[] = implementation.deriveProviderCapabilitiesFromTransport;
export const normalizeProviderFact: (input: {
  readonly provider: ProviderKind;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly nativeFact: NativeProviderFact;
  readonly now?: () => string;
}) => ProviderFact = implementation.normalizeProviderFact;
export const createProtocolGatedProviderAdapter: (config: ProviderAdapterConfig) => ProviderPort = implementation.createProtocolGatedProviderAdapter;
export const createScriptedProviderTransport: (input?: {
  readonly protocol: ProtocolPin;
  readonly effects?: Record<string, unknown>;
  readonly streams?: Record<string, readonly NativeProviderFact[]>;
  readonly reconciliations?: Record<string, readonly NativeProviderFact[]>;
}) => ProviderTransport = implementation.createScriptedProviderTransport;

export type { ProviderCapabilities, ProviderEffect, ProviderFact, ProviderKind, SessionPresentation };
