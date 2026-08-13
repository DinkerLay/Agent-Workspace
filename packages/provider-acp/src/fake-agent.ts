import type {
  AcpV1ClientHandlers,
  InjectedAcpV1Connection,
} from "./connection.js";
import { AcpBoundaryError } from "./errors.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export interface FakeAcpV1AgentOptions {
  readonly protocolVersion?: number;
  readonly rawSessionId?: string;
  readonly agentInfo?: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
  };
  readonly capabilities?: {
    readonly loadSession?: boolean;
    readonly resumeSession?: boolean;
    readonly closeSession?: boolean;
    readonly mcpHttp?: boolean;
    readonly mcpSse?: boolean;
  };
  readonly agentCapabilityExtensions?: Readonly<Record<string, unknown>>;
  readonly initializeMeta?: unknown;
  readonly configOptions?: readonly unknown[];
  readonly modes?: unknown;
  readonly staleConfigConfirmation?: boolean;
  readonly failLoad?: boolean;
  readonly failClose?: boolean;
}

export interface FakePromptRequest {
  readonly sessionId: string;
  readonly prompt: readonly unknown[];
}

export type FakePromptScript = (context: {
  readonly handlers: AcpV1ClientHandlers;
  readonly request: FakePromptRequest;
}) => Promise<unknown>;

export type FakeReverseRpcMethod =
  | "readTextFile"
  | "writeTextFile"
  | "createTerminal"
  | "terminalOutput"
  | "waitForTerminalExit"
  | "killTerminal"
  | "releaseTerminal";

/** Test-only injected ACP v1 Agent; never exported from the package main. */
export class FakeAcpV1Agent {
  readonly #options: Required<Pick<FakeAcpV1AgentOptions, "protocolVersion" | "rawSessionId">>
    & Omit<FakeAcpV1AgentOptions, "protocolVersion" | "rawSessionId">;
  readonly #promptScripts: FakePromptScript[] = [];
  readonly #promptWaiters: Array<() => void> = [];
  #handlers?: AcpV1ClientHandlers;
  #initialized = false;
  #promptCount = 0;
  #configOptions: unknown[];
  #modes: unknown;
  readonly initializeRequests: Record<string, unknown>[] = [];
  readonly setConfigRequests: Record<string, unknown>[] = [];
  readonly setModeRequests: Record<string, unknown>[] = [];
  readonly closeSessionRequests: Record<string, unknown>[] = [];

  constructor(options: FakeAcpV1AgentOptions = {}) {
    this.#options = {
      protocolVersion: options.protocolVersion ?? 1,
      rawSessionId: options.rawSessionId ?? "raw-fake-session",
      agentInfo: options.agentInfo,
      capabilities: options.capabilities,
      agentCapabilityExtensions: options.agentCapabilityExtensions,
      initializeMeta: options.initializeMeta,
      configOptions: options.configOptions,
      modes: options.modes,
      staleConfigConfirmation: options.staleConfigConfirmation,
      failLoad: options.failLoad,
      failClose: options.failClose,
    };
    this.#configOptions = cloneUnknown(options.configOptions ?? [defaultModelConfigOption()]) as unknown[];
    this.#modes = cloneUnknown(options.modes);
  }

  connect(handlers: AcpV1ClientHandlers): InjectedAcpV1Connection {
    if (this.#handlers) throw new AcpBoundaryError("fake_acp_agent_already_connected");
    this.#handlers = handlers;
    return {
      initialize: async (params) => {
        const request = assertRecord(params, "fake_acp_initialize_request_invalid");
        this.initializeRequests.push(cloneUnknown(request));
        this.#initialized = true;
        const capabilities = this.#options.capabilities ?? {};
        return {
          protocolVersion: this.#options.protocolVersion,
          agentCapabilities: {
            loadSession: capabilities.loadSession ?? true,
            sessionCapabilities: {
              ...((capabilities.resumeSession ?? true) ? { resume: {} } : {}),
              ...((capabilities.closeSession ?? true) ? { close: {} } : {}),
            },
            mcpCapabilities: {
              ...(capabilities.mcpHttp ? { http: true } : {}),
              ...(capabilities.mcpSse ? { sse: true } : {}),
            },
            ...cloneUnknown(this.#options.agentCapabilityExtensions ?? {}),
          },
          ...(this.#options.agentInfo ? { agentInfo: this.#options.agentInfo } : {}),
          ...(this.#options.initializeMeta === undefined
            ? {}
            : { _meta: cloneUnknown(this.#options.initializeMeta) }),
        };
      },
      newSession: async (params) => {
        this.#assertInitialized();
        const request = assertRecord(params, "fake_acp_new_session_request_invalid");
        if (typeof request.cwd !== "string" || !Array.isArray(request.mcpServers)) {
          throw new AcpBoundaryError("fake_acp_new_session_shape_invalid");
        }
        return {
          sessionId: this.#options.rawSessionId,
          ...this.#bindingConfigurationResponse(),
        };
      },
      loadSession: async (params) => {
        this.#assertSessionRequest(params);
        if (this.#options.failLoad) throw new AcpBoundaryError("fake_acp_load_failed");
        return this.#bindingConfigurationResponse();
      },
      resumeSession: async (params) => {
        this.#assertSessionRequest(params);
        return this.#bindingConfigurationResponse();
      },
      setSessionConfigOption: async (params) => {
        this.#assertSessionRequest(params);
        const request = assertRecord(params, "fake_acp_set_config_request_invalid");
        this.setConfigRequests.push(cloneUnknown(request));
        if (!this.#options.staleConfigConfirmation) {
          const matches = this.#configOptions.filter((entry) => (
            entry && typeof entry === "object" && !Array.isArray(entry)
            && (entry as Record<string, unknown>).id === request.configId
          ));
          if (matches.length !== 1) throw new AcpBoundaryError("fake_acp_config_not_found");
          (matches[0] as Record<string, unknown>).currentValue = request.value;
        }
        return { configOptions: cloneUnknown(this.#configOptions) };
      },
      setSessionMode: async (params) => {
        this.#assertSessionRequest(params);
        const request = assertRecord(params, "fake_acp_set_mode_request_invalid");
        this.setModeRequests.push(cloneUnknown(request));
        const modes = this.#modes && typeof this.#modes === "object" && !Array.isArray(this.#modes)
          ? this.#modes as Record<string, unknown>
          : undefined;
        if (modes) modes.currentModeId = request.modeId;
        return {};
      },
      prompt: async (params) => {
        this.#assertInitialized();
        const request = assertRecord(params, "fake_acp_prompt_request_invalid");
        if (typeof request.sessionId !== "string" || !Array.isArray(request.prompt)) {
          throw new AcpBoundaryError("fake_acp_prompt_shape_invalid");
        }
        this.#promptCount += 1;
        for (const waiter of this.#promptWaiters.splice(0)) waiter();
        const script = this.#promptScripts.shift();
        if (!script) return { stopReason: "end_turn" };
        return script({
          handlers,
          request: { sessionId: request.sessionId, prompt: request.prompt },
        });
      },
      cancel: async (params) => {
        this.#assertSessionRequest(params);
      },
      closeSession: async (params) => {
        this.#assertSessionRequest(params);
        const request = assertRecord(params, "fake_acp_close_session_request_invalid");
        this.closeSessionRequests.push(cloneUnknown(request));
        if (this.#options.failClose) throw new AcpBoundaryError("fake_acp_close_failed");
        return {};
      },
    };
  }

  queuePrompt(script: FakePromptScript): void {
    this.#promptScripts.push(script);
  }

  async waitForPromptCount(count: number): Promise<void> {
    while (this.#promptCount < count) {
      await new Promise<void>((resolve) => this.#promptWaiters.push(resolve));
    }
  }

  async invokeReverseRpc(method: FakeReverseRpcMethod, params: unknown): Promise<unknown> {
    const handler = this.#handlers?.[method];
    if (!handler) throw new AcpBoundaryError("fake_acp_reverse_rpc_unavailable");
    return handler(params);
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new AcpBoundaryError("fake_acp_not_initialized");
  }

  #assertSessionRequest(value: unknown): void {
    this.#assertInitialized();
    const request = assertRecord(value, "fake_acp_session_request_invalid");
    if (request.sessionId !== this.#options.rawSessionId) {
      throw new AcpBoundaryError("fake_acp_session_fence_mismatch");
    }
  }

  #bindingConfigurationResponse(): Record<string, unknown> {
    return {
      configOptions: cloneUnknown(this.#configOptions),
      ...(this.#modes === undefined ? {} : { modes: cloneUnknown(this.#modes) }),
    };
  }
}

function assertRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcpBoundaryError(code);
  }
  return value as Record<string, unknown>;
}

function defaultModelConfigOption(): Record<string, unknown> {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fake-model",
    options: [{ value: "fake-model", name: "Fake model" }],
  };
}

function cloneUnknown<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
