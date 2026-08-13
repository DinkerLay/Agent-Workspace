import { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AcpV1ClientHandlers,
  AcpV1ConnectionFactory,
  InjectedAcpV1Connection,
} from "@agent-workspace/provider-acp";
import type { AcpStdioConnectionInput } from "./acp-agent-process.js";

export class AcpSdkStdioConnectionError extends Error {
  readonly code: string;
  readonly diagnosticCode?: string;

  constructor(code: string, diagnosticCode?: string) {
    super(code);
    this.name = "AcpSdkStdioConnectionError";
    this.code = code;
    if (diagnosticCode !== undefined && diagnosticCode !== code) {
      this.diagnosticCode = diagnosticCode;
    }
  }
}

/**
 * Adapts one Host-owned child stdio pair to the official stable ACP v1 SDK.
 * The returned factory is deliberately single-use because one process
 * generation owns exactly one ACP connection and one Host-private raw-ID map.
 */
export function createOfficialAcpV1StdioConnection(
  streams: AcpStdioConnectionInput,
): AcpV1ConnectionFactory {
  validateStreams(streams);
  let claimed = false;

  return (handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => {
    if (claimed) throw safeError("acp_stdio_connection_already_claimed");
    claimed = true;
    validateHandlers(handlers);

    const app = acp.client({ name: "agent-workspace-runtime-host" });
    const drainSessionUpdates = registerClientHandlers(app, handlers);
    const wire = acp.ndJsonStream(
      NodeWritable.toWeb(streams.input) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(streams.output) as ReadableStream<Uint8Array>,
    );
    const live = app.connect(wire);
    const closeForAbort = () => live.close(safeError("acp_stdio_process_aborted"));
    if (streams.signal.aborted) closeForAbort();
    else streams.signal.addEventListener("abort", closeForAbort, { once: true });
    void live.closed.then(
      () => streams.signal.removeEventListener("abort", closeForAbort),
      () => streams.signal.removeEventListener("abort", closeForAbort),
    );

    const request = (method: string, params: unknown): Promise<unknown> => (
      live.agent.request<unknown, unknown>(method, params)
    );
    const safeRequest = (
      operation: AcpRequestOperation,
      method: string,
      params: unknown,
    ): Promise<unknown> => request(method, params).catch((error: unknown) => {
      throw classifyRequestFailure(operation, error);
    });
    const notify = (method: string, params: unknown): Promise<void> => (
      live.agent.notify<unknown>(method, params)
    );

    return Object.freeze({
      initialize: (params: unknown) => safeRequest("initialize", acp.methods.agent.initialize, params),
      newSession: (params: unknown) => safeRequest("session_new", acp.methods.agent.session.new, params),
      loadSession: (params: unknown) => safeRequest("session_load", acp.methods.agent.session.load, params),
      resumeSession: (params: unknown) => safeRequest("session_resume", acp.methods.agent.session.resume, params),
      setSessionConfigOption: (params: unknown) => safeRequest(
        "session_config",
        acp.methods.agent.session.setConfigOption,
        params,
      ),
      setSessionMode: (params: unknown) => safeRequest(
        "session_mode",
        acp.methods.agent.session.setMode,
        params,
      ),
      prompt: async (params: unknown) => {
        let response: unknown;
        let requestFailure: unknown;
        try {
          response = await request(acp.methods.agent.session.prompt, params);
        } catch (error) {
          requestFailure = error;
        }
        // ACP notifications preceding the prompt response on the wire must be
        // observed before managed settlement chooses the latest Final. This
        // ordering also applies to an explicit JSON-RPC error response: an
        // earlier receipt/update must not be hidden by the request rejection.
        await drainSessionUpdates();
        if (requestFailure !== undefined) throw classifyRequestFailure("prompt", requestFailure);
        return response;
      },
      cancel: (params: unknown) => notify(acp.methods.agent.session.cancel, params),
      closeSession: (params: unknown) => safeRequest(
        "session_close",
        acp.methods.agent.session.close,
        params,
      ),
      closed: live.closed,
    });
  };
}

type AcpRequestOperation =
  | "initialize"
  | "session_new"
  | "session_load"
  | "session_resume"
  | "session_config"
  | "session_mode"
  | "prompt"
  | "session_close";

function classifyRequestFailure(
  operation: AcpRequestOperation,
  error: unknown,
): AcpSdkStdioConnectionError {
  if (!(error instanceof acp.RequestError)) {
    return safeError(`acp_stdio_${operation}_transport_failed`);
  }
  switch (error.code) {
    case -32000:
      return safeError(`acp_stdio_${operation}_auth_required`);
    case -32002:
      return safeError(`acp_stdio_${operation}_resource_not_found`);
    case -32601:
      return safeError(`acp_stdio_${operation}_method_not_found`);
    case -32602:
      return safeError(`acp_stdio_${operation}_invalid_params`);
    case -32603:
      return safeError(
        `acp_stdio_${operation}_internal_error`,
        classifyInternalDiagnostic(operation, error),
      );
    case -32800:
      return safeError(`acp_stdio_${operation}_cancelled`);
    default:
      return safeError(`acp_stdio_${operation}_request_rejected`);
  }
}

function classifyInternalDiagnostic(
  operation: AcpRequestOperation,
  error: acp.RequestError,
): string | undefined {
  const text = boundedDiagnosticText(error.data);
  const prefix = `acp_stdio_${operation}_`;
  if (/(?:providermodelnotfounderror|model[_\s-]*(?:not[_\s-]*found|unavailable|unsupported|unknown)|(?:not[_\s-]*found|unavailable|unknown)[_\s-]*model)/iu.test(text)) {
    return `${prefix}model_unavailable`;
  }
  if (/(?:unauthori[sz]ed|forbidden|authentication|credential|api[_\s-]*key|status[_\s-]*40[13])/iu.test(text)) {
    return `${prefix}authentication_failed`;
  }
  if (/(?:insufficient[_\s-]*(?:quota|credit|balance)|(?:quota|credit|balance)[_\s-]*(?:exceeded|exhausted)|billing)/iu.test(text)) {
    return `${prefix}quota_unavailable`;
  }
  if (/(?:rate[_\s-]*limit|too[_\s-]*many[_\s-]*requests|status[_\s-]*429)/iu.test(text)) {
    return `${prefix}rate_limited`;
  }
  if (/(?:timed?[_\s-]*out|timeout)/iu.test(text)) return `${prefix}timeout`;
  if (/(?:econn|enotfound|network|fetch[_\s-]*failed|connection[_\s-]*refused)/iu.test(text)) {
    return `${prefix}network_failed`;
  }
  if (/(?:configuration|config)[_\s-]*(?:invalid|missing|unsupported)/iu.test(text)) {
    return `${prefix}configuration_invalid`;
  }
  return undefined;
}

function boundedDiagnosticText(value: unknown): string {
  const values: string[] = [];
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];
  while (pending.length > 0 && values.length < 32) {
    const entry = pending.shift()!;
    if (typeof entry.value === "string") {
      values.push(entry.value.slice(0, 512));
    } else if (typeof entry.value === "number" || typeof entry.value === "boolean") {
      values.push(String(entry.value));
    } else if (entry.depth < 3 && Array.isArray(entry.value)) {
      for (const child of entry.value.slice(0, 16)) pending.push({ value: child, depth: entry.depth + 1 });
    } else if (entry.depth < 3 && entry.value && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value as Record<string, unknown>).slice(0, 16)) {
        values.push(key.slice(0, 128));
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return values.join(" ");
}

function registerClientHandlers(
  app: acp.ClientApp,
  handlers: AcpV1ClientHandlers,
): () => Promise<void> {
  let updateTail: Promise<void> = Promise.resolve();
  let updateFailure: unknown;
  app.onNotification(acp.methods.client.session.update, ({ params }) => {
    const update = updateTail.then(() => handlers.sessionUpdate(params));
    updateTail = update.catch((error) => {
      updateFailure ??= error;
    });
    // The explicit prompt drain below owns ordering; do not block the SDK's
    // inbound reader on this handler or the following response cannot arrive.
  });
  app.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => (
    await handlers.requestPermission(params) as acp.RequestPermissionResponse
  ));

  const readTextFile = handlers.readTextFile;
  if (readTextFile) {
    app.onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => (
      await readTextFile(params) as acp.ReadTextFileResponse
    ));
  }
  const writeTextFile = handlers.writeTextFile;
  if (writeTextFile) {
    app.onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => (
      await writeTextFile(params) as acp.WriteTextFileResponse
    ));
  }
  const createTerminal = handlers.createTerminal;
  if (createTerminal) {
    app.onRequest(acp.methods.client.terminal.create, async ({ params }) => (
      await createTerminal(params) as acp.CreateTerminalResponse
    ));
  }
  const terminalOutput = handlers.terminalOutput;
  if (terminalOutput) {
    app.onRequest(acp.methods.client.terminal.output, async ({ params }) => (
      await terminalOutput(params) as acp.TerminalOutputResponse
    ));
  }
  const waitForTerminalExit = handlers.waitForTerminalExit;
  if (waitForTerminalExit) {
    app.onRequest(acp.methods.client.terminal.waitForExit, async ({ params }) => (
      await waitForTerminalExit(params) as acp.WaitForTerminalExitResponse
    ));
  }
  const killTerminal = handlers.killTerminal;
  if (killTerminal) {
    app.onRequest(acp.methods.client.terminal.kill, async ({ params }) => (
      await killTerminal(params) as acp.KillTerminalResponse
    ));
  }
  const releaseTerminal = handlers.releaseTerminal;
  if (releaseTerminal) {
    app.onRequest(acp.methods.client.terminal.release, async ({ params }) => (
      await releaseTerminal(params) as acp.ReleaseTerminalResponse
    ));
  }
  return async () => {
    await updateTail;
    if (updateFailure !== undefined) throw updateFailure;
  };
}

function validateStreams(streams: AcpStdioConnectionInput): void {
  if (!streams || typeof streams !== "object") throw safeError("acp_stdio_streams_invalid");
  if (!(streams.input instanceof NodeWritable) || !(streams.output instanceof NodeReadable)) {
    throw safeError("acp_stdio_streams_invalid");
  }
  if (!(streams.signal instanceof AbortSignal)) throw safeError("acp_stdio_signal_invalid");
}

function validateHandlers(handlers: AcpV1ClientHandlers): void {
  if (!handlers || typeof handlers !== "object") throw safeError("acp_stdio_handlers_invalid");
  if (typeof handlers.sessionUpdate !== "function" || typeof handlers.requestPermission !== "function") {
    throw safeError("acp_stdio_handlers_invalid");
  }
}

function safeError(code: string, diagnosticCode?: string): AcpSdkStdioConnectionError {
  return new AcpSdkStdioConnectionError(code, diagnosticCode);
}
