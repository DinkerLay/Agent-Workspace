import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  AcpV1ClientHandlers,
} from "@agent-workspace/provider-acp";
import { createOfficialAcpV1StdioConnection } from "./acp-sdk-stdio-connection.js";

class ControlledAgentPeer {
  readonly calls: Array<Readonly<{ method: string; params: unknown }>> = [];
  readonly #toHost: Writable;
  readonly #pending = new Map<number, (value: unknown) => void>();
  #nextId = 100;
  #buffer = "";

  constructor(
    fromHost: PassThrough,
    toHost: PassThrough,
    readonly requestError?: Readonly<{
      method: string;
      error: Readonly<{ code: number; message: string; data?: unknown }>;
    }>,
  ) {
    this.#toHost = toHost;
    fromHost.setEncoding("utf8");
    fromHost.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#drain();
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve) => this.#pending.set(id, resolve));
    this.#write({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #drain(): void {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.method === "string") {
        this.calls.push({ method: message.method, params: message.params });
        if (typeof message.id === "number") {
          this.#write(message.method === this.requestError?.method
            ? { jsonrpc: "2.0", id: message.id, error: this.requestError.error }
            : { jsonrpc: "2.0", id: message.id, result: resultFor(message.method) });
        }
        continue;
      }
      if (typeof message.id === "number") {
        const settle = this.#pending.get(message.id);
        if (settle) {
          this.#pending.delete(message.id);
          settle(Object.hasOwn(message, "error")
            ? { error: message.error }
            : message.result);
        }
      }
    }
  }

  #write(message: unknown): void {
    this.#toHost.write(`${JSON.stringify(message)}\n`);
  }
}

function resultFor(method: string): unknown {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
    case "session/new":
      return { sessionId: "raw-session-private" };
    case "session/set_config_option":
      return { configOptions: [] };
    case "session/prompt":
      return { stopReason: "end_turn" };
    default:
      return {};
  }
}

function openHarness(options: Readonly<{
  readonly omitFileAndTerminalHandlers?: boolean;
  readonly requestError?: Readonly<{
    method: string;
    error: Readonly<{ code: number; message: string; data?: unknown }>;
  }>;
}> = {}) {
  const hostToAgent = new PassThrough();
  const agentToHost = new PassThrough();
  const abort = new AbortController();
  const observed: Array<Readonly<{ method: string; params: unknown }>> = [];
  const handlers: AcpV1ClientHandlers = {
    sessionUpdate: async (params) => { observed.push({ method: "session/update", params }); },
    requestPermission: async (params) => {
      observed.push({ method: "session/request_permission", params });
      return { outcome: { outcome: "selected", optionId: "raw-option-private" } };
    },
    ...(options.omitFileAndTerminalHandlers ? {} : {
      readTextFile: async (params: unknown) => {
        observed.push({ method: "fs/read_text_file", params });
        return { content: "bounded" };
      },
      writeTextFile: async (params: unknown) => {
        observed.push({ method: "fs/write_text_file", params });
        return {};
      },
      createTerminal: async (params: unknown) => {
        observed.push({ method: "terminal/create", params });
        return { terminalId: "raw-terminal-private" };
      },
      terminalOutput: async (params: unknown) => {
        observed.push({ method: "terminal/output", params });
        return { output: "ok", truncated: false };
      },
      waitForTerminalExit: async (params: unknown) => {
        observed.push({ method: "terminal/wait_for_exit", params });
        return { exitCode: 0 };
      },
      killTerminal: async (params: unknown) => {
        observed.push({ method: "terminal/kill", params });
        return {};
      },
      releaseTerminal: async (params: unknown) => {
        observed.push({ method: "terminal/release", params });
        return {};
      },
    }),
  };
  const connect = createOfficialAcpV1StdioConnection({
    input: hostToAgent,
    output: agentToHost,
    signal: abort.signal,
  });
  const connection = connect(handlers);
  return {
    abort,
    agentToHost,
    connection,
    connect,
    handlers,
    hostToAgent,
    observed,
    peer: new ControlledAgentPeer(hostToAgent, agentToHost, options.requestError),
  };
}

describe("official ACP v1 stdio connection", () => {
  it("classifies a prompt JSON-RPC rejection without exposing Agent message or data", async () => {
    const harness = openHarness({
      requestError: {
        method: "session/prompt",
        error: {
          code: -32000,
          message: "Authentication failed for /private/agent-secret",
          data: { rawSessionId: "raw-session-private" },
        },
      },
    });
    const failure = await harness.connection.prompt({
      sessionId: "raw-session-private",
      prompt: [{ type: "text", text: "hello" }],
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: "acp_stdio_prompt_auth_required" });
    expect(JSON.stringify(failure)).not.toContain("/private/agent-secret");
    expect(JSON.stringify(failure)).not.toContain("raw-session-private");
  });

  it("derives only a bounded safe category from internal prompt diagnostics", async () => {
    const harness = openHarness({
      requestError: {
        method: "session/prompt",
        error: {
          code: -32603,
          message: "Internal error",
          data: {
            details: "ProviderModelNotFoundError for /private/agent-secret",
            rawSessionId: "raw-session-private",
          },
        },
      },
    });
    const failure = await harness.connection.prompt({
      sessionId: "raw-session-private",
      prompt: [{ type: "text", text: "hello" }],
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({
      code: "acp_stdio_prompt_internal_error",
      diagnosticCode: "acp_stdio_prompt_model_unavailable",
    });
    expect(JSON.stringify(failure)).not.toContain("/private/agent-secret");
    expect(JSON.stringify(failure)).not.toContain("raw-session-private");
  });

  it("classifies a Binding request rejection independently from prompt settlement", async () => {
    const harness = openHarness({
      requestError: {
        method: "session/new",
        error: {
          code: -32002,
          message: "Resource missing at /private/agent-secret",
          data: { rawSessionId: "raw-session-private" },
        },
      },
    });
    const failure = await harness.connection.newSession({
      cwd: "/private/workspace",
      mcpServers: [],
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: "acp_stdio_session_new_resource_not_found" });
    expect(JSON.stringify(failure)).not.toContain("/private/agent-secret");
    expect(JSON.stringify(failure)).not.toContain("raw-session-private");
  });

  it("maps the complete managed Agent method set over NDJSON without a Provider branch", async () => {
    const { connection, peer } = openHarness();
    await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await connection.newSession({ cwd: "/private/workspace", mcpServers: [] });
    await connection.loadSession?.({
      sessionId: "raw-session-private",
      cwd: "/private/workspace",
      mcpServers: [],
    });
    await connection.resumeSession?.({
      sessionId: "raw-session-private",
      cwd: "/private/workspace",
      mcpServers: [],
    });
    await connection.setSessionConfigOption?.({
      sessionId: "raw-session-private",
      configId: "model",
      value: "provider/model",
    });
    await connection.setSessionMode?.({ sessionId: "raw-session-private", modeId: "code" });
    await connection.prompt({
      sessionId: "raw-session-private",
      prompt: [{ type: "text", text: "hello" }],
    });
    await connection.cancel({ sessionId: "raw-session-private" });
    await connection.closeSession?.({ sessionId: "raw-session-private" });

    expect(peer.calls.map((call) => call.method)).toEqual([
      "initialize",
      "session/new",
      "session/load",
      "session/resume",
      "session/set_config_option",
      "session/set_mode",
      "session/prompt",
      "session/cancel",
      "session/close",
    ]);
  });

  it("maps every negotiated reverse RPC to the injected Host broker", async () => {
    const { observed, peer } = openHarness();
    peer.notify("session/update", {
      sessionId: "raw-session-private",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
    });
    const permission = await peer.request("session/request_permission", {
      sessionId: "raw-session-private",
      toolCall: { toolCallId: "raw-tool-private", title: "Write" },
      options: [{ optionId: "raw-option-private", name: "Allow", kind: "allow_once" }],
    });
    await peer.request("fs/read_text_file", {
      sessionId: "raw-session-private",
      path: "/private/workspace/read.txt",
    });
    await peer.request("fs/write_text_file", {
      sessionId: "raw-session-private",
      path: "/private/workspace/write.txt",
      content: "bounded",
    });
    const terminal = await peer.request("terminal/create", {
      sessionId: "raw-session-private",
      command: "printf",
      args: ["ok"],
      cwd: "/private/workspace",
    });
    for (const method of [
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ]) {
      await peer.request(method, {
        sessionId: "raw-session-private",
        terminalId: "raw-terminal-private",
      });
    }

    await vi.waitFor(() => expect(observed).toHaveLength(9));
    expect(observed.map((entry) => entry.method)).toEqual([
      "session/update",
      "session/request_permission",
      "fs/read_text_file",
      "fs/write_text_file",
      "terminal/create",
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ]);
    expect(permission).toEqual({
      outcome: { outcome: "selected", optionId: "raw-option-private" },
    });
    expect(terminal).toEqual({ terminalId: "raw-terminal-private" });
  });

  it("is single-use and closes the SDK connection when the process generation aborts", async () => {
    const harness = openHarness();
    expect(() => harness.connect(harness.handlers)).toThrowError(
      expect.objectContaining({ code: "acp_stdio_connection_already_claimed" }),
    );
    harness.abort.abort();
    await expect(harness.connection.closed).resolves.toBeUndefined();
  });

  it("fails closed when an unadvertised reverse RPC has no Host broker handler", async () => {
    const harness = openHarness({ omitFileAndTerminalHandlers: true });
    await expect(harness.peer.request("fs/read_text_file", {
      sessionId: "raw-session-private",
      path: "/private/workspace/read.txt",
    })).resolves.toMatchObject({
      error: { code: -32601 },
    });
    expect(harness.observed).toEqual([]);
    harness.abort.abort();
    await expect(harness.connection.closed).resolves.toBeUndefined();
  });
});
