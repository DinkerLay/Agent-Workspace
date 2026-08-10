import type {
  ExecutionProfileDefinition,
  ProviderCapability,
  ProviderKind,
} from "../../runtime-contracts/src/index";
import type {
  NativeProviderFact,
  ProtocolPin,
  ProviderPort,
  ProviderTransport,
} from "../../provider-port/src/index";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- implementation declarations are expressed by this facade.
import * as implementation from "./index.mjs";

export const CLAUDE_CODE_PROVIDER_ID: ProviderKind = implementation.CLAUDE_CODE_PROVIDER_ID;
export const CLAUDE_CODE_CAPABILITIES: readonly ProviderCapability[] = implementation.CLAUDE_CODE_CAPABILITIES;
export const CLAUDE_CODE_PROVEN_CAPABILITIES: readonly ProviderCapability[] = implementation.CLAUDE_CODE_PROVEN_CAPABILITIES;
export const CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES: readonly string[] = implementation.CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES;
export const CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT: string = implementation.CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT;
export const CLAUDE_CODE_FIXTURE_PROTOCOL: ProtocolPin = implementation.CLAUDE_CODE_FIXTURE_PROTOCOL;
export type ClaudeCodeCliDeliveryCorrelation = Readonly<{
  readonly commandUuid: string;
  readonly inputSubmissionId: string;
  readonly invocationId?: string;
}>;
export type ClaudeCodeCliMapContext = Readonly<{
  readonly sourceInstanceId: string;
  readonly cursor: string;
  readonly disposition: "create" | "resume";
  readonly activeCorrelation?: ClaudeCodeCliDeliveryCorrelation;
  readonly correlationForCommandUuid?: (commandUuid: string) => ClaudeCodeCliDeliveryCorrelation | undefined;
}>;
export type ClaudeCodeCliInit = Readonly<{
  readonly sessionId: string;
  readonly providerVersion: string;
  readonly capabilities: readonly string[];
}>;
export const createClaudeCodeCommandUuid: (input: { readonly bindingId: string; readonly idempotencyKey: string }) => string = implementation.createClaudeCodeCommandUuid;
export const readClaudeCodeCliInit: (frame: unknown) => ClaudeCodeCliInit | undefined = implementation.readClaudeCodeCliInit;
export const cliInitSupportsRequiredCapabilities: (init: ClaudeCodeCliInit | undefined) => boolean = implementation.cliInitSupportsRequiredCapabilities;
export const mapClaudeCodeCliFrame: (frame: unknown, context: ClaudeCodeCliMapContext) => readonly NativeProviderFact[] = implementation.mapClaudeCodeCliFrame;
export const createClaudeCodeProviderAdapter: (input: {
  readonly transport: ProviderTransport;
  readonly protocol: ProtocolPin;
  readonly capabilities?: readonly ProviderCapability[];
  readonly now?: () => string;
}) => ProviderPort = implementation.createClaudeCodeProviderAdapter;
export const createClaudeCodeFixtureTransport: (input?: {
  readonly protocol?: ProtocolPin;
  readonly effects?: Record<string, unknown>;
  readonly streams?: Record<string, readonly unknown[]>;
  readonly reconciliations?: Record<string, readonly unknown[]>;
}) => ProviderTransport = implementation.createClaudeCodeFixtureTransport;
export const createClaudeCodeFixtureProfile: (overrides?: Partial<ExecutionProfileDefinition>) => ExecutionProfileDefinition = implementation.createClaudeCodeFixtureProfile;
export const mapClaudeCodeNativeFact: (nativeFact: unknown, context?: { readonly bindingId: string }) => unknown = implementation.mapClaudeCodeNativeFact;
