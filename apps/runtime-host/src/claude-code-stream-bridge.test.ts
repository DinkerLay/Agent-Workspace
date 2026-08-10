import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES, CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT } from "@agent-workspace/provider-claude-code";
import type { ProviderPortBindingRequest } from "@agent-workspace/provider-port";
import {
  createClaudeCodeStreamTransport,
  type ClaudeCodeProcess,
  type ClaudeCodeProcessSpawner,
  type ClaudeCodeSpawnOptions,
} from "./claude-code-stream-bridge.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("Claude Code stream bridge", () => {
  it("owns one safe stream, journals native facts, resumes by native binding ref, and waits for a cancellation fact", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    const spawner = new FakeSpawner();
    const transport = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin", ANTHROPIC_AUTH_TOKEN: "test-token" },
      journalDirectory: path.join(directory, "journal"),
      protocolFingerprint: CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
      spawnProcess: spawner.spawn,
    });
    const request = bindingRequest();

    expect(await transport.inspectProtocol()).toEqual({
      providerVersion: "2.1.222",
      protocolFingerprint: CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
    });
    const ensured = await transport.request({ operation: "ensure_binding", request: { ...request, disposition: "create" } });
    expect(ensured).toMatchObject({ acceptance: "accepted" });
    const process = spawner.streamProcesses.at(-1)!;
    expect(process.args).toEqual(expect.arrayContaining([
      "--safe-mode", "--model", "sonnet", "--tools", "", "--permission-mode", "plan",
      "--append-system-prompt", expect.stringContaining("Coordinate this Task using only Runtime dispatch."),
      "--input-format", "stream-json", "--output-format", "stream-json", "--session-id",
    ]));
    expect(process.options).toEqual({
      cwd: "/tmp/claude-workspace", env: { PATH: "/trusted/bin", ANTHROPIC_AUTH_TOKEN: "test-token" },
      shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });

    const subscription = transport.observe!({ operation: "observe_binding", request })[Symbol.asyncIterator]();
    const submitted = await transport.request({
      operation: "submit_delivery",
      request: { ...request, inputSubmissionId: "input_1", invocationId: "invocation_1", idempotencyKey: "input:binding_1:1", content: "return evidence" },
    });
    expect(submitted).toMatchObject({ acceptance: "accepted" });
    const command = process.messages.find((message) => message.type === "user")!;
    expect(command).toMatchObject({ type: "user", message: { role: "user", content: "return evidence" } });
    expect(command.uuid).toMatch(/^[0-9a-f-]{36}$/i);

    process.emitJson({ type: "command_lifecycle", uuid: "event_started", session_id: ensured.transportRequestId, command_uuid: command.uuid, state: "started" });
    process.emitJson(initFrame(ensured.transportRequestId!));
    process.emitJson({ type: "result", uuid: "event_result", session_id: ensured.transportRequestId, user_message_uuid: command.uuid, is_error: false, terminal_reason: "completed", result: "evidence" });
    expect((await subscription.next()).value).toMatchObject({ kind: "claude-code.binding.created", payload: { nativeBindingRef: ensured.transportRequestId } });

    await eventually(async () => (await transport.reconcile!({ operation: "reconcile_binding", request })).some((fact) => fact.kind === "claude-code.turn.completed"));
    const facts = await transport.reconcile!({ operation: "reconcile_binding", request });
    expect(facts.some((fact) => fact.kind === "claude-code.binding.created")).toBe(true);
    expect(facts.findIndex((fact) => fact.kind === "claude-code.binding.created"))
      .toBeLessThan(facts.findIndex((fact) => fact.kind === "claude-code.delivery.receipt"));
    expect(facts.some((fact) => fact.kind === "claude-code.delivery.receipt"
      && fact.inputSubmissionId === "input_1" && fact.nativeMessageId === "event_started")).toBe(true);
    expect(facts.some((fact) => fact.kind === "claude-code.turn.completed"
      && fact.invocationId === "invocation_1"
      && (fact.payload as { readonly result?: { readonly text?: unknown } }).result?.text === "evidence")).toBe(true);

    const interrupt = await transport.request({
      operation: "request_interrupt",
      request: { ...request, invocationId: "invocation_1", idempotencyKey: "interrupt:1" },
    });
    expect(interrupt).toMatchObject({ acceptance: "accepted" });
    expect(process.messages).toContainEqual(expect.objectContaining({ type: "control_request", request: { subtype: "interrupt" } }));
    expect((await transport.reconcile!({ operation: "reconcile_binding", request })).some((fact) => fact.kind === "claude-code.interrupt.confirmed")).toBe(false);
    process.emitJson({ type: "command_lifecycle", uuid: "event_cancelled", session_id: ensured.transportRequestId, command_uuid: command.uuid, state: "cancelled" });
    await eventually(async () => (await transport.reconcile!({ operation: "reconcile_binding", request })).some((fact) => fact.kind === "claude-code.interrupt.confirmed"));

    const resumedSpawner = new FakeSpawner();
    const resumed = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin", ANTHROPIC_AUTH_TOKEN: "test-token" },
      journalDirectory: path.join(directory, "journal"),
      spawnProcess: resumedSpawner.spawn,
    });
    const resumedRequest = { ...request, nativeBindingRef: ensured.transportRequestId };
    expect(await resumed.request({ operation: "ensure_binding", request: { ...resumedRequest, disposition: "resume" } })).toMatchObject({ acceptance: "accepted" });
    const resumedProcess = resumedSpawner.streamProcesses.at(-1)!;
    expect(resumedProcess.args).toContain("--resume");
    expect(resumedProcess.args).toContain(ensured.transportRequestId);
    expect(await resumed.request({
      operation: "submit_delivery",
      request: { ...resumedRequest, inputSubmissionId: "input_1", invocationId: "invocation_1", idempotencyKey: "input:binding_1:1", content: "return evidence" },
    })).toMatchObject({ acceptance: "accepted" });
    resumedProcess.emitJson(initFrame(ensured.transportRequestId!));
    await eventually(async () => (await resumed.reconcile({ operation: "reconcile_binding", request: resumedRequest }))
      .some((fact) => fact.kind === "claude-code.binding.resumed"));
    expect(resumedProcess.messages.find((message) => message.type === "user")?.uuid).toBe(command.uuid);
    expect((await resumed.reconcile!({ operation: "reconcile_binding", request: resumedRequest })).some((fact) => fact.kind === "claude-code.turn.completed")).toBe(true);

    await transport.close();
    await resumed.close();
  });

  it("restores an unresolved delivery after a Host restart and permits only its UUID retry", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    const firstSpawner = new FakeSpawner();
    const first = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
      spawnProcess: firstSpawner.spawn,
    });
    const request = bindingRequest();
    const ensured = await first.request({ operation: "ensure_binding", request: { ...request, disposition: "create" } });
    expect(await first.request({
      operation: "submit_delivery",
      request: { ...request, inputSubmissionId: "input_1", invocationId: "invocation_1", idempotencyKey: "input:binding_1:1", content: "recover me" },
    })).toMatchObject({ acceptance: "accepted" });
    const firstCommand = firstSpawner.streamProcesses.at(-1)!.messages.find((message) => message.type === "user")!;

    const resumedSpawner = new FakeSpawner();
    const resumed = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
      spawnProcess: resumedSpawner.spawn,
    });
    const resumedRequest = { ...request, nativeBindingRef: ensured.transportRequestId };
    expect(await resumed.request({ operation: "ensure_binding", request: { ...resumedRequest, disposition: "resume" } }))
      .toMatchObject({ acceptance: "accepted" });
    expect(await resumed.request({
      operation: "submit_delivery",
      request: { ...resumedRequest, inputSubmissionId: "input_2", idempotencyKey: "input:binding_1:2", content: "must wait" },
    })).toEqual({ acceptance: "rejected", diagnostic: "claude_code_binding_delivery_busy" });
    expect(await resumed.request({
      operation: "submit_delivery",
      request: { ...resumedRequest, inputSubmissionId: "input_1", invocationId: "invocation_1", idempotencyKey: "input:binding_1:1", content: "recover me" },
    })).toMatchObject({ acceptance: "accepted" });
    const resumedProcess = resumedSpawner.streamProcesses.at(-1)!;
    expect(resumedProcess.messages.find((message) => message.type === "user")?.uuid).toBe(firstCommand.uuid);
    resumedProcess.emitJson(initFrame(ensured.transportRequestId!));
    resumedProcess.emitJson({ type: "result", uuid: "event_result", session_id: ensured.transportRequestId, user_message_uuid: firstCommand.uuid, is_error: false, terminal_reason: "completed", result: "recovered" });
    await eventually(async () => (await resumed.reconcile({ operation: "reconcile_binding", request: resumedRequest }))
      .some((fact) => fact.kind === "claude-code.turn.completed" && fact.inputSubmissionId === "input_1"));

    await first.close();
    await resumed.close();
  });

  it("fails closed instead of granting unverified tool attention", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    const spawner = new FakeSpawner();
    const transport = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
      spawnProcess: spawner.spawn,
    });
    const request = bindingRequest({
      executionProfile: {
        ...bindingRequest().executionProfile,
        capabilityPolicy: {
          requiredCapabilities: ["attention_reply"],
          allowedTools: ["Bash"],
          permissionMode: "ask",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
    });
    expect(await transport.request({ operation: "ensure_binding", request: { ...request, disposition: "create" } })).toEqual({
      acceptance: "rejected", diagnostic: "claude_code_profile_unavailable",
    });
    expect(spawner.streamProcesses).toHaveLength(0);
  });

  it("requires an absolute Host-owned Claude executable", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    expect(() => createClaudeCodeStreamTransport({
      command: "claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
    })).toThrow("claude_code_command_invalid");
  });

  it("deduplicates only an in-flight version probe and re-observes settled evidence before binding", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    const spawner = new FakeSpawner();
    const transport = createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
      spawnProcess: spawner.spawn,
    });

    await expect(transport.inspectProtocol()).resolves.toMatchObject({ providerVersion: "2.1.222" });
    spawner.version = "2.1.999";
    await expect(transport.inspectProtocol()).resolves.toMatchObject({ providerVersion: "2.1.999" });
    expect(spawner.calls.filter((call) => call.args[0] === "--version")).toHaveLength(2);

    await expect(transport.request({
      operation: "ensure_binding",
      request: { ...bindingRequest(), disposition: "create" },
    })).resolves.toEqual({ acceptance: "rejected", diagnostic: "claude_code_protocol_profile_mismatch" });
    expect(spawner.calls.filter((call) => call.args[0] === "--version")).toHaveLength(3);
    expect(spawner.streamProcesses).toEqual([]);
  });

  it("refuses a composition-supplied protocol fingerprint that was not actually spiked", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-claude-bridge-"));
    directories.push(directory);
    expect(() => createClaudeCodeStreamTransport({
      command: "/trusted/bin/claude",
      environment: { PATH: "/trusted/bin" },
      journalDirectory: path.join(directory, "journal"),
      protocolFingerprint: "sha256:composition-must-not-become-observation",
      spawnProcess: new FakeSpawner().spawn,
    })).toThrow("claude_code_protocol_fingerprint_unpinned");
  });
});

class FakeSpawner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly options: ClaudeCodeSpawnOptions }> = [];
  readonly streamProcesses: FakeClaudeProcess[] = [];
  version = "2.1.222";

  readonly spawn: ClaudeCodeProcessSpawner = (command, args, options) => {
    const process = new FakeClaudeProcess(args, options);
    this.calls.push({ command, args, options });
    if (args[0] === "--version") {
      queueMicrotask(() => {
        process.stdout.write(`${this.version} (Claude Code)\n`);
        process.exit(0);
      });
    } else {
      this.streamProcesses.push(process);
    }
    return process as unknown as ClaudeCodeProcess;
  };
}

class FakeClaudeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly killed: NodeJS.Signals[] = [];
  readonly #buffer: string[] = [];

  constructor(readonly args: readonly string[], readonly options: ClaudeCodeSpawnOptions) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.#buffer.push(chunk);
      const lines = this.#buffer.join("").split("\n");
      this.#buffer.splice(0, this.#buffer.length, lines.pop() ?? "");
      for (const line of lines) if (line) this.messages.push(JSON.parse(line));
    });
  }

  emitJson(value: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }

  exit(code: number): void {
    this.emit("close", code, null);
  }
}

function bindingRequest(overrides: Record<string, unknown> = {}): ProviderPortBindingRequest {
  return {
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfile: {
      executionProfileId: "profile_1",
      provider: "claude-code",
      model: "sonnet",
      providerVersion: "2.1.222",
      protocolFingerprint: CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
      capabilityPolicy: { requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"], allowedTools: [], permissionMode: "ask", maxConcurrentTurns: 1, maxNativeChildren: 0 },
    },
    workspace: { workspaceId: "workspace_1", cwd: "/tmp/claude-workspace" },
    bootstrap: {
      purpose: "task_conductor",
      agentCardId: "agent_card_conductor",
      systemPrompt: "Coordinate this Task using only Runtime dispatch.",
      capabilityRefs: [],
      dispatchRegistry: [],
    },
    ...overrides,
  } as ProviderPortBindingRequest;
}

function initFrame(sessionId: string): Record<string, unknown> {
  return {
    type: "system", subtype: "init", uuid: "event_init", session_id: sessionId,
    claude_code_version: "2.1.222", capabilities: [...CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES],
  };
}

async function eventually(assertion: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("eventually_timeout");
}
