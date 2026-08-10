import type { RuntimeCommand, RuntimeCommandResult, RuntimeInvalidation, RuntimeReadModel } from "../../runtime-contracts/src/index";
import {
  createRuntimeClient,
  type RuntimeClient,
  type RuntimeInvalidationListener,
  type RuntimeReadRequest,
  type RuntimeSubscriptionRequest,
  type RuntimeUnsubscribe,
} from "./index";

export type FetchLike = typeof fetch;

export type WebSocketLike = Pick<WebSocket, "close" | "addEventListener" | "removeEventListener">;

export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

export type HttpRuntimeClientOptions = Readonly<{
  baseUrl: string;
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  authorization?: string;
}>;

/**
 * Browser transport. Credentials are a short-lived bridge credential supplied
 * by an authenticated Runtime Host, never a Provider credential.
 */
export function createHttpRuntimeClient(options: HttpRuntimeClientOptions): RuntimeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = stripTrailingSlash(options.baseUrl);
  const headers = options.authorization ? { authorization: options.authorization } : undefined;

  return createRuntimeClient({
    read: (request) => postJson<RuntimeReadModel>(fetchImpl, `${baseUrl}/runtime/read`, request, headers),
    command: (command) => postJson<RuntimeCommandResult>(fetchImpl, `${baseUrl}/runtime/command`, command, headers),
    subscribe: (request, listener) => subscribeHttpRuntime({
      request,
      listener,
      baseUrl,
      authorization: options.authorization,
      webSocketFactory: options.webSocketFactory ?? defaultWebSocketFactory,
    }),
  });
}

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readRuntimeErrorCode(response));
  }
  return (await response.json()) as T;
}

async function readRuntimeErrorCode(response: Response): Promise<string> {
  try {
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "runtime_command_failed";
    const error = (value as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return "runtime_command_failed";
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(code)
      ? code
      : "runtime_command_failed";
  } catch {
    return "runtime_command_failed";
  }
}

function subscribeHttpRuntime({
  request,
  listener,
  baseUrl,
  authorization,
  webSocketFactory,
}: {
  request: RuntimeSubscriptionRequest;
  listener: RuntimeInvalidationListener;
  baseUrl: string;
  authorization?: string;
  webSocketFactory: WebSocketFactory;
}): Promise<RuntimeUnsubscribe> {
  const url = new URL(`${baseUrl}/runtime/subscribe`);
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const protocols = authorization ? ["agent-workspace-runtime", authorization] : undefined;
  const socket = webSocketFactory(toWebSocketUrl(url), protocols);
  const onMessage = (event: MessageEvent<string>) => {
    const message = parseRuntimeMessage(event.data);
    if (message?.type === "runtime.invalidated") listener(message.invalidation);
  };
  socket.addEventListener("message", onMessage as EventListener);

  return Promise.resolve(async () => {
    socket.removeEventListener("message", onMessage as EventListener);
    socket.close();
  });
}

function parseRuntimeMessage(value: unknown): { type: "runtime.invalidated"; invalidation: RuntimeInvalidation } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { type?: unknown; invalidation?: RuntimeInvalidation };
    return parsed.type === "runtime.invalidated" && parsed.invalidation ? {
      type: "runtime.invalidated",
      invalidation: parsed.invalidation,
    } : undefined;
  } catch {
    return undefined;
  }
}

function defaultWebSocketFactory(url: string, protocols?: string | string[]): WebSocketLike {
  return new WebSocket(url, protocols);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function toWebSocketUrl(url: URL): string {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
