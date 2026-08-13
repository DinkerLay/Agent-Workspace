import type { AcpObservedAgentIdentity, AcpProfileModelCatalogEntry } from "./acp-profile-readiness";
import type { ProviderFamily } from "./templates";

export type AcpProviderSettingsStatus =
  | "not_configured"
  | "not_checked"
  | "checking"
  | "available"
  | "unavailable"
  | "capability_missing";

export type AcpProviderInstallationComponentKind =
  | "provider_cli"
  | "node"
  | "credential_source";

export type AcpProviderInstallationComponent = Readonly<{
  kind: AcpProviderInstallationComponentKind;
  label: string;
  status: "found" | "missing";
  /** Settings-only local display value. Home paths are shortened to `~/...`. */
  displayPath?: string;
}>;

export type AcpProviderInstallationDiscovery = Readonly<{
  status: "not_scanned" | "ready" | "incomplete" | "not_found";
  components: readonly AcpProviderInstallationComponent[];
}>;

/** Renderer-safe Provider status. Host paths, credentials and raw ACP IDs are intentionally absent. */
export type AcpProviderSettingsEntry = Readonly<{
  providerFamily: ProviderFamily;
  displayName: string;
  configured: boolean;
  status: AcpProviderSettingsStatus;
  reasons: readonly string[];
  models: readonly AcpProfileModelCatalogEntry[];
  configurationSource: "none" | "environment" | "local";
  installation: AcpProviderInstallationDiscovery;
  /** Ordered models explicitly enabled for new Chat/Meta profile selection. */
  enabledChatModelIds?: readonly string[];
  defaultModelId?: string;
  observedAgent?: AcpObservedAgentIdentity;
  observedArtifactVersion?: string;
  observedUpstreamVersion?: string;
}>;

export type AcpProviderSettingsReadModel = Readonly<{
  generatedAt: string;
  providers: readonly AcpProviderSettingsEntry[];
}>;
