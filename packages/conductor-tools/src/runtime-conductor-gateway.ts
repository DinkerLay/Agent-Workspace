import {
  createId,
  type ArtifactId,
  type InvocationId,
  type MessageSelection,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type TaskRuntimeReadModel,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient } from "@agent-workspace/runtime-client";

/**
 * A Conductor is scoped to one Runtime-owned logical run. These are workbench
 * identities, never Provider session or thread identifiers.
 */
export type ConductorRunScope = Readonly<{
  taskId: string;
  runId: string;
  conductorLogicalSessionId: string;
  conductorSessionTurnId: string;
}>;

export type ConductorInvocationCommand = Extract<RuntimeCommand, { readonly type: "invocation.invoke_agent" }>;
export type ConductorRelayMessageCommand = Extract<RuntimeCommand, { readonly type: "session.relay_message" }>;
export type ConductorPublishMessageCommand = Extract<RuntimeCommand, { readonly type: "session.publish_message" }>;
export type ConductorVerifyRequestedArtifactCommand = Extract<RuntimeCommand, { readonly type: "artifact.verify_requested" }>;

/**
 * The only Runtime capability a Conductor receives. There is deliberately no
 * generic `command()` here, so a Conductor cannot synthesize Task lifecycle or
 * user-acceptance commands such as `task.achieve`.
 */
export type RuntimeConductorClient = Readonly<{
  read: RuntimeClient["read"];
  invokeAgent(command: ConductorInvocationCommand): Promise<RuntimeCommandResult>;
  relayMessage(command: ConductorRelayMessageCommand): Promise<RuntimeCommandResult>;
  publishMessage(command: ConductorPublishMessageCommand): Promise<RuntimeCommandResult>;
  verifyRequestedArtifact(command: ConductorVerifyRequestedArtifactCommand): Promise<RuntimeCommandResult>;
}>;

/** Narrows a generic RuntimeClient exactly once at trusted composition time. */
export function createRuntimeConductorClient(client: Pick<RuntimeClient, "read" | "command">): RuntimeConductorClient {
  if (!client || typeof client.read !== "function" || typeof client.command !== "function") {
    throw new TypeError("RuntimeConductorClient requires RuntimeClient read and command");
  }
  return Object.freeze({
    read: (request) => client.read(request),
    invokeAgent: (command) => client.command(command),
    relayMessage: (command) => client.command(command),
    publishMessage: (command) => client.command(command),
    verifyRequestedArtifact: (command) => client.command(command),
  });
}

/**
 * A Conductor chooses immutable collaboration content by identity. It cannot
 * pass an arbitrary context string, a native transcript, a file path, or a
 * Provider payload through this tool.
 */
export type InvokeAgentInput = Readonly<{
  agentCardId: string;
  instruction: string;
  messageSelections: readonly MessageSelection[];
  acceptanceCriteria?: readonly string[];
  requestedArtifacts?: readonly string[];
  priority?: "low" | "normal" | "high";
}>;

/** A relay is an explicit, ordinary Session-to-Session Message route. */
export type RelayMessageInput = Readonly<{
  targetAgentCardId: string;
  messageSelections: readonly MessageSelection[];
}>;

export type PublishMessageInput = Readonly<{
  targetAgentCardIds: readonly string[];
  messageSelections: readonly MessageSelection[];
  fanoutKey: string;
}>;

/**
 * A Conductor may only claim the path named by a completed Invocation. Runtime
 * resolves and validates the canonical final Message and owns Artifact identity,
 * digest, content type, and durable registration.
 */
export type RegisterArtifactInput = Readonly<{
  sourceInvocationId: InvocationId;
  workspaceRelativePath: string;
}>;

/** Returned to the Conductor; it never contains a Provider or Binding identity. */
export type InvocationDispatch = Readonly<{
  invocationId: InvocationId;
  commandId: string;
}>;

/** Relay delivery is owned by Runtime and creates no Invocation. */
export type RelayDispatch = Readonly<{
  commandId: string;
}>;

/** Artifact identity is returned only after Runtime validates the requested claim. */
export type ArtifactRegistration = Readonly<{
  artifactId: ArtifactId;
  commandId: string;
}>;

export interface RuntimeConductorGateway {
  readonly invoke_agent: (input: InvokeAgentInput) => Promise<InvocationDispatch>;
  readonly invoke_agents: (inputs: readonly InvokeAgentInput[]) => Promise<readonly InvocationDispatch[]>;
  readonly relay_message: (input: RelayMessageInput) => Promise<RelayDispatch>;
  readonly publish_message: (input: PublishMessageInput) => Promise<RelayDispatch>;
  readonly register_artifact: (input: RegisterArtifactInput) => Promise<ArtifactRegistration>;
}

export type RuntimeConductorGatewayOptions = Readonly<{
  client: RuntimeConductorClient;
  scope: ConductorRunScope;
  now?: () => string;
  createRuntimeId?: (prefix: "command" | "invocation") => string;
}>;

/**
 * Maps product-level Conductor tools to typed, task-scoped Runtime calls. It
 * deliberately has no Provider, Store, filesystem, terminal, native session,
 * result-polling, or Task-acceptance capability.
 */
export function createRuntimeConductorGateway(options: RuntimeConductorGatewayOptions): RuntimeConductorGateway {
  const client = requireClient(options.client);
  const scope = normalizeScope(options.scope);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.createRuntimeId ?? createId;

  const readScopedTask = async (): Promise<TaskRuntimeReadModel> => {
    const model = await client.read({ taskId: scope.taskId });
    const taskRuntime = model.task;
    if (!taskRuntime || taskRuntime.task.taskId !== scope.taskId) {
      throw new Error("conductor_scope_task_unavailable");
    }
    if (!taskRuntime.activeRun || taskRuntime.activeRun.runId !== scope.runId) {
      throw new Error("conductor_scope_run_unavailable");
    }
    if (taskRuntime.activeRun.conductorLogicalSessionId !== scope.conductorLogicalSessionId) {
      throw new Error("conductor_scope_session_mismatch");
    }
    return taskRuntime;
  };

  const dispatch = async (inputs: readonly InvokeAgentInput[]): Promise<readonly InvocationDispatch[]> => {
    if (inputs.length === 0) return Object.freeze([]);
    const normalizedInputs = inputs.map(normalizeInvokeAgentInput);
    const taskRuntime = await readScopedTask();
    const dispatched = normalizedInputs.map((input) => {
      const commandId = nextId("command");
      const invocationId = nextId("invocation") as InvocationId;
      const command = {
        type: "invocation.invoke_agent",
        commandId,
        issuedAt: now(),
        taskId: scope.taskId,
        expectedRevision: taskRuntime.task.revision,
        runId: scope.runId,
        sourceLogicalSessionId: scope.conductorLogicalSessionId,
        decidedBySessionTurnId: scope.conductorSessionTurnId,
        idempotencyKey: commandId,
        invocationId,
        agentCardId: input.agentCardId,
        instruction: input.instruction,
        messageSelections: input.messageSelections,
        acceptanceCriteria: input.acceptanceCriteria,
        ...(input.requestedArtifacts ? { requestedArtifacts: input.requestedArtifacts } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      } satisfies ConductorInvocationCommand;
      return { command, dispatch: Object.freeze({ invocationId, commandId }) };
    });

    // The contract intentionally provides individual durable Invocation
    // commands rather than pretending this is an atomic Provider batch.
    await Promise.all(dispatched.map(({ command }) => client.invokeAgent(command)));
    return Object.freeze(dispatched.map(({ dispatch: outcome }) => outcome));
  };

  return Object.freeze({
    async invoke_agent(input: InvokeAgentInput): Promise<InvocationDispatch> {
      const [outcome] = await dispatch([input]);
      if (!outcome) throw new Error("conductor_invocation_dispatch_missing");
      return outcome;
    },
    invoke_agents: dispatch,
    async relay_message(input: RelayMessageInput): Promise<RelayDispatch> {
      const normalized = normalizeRelayMessageInput(input);
      const taskRuntime = await readScopedTask();
      const commandId = nextId("command");
      const command = {
        type: "session.relay_message",
        commandId,
        issuedAt: now(),
        taskId: scope.taskId,
        expectedRevision: taskRuntime.task.revision,
        runId: scope.runId,
        sourceLogicalSessionId: scope.conductorLogicalSessionId,
        decidedBySessionTurnId: scope.conductorSessionTurnId,
        idempotencyKey: commandId,
        targetAgentCardId: normalized.targetAgentCardId,
        messageSelections: normalized.messageSelections,
      } satisfies ConductorRelayMessageCommand;
      await client.relayMessage(command);
      return Object.freeze({ commandId });
    },
    async publish_message(input: PublishMessageInput): Promise<RelayDispatch> {
      const normalized = normalizePublishMessageInput(input);
      const taskRuntime = await readScopedTask();
      const commandId = nextId("command");
      const command = {
        type: "session.publish_message",
        commandId,
        issuedAt: now(),
        taskId: scope.taskId,
        expectedRevision: taskRuntime.task.revision,
        runId: scope.runId,
        sourceLogicalSessionId: scope.conductorLogicalSessionId,
        decidedBySessionTurnId: scope.conductorSessionTurnId,
        idempotencyKey: commandId,
        fanoutKey: normalized.fanoutKey,
        targetAgentCardIds: normalized.targetAgentCardIds,
        messageSelections: normalized.messageSelections,
      } satisfies ConductorPublishMessageCommand;
      await client.publishMessage(command);
      return Object.freeze({ commandId });
    },
    async register_artifact(input: RegisterArtifactInput): Promise<ArtifactRegistration> {
      const normalized = normalizeRegisterArtifactInput(input);
      const taskRuntime = await readScopedTask();
      const commandId = nextId("command");
      const command = {
        type: "artifact.verify_requested",
        commandId,
        issuedAt: now(),
        taskId: scope.taskId,
        expectedRevision: taskRuntime.task.revision,
        runId: scope.runId,
        sourceLogicalSessionId: scope.conductorLogicalSessionId,
        decidedBySessionTurnId: scope.conductorSessionTurnId,
        idempotencyKey: commandId,
        sourceInvocationId: normalized.sourceInvocationId,
        workspaceRelativePath: normalized.workspaceRelativePath,
      } satisfies ConductorVerifyRequestedArtifactCommand;
      const result = await client.verifyRequestedArtifact(command);
      if (!result.artifactId) throw new Error("artifact_registration_identity_missing");
      return Object.freeze({ artifactId: result.artifactId, commandId });
    },
  });
}

function requireClient(client: RuntimeConductorClient): RuntimeConductorClient {
  if (!client || typeof client.read !== "function" || typeof client.invokeAgent !== "function" || typeof client.relayMessage !== "function" || typeof client.publishMessage !== "function" || typeof client.verifyRequestedArtifact !== "function") {
    throw new TypeError("RuntimeConductorGateway requires scoped read, invokeAgent, relayMessage, publishMessage, and verifyRequestedArtifact");
  }
  return client;
}

function normalizeScope(scope: ConductorRunScope): ConductorRunScope {
  return Object.freeze({
    taskId: requiredText(scope?.taskId, "taskId"),
    runId: requiredText(scope?.runId, "runId"),
    conductorLogicalSessionId: requiredText(scope?.conductorLogicalSessionId, "conductorLogicalSessionId"),
    conductorSessionTurnId: requiredText(scope?.conductorSessionTurnId, "conductorSessionTurnId"),
  });
}

function normalizeInvokeAgentInput(input: InvokeAgentInput): Required<Pick<InvokeAgentInput, "agentCardId" | "instruction" | "messageSelections" | "acceptanceCriteria">> & Pick<InvokeAgentInput, "requestedArtifacts" | "priority"> {
  const priority = input.priority === undefined ? undefined : normalizePriority(input.priority);
  return Object.freeze({
    agentCardId: requiredText(input.agentCardId, "agentCardId"),
    instruction: requiredText(input.instruction, "instruction"),
    messageSelections: normalizeMessageSelections(input.messageSelections, "messageSelections"),
    acceptanceCriteria: input.acceptanceCriteria === undefined ? Object.freeze([]) : textArray(input.acceptanceCriteria, "acceptanceCriteria"),
    ...(input.requestedArtifacts === undefined ? {} : { requestedArtifacts: textArray(input.requestedArtifacts, "requestedArtifacts") }),
    ...(priority === undefined ? {} : { priority }),
  });
}

function normalizeRelayMessageInput(input: RelayMessageInput): RelayMessageInput {
  const messageSelections = normalizeMessageSelections(input.messageSelections, "messageSelections");
  if (messageSelections.length === 0) throw new Error("relay_message_selection_required");
  return Object.freeze({
    targetAgentCardId: requiredText(input.targetAgentCardId, "targetAgentCardId"),
    messageSelections,
  });
}

function normalizePublishMessageInput(input: PublishMessageInput): PublishMessageInput {
  const targetAgentCardIds = textArray(input.targetAgentCardIds, "targetAgentCardIds");
  if (targetAgentCardIds.length === 0 || new Set(targetAgentCardIds).size !== targetAgentCardIds.length) {
    throw new Error("publish_message_targets_invalid");
  }
  const messageSelections = normalizeMessageSelections(input.messageSelections, "messageSelections");
  if (messageSelections.length === 0) throw new Error("publish_message_selection_required");
  return Object.freeze({
    targetAgentCardIds,
    messageSelections,
    fanoutKey: requiredText(input.fanoutKey, "fanoutKey"),
  });
}

function normalizeRegisterArtifactInput(input: RegisterArtifactInput): RegisterArtifactInput {
  if (!input || typeof input !== "object") throw new TypeError("register_artifact input is required");
  return Object.freeze({
    sourceInvocationId: requiredText(input.sourceInvocationId, "sourceInvocationId") as InvocationId,
    workspaceRelativePath: requiredText(input.workspaceRelativePath, "workspaceRelativePath"),
  });
}

function normalizeMessageSelections(value: readonly MessageSelection[], label: string): readonly MessageSelection[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((selection, index) => normalizeMessageSelection(selection, `${label}[${index}]`)));
}

function normalizeMessageSelection(value: MessageSelection, label: string): MessageSelection {
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be a MessageSelection`);
  if (value.kind === "full_message") {
    return Object.freeze({ kind: "full_message", sourceMessageId: requiredText(value.sourceMessageId, `${label}.sourceMessageId`) });
  }
  if (value.kind === "relay_block") {
    return Object.freeze({
      kind: "relay_block",
      sourceMessageId: requiredText(value.sourceMessageId, `${label}.sourceMessageId`),
      relayBlockId: requiredText(value.relayBlockId, `${label}.relayBlockId`),
    });
  }
  throw new Error(`${label}.kind_invalid`);
}

function normalizePriority(value: InvokeAgentInput["priority"]): NonNullable<InvokeAgentInput["priority"]> {
  if (value === "low" || value === "normal" || value === "high") return value;
  throw new Error("priority_invalid");
}

function textArray(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => requiredText(entry, `${label}[${index}]`)));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}
