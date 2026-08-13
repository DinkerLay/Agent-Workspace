import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  dispatchProviderScopedToolCall,
  normalizeProviderScopedToolRegistration,
  stableJson,
  type ProviderScopedToolRegistration,
  type ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const ROUTE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;

export type ProviderScopedMcpRoute = Readonly<{
  readonly bindingId: string;
  readonly url: string;
  waitForToolDiscovery(): Promise<void>;
  activate(context: ProviderScopedToolTurnContext): void;
  deactivate(): void;
  close(): void;
}>;

export type ProviderScopedMcpBridge = Readonly<{
  listen(port?: number): Promise<Readonly<{ host: typeof LOOPBACK_HOST; port: number; url: string }>>;
  registerRoute(input: Readonly<{
    bindingId: string;
    registration: ProviderScopedToolRegistration;
  }>): ProviderScopedMcpRoute;
  close(): Promise<void>;
}>;

type RouteState = {
  readonly bindingId: string;
  readonly token: string;
  readonly registration: ProviderScopedToolRegistration;
  readonly calls: Map<string, Readonly<{
    fingerprint: string;
    response: Promise<Readonly<Record<string, unknown>>>;
  }>>;
  readonly toolDiscovery: Promise<void>;
  readonly resolveToolDiscovery: () => void;
  readonly rejectToolDiscovery: (error: Error) => void;
  toolDiscoveryObserved: boolean;
  turnEpoch: number;
  activeContext?: ProviderScopedToolTurnContext;
  closed: boolean;
};

export function createProviderScopedMcpBridge(options: Readonly<{
  readonly createToken?: () => string;
}> = {}): ProviderScopedMcpBridge {
  const createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const routes = new Map<string, RouteState>();
  let server: Server | undefined;
  let address: Readonly<{ host: typeof LOOPBACK_HOST; port: number; url: string }> | undefined;
  let closed = false;

  const bridge: ProviderScopedMcpBridge = Object.freeze({
    async listen(port = 0) {
      ensureOpen();
      if (address) return address;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("provider_scoped_mcp_port_invalid");
      const next = createServer((request, response) => {
        void handleHttpRequest(request, response, routes).catch(() => {
          if (!response.headersSent) writeJson(response, 500, rpcError(null, -32603, "internal_error"));
          else response.destroy();
        });
      });
      server = next;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          next.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          next.off("error", onError);
          resolve();
        };
        next.once("error", onError);
        next.once("listening", onListening);
        next.listen(port, LOOPBACK_HOST);
      });
      const socket = next.address() as AddressInfo | null;
      if (!socket || socket.address !== LOOPBACK_HOST) {
        await closeServer(next);
        server = undefined;
        throw new Error("provider_scoped_mcp_loopback_bind_failed");
      }
      address = Object.freeze({ host: LOOPBACK_HOST, port: socket.port, url: `http://${LOOPBACK_HOST}:${socket.port}` });
      return address;
    },

    registerRoute(input) {
      ensureOpen();
      if (!address) throw new Error("provider_scoped_mcp_not_listening");
      const bindingId = requiredText(input.bindingId, "provider_scoped_mcp_binding_id_required");
      const registration = normalizeProviderScopedToolRegistration(input.registration);
      const token = createToken();
      if (!ROUTE_TOKEN.test(token) || routes.has(token)) throw new Error("provider_scoped_mcp_route_token_invalid");
      let resolveToolDiscovery!: () => void;
      let rejectToolDiscovery!: (error: Error) => void;
      const toolDiscovery = new Promise<void>((resolve, reject) => {
        resolveToolDiscovery = resolve;
        rejectToolDiscovery = reject;
      });
      toolDiscovery.catch(() => undefined);
      const state: RouteState = {
        bindingId,
        token,
        registration,
        calls: new Map(),
        toolDiscovery,
        resolveToolDiscovery,
        rejectToolDiscovery,
        toolDiscoveryObserved: false,
        turnEpoch: 0,
        closed: false,
      };
      routes.set(token, state);
      const url = `${address.url}/mcp/${token}`;
      return Object.freeze({
        bindingId,
        url,
        waitForToolDiscovery() {
          ensureRouteOpen(state);
          return state.toolDiscovery;
        },
        activate(context: ProviderScopedToolTurnContext) {
          ensureRouteOpen(state);
          if (!context || context.capabilityClass !== registration.capabilityClass) {
            throw new Error("provider_scoped_tool_capability_mismatch");
          }
          if (typeof context.handleCall !== "function") throw new Error("provider_scoped_tool_turn_context_invalid");
          state.turnEpoch += 1;
          state.calls.clear();
          state.activeContext = context;
        },
        deactivate() {
          ensureRouteOpen(state);
          state.activeContext = undefined;
          state.calls.clear();
        },
        close() {
          if (state.closed) return;
          state.closed = true;
          state.activeContext = undefined;
          state.calls.clear();
          if (!state.toolDiscoveryObserved) {
            state.rejectToolDiscovery(new Error("provider_scoped_mcp_route_closed"));
          }
          routes.delete(token);
        },
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const route of routes.values()) {
        route.closed = true;
        route.activeContext = undefined;
        route.calls.clear();
        if (!route.toolDiscoveryObserved) {
          route.rejectToolDiscovery(new Error("provider_scoped_mcp_bridge_closed"));
        }
      }
      routes.clear();
      const current = server;
      server = undefined;
      address = undefined;
      if (current) await closeServer(current);
    },
  });

  return bridge;

  function ensureOpen(): void {
    if (closed) throw new Error("provider_scoped_mcp_bridge_closed");
  }
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  routes: ReadonlyMap<string, RouteState>,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  const match = /^\/mcp\/([A-Za-z0-9_-]{32,128})$/u.exec(url.pathname);
  const route = match ? routes.get(match[1]!) : undefined;
  if (!route || route.closed) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    response.writeHead(405).end();
    return;
  }
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    writeJson(response, 415, rpcError(null, -32600, "content_type_invalid"));
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "provider_scoped_mcp_body_too_large";
    writeJson(response, tooLarge ? 413 : 400, rpcError(null, -32700, tooLarge ? "body_too_large" : "parse_error"));
    return;
  }
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    writeJson(response, 200, rpcError(rpcId(payload), -32600, "invalid_request"));
    return;
  }
  const id = rpcId(payload);
  if (payload.method === "notifications/initialized" && id === null) {
    response.writeHead(202).end();
    return;
  }
  if (payload.method === "initialize") {
    writeJson(response, 200, rpcResult(id, {
      protocolVersion: requestedProtocolVersion(payload.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "agent-workspace-scoped-tools", version: "1" },
    }));
    return;
  }
  if (payload.method === "ping") {
    writeJson(response, 200, rpcResult(id, {}));
    return;
  }
  if (payload.method === "tools/list") {
    if (!route.toolDiscoveryObserved) {
      route.toolDiscoveryObserved = true;
      route.resolveToolDiscovery();
    }
    writeJson(response, 200, rpcResult(id, {
      tools: route.registration.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    return;
  }
  if (payload.method === "tools/call") {
    if (id === null) {
      writeJson(response, 200, rpcError(id, -32600, "tool_call_id_required"));
      return;
    }
    const params = isRecord(payload.params) ? payload.params : undefined;
    const name = typeof params?.name === "string" ? params.name : undefined;
    if (!name || !route.registration.tools.some((tool) => tool.name === name)) {
      writeJson(response, 200, rpcError(id, -32602, "tool_not_registered"));
      return;
    }
    const context = route.activeContext;
    if (!context) {
      writeJson(response, 200, rpcError(id, -32001, "scoped_turn_inactive"));
      return;
    }
    const argumentsValue = params?.arguments ?? {};
    const replayKey = `${typeof id}:${String(id)}`;
    const fingerprint = stableJson({ name, arguments: argumentsValue });
    const existing = route.calls.get(replayKey);
    if (existing && existing.fingerprint !== fingerprint) {
      writeJson(response, 200, rpcError(id, -32003, "provider_call_replay_conflict"));
      return;
    }
    const pending = existing?.response ?? dispatchToolCall(route, context, id, name, argumentsValue);
    if (!existing) route.calls.set(replayKey, Object.freeze({ fingerprint, response: pending }));
    writeJson(response, 200, await pending);
    return;
  }
  writeJson(response, 200, rpcError(id, -32601, "method_not_found"));
}

function providerCallId(route: RouteState, id: unknown, name: string): string {
  const digest = createHash("sha256")
    .update(route.token)
    .update("\0")
    .update(route.bindingId)
    .update("\0")
    .update(String(route.turnEpoch))
    .update("\0")
    .update(JSON.stringify(id))
    .update("\0")
    .update(name)
    .digest("hex");
  return `provider_call_${digest.slice(0, 40)}`;
}

async function dispatchToolCall(
  route: RouteState,
  context: ProviderScopedToolTurnContext,
  id: string | number,
  name: string,
  argumentsValue: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const result = await dispatchProviderScopedToolCall({
      registration: route.registration,
      turnContext: context,
      nativeCall: {
        providerCallId: providerCallId(route, id, name),
        name,
        arguments: argumentsValue,
      },
    });
    const text = JSON.stringify(result.result) ?? "null";
    const structuredContent = isRecord(result.result) ? result.result : { value: result.result ?? null };
    return rpcResult(id, {
      content: [{ type: "text", text }],
      structuredContent,
      isError: false,
    });
  } catch {
    return rpcError(id, -32002, "tool_dispatch_rejected");
  }
}

function requestedProtocolVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string" && params.protocolVersion.trim()) {
    return params.protocolVersion;
  }
  return "2025-06-18";
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("provider_scoped_mcp_body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function rpcResult(id: unknown, result: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ jsonrpc: "2.0", id, error: Object.freeze({ code, message }) });
}

function rpcId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function ensureRouteOpen(route: RouteState): void {
  if (route.closed) throw new Error("provider_scoped_mcp_route_closed");
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
