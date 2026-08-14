import type {
  AcpV1ConnectionFactory,
  AcpV1ReverseRpcHandlers,
} from "./connection.js";

export type AcpV1Capability =
  | "session_new"
  | "session_prompt"
  | "session_cancel"
  | "session_update"
  | "session_load"
  | "session_resume"
  | "session_close"
  | "mcp_stdio"
  | "mcp_http"
  | "mcp_sse"
  | "permission";

export interface AcpV1QualificationRequirements {
  readonly protocolMajor: 1;
  readonly requiredCapabilities: readonly AcpV1Capability[];
  /** Exact standard names or namespaced custom names declared by initialize. */
  readonly requiredExtensions: readonly string[];
}

export interface AcpQualificationObservation {
  readonly available: boolean;
  readonly protocolMajor: number | null;
  readonly agent?: {
    readonly name: string;
    readonly title?: string;
    readonly version?: string;
  };
  readonly capabilities: readonly AcpV1Capability[];
  /** Safe, explicitly named initialize extensions; never raw `_meta` values. */
  readonly extensions: readonly string[];
  readonly capabilityFingerprint: string;
  readonly unavailableReasons: readonly string[];
}

export interface AcpClientInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Host-private proof over a frozen initialize capability view
 * (`protocolVersion`, `agentCapabilities`, `_meta`); `agentInfo` is excluded.
 */
export type AcpExtensionPredicate = (initializeResponse: unknown) => boolean;

/** Workspace-owned opaque identity namespaces emitted by the ACP boundary. */
export type AcpOpaqueIdKind = "tool_handle" | "interaction" | "choice";

export interface CreateManagedAcpV1ClientOptions {
  readonly connect: AcpV1ConnectionFactory;
  readonly generationId: string;
  readonly createOpaqueId?: (kind: AcpOpaqueIdKind) => string;
  readonly onObservation?: (
    observation: AcpSessionObservation,
  ) => void | Promise<void>;
  /** Host-private synchronous hard-budget reservation before wire prompt effect. */
  readonly beforePromptEffect?: () => undefined;
  /** Host-private process paths that must be removed from safe observations. */
  readonly privateRedactionValues?: readonly string[];
  readonly clientInfo?: AcpClientInfo;
  /** Unknown initialize extensions grant nothing unless an exact predicate is registered. */
  readonly extensionPredicates?: Readonly<Record<string, AcpExtensionPredicate>>;
  /** Host-owned, lease-checking reverse-RPC broker. Omitted methods fail closed. */
  readonly reverseRpcHandlers?: AcpV1ReverseRpcHandlers;
}

export interface AcpBindingCommand {
  readonly bindingHandle: string;
  readonly disposition: "create" | "load" | "resume";
  /** Host-resolved private launch input. It is never returned in an observation. */
  readonly workspaceDirectory: string;
  readonly additionalDirectories?: readonly string[];
  /** ACP v1 MCP descriptors are passed through only to the injected connection. */
  readonly mcpServers: readonly unknown[];
  readonly configuration: AcpSessionConfigurationIntent;
}

export type AcpSessionConfigIntent =
  | {
      readonly configId: string;
      readonly category: string;
      readonly type: "select";
      readonly value: string;
    }
  | {
      readonly configId: string;
      readonly category: string;
      readonly type: "boolean";
      readonly value: boolean;
    };

export interface AcpSessionConfigurationIntent {
  /** Exact ACP model value ID selected from the category=model selector. */
  readonly model: string;
  /** Exact config ID/category/type/value requirements; labels are never matched. */
  readonly options: readonly AcpSessionConfigIntent[];
  /** Legacy session mode is touched only when explicitly requested. */
  readonly legacyModeId?: string;
}

/**
 * Renderer-safe model declared by the ACP Agent's category=model selector.
 * The originating config option id remains Host-private.
 */
export interface AcpModelCatalogEntry {
  readonly modelId: string;
  readonly label: string;
}

export interface AcpBindingObservation {
  readonly kind: "binding_ready";
  readonly bindingHandle: string;
  readonly disposition: "create" | "load" | "resume";
  readonly recoverable: boolean;
  readonly model: string;
  readonly modelCatalog: readonly AcpModelCatalogEntry[];
  readonly configurationFingerprint: string;
}

/** Host-private, temporary session used only to read the ACP model selector. */
export interface AcpModelCatalogInspectionCommand {
  readonly bindingHandle: string;
  readonly workspaceDirectory: string;
  readonly mcpServers: readonly unknown[];
}

export interface AcpModelCatalogInspectionObservation {
  readonly kind: "model_catalog_observed";
  readonly bindingHandle: string;
  readonly currentModel: string;
  readonly modelCatalog: readonly AcpModelCatalogEntry[];
}

export interface AcpPromptCommand {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly content: string;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpPermissionChoiceKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

interface AcpAttemptObservation {
  readonly bindingHandle: string;
  readonly attemptId: string;
}

export type AcpSessionObservation =
  | (AcpAttemptObservation & {
      readonly kind: "delivery_receipt";
      readonly receiptDigest: string;
    })
  | (AcpAttemptObservation & {
      readonly kind: "agent_message_chunk";
      readonly text: string;
    })
  | (AcpAttemptObservation & {
      readonly kind: "agent_thought_chunk";
      readonly text: string;
    })
  | (AcpAttemptObservation & {
      readonly kind: "tool_status";
      readonly toolCallHandle: string;
      readonly title?: string;
      readonly status?: "pending" | "in_progress" | "completed" | "failed";
    })
  | (AcpAttemptObservation & {
      readonly kind: "interaction_requested";
      readonly interactionId: string;
      readonly toolCallHandle: string;
      readonly promptDigest: string;
      readonly choices: readonly {
        readonly choiceId: string;
        readonly name: string;
        readonly kind: AcpPermissionChoiceKind;
      }[];
    })
  | (AcpAttemptObservation & {
      readonly kind: "final_candidate";
      readonly text: string;
    })
  | (AcpAttemptObservation & {
      readonly kind: "prompt_terminal";
      readonly stopReason: AcpStopReason;
      readonly receiptDigest: string;
    });

export interface AcpPromptSettlement {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly stopReason: AcpStopReason;
  readonly receiptDigest: string;
  /** Safe count of text candidate groups observed during this exact attempt. */
  readonly finalCandidateGroupCount: number;
  readonly finalCandidate?: string;
}

export interface AcpInteractionResponseCommand {
  readonly bindingHandle: string;
  readonly attemptId: string;
  readonly interactionId: string;
  readonly choiceId: string;
}

export interface AcpInterruptCommand {
  readonly bindingHandle: string;
  readonly attemptId?: string;
}

export interface AcpInterruptObservation {
  readonly kind: "interrupt_requested";
  readonly bindingHandle: string;
  readonly attemptId?: string;
  readonly acceptance: "accepted";
}

export interface AcpReleaseBindingCommand {
  readonly bindingHandle: string;
}

export interface ManagedAcpV1Client {
  initialize(
    requirements: AcpV1QualificationRequirements,
  ): Promise<AcpQualificationObservation>;
  inspectModelCatalog(
    command: AcpModelCatalogInspectionCommand,
  ): Promise<AcpModelCatalogInspectionObservation>;
  ensureBinding(command: AcpBindingCommand): Promise<AcpBindingObservation>;
  submitPrompt(command: AcpPromptCommand): Promise<AcpPromptSettlement>;
  requestInterrupt(command: AcpInterruptCommand): Promise<AcpInterruptObservation>;
  respondToInteraction(command: AcpInteractionResponseCommand): Promise<void>;
  releaseBinding(command: AcpReleaseBindingCommand): Promise<void>;
  invalidateGeneration(): void;
}
