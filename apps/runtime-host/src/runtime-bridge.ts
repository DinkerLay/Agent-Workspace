import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  assertJsonValue,
  TEMPLATE_ARCHIVE_LIMITS,
  type RuntimeCommand,
  type RuntimeInvalidation,
  type RuntimeReadModel,
  type RuntimeReadRequest,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeHost } from "./runtime-host.js";

const MAX_RUNTIME_READ_BYTES = 1_000_000;
/**
 * Template assets are JSON-safe base64 at this boundary. Allow the documented
 * 16 MiB aggregate asset limit plus encoding and command-envelope overhead;
 * the command body remains bounded and is authenticated.
 */
const MAX_RUNTIME_COMMAND_BYTES = Math.ceil(TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes * 4 / 3)
  + TEMPLATE_ARCHIVE_LIMITS.maxManifestBytes
  + (1 * 1024 * 1024);

type RuntimeBridgeErrorCode =
  | "runtime_bridge_unauthorized"
  | "runtime_bridge_method_not_allowed"
  | "runtime_bridge_not_found"
  | "runtime_bridge_payload_too_large"
  | "runtime_bridge_conductor_scope_invalid"
  | "runtime_bridge_conductor_scope_denied"
  | "runtime_bridge_conductor_command_denied"
  | "runtime_bridge_owner_scope_denied"
  | "runtime_bridge_workspace_scope_denied"
  | "expected_revision_stale"
  | "execution_profile_unavailable"
  | "provider_unavailable"
  | "provider_mismatch"
  | "provider_version_mismatch"
  | "protocol_fingerprint_mismatch"
  | "capability_missing"
  | "meta_profile_option_unavailable"
  | "meta_agent_provider_not_composed"
  | "meta_agent_profile_unavailable"
  | "meta_profile_protocol_mismatch"
  | "meta_agent_capability_unavailable"
  | "meta_agent_capability_probe_failed"
  | "runtime_command_failed";

type RuntimeBridgeErrorEnvelope = Readonly<{ error: Readonly<{ code: RuntimeBridgeErrorCode }> }>;

const BRIDGE_ERROR_CODES = new Set<RuntimeBridgeErrorCode>([
  "runtime_bridge_unauthorized",
  "runtime_bridge_method_not_allowed",
  "runtime_bridge_not_found",
  "runtime_bridge_payload_too_large",
  "runtime_bridge_conductor_scope_invalid",
  "runtime_bridge_conductor_scope_denied",
  "runtime_bridge_conductor_command_denied",
  "runtime_bridge_owner_scope_denied",
  "runtime_bridge_workspace_scope_denied",
]);

export type RuntimeBridgeOptions = {
  readonly host: RuntimeHost;
  /** Short-lived bridge credential; never a Provider credential. */
  readonly token: string;
  readonly allowedOrigins?: readonly string[];
  /** A bridge credential represents either a user surface or one scoped Conductor. */
  readonly scope?: {
    readonly actor?: "user" | "conductor";
    readonly userId?: string;
    readonly workspaceIds?: readonly string[];
    readonly taskId?: string;
    readonly runId?: string;
    readonly conductorLogicalSessionId?: string;
  };
  readonly tls?: { readonly key: string; readonly cert: string };
};

export type RuntimeBridgeAddress = { readonly url: string; readonly port: number };

export type RuntimeBridgeServer = {
  listen(port?: number, host?: string): Promise<RuntimeBridgeAddress>;
  close(): Promise<void>;
};

/**
 * Authenticated HTTP + WebSocket bridge for Browser RuntimeClient. It exposes
 * only read model, typed command and semantic invalidations.
 */
export function createRuntimeBridgeServer(options: RuntimeBridgeOptions): RuntimeBridgeServer {
  const subscriptions = new Map<WebSocket, () => void>();
  const http = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  const sockets = new WebSocketServer({ noServer: true });

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = requestUrl(request);
    if (target.pathname !== "/runtime/subscribe" || !authorizeUpgrade(request, options.token) || !originAllowed(request, options.allowedOrigins)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      sockets.emit("connection", websocket, request);
    });
  });

  sockets.on("connection", (socket, request) => {
    let filter: { readonly taskId?: string; readonly runId?: string };
    let initialUserTaskIds: ReadonlySet<string> | undefined;
    try {
      const userModel = isUserScope(options.scope)
        ? authorizeReadModel(options.host.read({}), options.scope)
        : undefined;
      initialUserTaskIds = userModel ? userTaskIds(userModel) : undefined;
      filter = authorizeSubscriptionFilter(subscriptionFilter(requestUrl(request).searchParams), options.scope, userModel);
    } catch {
      socket.close(1008, "runtime scope denied");
      return;
    }
    const unsubscribe = options.host.subscribe((invalidation) => {
      let authorized: RuntimeInvalidation | undefined;
      try {
        authorized = authorizeInvalidation(invalidation, options, initialUserTaskIds);
      } catch {
        return;
      }
      if (authorized && matchesFilter(authorized, filter) && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "runtime.invalidated", invalidation: authorized }));
      }
    });
    subscriptions.set(socket, unsubscribe);
    socket.once("close", () => {
      subscriptions.get(socket)?.();
      subscriptions.delete(socket);
    });
  });

  return {
    async listen(port = 0, host = "127.0.0.1"): Promise<RuntimeBridgeAddress> {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolve();
        });
      });
      const address = http.address() as AddressInfo;
      return { port: address.port, url: `${options.tls ? "https" : "http"}://${host}:${address.port}` };
    },
    async close(): Promise<void> {
      for (const [socket, unsubscribe] of subscriptions) {
        unsubscribe();
        socket.close();
      }
      subscriptions.clear();
      await new Promise<void>((resolve, reject) => sockets.close((error?: Error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => http.close((error?: Error) => error ? reject(error) : resolve()));
    },
  };

  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!authorizeHttp(request, options.token) || !originAllowed(request, options.allowedOrigins)) {
        respond(response, 401, errorEnvelope("runtime_bridge_unauthorized"));
        return;
      }
      if (request.method !== "POST") {
        respond(response, 405, errorEnvelope("runtime_bridge_method_not_allowed"));
        return;
      }
      const target = requestUrl(request);
      if (target.pathname === "/runtime/read") {
        const body = await readJson(request, MAX_RUNTIME_READ_BYTES);
        const readRequest = authorizeReadRequest(readRuntimeReadRequest(body), options.scope);
        if (isUserScope(options.scope) && readRequest.taskId !== undefined) {
          authorizeFocusedUserReadRequest(readRequest, authorizeReadModel(options.host.read({}), options.scope));
        }
        const model = authorizeReadModel(options.host.read(readRequest), options.scope);
        respond(response, 200, model);
        return;
      }
      if (target.pathname === "/runtime/command") {
        const command = await readJson(request, MAX_RUNTIME_COMMAND_BYTES) as RuntimeCommand;
        assertJsonValue(command);
        const authorizedCommand = authorizeCommand(command, options.scope);
        if (isUserScope(options.scope)) {
          authorizeUserCommand(authorizedCommand, authorizeReadModel(options.host.read({}), options.scope));
        }
        const result = await options.host.command(authorizedCommand);
        respond(response, 200, result);
        return;
      }
      respond(response, 404, errorEnvelope("runtime_bridge_not_found"));
    } catch (error) {
      respond(response, 400, errorEnvelope(publicRuntimeErrorCode(error)));
    }
  }
}

function errorEnvelope(code: RuntimeBridgeErrorCode): RuntimeBridgeErrorEnvelope {
  return { error: { code } };
}

/** Provider/profile identifiers and native diagnostics never cross the Bridge. */
function publicRuntimeErrorCode(error: unknown): RuntimeBridgeErrorCode {
  const message = error instanceof Error ? error.message : undefined;
  const structuredCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (structuredCode === "expected_revision_stale") return "expected_revision_stale";
  if (!message) return "runtime_command_failed";
  if (BRIDGE_ERROR_CODES.has(message as RuntimeBridgeErrorCode)) return message as RuntimeBridgeErrorCode;
  if (message === "expected_revision_stale" || message.startsWith("expected_revision_stale:")) return "expected_revision_stale";
  if (message === "meta_profile_option_unavailable" || message.startsWith("meta_profile_option_unavailable:")) {
    return "meta_profile_option_unavailable";
  }
  if (message === "meta_agent_unavailable" || message.startsWith("meta_agent_unavailable:")) {
    return "meta_agent_provider_not_composed";
  }
  if (message === "meta_agent_profile_unavailable") return "meta_agent_profile_unavailable";
  if (message.startsWith("meta_agent_profile_unavailable:")) {
    const reason = message.split(":")[2];
    if (reason === "meta_agent_provider_not_composed") return "meta_agent_provider_not_composed";
    if (reason === "meta_profile_protocol_mismatch") return "meta_profile_protocol_mismatch";
    if (reason === "meta_agent_capability_unavailable") return "meta_agent_capability_unavailable";
    if (reason === "meta_agent_capability_probe_failed") return "meta_agent_capability_probe_failed";
    return "meta_agent_profile_unavailable";
  }
  if (message === "provider_unavailable" || message.startsWith("provider_unavailable:")) return "provider_unavailable";
  if (message === "provider_mismatch") return "provider_mismatch";
  if (message === "provider_version_mismatch") return "provider_version_mismatch";
  if (message === "protocol_fingerprint_mismatch") return "protocol_fingerprint_mismatch";
  if (/^capability_[a-z0-9_]+_unavailable$/.test(message)) return "capability_missing";
  if (message === "execution_profile_unavailable") return "execution_profile_unavailable";
  if (!message.startsWith("execution_profile_unavailable:")) return "runtime_command_failed";

  const reasons = message.split(":").slice(2).join(":").split(",");
  if (reasons.includes("provider_version_mismatch")) return "provider_version_mismatch";
  if (reasons.includes("protocol_fingerprint_mismatch")) return "protocol_fingerprint_mismatch";
  if (reasons.some((reason) => /^capability_[a-z0-9_]+_unavailable$/.test(reason))) return "capability_missing";
  if (reasons.includes("provider_unavailable")) return "provider_unavailable";
  if (reasons.includes("provider_mismatch")) return "provider_mismatch";
  return "execution_profile_unavailable";
}

function authorizeHttp(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization;
  return value === token || value === `Bearer ${token}`;
}

/** Browser WebSocket cannot send arbitrary headers; the token is a subprotocol. */
function authorizeUpgrade(request: IncomingMessage, token: string): boolean {
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim());
  return protocols.includes(token);
}

function originAllowed(request: IncomingMessage, allowed?: readonly string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  const origin = request.headers.origin;
  return typeof origin === "string" && allowed.includes(origin);
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://runtime.local");
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) throw new Error("runtime_bridge_payload_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/**
 * Bridge requests are untrusted JSON.  Only the documented focused selectors
 * cross into the Host; unknown keys are deliberately ignored.
 */
function readRuntimeReadRequest(value: unknown): RuntimeReadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  return {
    ...(typeof candidate.workspaceId === "string" ? { workspaceId: candidate.workspaceId } : {}),
    ...(typeof candidate.taskId === "string" ? { taskId: candidate.taskId } : {}),
    ...(typeof candidate.taskRunId === "string" ? { taskRunId: candidate.taskRunId } : {}),
    ...(typeof candidate.templateId === "string" ? { templateId: candidate.templateId } : {}),
  };
}

function subscriptionFilter(params: URLSearchParams): { readonly taskId?: string; readonly runId?: string } {
  const taskId = params.get("taskId");
  const runId = params.get("runId");
  return { ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) };
}

function matchesFilter(event: RuntimeInvalidation, filter: { readonly taskId?: string; readonly runId?: string }): boolean {
  return (!filter.taskId || event.taskId === filter.taskId)
    && (!filter.runId || event.runId === filter.runId);
}

type ConductorScope = Readonly<{
  actor: "conductor";
  taskId: string;
  runId: string;
  conductorLogicalSessionId: string;
}>;

type UserScope = Readonly<{
  actor?: "user";
  userId: string;
  workspaceIds?: readonly string[];
}>;

function requireConductorScope(scope: RuntimeBridgeOptions["scope"]): ConductorScope {
  if (
    scope?.actor !== "conductor"
    || typeof scope.taskId !== "string"
    || !scope.taskId
    || typeof scope.runId !== "string"
    || !scope.runId
    || typeof scope.conductorLogicalSessionId !== "string"
    || !scope.conductorLogicalSessionId
  ) throw new Error("runtime_bridge_conductor_scope_invalid");
  return scope as ConductorScope;
}

function authorizeReadRequest(
  request: RuntimeReadRequest,
  scope?: RuntimeBridgeOptions["scope"],
): RuntimeReadRequest {
  if (!scope) return request;
  if (scope.actor === "conductor") {
    const conductor = requireConductorScope(scope);
    if (
      request.workspaceId !== undefined
      || request.templateId !== undefined
      || (request.taskId !== undefined && request.taskId !== conductor.taskId)
      || (request.taskRunId !== undefined && request.taskRunId !== conductor.runId)
    ) throw new Error("runtime_bridge_conductor_scope_denied");
    return { taskId: conductor.taskId, taskRunId: conductor.runId };
  }
  const user = requireUserScope(scope);
  if (request.workspaceId !== undefined && !workspaceAllowed(user, request.workspaceId)) {
    throw new Error("runtime_bridge_workspace_scope_denied");
  }
  if (request.taskRunId !== undefined && request.taskId === undefined) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  return request;
}

function authorizeReadModel(
  model: RuntimeReadModel,
  scope?: RuntimeBridgeOptions["scope"],
): RuntimeReadModel {
  if (!scope) return model;
  if (scope.actor !== "conductor") return authorizeUserReadModel(model, requireUserScope(scope));
  const conductor = requireConductorScope(scope);
  if (
    !model.task
    || model.task.task.taskId !== conductor.taskId
    || model.task.activeRun?.runId !== conductor.runId
    || model.task.activeRun.conductorLogicalSessionId !== conductor.conductorLogicalSessionId
  ) throw new Error("runtime_bridge_conductor_scope_denied");
  const task = {
    ...model.task,
    providerActivities: [],
    presentations: [],
    timeline: [],
  };
  return {
    generatedAt: model.generatedAt,
      configuration: {
        metaProfileOptions: [],
        executionProfileReadiness: [],
        taskSetupDrafts: [],
      metaSessions: [],
      metaMessages: [],
      metaPatchProposals: [],
      metaTurns: [],
    },
    workspaceLibrary: { authorizations: [] },
    templateLibrary: { templates: [], drafts: [] },
    taskLibrary: { tasks: [model.task.task] },
    task,
  };
}

function isUserScope(scope: RuntimeBridgeOptions["scope"]): scope is UserScope {
  return scope !== undefined && scope.actor !== "conductor";
}

function requireUserScope(scope: RuntimeBridgeOptions["scope"]): UserScope {
  if (
    !scope
    || scope.actor === "conductor"
    || typeof scope.userId !== "string"
    || !scope.userId
    || (scope.workspaceIds !== undefined && (
      !Array.isArray(scope.workspaceIds)
      || scope.workspaceIds.some((workspaceId) => typeof workspaceId !== "string" || !workspaceId)
    ))
  ) throw new Error("runtime_bridge_owner_scope_denied");
  return scope as UserScope;
}

function workspaceAllowed(scope: UserScope, workspaceId: string): boolean {
  return scope.workspaceIds === undefined || scope.workspaceIds.includes(workspaceId);
}

function authorizeFocusedUserReadRequest(request: RuntimeReadRequest, model: RuntimeReadModel): void {
  if (request.taskId !== undefined && !model.taskLibrary.tasks.some((task) => task.taskId === request.taskId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
}

function authorizeUserReadModel(model: RuntimeReadModel, scope: UserScope): RuntimeReadModel {
  const templateDrafts = model.templateLibrary.drafts.filter((draft) => draft.ownerId === scope.userId);
  const taskSetupDrafts = model.configuration.taskSetupDrafts.filter((draft) =>
    draft.ownerId === scope.userId && workspaceAllowed(scope, draft.workspaceId));
  const taskIds = new Set(taskSetupDrafts.flatMap((draft) => draft.createdTaskId ? [draft.createdTaskId] : []));
  const taskSetupDraftIds = new Set(taskSetupDrafts.map((draft) => draft.taskSetupDraftId));
  const metaSessions = model.configuration.metaSessions.filter((session) =>
    session.ownerId === scope.userId
    && (session.target.kind === "template_draft" || taskSetupDraftIds.has(session.target.taskSetupDraftId)));
  const metaSessionIds = new Set(metaSessions.map((session) => session.metaSessionId));

  const task = model.task && taskIds.has(model.task.task.taskId)
    ? model.task
    : undefined;

  return {
    generatedAt: model.generatedAt,
    configuration: {
      metaProfileOptions: model.configuration.metaProfileOptions,
      executionProfileReadiness: model.configuration.executionProfileReadiness,
      taskSetupDrafts,
      metaSessions,
      metaMessages: model.configuration.metaMessages.filter((message) =>
        message.ownerId === scope.userId && metaSessionIds.has(message.metaSessionId)),
      metaPatchProposals: model.configuration.metaPatchProposals.filter((proposal) =>
        proposal.ownerId === scope.userId && metaSessionIds.has(proposal.metaSessionId)),
      metaTurns: model.configuration.metaTurns.filter((turn) => metaSessionIds.has(turn.metaSessionId)),
    },
    ...(model.workspaceId !== undefined && workspaceAllowed(scope, model.workspaceId) ? { workspaceId: model.workspaceId } : {}),
    workspaceLibrary: {
      authorizations: model.workspaceLibrary.authorizations.filter(({ workspaceId }) => workspaceAllowed(scope, workspaceId)),
    },
    templateLibrary: {
      templates: model.templateLibrary.templates,
      drafts: templateDrafts,
    },
    ...(model.template ? { template: model.template } : {}),
    taskLibrary: { tasks: model.taskLibrary.tasks.filter((entry) => taskIds.has(entry.taskId)) },
    ...(task ? { task } : {}),
  };
}

function authorizeSubscriptionFilter(
  filter: { readonly taskId?: string; readonly runId?: string },
  scope?: RuntimeBridgeOptions["scope"],
  userModel?: RuntimeReadModel,
): { readonly taskId?: string; readonly runId?: string } {
  if (!scope) return filter;
  if (scope.actor === "conductor") {
    const conductor = requireConductorScope(scope);
    if (
      (filter.taskId !== undefined && filter.taskId !== conductor.taskId)
      || (filter.runId !== undefined && filter.runId !== conductor.runId)
    ) throw new Error("runtime_bridge_conductor_scope_denied");
    return { taskId: conductor.taskId, runId: conductor.runId };
  }
  requireUserScope(scope);
  if (filter.runId !== undefined && filter.taskId === undefined) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if (filter.taskId !== undefined && (!userModel || !userOwnsTask(userModel, filter.taskId))) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  return filter;
}

function authorizeInvalidation(
  invalidation: RuntimeInvalidation,
  options: RuntimeBridgeOptions,
  initialUserTaskIds?: ReadonlySet<string>,
): RuntimeInvalidation | undefined {
  if (!isUserScope(options.scope)) return invalidation;
  const scope = requireUserScope(options.scope);
  if (invalidation.workspaceId !== undefined && !workspaceAllowed(scope, invalidation.workspaceId)) return undefined;
  if (invalidation.runId !== undefined && invalidation.taskId === undefined) return undefined;
  if (invalidation.taskId !== undefined) {
    const currentlyAuthorized = userOwnsTask(authorizeReadModel(options.host.read({}), scope), invalidation.taskId);
    if (!currentlyAuthorized && !initialUserTaskIds?.has(invalidation.taskId)) return undefined;
  }
  const { commandId: _commandId, ...safe } = invalidation;
  return safe;
}

function userTaskIds(model: RuntimeReadModel): ReadonlySet<string> {
  return new Set(model.configuration.taskSetupDrafts.flatMap((draft) => draft.createdTaskId ? [draft.createdTaskId] : []));
}

function userOwnsTask(model: RuntimeReadModel, taskId: string): boolean {
  return userTaskIds(model).has(taskId);
}

function authorizeUserCommand(command: RuntimeCommand, model: RuntimeReadModel): void {
  if ("taskId" in command && command.type !== "task.create" && !userOwnsTask(model, command.taskId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if ("templateDraftId" in command
    && !model.templateLibrary.drafts.some((draft) => draft.templateDraftId === command.templateDraftId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if ("taskSetupDraftId" in command
    && !model.configuration.taskSetupDrafts.some((draft) => draft.taskSetupDraftId === command.taskSetupDraftId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if ("metaSessionId" in command
    && !model.configuration.metaSessions.some((session) => session.metaSessionId === command.metaSessionId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if ("metaPatchProposalId" in command
    && !model.configuration.metaPatchProposals.some((proposal) => proposal.metaPatchProposalId === command.metaPatchProposalId)) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if (command.type === "meta.create_session") {
    const target = command.target;
    const targetAllowed = target.kind === "template_draft"
      ? model.templateLibrary.drafts.some((draft) => draft.templateDraftId === target.templateDraftId)
      : model.configuration.taskSetupDrafts.some((draft) => draft.taskSetupDraftId === target.taskSetupDraftId);
    if (!targetAllowed) throw new Error("runtime_bridge_owner_scope_denied");
  }
}

function authorizeCommand(command: RuntimeCommand, scope?: RuntimeBridgeOptions["scope"]): RuntimeCommand {
  if (!scope) return command;
  if (scope.actor === "conductor") {
    const conductor = requireConductorScope(scope);
    if (!["invocation.invoke_agent", "session.relay_message", "session.publish_message", "artifact.verify_requested"].includes(command.type)) {
      throw new Error("runtime_bridge_conductor_command_denied");
    }
    if (!("runId" in command)) throw new Error("runtime_bridge_conductor_scope_denied");
    const sourceLogicalSessionId = "sourceLogicalSessionId" in command ? command.sourceLogicalSessionId : undefined;
    if (
      command.taskId !== conductor.taskId
      || command.runId !== conductor.runId
      || sourceLogicalSessionId !== conductor.conductorLogicalSessionId
    ) {
      throw new Error("runtime_bridge_conductor_scope_denied");
    }
  }
  if (
    "ownerId" in command
    && scope.userId
    && command.ownerId !== scope.userId
  ) {
    throw new Error("runtime_bridge_owner_scope_denied");
  }
  if (
    (
      command.type === "workspace.authorize"
      || command.type === "task_setup.create_draft"
      || command.type === "task_setup.save_draft"
      || command.type === "task.create"
    )
    && scope.workspaceIds
    && !scope.workspaceIds.includes(command.workspaceId)
  ) {
    throw new Error("runtime_bridge_workspace_scope_denied");
  }
  return command;
}
