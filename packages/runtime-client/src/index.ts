import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeInvalidation,
  RuntimeReadModel,
  RuntimeReadRequest,
} from "../../runtime-contracts/src/index";

/**
 * Renderer-safe access to the Runtime Bridge. The interface intentionally has
 * no Provider, terminal, filesystem, database, or generic event append API.
 */
export type RuntimeSubscriptionRequest = Readonly<{
  workspaceId?: string;
  taskId?: string;
  taskRunId?: string;
  templateId?: string;
}>;

export type RuntimeInvalidationListener = (invalidation: RuntimeInvalidation) => void;
export type RuntimeUnsubscribe = () => Promise<void> | void;

export interface RuntimeClient {
  read(request?: RuntimeReadRequest): Promise<RuntimeReadModel>;
  command(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  subscribe(request: RuntimeSubscriptionRequest, listener: RuntimeInvalidationListener): Promise<RuntimeUnsubscribe>;
}

export interface RuntimeClientTransport {
  read(request: RuntimeReadRequest): Promise<RuntimeReadModel>;
  command(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  subscribe(request: RuntimeSubscriptionRequest, listener: RuntimeInvalidationListener): Promise<RuntimeUnsubscribe>;
}

export function createRuntimeClient(transport: RuntimeClientTransport): RuntimeClient {
  if (!transport || typeof transport.read !== "function" || typeof transport.command !== "function") {
    throw new TypeError("RuntimeClient transport must provide read and command");
  }
  if (typeof transport.subscribe !== "function") {
    throw new TypeError("RuntimeClient transport must provide subscribe");
  }

  return Object.freeze({
    read: (request: RuntimeReadRequest = {}) => transport.read(request),
    command: (command: RuntimeCommand) => transport.command(command),
    subscribe: (request: RuntimeSubscriptionRequest, listener: RuntimeInvalidationListener) =>
      transport.subscribe(request, listener),
  });
}

export type { RuntimeCommand, RuntimeCommandResult, RuntimeInvalidation, RuntimeReadModel, RuntimeReadRequest };
