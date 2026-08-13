export type SessionIdRuntimeTaskRequest = Readonly<{ taskId: string }>;

export type SessionIdRuntimeUnsubscribe = () => Promise<void> | void;

export interface SessionIdRuntimeClient<ReadModel, Command, CommandResult, Invalidation> {
  read(request: SessionIdRuntimeTaskRequest): Promise<ReadModel>;
  command(command: Command): Promise<CommandResult>;
  subscribe(
    request: SessionIdRuntimeTaskRequest,
    listener: (invalidation: Invalidation) => void,
  ): Promise<SessionIdRuntimeUnsubscribe>;
}

export interface SessionIdDesktopRuntimeFacade<ReadModel, Command, CommandResult, Invalidation>
  extends SessionIdRuntimeClient<ReadModel, Command, CommandResult, Invalidation> {}

export type SessionIdFetchLike = typeof fetch;
export type SessionIdWebSocketLike = Pick<WebSocket, "close" | "addEventListener" | "removeEventListener">;
export type SessionIdWebSocketFactory = (url: string, protocols?: string | string[]) => SessionIdWebSocketLike;

export type SessionIdHttpRuntimeClientOptions<Invalidation = never> = Readonly<{
  baseUrl: string;
  authorization: string;
  fetchImpl?: SessionIdFetchLike;
  webSocketFactory?: SessionIdWebSocketFactory;
  createResyncInvalidation?: (request: SessionIdRuntimeTaskRequest) => Invalidation;
}>;

/**
 * Candidate browser adapter for the Session-ID cutover. It exposes only the
 * Task-scoped read/command/invalidation trio and no generic HTTP, tool, lease,
 * Provider, filesystem or Store capability.
 */
export function createSessionIdHttpRuntimeClient<ReadModel, Command, CommandResult, Invalidation>(
  options: SessionIdHttpRuntimeClientOptions<Invalidation>,
): SessionIdRuntimeClient<ReadModel, Command, CommandResult, Invalidation> {
  const baseUrl = stripTrailingSlash(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const websocket = options.webSocketFactory ?? defaultWebSocketFactory;
  const headers = { authorization: options.authorization };

  return Object.freeze({
    read: (request: SessionIdRuntimeTaskRequest) =>
      postJson<ReadModel>(fetchImpl, `${baseUrl}/runtime/session-id/read`, request, headers),
    command: (command: Command) =>
      postJson<CommandResult>(fetchImpl, `${baseUrl}/runtime/session-id/command`, command, headers),
    subscribe(request: SessionIdRuntimeTaskRequest, listener: (invalidation: Invalidation) => void) {
      const url = new URL(`${baseUrl}/runtime/session-id/subscribe`);
      const subscriptionRequest = Object.freeze({ taskId: requiredTaskId(request) });
      url.searchParams.set("taskId", subscriptionRequest.taskId);
      const websocketUrl = toWebSocketUrl(url);
      const protocols = ["agent-workspace-session-id-runtime", options.authorization];
      let active = true;
      let reconnectAttempt = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let currentSocket: SessionIdWebSocketLike | undefined;
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
        let socket: SessionIdWebSocketLike;
        try {
          socket = websocket(websocketUrl, protocols);
        } catch {
          scheduleReconnect();
          return;
        }
        currentSocket = socket;
        let detached = false;
        const onOpen = () => {
          reconnectAttempt = 0;
          if (options.createResyncInvalidation) {
            listener(options.createResyncInvalidation(subscriptionRequest));
          }
        };
        const onMessage = (event: MessageEvent<string>) => {
          const value = parseInvalidation<Invalidation>(event.data);
          if (value !== undefined) listener(value);
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

/** Candidate Electron adapter over the preload-owned narrow facade. */
export function createSessionIdDesktopRuntimeClient<ReadModel, Command, CommandResult, Invalidation>(
  facade: SessionIdDesktopRuntimeFacade<ReadModel, Command, CommandResult, Invalidation>,
): SessionIdRuntimeClient<ReadModel, Command, CommandResult, Invalidation> {
  if (!facade || typeof facade.read !== "function" || typeof facade.command !== "function" || typeof facade.subscribe !== "function") {
    throw new TypeError("session_id_desktop_runtime_facade_invalid");
  }
  return Object.freeze({
    read: (request: SessionIdRuntimeTaskRequest) => facade.read(request),
    command: (command: Command) => facade.command(command),
    subscribe: (request: SessionIdRuntimeTaskRequest, listener: (invalidation: Invalidation) => void) =>
      facade.subscribe(request, listener),
  });
}

async function postJson<T>(
  fetchImpl: SessionIdFetchLike,
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: { code?: unknown } };
    const code = value?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(code)
      ? code
      : "session_id_runtime_request_failed";
  } catch {
    return "session_id_runtime_request_failed";
  }
}

function parseInvalidation<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { type?: unknown; invalidation?: T };
    return parsed.type === "runtime.invalidated" ? parsed.invalidation : undefined;
  } catch {
    return undefined;
  }
}

function requiredTaskId(request: SessionIdRuntimeTaskRequest): string {
  if (!request || typeof request.taskId !== "string" || !request.taskId.trim()) {
    throw new TypeError("session_id_runtime_task_id_required");
  }
  return request.taskId;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function toWebSocketUrl(url: URL): string {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function defaultWebSocketFactory(url: string, protocols?: string | string[]): SessionIdWebSocketLike {
  return new WebSocket(url, protocols);
}
