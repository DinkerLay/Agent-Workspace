import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CodexAppServerConnectionInput } from "@agent-workspace/provider-codex";
import type { ProtocolPin } from "@agent-workspace/provider-port";
import {
  CodexAppServerBridgeError,
  createCodexAppServerConnectionFactory,
  createCodexAppServerProtocolProbe,
  createCodexAppServerProtocolPin,
  type CodexAppServerChild,
  type CodexAppServerProtocolCommand,
  type CodexAppServerProtocolProbe,
  type CodexAppServerProtocolProbeInput,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
} from "./codex-app-server-bridge.js";

const PROTOCOL: ProtocolPin = Object.freeze({
  providerVersion: "0.146.0",
  protocolFingerprint: `sha256:${"a".repeat(64)}`,
});
const PROTOCOL_DIRECTORY = "/trusted/protocols";

describe("Codex App Server bridge", () => {
  it("uses an explicit shell-free child, correlates split JSON-RPC frames, and closes idempotently", async () => {
    const spawner = new FakeSpawner();
    const protocolProbe = new FixedProtocolProbe();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home", PATH: "/trusted/bin" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe,
    });

    await expect(factory.inspectProtocol()).resolves.toEqual(PROTOCOL);
    expect(protocolProbe.inputs).toEqual([expect.objectContaining({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      protocolDirectory: PROTOCOL_DIRECTORY,
      expectedProtocol: PROTOCOL,
    })]);
    const connection = await factory.create(connectionInput());
    expect(protocolProbe.inputs).toHaveLength(2);
    expect(spawner.calls).toHaveLength(3);
    expect(spawner.calls[2]).toEqual({
      command: "/trusted/bin/codex",
      args: ["app-server", "--stdio"],
      options: {
        cwd: "/trusted/workspace",
        env: { CODEX_HOME: "/private/codex-home", PATH: "/trusted/bin" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    });

    const child = spawner.children[2]!;
    const pendingRead = connection.request("thread/read", { threadId: "thread_1" });
    const readRequest = await eventually(() => child.messages.find((message) => message.method === "thread/read"));
    child.emitSplitJson({ id: readRequest.id, result: { thread: { id: "thread_1" } } });
    await expect(pendingRead).resolves.toEqual({ thread: { id: "thread_1" } });

    const iterator = connection.events()[Symbol.asyncIterator]();
    child.emitJson({ jsonrpc: "2.0", id: "server_request_1", method: "item/fileChange/requestApproval", params: { threadId: "thread_1" } });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: "server_request",
        id: "server_request_1",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread_1" },
      },
    });
    await connection.respond("server_request_1", { decision: "decline" });
    expect(child.messages).toContainEqual({ jsonrpc: "2.0", id: "server_request_1", result: { decision: "decline" } });

    await Promise.all([connection.close(), connection.close()]);
    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(connection.request("thread/read", { threadId: "thread_1" })).rejects.toMatchObject({
      code: "codex_app_server_connection_closed",
    });
  });

  it("exposes only a numeric JSON-RPC error class and never the server diagnostic", async () => {
    const spawner = new FakeSpawner();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe: new FixedProtocolProbe(),
    });
    const connection = await factory.create(connectionInput());
    const child = spawner.children[1]!;
    const pendingRead = connection.request("thread/read", { threadId: "thread_1" });
    const readRequest = await eventually(() => child.messages.find((message) => message.method === "thread/read"));
    child.emitJson({
      id: readRequest.id,
      error: { code: -32602, message: "this raw diagnostic must not escape the bridge" },
    });
    await expect(pendingRead).rejects.toMatchObject({ code: "codex_app_server_rpc_-32602" });
    await connection.close();
  });

  it("classifies a small allowlist of parameter categories without retaining a server message", async () => {
    const spawner = new FakeSpawner();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe: new FixedProtocolProbe(),
    });
    const connection = await factory.create(connectionInput());
    const child = spawner.children[1]!;
    const pendingTurn = connection.request("turn/start", {});
    const turnRequest = await eventually(() => child.messages.find((message) => message.method === "turn/start"));
    child.emitJson({ id: turnRequest.id, error: { code: -32600, message: "invalid clientUserMessageId: private detail" } });
    await expect(pendingTurn).rejects.toMatchObject({ code: "codex_app_server_rpc_-32600_client_user_message_id" });
    await connection.close();
  });

  it("fails closed for malformed Host config and a protocol seam that does not match the pin", async () => {
    expect(() => createCodexAppServerConnectionFactory({
      command: "codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
    })).toThrow(CodexAppServerBridgeError);

    expect(() => createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home", INHERITED_GLOBAL: "must-not-pass" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
    })).toThrow(/codex_app_server_environment_invalid/);

    const spawner = new FakeSpawner();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe: new FixedProtocolProbe({
        providerVersion: "0.145.0",
        protocolFingerprint: PROTOCOL.protocolFingerprint,
      }),
    });
    await expect(factory.inspectProtocol()).rejects.toMatchObject({ code: "codex_app_server_protocol_pin_mismatch" });
    expect(spawner.children).toHaveLength(0);
  });

  it("does not allow a direct connection create to bypass the version/schema probe", async () => {
    const spawner = new FakeSpawner();
    const protocolProbe = new FixedProtocolProbe();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe,
    });
    const connection = await factory.create(connectionInput());
    expect(protocolProbe.inputs).toHaveLength(1);
    expect(spawner.calls).toHaveLength(2);
    await connection.close();
  });

  it("re-observes a settled protocol pin before binding creation and rejects changed evidence before a native binding effect", async () => {
    const spawner = new FakeSpawner();
    const protocolProbe = new FixedProtocolProbe();
    const factory = createCodexAppServerConnectionFactory({
      command: "/trusted/bin/codex",
      cwd: "/trusted/probe",
      environment: { CODEX_HOME: "/private/codex-home" },
      protocolDirectory: PROTOCOL_DIRECTORY,
      protocol: PROTOCOL,
      spawn: spawner.spawn,
      protocolProbe,
    });
    await expect(factory.inspectProtocol()).resolves.toEqual(PROTOCOL);
    protocolProbe.observed = { ...PROTOCOL, providerVersion: "0.147.0" };

    await expect(factory.create(connectionInput())).rejects.toMatchObject({
      code: "codex_app_server_protocol_pin_mismatch",
    });

    expect(protocolProbe.inputs).toHaveLength(2);
    expect(spawner.calls.filter((call) => call.options.cwd === "/trusted/workspace")).toEqual([]);
  });

  it("pins the generated schema bundle deterministically and rejects traversal paths", () => {
    const first = createCodexAppServerProtocolPin({
      providerVersion: "0.146.0",
      schemaFiles: { "b.json": "{\"value\":2}", "a.json": "{\"value\":1}" },
    });
    const second = createCodexAppServerProtocolPin({
      providerVersion: "0.146.0",
      schemaFiles: { "a.json": "{\"value\":1}", "b.json": "{\"value\":2}" },
    });
    expect(first).toEqual(second);
    expect(first.protocolFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const semanticFirst = createCodexAppServerProtocolPin({
      providerVersion: "0.146.0",
      schemaFiles: { "schema.json": "{\"definitions\":{\"z\":{\"type\":\"string\"},\"a\":{\"type\":\"number\"}}}" },
    });
    const semanticSecond = createCodexAppServerProtocolPin({
      providerVersion: "0.146.0",
      schemaFiles: { "schema.json": "{\"definitions\":{\"a\":{\"type\":\"number\"},\"z\":{\"type\":\"string\"}}}" },
    });
    expect(semanticFirst).toEqual(semanticSecond);
    expect(() => createCodexAppServerProtocolPin({
      providerVersion: "0.146.0",
      schemaFiles: { "../escape.json": "{\"value\":false}" },
    })).toThrow(/codex_app_server_schema_path_invalid/);
  });

  it("runs the real version/schema verification flow through an injectable command seam and removes only its generated child", async () => {
    const protocolDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-codex-schema-probe-"));
    const schemaFiles = { "nested/protocol.json": "{\"type\":\"object\"}", "root.json": "{\"type\":\"string\"}" };
    const expectedProtocol = createCodexAppServerProtocolPin({ providerVersion: "0.146.0", schemaFiles });
    const commands: CodexAppServerProtocolCommand[] = [];
    const probe = createCodexAppServerProtocolProbe({
      runCommand: async (command) => {
        commands.push(command);
        if (command.args[0] === "--version") return { stdout: "codex-cli 0.146.0\n" };
        expect(command.args).toEqual(["app-server", "generate-json-schema", "--out", expect.any(String)]);
        const outputDirectory = command.args[3]!;
        await mkdir(path.join(outputDirectory, "nested"), { recursive: true });
        await writeFile(path.join(outputDirectory, "nested", "protocol.json"), schemaFiles["nested/protocol.json"]!);
        await writeFile(path.join(outputDirectory, "root.json"), schemaFiles["root.json"]!);
        return { stdout: "" };
      },
    });
    try {
      await expect(probe.inspect(protocolProbeInput(protocolDirectory, expectedProtocol))).resolves.toEqual(expectedProtocol);
      expect(commands).toEqual([
        expect.objectContaining({ command: "/trusted/bin/codex", args: ["--version"], environment: { CODEX_HOME: "/private/codex-home" } }),
        expect.objectContaining({ command: "/trusted/bin/codex", args: ["app-server", "generate-json-schema", "--out", expect.any(String)], environment: { CODEX_HOME: "/private/codex-home" } }),
      ]);
      expect(await readdir(protocolDirectory)).toEqual([]);
    } finally {
      await rm(protocolDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a mismatched CLI version before schema generation and rejects a mismatched generated schema pin", async () => {
    const protocolDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-codex-schema-probe-"));
    try {
      const versionMismatch = createCodexAppServerProtocolProbe({
        runCommand: async () => ({ stdout: "codex-cli 0.145.0\n" }),
      });
      await expect(versionMismatch.inspect(protocolProbeInput(protocolDirectory, PROTOCOL))).rejects.toMatchObject({
        code: "codex_app_server_version_mismatch",
      });

      const schemaMismatch = createCodexAppServerProtocolProbe({
        runCommand: async (command) => {
          if (command.args[0] === "--version") return { stdout: "codex-cli 0.146.0\n" };
          const outputDirectory = command.args[3]!;
          await writeFile(path.join(outputDirectory, "unexpected.json"), "{\"type\":\"boolean\"}");
          return { stdout: "" };
        },
      });
      await expect(schemaMismatch.inspect(protocolProbeInput(protocolDirectory, PROTOCOL))).rejects.toMatchObject({
        code: "codex_app_server_schema_fingerprint_mismatch",
      });
      expect(await readdir(protocolDirectory)).toEqual([]);
    } finally {
      await rm(protocolDirectory, { force: true, recursive: true });
    }
  });
});

class FakeSpawner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly options: CodexAppServerSpawnOptions }> = [];
  readonly children: FakeCodexAppServerChild[] = [];

  constructor(private readonly version = "0.146.0") {}

  readonly spawn: CodexAppServerSpawn = (command, args, options) => {
    const child = new FakeCodexAppServerChild(this.version);
    this.calls.push({ command, args, options });
    this.children.push(child);
    return child as unknown as CodexAppServerChild;
  };
}

class FixedProtocolProbe implements CodexAppServerProtocolProbe {
  readonly inputs: CodexAppServerProtocolProbeInput[] = [];

  constructor(public observed: ProtocolPin = PROTOCOL) {}

  async inspect(input: CodexAppServerProtocolProbeInput): Promise<ProtocolPin> {
    this.inputs.push(input);
    return this.observed;
  }
}

class FakeCodexAppServerChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly kills: NodeJS.Signals[] = [];
  #buffer = "";

  constructor(private readonly version: string) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => this.#onInput(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
  }

  emitJson(value: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  emitSplitJson(value: Record<string, unknown>): void {
    const line = `${JSON.stringify(value)}\n`;
    const splitAt = Math.max(1, Math.floor(line.length / 2));
    this.stdout.write(line.slice(0, splitAt));
    this.stdout.write(line.slice(splitAt));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }

  #onInput(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      this.messages.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => this.emitJson({
          id: message.id,
          result: {
            userAgent: `agent-workspace/${this.version} (Mac OS; arm64)`,
            codexHome: "/private/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
          },
        }));
      }
    }
  }
}

function connectionInput(): CodexAppServerConnectionInput {
  return {
    bindingId: "binding_1",
    bindingRevision: 1,
    workspace: { workspaceId: "workspace_1", cwd: "/trusted/workspace" },
    executionProfile: {
      executionProfileId: "profile_1",
      provider: "codex",
      model: "gpt-5.1-codex",
      providerVersion: PROTOCOL.providerVersion,
      protocolFingerprint: PROTOCOL.protocolFingerprint,
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    protocol: PROTOCOL,
  };
}

function protocolProbeInput(protocolDirectory: string, expectedProtocol: ProtocolPin): CodexAppServerProtocolProbeInput {
  return {
    command: "/trusted/bin/codex",
    cwd: "/trusted/probe",
    environment: { CODEX_HOME: "/private/codex-home" },
    protocolDirectory,
    expectedProtocol,
    timeoutMs: 1_000,
  };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("eventually_timeout");
}
