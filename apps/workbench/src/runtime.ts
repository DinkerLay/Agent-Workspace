import { createDesktopRuntimeClient } from "../../../packages/runtime-client/src/desktop";
import { createHttpRuntimeClient } from "../../../packages/runtime-client/src/http";
import { createRuntimeClient, type RuntimeClient } from "../../../packages/runtime-client/src/index";
import {
  createAgentLoopRuntimeController,
  createAgentLoopConfigurationController,
  createAgentLoopTemplateStudioController,
  type AgentLoopConfigurationController,
  type AgentLoopRuntimeController,
  type AgentLoopTemplateStudioController,
} from "../../../packages/workbench-ui/src/index";

export type AgentLoopRendererControllers = Readonly<{
  task: AgentLoopRuntimeController;
  configuration: AgentLoopConfigurationController;
  templateStudio: AgentLoopTemplateStudioController;
}>;

/**
 * Chooses only one Runtime bridge transport for the preserved AgentLoop UI.
 * Provider SDKs, PTY objects and filesystem capabilities never enter this
 * bundle; the task page and Template Studio share the same typed RuntimeClient.
 */
export function createAgentLoopControllers(): AgentLoopRendererControllers {
  const runtime = window.agentWorkspace?.runtime
    ? createDesktopRuntimeClient(window.agentWorkspace.runtime)
    : createBrowserRuntimeClient();

  const ownerId = rendererOwnerId();
  return Object.freeze({
    task: createAgentLoopRuntimeController({ client: runtime }),
    configuration: createAgentLoopConfigurationController({ client: runtime, ownerId }),
    templateStudio: createAgentLoopTemplateStudioController({
      client: runtime,
      ownerId,
    }),
  });
}

/**
 * Browser pages receive this value only from an already-authenticated Host page
 * bootstrap. It is a short-lived Runtime Bridge credential, never a Provider
 * credential, and must not be put in a checked-in HTML file or build-time env.
 */
export function createBrowserRuntimeClient(): RuntimeClient {
  const token = metaContent("agent-workspace-runtime-bridge-token");
  if (!token) return unavailableRuntimeClient("browser_runtime_bridge_token_missing");
  if (/^Bearer\s/i.test(token)) return unavailableRuntimeClient("browser_runtime_bridge_token_must_be_raw");
  return createHttpRuntimeClient({
    baseUrl: metaContent("agent-workspace-runtime-origin") ?? window.location.origin,
    authorization: token,
  });
}

function metaContent(name: string): string | undefined {
  const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim();
  return value || undefined;
}

/** Renderer identity is a display/ownership selector, never a Provider credential. */
function rendererOwnerId(): string {
  const candidate = metaContent("agent-workspace-runtime-owner-id") ?? "local-user";
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(candidate) ? candidate : "local-user";
}

function unavailableRuntimeClient(reason: string): RuntimeClient {
  const unavailable = async (): Promise<never> => {
    throw new Error(reason);
  };
  return createRuntimeClient({
    read: unavailable,
    command: unavailable,
    subscribe: unavailable,
  });
}
