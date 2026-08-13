export { AcpBoundaryError } from "./errors.js";
export { createManagedAcpV1Client } from "./managed-client.js";

export const ACP_V1_PROTOCOL_MAJOR = 1 as const;

export type {
  AcpV1ClientHandlers,
  AcpV1ConnectionFactory,
  AcpV1ReverseRpcHandlers,
  InjectedAcpV1Connection,
} from "./connection.js";
export type {
  AcpBindingCommand,
  AcpBindingObservation,
  AcpClientInfo,
  AcpExtensionPredicate,
  AcpInteractionResponseCommand,
  AcpInterruptCommand,
  AcpInterruptObservation,
  AcpModelCatalogEntry,
  AcpModelCatalogInspectionCommand,
  AcpModelCatalogInspectionObservation,
  AcpOpaqueIdKind,
  AcpPermissionChoiceKind,
  AcpPromptCommand,
  AcpPromptSettlement,
  AcpQualificationObservation,
  AcpReleaseBindingCommand,
  AcpSessionObservation,
  AcpSessionConfigIntent,
  AcpSessionConfigurationIntent,
  AcpStopReason,
  AcpV1Capability,
  AcpV1QualificationRequirements,
  CreateManagedAcpV1ClientOptions,
  ManagedAcpV1Client,
} from "./types.js";
