import type {
  NativeAgentLoopArtifact,
  NativeCreatedAgentLoopProjectDirectory,
  NativeAgentLoopRunDetail,
  NativeAgentLoopTask,
  NativeAgentLoopTemplate,
  NativeAgentLoopWorkbenchLayout,
  NativeGeneratedAgentLoopTemplateDraft,
  NativeRuntimeBridge,
  NativeRuntimeStatus,
  NativeTerminalAttachResult,
  NativeTerminalClientEvent,
  NativeTerminalDiagnosticLog,
  NativeTerminalInputResult,
  NativePtySession,
  NativeAgentLoopRuntimeEvent,
  NativeTemplateDesignDraft,
  NativeTemplateDesignSaveResult,
  NativeTemplateDesignEvent,
  NativeTemplateDesignSession,
  NativeTemplateDesignSessionSummary,
  NativeOpenCodeSessionPage,
  NativeOpencodeInput,
  NativeOpencodeModelCapabilityListInput,
  NativeOpencodeModelCapabilityListResult,
  NativeOpencodeResult,
} from "./nativeBridge";

const runtimeBasePath = "/runtime/v1";

type RuntimeEvent = { channel: string; payload: unknown };
type RuntimeEventSource = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};
type FetchLike = typeof fetch;

/**
 * Installs the browser side of the local-development Runtime bridge. The
 * Vite proxy adds the ephemeral Host credential; browser JavaScript never
 * receives it. Electron's preload bridge always takes precedence.
 */
export async function installWebRuntimeBridge({
  fetchImpl = fetch,
  eventSourceFactory = (url: string) => new EventSource(url),
}: {
  fetchImpl?: FetchLike;
  eventSourceFactory?: (url: string) => RuntimeEventSource;
} = {}): Promise<boolean> {
  if (typeof window === "undefined" || window.agentWorkspace?.native) return Boolean(window?.agentWorkspace?.native);
  const clientId = browserClientId();
  const request = createRequest(fetchImpl, clientId);
  try {
    const status = await request<NativeRuntimeStatus>("status");
    if (!status.available || window.agentWorkspace?.native) return false;
  } catch {
    return false;
  }
  window.agentWorkspace = { native: createWebNativeRuntimeBridge({ request, clientId, eventSourceFactory }) };
  return true;
}

function createWebNativeRuntimeBridge({
  request,
  clientId,
  eventSourceFactory,
}: {
  request: <T>(method: string, input?: unknown) => Promise<T>;
  clientId: string;
  eventSourceFactory: (url: string) => RuntimeEventSource;
}): NativeRuntimeBridge {
  const events = createEventSubscriptions(clientId, eventSourceFactory);
  return {
    getRuntimeStatus: async () => ({ ...(await request<NativeRuntimeStatus>("status")), mode: "browser" }),
    runOpencode: (input: NativeOpencodeInput) => request<NativeOpencodeResult>("runOpencode", input),
    listOpencodeModelCapabilities: (input: NativeOpencodeModelCapabilityListInput = {}) =>
      request<NativeOpencodeModelCapabilityListResult>("listOpencodeModelCapabilities", input),
    readWorkspaceTerminalLog: (input) => request<NativeTerminalDiagnosticLog | undefined>("readWorkspaceTerminalLog", input),
    attachTerminalClient: (input) => request<NativeTerminalAttachResult | undefined>("attachTerminalClient", input),
    acknowledgeTerminalOutput: (input) => request<{ accepted: boolean; reason?: string }>("acknowledgeTerminalOutput", input),
    detachTerminalClient: (input) => request<boolean>("detachTerminalClient", input),
    enqueueTerminalInput: (input) => request<NativeTerminalInputResult>("enqueueTerminalInput", input),
    resizeWorkspaceSession: (input) => request<NativePtySession | undefined>("resizeWorkspaceSession", input),
    stopWorkspaceSession: (input) => request<NativePtySession | undefined>("stopWorkspaceSession", input),
    onTerminalClientEvent: (callback) => events.subscribe<NativeTerminalClientEvent>("terminal-client", callback),
    onAgentLoopRuntimeEvent: (callback) => events.subscribe<NativeAgentLoopRuntimeEvent>("agent-loop-runtime", callback),
    onAgentLoopTemplateDesignEvent: (callback) => events.subscribe<NativeTemplateDesignEvent>("agent-loop-template-design", callback),
    appendTaskEvent: (input) => request("appendTaskEvent", input),
    sendAgentLoopTaskMessage: (input) => request("sendAgentLoopTaskMessage", input),
    listAgentLoopTemplates: () => request<NativeAgentLoopTemplate[]>("listAgentLoopTemplates"),
    listAgentLoopTemplateVersions: (input) => request<NativeAgentLoopTemplate[]>("listAgentLoopTemplateVersions", input),
    generateAgentLoopTemplate: (input) => request<NativeGeneratedAgentLoopTemplateDraft>("generateAgentLoopTemplate", input),
    saveAgentLoopTemplate: (input) => request<NativeAgentLoopTemplate>("saveAgentLoopTemplate", input),
    copyAgentLoopTemplate: (input) => request<NativeAgentLoopTemplate>("copyAgentLoopTemplate", input),
    archiveAgentLoopTemplate: (input) => request<NativeAgentLoopTemplate>("archiveAgentLoopTemplate", input),
    deleteAgentLoopTemplate: (input) => request<{ deleted: boolean; templateId: string }>("deleteAgentLoopTemplate", input),
    getOrCreateAgentLoopTemplateDesignSession: (input) => request<NativeTemplateDesignSession>("getOrCreateAgentLoopTemplateDesignSession", input),
    listActiveAgentLoopTemplateDesignSessions: (input) => request<NativeTemplateDesignSessionSummary[]>("listActiveAgentLoopTemplateDesignSessions", input),
    readAgentLoopTemplateDesignSession: (input) => request<NativeTemplateDesignDraft | undefined>("readAgentLoopTemplateDesignSession", input),
    saveAgentLoopTemplateDesignDraft: (input) => request<NativeTemplateDesignSaveResult>("saveAgentLoopTemplateDesignDraft", input),
    discardAgentLoopTemplateDesignDraft: (input) => request<NativeTemplateDesignDraft>("discardAgentLoopTemplateDesignDraft", input),
    openAgentLoopTemplateDesignSessionPage: (input) => request<NativeOpenCodeSessionPage | undefined>("openAgentLoopTemplateDesignSessionPage", input),
    releaseAgentLoopTemplateDesignSessionPage: (input) => request<boolean>("releaseAgentLoopTemplateDesignSessionPage", input),
    validateAgentLoopProjectDirectory: (input) => request<{ path: string; name: string } | undefined>("validateAgentLoopProjectDirectory", input),
    suggestAgentLoopProjectDirectories: (input) => request<string[]>("suggestAgentLoopProjectDirectories", input),
    createAgentLoopProjectDirectory: (input) => request<NativeCreatedAgentLoopProjectDirectory>("createAgentLoopProjectDirectory", input),
    createAgentLoopTask: (input) => request<NativeAgentLoopTask>("createAgentLoopTask", input),
    listAgentLoopTasks: (input) => request<NativeAgentLoopTask[]>("listAgentLoopTasks", input),
    readAgentLoopTask: (input) => request<NativeAgentLoopTask | undefined>("readAgentLoopTask", input),
    startAgentLoopRun: (input) => request<NativeAgentLoopRunDetail>("startAgentLoopRun", input),
    readAgentLoopRun: (input) => request<NativeAgentLoopRunDetail | undefined>("readAgentLoopRun", input),
    openAgentLoopOpenCodeSessionPage: (input) => request("openAgentLoopOpenCodeSessionPage", input),
    releaseAgentLoopOpenCodeSessionPage: (input) => request<boolean>("releaseAgentLoopOpenCodeSessionPage", input),
    readAgentLoopWorkbenchLayout: (input) => request<NativeAgentLoopWorkbenchLayout | undefined>("readAgentLoopWorkbenchLayout", input),
    saveAgentLoopWorkbenchLayout: (input) => request<NativeAgentLoopWorkbenchLayout | undefined>("saveAgentLoopWorkbenchLayout", input),
    readAgentLoopArtifact: (input) => request<NativeAgentLoopArtifact>("readAgentLoopArtifact", input),
    markAgentLoopTaskAchieved: (input) => request<NativeAgentLoopTask | undefined>("markAgentLoopTaskAchieved", input),
    resumeAchievedAgentLoopTask: (input) => request<NativeAgentLoopRunDetail>("resumeAchievedAgentLoopTask", input),
    stopAgentLoopTask: (input) => request<NativeAgentLoopTask | undefined>("stopAgentLoopTask", input),
    respondAgentLoopPermission: (input) => request("respondAgentLoopPermission", input),
    respondAgentLoopQuestion: (input) => request("respondAgentLoopQuestion", input),
    moveAgentLoopTaskToRecycleBin: (input) => request("moveAgentLoopTaskToRecycleBin", input),
    restoreAgentLoopTaskFromRecycleBin: (input) => request("restoreAgentLoopTaskFromRecycleBin", input),
    previewAgentLoopTaskPermanentDeletion: (input) => request("previewAgentLoopTaskPermanentDeletion", input),
    permanentlyDeleteAgentLoopTask: (input) => request("permanentlyDeleteAgentLoopTask", input),
    deleteAgentLoopTask: (input) => request("deleteAgentLoopTask", input),
  };
}

function createRequest(fetchImpl: FetchLike, clientId: string) {
  return async function request<T>(method: string, input?: unknown): Promise<T> {
    const status = method === "status";
    const response = await fetchImpl(status ? `${runtimeBasePath}/status` : `${runtimeBasePath}/call`, {
      method: status ? "GET" : "POST",
      headers: status ? undefined : { "content-type": "application/json", "x-agent-workspace-client": clientId },
      ...(status ? {} : { body: JSON.stringify({ method, input }) }),
    });
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body?.error || `runtime_bridge_unavailable:${Number(response.status) || 0}`);
    }
    const body = await readSuccessBody<T>(response);
    if (!body) throw new Error("runtime_bridge_response_invalid");
    return body.result as T;
  };
}

async function readErrorBody(response: Response): Promise<{ error?: string } | undefined> {
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLocaleLowerCase();
  if (!contentType.includes("application/json")) return undefined;
  try {
    return await response.json() as { error?: string };
  } catch {
    return undefined;
  }
}

async function readSuccessBody<T>(response: Response): Promise<{ result?: T; error?: string } | undefined> {
  try {
    return await response.json() as { result?: T; error?: string };
  } catch {
    return undefined;
  }
}

function createEventSubscriptions(clientId: string, eventSourceFactory: (url: string) => RuntimeEventSource) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let source: RuntimeEventSource | undefined;

  function subscribe<T>(channel: string, listener: (event: T) => void) {
    if (!source) {
      source = eventSourceFactory(`${runtimeBasePath}/events?clientId=${encodeURIComponent(clientId)}`);
      source.addEventListener("runtime", (event) => {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as RuntimeEvent;
        for (const callback of listeners.get(parsed.channel) ?? []) callback(parsed.payload);
      });
    }
    const bucket = listeners.get(channel) ?? new Set();
    bucket.add(listener as (payload: unknown) => void);
    listeners.set(channel, bucket);
    return () => {
      bucket.delete(listener as (payload: unknown) => void);
      if (bucket.size || [...listeners.values()].some((candidate) => candidate.size)) return;
      source?.close();
      source = undefined;
    };
  }

  return { subscribe };
}

function browserClientId() {
  const key = "agent-workspace.browser-runtime-client-id";
  const existing = window.sessionStorage.getItem(key);
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const generated = `browser_${globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? Math.random().toString(36).slice(2).padEnd(24, "0")}`;
  window.sessionStorage.setItem(key, generated);
  return generated;
}
