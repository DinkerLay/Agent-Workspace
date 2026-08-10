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

// The runnable Adapter is Node ESM. This facade provides the typed workspace
// import surface without coupling the Provider package to Runtime application.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- implementation declarations are expressed by this facade.
import * as implementation from "./index.mjs";

export const OPENCODE_PROVIDER_ID: ProviderKind = implementation.OPENCODE_PROVIDER_ID;
export const OPENCODE_CAPABILITIES: readonly ProviderCapability[] = implementation.OPENCODE_CAPABILITIES;
export const OPENCODE_FIXTURE_PROTOCOL: ProtocolPin = implementation.OPENCODE_FIXTURE_PROTOCOL;

export const createOpenCodeProviderAdapter: (input: {
  readonly transport: ProviderTransport;
  readonly protocol: ProtocolPin;
  readonly capabilities?: readonly ProviderCapability[];
  readonly now?: () => string;
}) => ProviderPort = implementation.createOpenCodeProviderAdapter;
export const createOpenCodeServerTransport: (input: {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchFn?: typeof fetch;
}) => ProviderTransport = implementation.createOpenCodeServerTransport;
export const openCodeServerProtocolFingerprint: (openApi: unknown) => string = implementation.openCodeServerProtocolFingerprint;
export const inspectOpenCodeServerProtocol: (input: {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchFn?: typeof fetch;
}) => Promise<ProtocolPin> = implementation.inspectOpenCodeServerProtocol;
export const createOpenCodeFixtureTransport: (input?: {
  readonly protocol?: ProtocolPin;
  readonly effects?: Record<string, unknown>;
  readonly streams?: Record<string, readonly unknown[]>;
  readonly reconciliations?: Record<string, readonly unknown[]>;
}) => ProviderTransport = implementation.createOpenCodeFixtureTransport;
export const createOpenCodeFixtureProfile: (overrides?: Partial<ExecutionProfileDefinition>) => ExecutionProfileDefinition = implementation.createOpenCodeFixtureProfile;
export const mapOpenCodeNativeFact: (nativeFact: unknown, context?: { readonly bindingId: string }) => unknown = implementation.mapOpenCodeNativeFact;
