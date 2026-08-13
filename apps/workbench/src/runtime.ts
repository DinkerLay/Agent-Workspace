import {
  createAgentLoopSessionIdRootController,
  type AgentLoopSessionIdLifecycleCommand,
  type AgentLoopSessionIdLifecycleCommandResult,
  type AgentLoopSessionIdRootController,
  type AgentLoopSessionIdRootRuntimePort,
  type AgentLoopSessionIdWorkspaceReadModel,
} from "../../../packages/workbench-ui/src/agent-loop/agent-loop-session-id-root-controller";
import type {
  AgentLoopSessionIdConfigurationReadResult,
} from "../../../packages/workbench-ui/src/agent-loop/agent-loop-session-id-configuration-controller";
import type {
  AgentLoopSessionIdCommandResult,
  AgentLoopSessionIdTaskReadModel,
  AgentLoopSessionIdUiCommand,
} from "../../../packages/workbench-ui/src/agent-loop/agent-loop-session-id-runtime-controller";

type SessionIdCommand = AgentLoopSessionIdUiCommand | AgentLoopSessionIdLifecycleCommand;
type SessionIdCommandResult = AgentLoopSessionIdCommandResult | AgentLoopSessionIdLifecycleCommandResult;

export interface AgentLoopSessionIdDesktopFacade extends AgentLoopSessionIdRootRuntimePort {}

declare global {
  interface AgentWorkspaceWindowBridge {
    sessionIdRuntime?: AgentLoopSessionIdDesktopFacade & Readonly<{ authenticatedUserId?: string }>;
  }

  interface Window {
    agentWorkspace?: AgentWorkspaceWindowBridge;
  }
}

export type AgentLoopSessionIdBrowserClientOptions = Readonly<{
  baseUrl: string;
  authorization: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => Pick<WebSocket, "addEventListener" | "removeEventListener" | "close">;
}>;

/** Selects the one formal Session-ID transport; neither branch has a generic Runtime fallback. */
export function createAgentLoopSessionIdController(): AgentLoopSessionIdRootController {
  const desktop = window.agentWorkspace?.sessionIdRuntime;
  const client = desktop ? createAgentLoopSessionIdDesktopPort(desktop) : createAgentLoopSessionIdBrowserPortFromPage();
  return createAgentLoopSessionIdRootController({
    client,
    ownerId: rendererOwnerId(desktop?.authenticatedUserId),
  });
}

export function createAgentLoopSessionIdDesktopPort(
  facade: AgentLoopSessionIdDesktopFacade,
): AgentLoopSessionIdRootRuntimePort {
  assertPort(facade);
  return Object.freeze({
    readWorkspace: () => facade.readWorkspace(),
    readTask: (request) => facade.readTask(request),
    readConfiguration: (request) => facade.readConfiguration(request),
    command: (command) => facade.command(command),
    subscribe: (request, listener) => facade.subscribe(request, listener),
  });
}

export function createAgentLoopSessionIdBrowserPortFromPage(): AgentLoopSessionIdRootRuntimePort {
  const authorization = metaContent("agent-workspace-runtime-bridge-token");
  if (!authorization) return unavailablePort("browser_session_id_runtime_bridge_token_missing");
  if (/^Bearer\s/iu.test(authorization)) return unavailablePort("browser_session_id_runtime_bridge_token_must_be_raw");
  return createAgentLoopSessionIdBrowserPort({
    baseUrl: metaContent("agent-workspace-runtime-origin") ?? window.location.origin,
    authorization,
  });
}

export function createAgentLoopSessionIdBrowserPort(
  options: AgentLoopSessionIdBrowserClientOptions,
): AgentLoopSessionIdRootRuntimePort {
  const baseUrl = normalizeRuntimeBaseUrl(options.baseUrl);
  const authorization = requiredToken(options.authorization);
  const fetchImpl = options.fetchImpl ?? fetch;
  const webSocketFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  const post = <Result>(route: string, body: unknown) => postJson<Result>(
    fetchImpl,
    `${baseUrl}${route}`,
    authorization,
    body,
  );
  return Object.freeze({
    readWorkspace: () => post<AgentLoopSessionIdWorkspaceReadModel>("/runtime/session-id/workspace/read", {}),
    readTask: (request) => post<AgentLoopSessionIdTaskReadModel>("/runtime/session-id/read", taskRequest(request)),
    readConfiguration: (request) => post<AgentLoopSessionIdConfigurationReadResult>(
      "/runtime/session-id/configuration/read",
      request,
    ),
    command: (command) => post<SessionIdCommandResult>("/runtime/session-id/command", command),
    subscribe(request, listener) {
      const url = new URL(`${baseUrl}/runtime/session-id/subscribe`);
      if (request.taskId) url.searchParams.set("taskId", requiredText(request.taskId, "session_id_task_id_required"));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const protocols = ["agent-workspace-session-id-runtime", authorization];
      let active = true;
      let reconnectAttempt = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let currentSocket: ReturnType<typeof webSocketFactory> | undefined;
      let detachCurrent: () => void = () => undefined;

      const scheduleReconnect = () => {
        if (!active || reconnectTimer) return;
        const delayMs = Math.min(250 * (2 ** reconnectAttempt), 1_000);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delayMs);
      };
      const connect = () => {
        if (!active) return;
        let socket: ReturnType<typeof webSocketFactory>;
        try {
          socket = webSocketFactory(url.toString(), protocols);
        } catch {
          scheduleReconnect();
          return;
        }
        currentSocket = socket;
        let detached = false;
        const onOpen = () => {
          reconnectAttempt = 0;
          listener(Object.freeze({
            reason: "subscription_resynced",
            observedAt: new Date().toISOString(),
          }));
        };
        const onMessage = (event: MessageEvent<string>) => {
          try {
            const value = JSON.parse(event.data) as { type?: unknown; invalidation?: unknown };
            if (value.type === "runtime.invalidated" && value.invalidation && typeof value.invalidation === "object") {
              listener(value.invalidation as Parameters<typeof listener>[0]);
            }
          } catch {
            // Malformed transport data never becomes a Runtime fact.
          }
        };
        const detach = () => {
          if (detached) return;
          detached = true;
          socket.removeEventListener("open", onOpen as EventListener);
          socket.removeEventListener("message", onMessage as EventListener);
          socket.removeEventListener("error", onDisconnected as EventListener);
          socket.removeEventListener("close", onDisconnected as EventListener);
        };
        const onDisconnected = () => {
          if (currentSocket !== socket) return;
          detach();
          currentSocket = undefined;
          socket.close();
          scheduleReconnect();
        };
        detachCurrent = detach;
        socket.addEventListener("open", onOpen as EventListener);
        socket.addEventListener("message", onMessage as EventListener);
        socket.addEventListener("error", onDisconnected as EventListener);
        socket.addEventListener("close", onDisconnected as EventListener);
      };

      connect();
      return Promise.resolve(() => {
        if (!active) return;
        active = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        detachCurrent();
        const socket = currentSocket;
        currentSocket = undefined;
        socket?.close();
      });
    },
  });
}

async function postJson<Result>(
  fetchImpl: typeof fetch,
  url: string,
  authorization: string,
  body: unknown,
): Promise<Result> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await publicError(response));
  return await response.json() as Result;
}

async function publicError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: { code?: unknown } };
    return typeof value.error?.code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value.error.code)
      ? value.error.code
      : "session_id_runtime_request_failed";
  } catch {
    return "session_id_runtime_request_failed";
  }
}

function taskRequest(value: Readonly<{ taskId: string }>): Readonly<{ taskId: string }> {
  return Object.freeze({ taskId: requiredText(value.taskId, "session_id_task_id_required") });
}

function assertPort(value: AgentLoopSessionIdDesktopFacade): void {
  if (!value
    || typeof value.readWorkspace !== "function"
    || typeof value.readTask !== "function"
    || typeof value.readConfiguration !== "function"
    || typeof value.command !== "function"
    || typeof value.subscribe !== "function") {
    throw new TypeError("session_id_root_runtime_facade_invalid");
  }
}

function unavailablePort(reason: string): AgentLoopSessionIdRootRuntimePort {
  const unavailable = async (): Promise<never> => { throw new Error(reason); };
  return Object.freeze({
    readWorkspace: unavailable,
    readTask: unavailable,
    readConfiguration: unavailable,
    command: unavailable,
    subscribe: unavailable,
  });
}

function rendererOwnerId(desktopOwnerId?: string): string {
  const value = desktopOwnerId?.trim() || metaContent("agent-workspace-owner-id") || "user_local";
  return /^user_[A-Za-z0-9_-]{1,251}$/u.test(value) ? value : "user_local";
}

function metaContent(name: string): string | undefined {
  const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim();
  return value || undefined;
}

function normalizeRuntimeBaseUrl(value: string): string {
  const url = new URL(requiredText(value, "session_id_runtime_url_required"));
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError("session_id_runtime_url_invalid");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function requiredToken(value: string): string {
  const token = requiredText(value, "session_id_runtime_token_required");
  if (token.length < 16 || /\s/u.test(token)) throw new TypeError("session_id_runtime_token_invalid");
  return token;
}

function requiredText(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(code);
  return value.trim();
}
