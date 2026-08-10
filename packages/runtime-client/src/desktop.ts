import type { RuntimeCommand, RuntimeCommandResult, RuntimeInvalidation, RuntimeReadModel } from "../../runtime-contracts/src/index";
import {
  createRuntimeClient,
  type RuntimeClient,
  type RuntimeInvalidationListener,
  type RuntimeReadRequest,
  type RuntimeSubscriptionRequest,
  type RuntimeUnsubscribe,
} from "./index";

export interface DesktopRuntimeFacade {
  read(request?: RuntimeReadRequest): Promise<RuntimeReadModel>;
  command(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  subscribe(request: RuntimeSubscriptionRequest, listener: RuntimeInvalidationListener): Promise<RuntimeUnsubscribe>;
}

declare global {
  /** The formal Electron preload owns this narrow, typed bridge namespace. */
  interface AgentWorkspaceWindowBridge {
    runtime?: DesktopRuntimeFacade;
  }

  interface Window {
    agentWorkspace?: AgentWorkspaceWindowBridge;
  }
}

export function createDesktopRuntimeClient(facade?: DesktopRuntimeFacade): RuntimeClient {
  const resolved = facade ?? (typeof window === "undefined" ? undefined : window.agentWorkspace?.runtime);
  if (!resolved) throw new Error("desktop_runtime_facade_unavailable");
  return createRuntimeClient(resolved);
}
