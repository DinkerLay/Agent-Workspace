import { EventEmitter } from "node:events";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_BINARY_SHA256_0_146,
  CODEX_META_LAUNCH_ARGUMENTS_0_146,
  CODEX_META_NO_TOOL_ATTESTATION_0_146,
  type CodexMetaAppServerConnectionInput,
} from "@agent-workspace/provider-codex";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerProtocolProbe,
  CodexAppServerProtocolProbeInput,
} from "./codex-app-server-bridge.js";
import {
  CodexMetaAppServerBridgeError,
  createCodexMetaAppServerConnectionFactory,
  type CodexMetaAppServerChild,
  type CodexMetaAppServerSpawn,
  type CodexMetaAppServerSpawnOptions,
  type CodexMetaBinaryInspector,
} from "./codex-meta-app-server-bridge.js";

describe("Host Codex 0.146 Meta App Server bridge", () => {
  it("pins hash/schema, initializes one exact no-tool child in an isolated Host directory, and cleans it", async () => {
    const runtimeDataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-meta-bridge-"));
    const binary = new FixedBinaryInspector();
    const protocol = new FixedProtocolProbe();
    const spawner = new FakeSpawner();
    const inheritedSecret = process.env.AGENT_WORKSPACE_META_TEST_SECRET;
    process.env.AGENT_WORKSPACE_META_TEST_SECRET = "must-not-leak";
    try {
      const factory = createCodexMetaAppServerConnectionFactory({
        command: "/private/verified/codex-0.146.0",
        runtimeDataDirectory,
        environment: { OPENAI_API_KEY: "host-explicit-key", LANG: "en_US.UTF-8" },
        binaryInspector: binary,
        protocolProbe: protocol,
        spawn: spawner.spawn,
        requestTimeoutMs: 1_000,
      });

      await expect(factory.inspectNoToolConfiguration()).resolves.toBe(CODEX_META_NO_TOOL_ATTESTATION_0_146);
      await expect(factory.inspectProtocol()).resolves.toBe(CODEX_META_APP_SERVER_PROTOCOL_0_146);
      const probe = protocol.inputs[0]!;
      expect(probe).toMatchObject({
        command: "/private/verified/codex-0.146.0",
        expectedProtocol: CODEX_META_APP_SERVER_PROTOCOL_0_146,
      });
      expect(probe.cwd).toMatch(new RegExp(`^${escapeRegExp(runtimeDataDirectory)}/meta-provider/codex/processes/codex-meta-`));
      expect(probe.environment).toEqual({
        OPENAI_API_KEY: "host-explicit-key",
        LANG: "en_US.UTF-8",
        CODEX_HOME: expect.stringMatching(new RegExp(`^${escapeRegExp(runtimeDataDirectory)}/`)),
        HOME: expect.stringMatching(new RegExp(`^${escapeRegExp(runtimeDataDirectory)}/`)),
        TMPDIR: expect.stringMatching(new RegExp(`^${escapeRegExp(runtimeDataDirectory)}/`)),
      });
      await expect(access(probe.cwd)).rejects.toBeDefined();

      const connection = await factory.create(connectionInput());
      expect(binary.commands).toEqual([
        "/private/verified/codex-0.146.0",
        "/private/verified/codex-0.146.0",
        "/private/verified/codex-0.146.0",
      ]);
      expect(spawner.calls).toHaveLength(1);
      const launch = spawner.calls[0]!;
      expect(launch.command).toBe("/private/verified/codex-0.146.0");
      expect(launch.args).toEqual(CODEX_META_LAUNCH_ARGUMENTS_0_146);
      expect(launch.options).toMatchObject({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(launch.options.cwd).toMatch(new RegExp(`^${escapeRegExp(runtimeDataDirectory)}/meta-provider/codex/processes/codex-meta-.+/cwd$`));
      expect(launch.options.env).toEqual({
        OPENAI_API_KEY: "host-explicit-key",
        LANG: "en_US.UTF-8",
        CODEX_HOME: path.dirname(launch.options.cwd) + "/codex-home",
        HOME: path.dirname(launch.options.cwd) + "/codex-home",
        TMPDIR: path.dirname(launch.options.cwd) + "/tmp",
      });
      expect(launch.options.env.AGENT_WORKSPACE_META_TEST_SECRET).toBeUndefined();
      expect(spawner.children[0]!.messages[0]).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent-workspace-meta", title: "Agent Workspace Meta", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });

      const processRoot = path.dirname(launch.options.cwd);
      await expect(access(processRoot)).resolves.toBeUndefined();
      await connection.close();
      await expect(access(processRoot)).rejects.toBeDefined();
      expect(await readdir(path.join(runtimeDataDirectory, "meta-provider", "codex", "processes"))).toEqual([]);
    } finally {
      if (inheritedSecret === undefined) delete process.env.AGENT_WORKSPACE_META_TEST_SECRET;
      else process.env.AGENT_WORKSPACE_META_TEST_SECRET = inheritedSecret;
      await rm(runtimeDataDirectory, { recursive: true, force: true });
    }
  });

  it("declines every native server request before exposing it to the Meta adapter", async () => {
    const runtimeDataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-meta-bridge-"));
    const spawner = new FakeSpawner();
    try {
      const connection = await createCodexMetaAppServerConnectionFactory({
        command: "/private/verified/codex-0.146.0",
        runtimeDataDirectory,
        binaryInspector: new FixedBinaryInspector(),
        protocolProbe: new FixedProtocolProbe(),
        spawn: spawner.spawn,
        requestTimeoutMs: 1_000,
      }).create(connectionInput());
      const iterator = connection.events()[Symbol.asyncIterator]();
      spawner.children[0]!.emitJson({
        jsonrpc: "2.0",
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "do-not-run" },
      });
      await eventually(() => spawner.children[0]!.messages.find((message) => message.id === "approval-1"));
      expect(spawner.children[0]!.messages).toContainEqual({
        jsonrpc: "2.0",
        id: "approval-1",
        result: { decision: "decline" },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "server_request", id: "approval-1", method: "item/commandExecution/requestApproval" },
      });
      // The adapter's defensive second decline does not write a second response.
      await connection.respond("approval-1", { decision: "decline" });
      expect(spawner.children[0]!.messages.filter((message) => message.id === "approval-1")).toHaveLength(1);
      await iterator.return?.();
      await connection.close();
    } finally {
      await rm(runtimeDataDirectory, { recursive: true, force: true });
    }
  });

  it("rejects pin and attestation mismatches before hash, probe, directory, or process effects", async () => {
    const runtimeDataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-meta-bridge-"));
    const binary = new FixedBinaryInspector();
    const protocol = new FixedProtocolProbe();
    const spawner = new FakeSpawner();
    const factory = createCodexMetaAppServerConnectionFactory({
      command: "/private/verified/codex-0.146.0",
      runtimeDataDirectory,
      binaryInspector: binary,
      protocolProbe: protocol,
      spawn: spawner.spawn,
    });
    try {
      await expect(factory.create({
        ...connectionInput(),
        protocol: { ...CODEX_META_APP_SERVER_PROTOCOL_0_146, providerVersion: "0.145.0" },
      })).rejects.toMatchObject({ code: "codex_meta_protocol_pin_mismatch" });
      await expect(factory.create({
        ...connectionInput(),
        noToolAttestation: {
          ...CODEX_META_NO_TOOL_ATTESTATION_0_146,
          initializationCapabilities: { experimentalApi: true, requestAttestation: true as false },
        },
      })).rejects.toMatchObject({ code: "codex_meta_no_tool_attestation_mismatch" });
      await expect(factory.create({
        ...connectionInput(),
        workspace: { cwd: "/untrusted/task-workspace" },
      } as unknown as CodexMetaAppServerConnectionInput)).rejects.toMatchObject({
        code: "codex_meta_connection_input_invalid",
      });
      expect(binary.commands).toEqual([]);
      expect(protocol.inputs).toEqual([]);
      expect(spawner.calls).toEqual([]);
      await expect(access(path.join(runtimeDataDirectory, "meta-provider"))).rejects.toBeDefined();
    } finally {
      await rm(runtimeDataDirectory, { recursive: true, force: true });
    }
  });

  it("requires an absolute executable path before any binary or process inspection", () => {
    let inspected = 0;
    expect(() => createCodexMetaAppServerConnectionFactory({
      command: "codex",
      runtimeDataDirectory: "/private/runtime-data",
      binaryInspector: {
        inspect: async () => {
          inspected += 1;
          return { sha256: CODEX_META_BINARY_SHA256_0_146 };
        },
      },
    })).toThrow(expect.objectContaining({ code: "codex_meta_command_must_be_absolute" }));
    expect(inspected).toBe(0);
  });

  it("fails closed on an unproven binary or initialization and never includes native secrets in errors", async () => {
    const runtimeDataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-meta-bridge-"));
    try {
      const wrongHash = createCodexMetaAppServerConnectionFactory({
        command: "/private/verified/codex-0.146.0",
        runtimeDataDirectory,
        binaryInspector: new FixedBinaryInspector("0".repeat(64)),
        protocolProbe: new FixedProtocolProbe(),
        spawn: new FakeSpawner().spawn,
      });
      await expect(wrongHash.inspectNoToolConfiguration()).rejects.toEqual(
        expect.objectContaining({ code: "codex_meta_binary_sha256_mismatch", message: "codex_meta_binary_sha256_mismatch" }),
      );

      const failing = new FakeSpawner({ initializeError: "account=secret@example.test token=super-secret" });
      const factory = createCodexMetaAppServerConnectionFactory({
        command: "/private/verified/codex-0.146.0",
        runtimeDataDirectory,
        binaryInspector: new FixedBinaryInspector(),
        protocolProbe: new FixedProtocolProbe(),
        spawn: failing.spawn,
        requestTimeoutMs: 1_000,
      });
      let observed: unknown;
      try {
        await factory.create(connectionInput());
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(CodexMetaAppServerBridgeError);
      expect((observed as Error).message).toBe("codex_meta_app_server_rpc_-32000");
      expect((observed as Error).message).not.toMatch(/secret|account|token|example/i);
      expect(await readdir(path.join(runtimeDataDirectory, "meta-provider", "codex", "processes"))).toEqual([]);
    } finally {
      await rm(runtimeDataDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "invalid JSON",
      expectedCode: "codex_meta_app_server_invalid_json",
      fail: (child: FakeChild) => child.stdout.write("{not-json}\n"),
    },
    {
      name: "an oversized JSON line",
      expectedCode: "codex_meta_app_server_message_too_large",
      fail: (child: FakeChild) => child.stdout.write("x".repeat((4 * 1024 * 1024) + 1)),
    },
    {
      name: "a spawned child connection error",
      expectedCode: "codex_meta_app_server_spawn_failed",
      fail: (child: FakeChild) => child.emit("error", new Error("native secret must not escape")),
    },
  ])("contains $name even when the spawned child never emits close", async ({ expectedCode, fail }) => {
    const runtimeDataDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-meta-bridge-"));
    const spawner = new FakeSpawner({ closeOnKill: false });
    try {
      const connection = await createCodexMetaAppServerConnectionFactory({
        command: "/private/verified/codex-0.146.0",
        runtimeDataDirectory,
        binaryInspector: new FixedBinaryInspector(),
        protocolProbe: new FixedProtocolProbe(),
        spawn: spawner.spawn,
        requestTimeoutMs: 10_000,
      }).create(connectionInput());
      const child = spawner.children[0]!;
      const processRoot = path.dirname(spawner.calls[0]!.options.cwd);

      vi.useFakeTimers();
      const pending = connection.request("turn/start", { input: "contained" });
      fail(child);
      await expect(pending).rejects.toMatchObject({ code: expectedCode });

      const firstClose = connection.close();
      const repeatedClose = connection.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(child.kills).toEqual(["SIGTERM"]);
      await expect(access(processRoot)).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(999);
      expect(child.kills).toEqual(["SIGTERM"]);
      await expect(access(processRoot)).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(access(processRoot)).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([firstClose, repeatedClose]);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(access(processRoot)).rejects.toBeDefined();
      expect(await readdir(path.join(runtimeDataDirectory, "meta-provider", "codex", "processes"))).toEqual([]);
    } finally {
      vi.useRealTimers();
      await rm(runtimeDataDirectory, { recursive: true, force: true });
    }
  });
});

class FixedBinaryInspector implements CodexMetaBinaryInspector {
  readonly commands: string[] = [];

  constructor(private readonly sha256 = CODEX_META_BINARY_SHA256_0_146) {}

  async inspect(command: string): Promise<Readonly<{ readonly sha256: string }>> {
    this.commands.push(command);
    return { sha256: this.sha256 };
  }
}

class FixedProtocolProbe implements CodexAppServerProtocolProbe {
  readonly inputs: CodexAppServerProtocolProbeInput[] = [];

  async inspect(input: CodexAppServerProtocolProbeInput) {
    this.inputs.push(input);
    return CODEX_META_APP_SERVER_PROTOCOL_0_146;
  }
}

type FakeChildBehavior = Readonly<{
  initializeError?: string;
  closeOnKill?: boolean;
}>;

class FakeSpawner {
  readonly calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: CodexMetaAppServerSpawnOptions;
  }> = [];
  readonly children: FakeChild[] = [];

  constructor(private readonly behavior: FakeChildBehavior = {}) {}

  readonly spawn: CodexMetaAppServerSpawn = (command, args, options) => {
    const child = new FakeChild(options, this.behavior);
    this.calls.push({ command, args, options });
    this.children.push(child);
    return child;
  };
}

class FakeChild extends EventEmitter implements CodexMetaAppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly kills: NodeJS.Signals[] = [];
  #buffer = "";

  constructor(
    private readonly options: CodexMetaAppServerSpawnOptions,
    private readonly behavior: FakeChildBehavior,
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => this.#onInput(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
  }

  emitJson(value: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.behavior.closeOnKill !== false) {
      queueMicrotask(() => this.emit("close", 0, signal));
    }
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
      if (message.method !== "initialize") continue;
      if (this.behavior.initializeError) {
        queueMicrotask(() => this.emitJson({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: this.behavior.initializeError },
        }));
      } else {
        queueMicrotask(() => this.emitJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            userAgent: "codex-cli/0.146.0",
            codexHome: this.options.env.CODEX_HOME,
            platformFamily: "unix",
            platformOs: "macos",
          },
        }));
      }
    }
  }
}

function connectionInput(): CodexMetaAppServerConnectionInput {
  return {
    metaTurnId: "meta_turn_bridge_test",
    profile: {
      metaProfileId: "meta_profile_bridge_test",
      provider: "codex",
      model: "gpt-5.6",
      providerVersion: CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion,
      protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    protocol: CODEX_META_APP_SERVER_PROTOCOL_0_146,
    noToolAttestation: CODEX_META_NO_TOOL_ATTESTATION_0_146,
  };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("eventually_timeout");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
