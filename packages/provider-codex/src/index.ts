import type {
  ExecutionProfileDefinition,
  ProviderCapability,
  ProviderKind,
} from "../../runtime-contracts/src/index";
import type {
  ProtocolPin,
  ProviderPort,
  ProviderTransport,
} from "../../provider-port/src/index";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- implementation declarations are expressed by this facade.
import * as implementation from "./index.mjs";

export const CODEX_PROVIDER_ID: ProviderKind = implementation.CODEX_PROVIDER_ID;
export const CODEX_CAPABILITIES: readonly ProviderCapability[] = implementation.CODEX_CAPABILITIES;
export const CODEX_FIXTURE_PROTOCOL: ProtocolPin = implementation.CODEX_FIXTURE_PROTOCOL;
export const createCodexProviderAdapter: (input: {
  readonly transport: ProviderTransport;
  readonly protocol: ProtocolPin;
  readonly capabilities?: readonly ProviderCapability[];
  readonly now?: () => string;
}) => ProviderPort = implementation.createCodexProviderAdapter;
export const createCodexFixtureTransport: (input?: {
  readonly protocol?: ProtocolPin;
  readonly effects?: Record<string, unknown>;
  readonly streams?: Record<string, readonly unknown[]>;
  readonly reconciliations?: Record<string, readonly unknown[]>;
}) => ProviderTransport = implementation.createCodexFixtureTransport;
export const createCodexFixtureProfile: (overrides?: Partial<ExecutionProfileDefinition>) => ExecutionProfileDefinition = implementation.createCodexFixtureProfile;
export const mapCodexNativeFact: (nativeFact: unknown, context?: { readonly bindingId: string }) => unknown = implementation.mapCodexNativeFact;

export {
  CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
  createCodexAppServerProviderAdapter,
  createCodexAppServerTransport,
} from "./app-server";
export type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
  CodexAppServerConnectionInput,
  CodexAppServerInboundMessage,
  CodexAppServerJsonRpcId,
  CodexAppServerProviderAdapterOptions,
  CodexAppServerProviderPort,
  CodexAppServerSafetyPolicy,
  CodexAppServerTransport,
  CodexAppServerTransportOptions,
} from "./app-server";

export {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_BINARY_SHA256_0_146,
  CODEX_META_DISABLED_FEATURES_0_146,
  CODEX_META_LAUNCH_ARGUMENTS_0_146,
  CODEX_META_NO_TOOL_ATTESTATION_0_146,
  createCodexMetaAgentPort,
} from "./meta-agent";
export type {
  CodexMetaAgentPort,
  CodexMetaAgentPortOptions,
  CodexMetaAppServerConnectionFactory,
  CodexMetaAppServerConnectionInput,
  CodexMetaNoToolProcessAttestation,
} from "./meta-agent";
