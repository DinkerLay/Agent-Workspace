import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  TEMPLATE_ARCHIVE_LIMITS,
  assertJsonValue,
  decodeTemplateAssetTransports,
  validateTemplateArchivePayload,
  validateTemplateDefinitionSnapshot,
  validateTemplateDefinitionV3,
  validateTemplatePackage,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdUnifiedConfigurationReadRequest,
  SessionIdUnifiedRendererCommand,
  SessionIdUnifiedRuntimeHost,
} from "./session-id-unified-runtime-host.js";

const MAX_PAYLOAD_BYTES = Math.ceil(TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes * 4 / 3) + 512_000;
const COMMAND_TYPES = new Set<string>([
  "template.create_draft",
  "template.save_draft",
  "template.migrate_v2_to_v3_draft",
  "template.publish_draft",
  "template.archive",
  "template.import",
  "template.export",
  "task_setup.create_draft",
  "task_setup.save_draft",
  "task_setup.abandon_draft",
  "meta.create_session",
  "meta.send_message",
  "meta.abandon_session",
  "meta.apply_patch",
  "meta.reject_patch",
  "task.create",
  "task.start",
  "task.resume",
  "task.restart",
  "task.achieve",
  "task.archive",
  "task.restore",
  "task.preview_permanent_delete",
  "task.permanently_delete",
  "task.submit_input",
  "session.send_human_message",
  "session.abandon_human_message",
  "session.request_interrupt",
  "session.respond_interaction",
  "task.stop",
  "workspace.preview_file",
  "provider.probe_models",
  "provider.discover_installation",
  "provider.configure_installation",
  "provider.configure_chat_models",
]);

export const SESSION_ID_UNIFIED_RUNTIME_PATHS = Object.freeze({
  workspaceRead: "/runtime/session-id/workspace/read",
  taskRead: "/runtime/session-id/read",
  configurationRead: "/runtime/session-id/configuration/read",
  command: "/runtime/session-id/command",
  subscribe: "/runtime/session-id/subscribe",
  commandEvidence: "/runtime/session-id/evidence/commands",
});

export type SessionIdUnifiedRuntimeBridgeOptions = Readonly<{
  host: SessionIdUnifiedRuntimeHost;
  /** Browser renderer credential. */
  rendererToken: string;
  /** Optional Electron renderer credential; must be distinct from every other bridge token. */
  desktopRendererToken?: string;
  evidenceToken: string;
  authorizeTask(taskId: string, authenticatedUserId: string): boolean;
  authorizeCommand(command: SessionIdUnifiedRendererCommand, authenticatedUserId: string): boolean;
  allowedOrigins?: readonly string[];
}>;

export type SessionIdUnifiedRuntimeBridgeServer = Readonly<{
  listen(port?: number, hostname?: string): Promise<Readonly<{ url: string; port: number }>>;
  close(): Promise<void>;
}>;

/** Authenticated Phase-7 root bridge. It intentionally has no legacy routes. */
export function createSessionIdUnifiedRuntimeBridgeServer(
  options: SessionIdUnifiedRuntimeBridgeOptions,
): SessionIdUnifiedRuntimeBridgeServer {
  const rendererToken = requiredSecret(options.rendererToken, "session_id_renderer_token_required");
  const desktopRendererToken = options.desktopRendererToken === undefined
    ? undefined
    : requiredSecret(options.desktopRendererToken, "session_id_desktop_renderer_token_required");
  const evidenceToken = requiredSecret(options.evidenceToken, "session_id_evidence_token_required");
  if (new Set([rendererToken, evidenceToken, ...(desktopRendererToken ? [desktopRendererToken] : [])]).size
    !== (desktopRendererToken ? 3 : 2)) throw new Error("session_id_bridge_tokens_must_differ");
  const authenticatedUserId = requiredText(options.host.authenticatedUserId, "session_id_authenticated_user_required");
  const subscriptions = new Map<WebSocket, () => void>();
  const http = createServer(handler);
  const sockets = new WebSocketServer({ noServer: true });
  let closed = false;

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = requestUrl(request);
    const surface = authenticatedWebSocketSurface(request, rendererToken, desktopRendererToken);
    if (target.pathname !== SESSION_ID_UNIFIED_RUNTIME_PATHS.subscribe
      || !surface
      || !originAllowed(request, options.allowedOrigins)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
  });

  sockets.on("connection", (socket, request) => {
    const taskId = optionalText(requestUrl(request).searchParams.get("taskId"));
    if (taskId && !options.authorizeTask(taskId, authenticatedUserId)) {
      socket.close(1008, "session-id scope denied");
      return;
    }
    const unsubscribe = options.host.subscribe(taskId ? { taskId } : {}, (invalidation) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "runtime.invalidated", invalidation }));
      }
    });
    subscriptions.set(socket, unsubscribe);
    socket.once("close", () => {
      subscriptions.get(socket)?.();
      subscriptions.delete(socket);
    });
  });

  return Object.freeze({
    async listen(port = 0, hostname = "127.0.0.1") {
      if (closed) throw new Error("session_id_unified_bridge_closed");
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, hostname, () => {
          http.off("error", reject);
          resolve();
        });
      });
      const address = http.address() as AddressInfo;
      return Object.freeze({ url: `http://${hostname}:${address.port}`, port: address.port });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const [socket, unsubscribe] of subscriptions) {
        unsubscribe();
        socket.close(1001, "runtime host closing");
      }
      subscriptions.clear();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  });

  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!originAllowed(request, options.allowedOrigins)) return respond(response, 403, "session_id_runtime_origin_denied");
      const target = requestUrl(request);
      if (target.pathname === SESSION_ID_UNIFIED_RUNTIME_PATHS.commandEvidence) {
        if (!authorizedHttp(request, evidenceToken)) return respond(response, 401, "session_id_evidence_unauthorized");
        if (request.method !== "GET") return respond(response, 405, "session_id_runtime_method_not_allowed");
        return respondValue(response, 200, options.host.readCommandEvidence());
      }
      const authenticatedSurface = authenticatedHttpSurface(request, rendererToken, desktopRendererToken);
      if (!authenticatedSurface) return respond(response, 401, "session_id_runtime_unauthorized");
      if (request.method !== "POST") return respond(response, 405, "session_id_runtime_method_not_allowed");
      if (target.pathname === SESSION_ID_UNIFIED_RUNTIME_PATHS.workspaceRead) {
        exactEmpty(await readJson(request), "session_id_workspace_read_invalid");
        return respondValue(response, 200, options.host.readWorkspace());
      }
      if (target.pathname === SESSION_ID_UNIFIED_RUNTIME_PATHS.taskRead) {
        const taskId = taskRequest(await readJson(request));
        authorizeTask(taskId);
        return respondValue(response, 200, options.host.readTask({ taskId, continuedFromSurface: authenticatedSurface }));
      }
      if (target.pathname === SESSION_ID_UNIFIED_RUNTIME_PATHS.configurationRead) {
        const readRequest = configurationRequest(await readJson(request));
        return respondValue(response, 200, await options.host.readConfiguration(readRequest));
      }
      if (target.pathname === SESSION_ID_UNIFIED_RUNTIME_PATHS.command) {
        const command = rendererCommand(await readJson(request));
        if ("taskId" in command && typeof command.taskId === "string") authorizeTask(command.taskId);
        if (!options.authorizeCommand(command, authenticatedUserId)) throw new Error("session_id_runtime_command_denied");
        return respondValue(response, 200, await options.host.command(command, {
          authenticatedUserId,
          source: "authenticated_runtime_bridge",
        }));
      }
      return respond(response, 404, "session_id_runtime_not_found");
    } catch (error) {
      const code = publicCode(error);
      return respond(response, code === "session_id_runtime_payload_too_large" ? 413 : 400, code);
    }
  }

  function authorizeTask(taskId: string): void {
    if (!options.authorizeTask(taskId, authenticatedUserId)) throw new Error("session_id_runtime_task_denied");
  }
}

function rendererCommand(value: unknown): SessionIdUnifiedRendererCommand {
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_runtime_command_invalid");
  const command = value as Record<string, unknown>;
  const type = requiredText(command.type, "session_id_runtime_command_invalid");
  if (!COMMAND_TYPES.has(type)) throw new Error("session_id_runtime_command_denied");
  const common = ["type", "commandId", "uiIntentId", "issuedAt"];
  const schema = commandSchema(type);
  assertKeys(command, [...common, ...schema.required], schema.optional, "session_id_runtime_command_invalid");
  for (const key of common.slice(1)) requiredText(command[key], "session_id_runtime_command_invalid");
  for (const key of schema.text) {
    if (command[key] !== undefined) requiredText(command[key], "session_id_runtime_command_invalid");
  }
  for (const key of schema.revisions) {
    if (!Number.isSafeInteger(command[key]) || Number(command[key]) < 0) throw new Error("session_id_runtime_command_invalid");
  }
  if (command.metadata !== undefined) validateMetadata(command.metadata);
  if (command.initialDefinition !== undefined) validateTemplateDefinitionSnapshot(command.initialDefinition);
  if (command.definition !== undefined) {
    if (type === "template.migrate_v2_to_v3_draft") validateTemplateDefinitionV3(command.definition);
    else validateTemplateDefinitionSnapshot(command.definition);
  }
  if (command.package !== undefined) validateTemplatePackage(command.package);
  if (command.assets !== undefined) decodeTemplateAssetTransports(command.assets as never);
  if (type === "template.import" && command.mode !== "create" && command.mode !== "new_version") {
    throw new Error("session_id_runtime_command_invalid");
  }
  if (type === "template.import") {
    validateTemplateArchivePayload({
      package: validateTemplatePackage(command.package),
      assets: decodeTemplateAssetTransports(command.assets as never),
    });
  }
  if (type.startsWith("provider.")
    && command.providerFamily !== "opencode"
    && command.providerFamily !== "codex"
    && command.providerFamily !== "claude-code") {
    throw new Error("session_id_runtime_command_invalid");
  }
  if (type === "provider.configure_installation") {
    validateProviderInstallation(command.providerFamily, command.installation);
  }
  if (type === "provider.configure_chat_models") {
    if (!Array.isArray(command.modelIds)
      || command.modelIds.length === 0
      || command.modelIds.length > 512
      || command.modelIds.some((modelId) => typeof modelId !== "string" || !modelId.trim() || modelId.length > 256)
      || new Set(command.modelIds).size !== command.modelIds.length) {
      throw new Error("session_id_runtime_command_invalid");
    }
  }
  if (command.taskInputValues !== undefined) validateTaskInputValues(command.taskInputValues);
  if (command.target !== undefined) validateMetaTarget(command.target);
  if (command.fileStateAnchor !== undefined) validateFileStateAnchor(command.fileStateAnchor);
  if (type === "session.send_human_message") validateHumanMessageTarget(command);
  return command as SessionIdUnifiedRendererCommand;
}

function commandSchema(type: string): Readonly<{
  required: readonly string[];
  optional: readonly string[];
  text: readonly string[];
  revisions: readonly string[];
}> {
  const definition = (required: readonly string[], optional: readonly string[] = [], revisions: readonly string[] = []) => ({
    required,
    optional,
    text: [...required, ...optional].filter((key) => !revisions.includes(key)
      && !["metadata", "initialDefinition", "definition", "package", "assets", "taskInputValues", "target", "fileStateAnchor", "installation", "modelIds"].includes(key)),
    revisions,
  });
  switch (type) {
    case "template.create_draft": return definition(["ownerId", "metadata", "initialDefinition"], ["templateId", "baseTemplateVersionId"]);
    case "template.save_draft": return definition(["templateDraftId", "expectedRevision", "metadata", "definition"], [], ["expectedRevision"]);
    case "template.migrate_v2_to_v3_draft": return definition([
      "ownerId",
      "sourceTemplateVersionId",
      "expectedSourceDefinitionHash",
      "metadata",
      "definition",
    ]);
    case "template.publish_draft": return definition(["templateDraftId", "expectedRevision", "slug", "title"], ["templateId", "description"], ["expectedRevision"]);
    case "template.archive": return definition(["templateId", "expectedRevision"], [], ["expectedRevision"]);
    case "template.import": return definition(["package", "mode"], ["assets"]);
    case "template.export": return definition(["templateVersionId"]);
    case "task_setup.create_draft": return definition(["ownerId", "templateVersionId", "workspaceId", "title", "goal", "taskInputValues"]);
    case "task_setup.save_draft": return definition(["ownerId", "taskSetupDraftId", "expectedRevision", "workspaceId", "title", "goal", "taskInputValues"], [], ["expectedRevision"]);
    case "task_setup.abandon_draft": return definition(["ownerId", "taskSetupDraftId", "expectedRevision"], [], ["expectedRevision"]);
    case "meta.create_session": return definition(["ownerId", "metaProfileOptionId", "target"]);
    case "meta.send_message": return definition(["ownerId", "metaSessionId", "expectedSessionRevision", "expectedTargetRevision", "idempotencyKey", "content"], [], ["expectedSessionRevision", "expectedTargetRevision"]);
    case "meta.abandon_session": return definition(["ownerId", "metaSessionId", "expectedRevision"], [], ["expectedRevision"]);
    case "meta.apply_patch": return definition(["ownerId", "metaSessionId", "metaPatchProposalId", "expectedTargetRevision"], [], ["expectedTargetRevision"]);
    case "meta.reject_patch": return definition(["ownerId", "metaSessionId", "metaPatchProposalId"]);
    case "task.create": return definition(["ownerId", "workspaceId", "taskSetupDraftId", "expectedTaskSetupRevision"], [], ["expectedTaskSetupRevision"]);
    case "task.start":
    case "task.restart": return definition(["taskId", "expectedRevision"], [], ["expectedRevision"]);
    case "task.resume": return definition(["taskId", "runId", "expectedRevision"], [], ["expectedRevision"]);
    case "task.achieve": return definition(["taskId", "expectedRevision"], ["fileStateAnchor", "acceptanceNote"], ["expectedRevision"]);
    case "task.archive":
    case "task.restore":
    case "task.preview_permanent_delete":
    case "task.permanently_delete": return definition(["taskId", "expectedRevision"], [], ["expectedRevision"]);
    case "task.submit_input": return definition(["taskId", "runId", "expectedRevision", "targetLogicalSessionId", "content"], [], ["expectedRevision"]);
    case "session.send_human_message": return definition(
      ["taskId", "runId", "expectedRevision", "humanInterventionId", "idempotencyKey", "content"],
      ["targetAgentCardId", "targetLogicalSessionId"],
      ["expectedRevision"],
    );
    case "session.abandon_human_message": return definition(
      ["taskId", "runId", "expectedRevision", "humanInterventionId", "idempotencyKey"],
      [],
      ["expectedRevision"],
    );
    case "session.request_interrupt": return definition(["taskId", "runId", "expectedRevision", "targetLogicalSessionId", "humanInterventionId", "idempotencyKey"], [], ["expectedRevision"]);
    case "session.respond_interaction": return definition(
      [
        "taskId",
        "runId",
        "expectedRevision",
        "targetLogicalSessionId",
        "interactionId",
        "expectedInteractionRevision",
        "choiceId",
      ],
      [],
      ["expectedRevision", "expectedInteractionRevision"],
    );
    case "task.stop": return definition(["taskId", "runId", "expectedRevision"], [], ["expectedRevision"]);
    case "workspace.preview_file": return definition(["taskId", "runId", "expectedRevision", "observationId"], [], ["expectedRevision"]);
    case "provider.probe_models": return definition(["providerFamily"]);
    case "provider.discover_installation": return definition(["providerFamily"]);
    case "provider.configure_installation": return definition(["providerFamily", "installation"]);
    case "provider.configure_chat_models": return definition(["providerFamily", "modelIds", "defaultModelId"]);
    default: throw new Error("session_id_runtime_command_denied");
  }
}

function validateProviderInstallation(providerFamily: unknown, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session_id_runtime_command_invalid");
  }
  const installation = value as Record<string, unknown>;
  if (providerFamily === "opencode") {
    assertKeys(installation, ["kind", "commandPath", "authFilePath"], [], "session_id_runtime_command_invalid");
    if (installation.kind !== "opencode") throw new Error("session_id_runtime_command_invalid");
    requiredText(installation.commandPath, "session_id_runtime_command_invalid");
    requiredText(installation.authFilePath, "session_id_runtime_command_invalid");
    return;
  }
  if (providerFamily === "codex") {
    assertKeys(installation, ["kind", "codexPath", "nodePath", "authFilePath"], [], "session_id_runtime_command_invalid");
    if (installation.kind !== "codex") throw new Error("session_id_runtime_command_invalid");
    requiredText(installation.codexPath, "session_id_runtime_command_invalid");
    requiredText(installation.nodePath, "session_id_runtime_command_invalid");
    requiredText(installation.authFilePath, "session_id_runtime_command_invalid");
    return;
  }
  assertKeys(installation, ["kind", "claudePath", "nodePath", "settingsFilePath"], [], "session_id_runtime_command_invalid");
  if (installation.kind !== "claude-code") throw new Error("session_id_runtime_command_invalid");
  requiredText(installation.claudePath, "session_id_runtime_command_invalid");
  requiredText(installation.nodePath, "session_id_runtime_command_invalid");
  requiredText(installation.settingsFilePath, "session_id_runtime_command_invalid");
}

function validateHumanMessageTarget(command: Record<string, unknown>): void {
  const hasAgentCard = typeof command.targetAgentCardId === "string" && Boolean(command.targetAgentCardId.trim());
  const hasLogicalSession = typeof command.targetLogicalSessionId === "string" && Boolean(command.targetLogicalSessionId.trim());
  if (hasAgentCard === hasLogicalSession) throw new Error("session_id_runtime_command_invalid");
}

function validateMetadata(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_runtime_command_invalid");
  const metadata = value as Record<string, unknown>;
  assertKeys(metadata, ["title"], ["slug", "description"], "session_id_runtime_command_invalid");
  requiredText(metadata.title, "session_id_runtime_command_invalid");
  if (metadata.slug !== undefined) requiredText(metadata.slug, "session_id_runtime_command_invalid");
  if (metadata.description !== undefined && typeof metadata.description !== "string") throw new Error("session_id_runtime_command_invalid");
}

function validateTaskInputValues(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("session_id_runtime_command_invalid");
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("session_id_runtime_command_invalid");
    const record = item as Record<string, unknown>;
    assertKeys(record, ["fieldId", "value"], [], "session_id_runtime_command_invalid");
    requiredText(record.fieldId, "session_id_runtime_command_invalid");
    requiredText(record.value, "session_id_runtime_command_invalid");
  }
}

function validateMetaTarget(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_runtime_command_invalid");
  const target = value as Record<string, unknown>;
  if (target.kind === "template_draft") {
    assertKeys(target, ["kind", "templateDraftId"], [], "session_id_runtime_command_invalid");
    requiredText(target.templateDraftId, "session_id_runtime_command_invalid");
    return;
  }
  if (target.kind === "task_setup_draft") {
    assertKeys(target, ["kind", "taskSetupDraftId"], [], "session_id_runtime_command_invalid");
    requiredText(target.taskSetupDraftId, "session_id_runtime_command_invalid");
    return;
  }
  throw new Error("session_id_runtime_command_invalid");
}

function validateFileStateAnchor(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_runtime_command_invalid");
  const anchor = value as Record<string, unknown>;
  assertKeys(anchor, ["observationId"], ["label"], "session_id_runtime_command_invalid");
  requiredText(anchor.observationId, "session_id_runtime_command_invalid");
  if (anchor.label !== undefined) requiredText(anchor.label, "session_id_runtime_command_invalid");
}

function taskRequest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_task_read_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("taskId" in record)) throw new Error("session_id_task_read_invalid");
  return requiredText(record.taskId, "session_id_task_id_required");
}

function configurationRequest(value: unknown): SessionIdUnifiedConfigurationReadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_configuration_read_invalid");
  const record = value as Record<string, unknown>;
  if (record.kind === "template_studio") {
    assertKeys(record, ["kind"], ["templateId"], "session_id_configuration_read_invalid");
    return Object.freeze({
      kind: "template_studio",
      ...(record.templateId === undefined ? {} : { templateId: requiredText(record.templateId, "session_id_configuration_read_invalid") }),
    });
  }
  if (record.kind === "task_setup") {
    assertKeys(record, ["kind", "taskSetupDraftId"], [], "session_id_configuration_read_invalid");
    return Object.freeze({ kind: "task_setup", taskSetupDraftId: requiredText(record.taskSetupDraftId, "session_id_configuration_read_invalid") });
  }
  if (record.kind === "provider_settings") {
    assertKeys(record, ["kind"], [], "session_id_configuration_read_invalid");
    return Object.freeze({ kind: "provider_settings" });
  }
  if (record.kind === "meta") {
    assertKeys(record, ["kind", "scope"], [], "session_id_configuration_read_invalid");
    if (!record.scope || typeof record.scope !== "object" || Array.isArray(record.scope)) throw new Error("session_id_configuration_read_invalid");
    const scope = record.scope as Record<string, unknown>;
    assertKeys(scope, ["kind", "draftId", "draftRevision"], [], "session_id_configuration_read_invalid");
    if (scope.kind !== "template_design" && scope.kind !== "task_setup") throw new Error("session_id_configuration_read_invalid");
    if (!Number.isSafeInteger(scope.draftRevision) || Number(scope.draftRevision) < 1) throw new Error("session_id_configuration_read_invalid");
    return Object.freeze({
      kind: "meta",
      scope: Object.freeze({
        kind: scope.kind,
        draftId: requiredText(scope.draftId, "session_id_configuration_read_invalid"),
        draftRevision: scope.draftRevision as number,
      }),
    });
  }
  throw new Error("session_id_configuration_read_invalid");
}

function exactEmpty(value: unknown, code: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) throw new Error(code);
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(code);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PAYLOAD_BYTES) throw new Error("session_id_runtime_payload_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function authenticatedHttpSurface(
  request: IncomingMessage,
  browserToken: string,
  desktopToken: string | undefined,
): "browser" | "electron" | undefined {
  const authorization = request.headers.authorization;
  const raw = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : authorization;
  if (raw === browserToken) return "browser";
  if (desktopToken && raw === desktopToken) return "electron";
  return undefined;
}

function authorizedHttp(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === token || request.headers.authorization === `Bearer ${token}`;
}

function authenticatedWebSocketSurface(
  request: IncomingMessage,
  browserToken: string,
  desktopToken: string | undefined,
): "browser" | "electron" | undefined {
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
  if (!protocols.includes("agent-workspace-session-id-runtime")) return undefined;
  const browser = protocols.includes(browserToken);
  const desktop = Boolean(desktopToken && protocols.includes(desktopToken));
  if (browser === desktop) return undefined;
  return browser ? "browser" : "electron";
}

function originAllowed(request: IncomingMessage, allowedOrigins: readonly string[] | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return Boolean(allowedOrigins?.includes(origin));
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://runtime.local");
}

function respond(response: ServerResponse, status: number, code: string): void {
  respondValue(response, status, { error: { code } });
}

function respondValue(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function publicCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return [
    "session_id_runtime_payload_too_large",
    "session_id_runtime_task_denied",
    "session_id_runtime_command_denied",
    "session_id_runtime_command_invalid",
    "session_id_task_read_invalid",
    "session_id_configuration_read_invalid",
  ].includes(code) ? code : "session_id_runtime_command_rejected";
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function optionalText(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function requiredSecret(value: string, code: string): string {
  const secret = requiredText(value, code);
  if (secret.length < 16 || /\s/u.test(secret)) throw new Error(code);
  return secret;
}
