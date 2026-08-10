import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT,
  CLAUDE_CODE_PROVEN_CAPABILITIES,
  cliInitSupportsRequiredCapabilities,
  createClaudeCodeCommandUuid,
  mapClaudeCodeCliFrame,
  readClaudeCodeCliInit,
  type ClaudeCodeCliDeliveryCorrelation,
} from "@agent-workspace/provider-claude-code";
import type { ExecutionProfileDefinition, ProviderCapability } from "@agent-workspace/runtime-contracts";
import {
  renderProviderSessionBootstrap,
  type NativeProviderFact,
  type ProtocolPin,
  type ProviderPortBindingRequest,
  type ProviderTransport,
  type ProviderTransportOperation,
} from "@agent-workspace/provider-port";

const CLAUDE_CODE_STREAM_OPERATIONS: readonly ProviderTransportOperation[] = Object.freeze([
  "inspect_protocol",
  "ensure_binding",
  "submit_delivery",
  "observe_binding",
  "reconcile_binding",
  "request_interrupt",
  "release_binding",
]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type ClaudeCodeStreamBridgeOptions = Readonly<{
  /** Host-configured executable only. It is never supplied by a Template or Renderer. */
  readonly command: string;
  /** Explicit allowlist resolved by Runtime Host; `process.env` is never inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** Private Host directory for append-only native frame records. */
  readonly journalDirectory: string;
  /** Optional assertion only; it may never change this bridge's observed pin. */
  readonly protocolFingerprint?: string;
  readonly spawnProcess?: ClaudeCodeProcessSpawner;
}>;

export type ClaudeCodeStreamTransport = Omit<ProviderTransport, "inspectProtocol" | "observe" | "reconcile" | "verifiedCapabilities"> & Readonly<{
  /** Narrower than operation-derived capabilities; do not infer unverified features. */
  readonly verifiedCapabilities: readonly ProviderCapability[];
  inspectProtocol(): Promise<ProtocolPin>;
  observe(input: { readonly operation: "observe_binding"; readonly request: ProviderPortBindingRequest }): AsyncIterable<NativeProviderFact>;
  reconcile(input: { readonly operation: "reconcile_binding"; readonly request: ProviderPortBindingRequest }): Promise<readonly NativeProviderFact[]>;
  close(): Promise<void>;
}>;

export type ClaudeCodeSpawnOptions = Readonly<{
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}>;

export interface ClaudeCodeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ClaudeCodeProcessSpawner = (
  command: string,
  args: readonly string[],
  options: ClaudeCodeSpawnOptions,
) => ClaudeCodeProcess;

/**
 * Host-only stateful transport for the official Claude Code stream-json CLI.
 * One child process exists per Binding. The transport records native frames
 * before publishing any mapped fact and never treats a stdin write as a fact.
 */
export function createClaudeCodeStreamTransport(options: ClaudeCodeStreamBridgeOptions): ClaudeCodeStreamTransport {
  return new ClaudeCodeStreamBridge(options);
}

class ClaudeCodeStreamBridge implements ClaudeCodeStreamTransport {
  readonly supportedOperations = CLAUDE_CODE_STREAM_OPERATIONS;
  readonly verifiedCapabilities = CLAUDE_CODE_PROVEN_CAPABILITIES as readonly ProviderCapability[];

  readonly #command: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #journalDirectory: string;
  readonly #protocolFingerprint: string;
  readonly #spawn: ClaudeCodeProcessSpawner;
  readonly #bindings = new Map<string, BindingState>();
  #protocolPromise: Promise<ProtocolPin> | undefined;
  #closed = false;

  constructor(options: ClaudeCodeStreamBridgeOptions) {
    // A Provider executable is Host authority, never a shell lookup supplied by
    // a Template or inherited ambient PATH. Keep the resolution explicit even
    // though spawning itself already uses shell:false.
    this.#command = requiredAbsolutePath(options.command, "claude_code_command_invalid");
    this.#environment = freezeEnvironment(options.environment);
    this.#journalDirectory = requiredAbsolutePath(options.journalDirectory, "claude_code_journal_directory_invalid");
    if (options.protocolFingerprint !== undefined
      && options.protocolFingerprint !== CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT) {
      throw new Error("claude_code_protocol_fingerprint_unpinned");
    }
    this.#protocolFingerprint = CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT;
    this.#spawn = options.spawnProcess ?? defaultSpawn;
  }

  async inspectProtocol(): Promise<ProtocolPin> {
    if (!this.#protocolPromise) {
      const pending = this.#inspectProtocol();
      this.#protocolPromise = pending;
      const clear = () => {
        if (this.#protocolPromise === pending) this.#protocolPromise = undefined;
      };
      void pending.then(clear, clear);
    }
    return this.#protocolPromise;
  }

  async request(input: { readonly operation: string; readonly request: unknown }): Promise<{
    readonly acceptance?: "accepted" | "rejected" | "unknown";
    readonly transportRequestId?: string;
    readonly diagnostic?: string;
  }> {
    if (this.#closed) return { acceptance: "rejected", diagnostic: "claude_code_stream_bridge_closed" };
    switch (input.operation) {
      case "ensure_binding":
        return this.#ensureBinding(requireBindingRequest(input.request), input.request);
      case "submit_delivery":
        return this.#submitDelivery(requireBindingRequest(input.request), input.request);
      case "request_interrupt":
        return this.#requestInterrupt(requireBindingRequest(input.request), input.request);
      case "release_binding":
        return this.#releaseBinding(requireBindingRequest(input.request));
      default:
        return { acceptance: "rejected", diagnostic: "claude_code_stream_operation_unsupported" };
    }
  }

  async *observe(input: { readonly operation: "observe_binding"; readonly request: ProviderPortBindingRequest }): AsyncIterable<NativeProviderFact> {
    if (input.operation !== "observe_binding") return;
    const state = this.#bindings.get(input.request.bindingId);
    if (!state) return;
    const subscription = new FactSubscription();
    state.subscriptions.add(subscription);
    try {
      yield* subscription;
    } finally {
      state.subscriptions.delete(subscription);
      subscription.close();
    }
  }

  async reconcile(input: { readonly operation: "reconcile_binding"; readonly request: ProviderPortBindingRequest }): Promise<readonly NativeProviderFact[]> {
    if (input.operation !== "reconcile_binding") return Object.freeze([]);
    const entries = await this.#readJournal(input.request.bindingId);
    const facts: NativeProviderFact[] = [];
    for (const entry of entries) {
      if (entry.kind !== "frame") continue;
      for (const fact of entry.nativeFacts) facts.push(fact);
    }
    return Object.freeze(facts);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#bindings.values()].map(async (state) => {
      state.releaseRequested = true;
      try {
        state.process.stdin.end();
      } catch {
        // The process has already exited; its close event remains the fact source.
      }
      try {
        state.process.kill("SIGTERM");
      } catch {
        // The process may have exited between end() and kill().
      }
    }));
  }

  async #inspectProtocol(): Promise<ProtocolPin> {
    const stdout = await this.#runVersionProbe();
    const match = /^([^\s]+)\s+\(Claude Code\)\s*$/m.exec(stdout);
    if (!match) throw new Error("claude_code_version_probe_invalid");
    return Object.freeze({ providerVersion: match[1], protocolFingerprint: this.#protocolFingerprint });
  }

  async #runVersionProbe(): Promise<string> {
    await mkdir(this.#journalDirectory, { recursive: true, mode: 0o700 });
    const process = this.#spawn(this.#command, ["--version"], {
      cwd: this.#journalDirectory,
      env: this.#environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    process.stderr.resume();
    const chunks: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error("claude_code_version_probe_failed"));
      };
      process.once("error", fail);
      process.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (exitCode !== 0) {
          reject(new Error("claude_code_version_probe_failed"));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      process.stdin.end();
    });
  }

  async #ensureBinding(request: ProviderPortBindingRequest, rawRequest: unknown): Promise<{ readonly acceptance: "accepted" | "rejected"; readonly transportRequestId?: string; readonly diagnostic?: string }> {
    if (!isEnsureBindingRequest(rawRequest)) return { acceptance: "rejected", diagnostic: "claude_code_binding_request_invalid" };
    if (!this.#profileSupported(request.executionProfile)) return { acceptance: "rejected", diagnostic: "claude_code_profile_unavailable" };
    try {
      const protocol = await this.inspectProtocol();
      if (protocol.providerVersion !== request.executionProfile.providerVersion
        || protocol.protocolFingerprint !== request.executionProfile.protocolFingerprint) {
        return { acceptance: "rejected", diagnostic: "claude_code_protocol_profile_mismatch" };
      }
    } catch {
      return { acceptance: "rejected", diagnostic: "claude_code_protocol_unavailable" };
    }

    const existing = this.#bindings.get(request.bindingId);
    if (existing && !existing.closed) {
      return existing.nativeBindingRef === request.nativeBindingRef || !request.nativeBindingRef
        ? { acceptance: "accepted", transportRequestId: existing.nativeBindingRef }
        : { acceptance: "rejected", diagnostic: "claude_code_binding_ref_mismatch" };
    }

    const journalEntries = await this.#readJournal(request.bindingId);
    const journalBinding = lastJournalBinding(journalEntries);
    const nativeBindingRef = request.nativeBindingRef ?? journalBinding?.nativeBindingRef ?? randomUUID();
    if (!isSafeCliValue(nativeBindingRef)) return { acceptance: "rejected", diagnostic: "claude_code_native_binding_ref_invalid" };
    const recovered = recoverDeliveryState(journalEntries, nativeBindingRef);
    const disposition: "create" | "resume" = rawRequest.disposition === "resume" || request.nativeBindingRef || journalBinding
      ? "resume"
      : "create";
    const sourceInstanceId = `claude-code-cli:${randomUUID()}`;
    const args = claudeCodeArgs({ profile: request.executionProfile, nativeBindingRef, disposition, bootstrap: request.bootstrap });
    let process: ClaudeCodeProcess;
    try {
      process = this.#spawn(this.#command, args, {
        cwd: requiredAbsolutePath(request.workspace.cwd, "claude_code_workspace_cwd_invalid"),
        env: this.#environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return { acceptance: "rejected", diagnostic: "claude_code_stream_spawn_failed" };
    }

    const state: BindingState = {
      bindingId: request.bindingId,
      nativeBindingRef,
      disposition,
      profile: request.executionProfile,
      sourceInstanceId,
      process,
      deliveries: recovered.deliveries,
      subscriptions: new Set(),
      cursor: 0,
      stdoutBuffer: "",
      writeTail: Promise.resolve(),
      releaseRequested: false,
      initialized: false,
      preInitFrames: [],
      ...(recovered.activeCommandUuid ? { activeCommandUuid: recovered.activeCommandUuid } : {}),
      closed: false,
    };
    this.#bindings.set(request.bindingId, state);
    try {
      await this.#appendJournal(state.bindingId, {
        kind: "binding",
        nativeBindingRef,
        disposition,
        sourceInstanceId,
      });
    } catch {
      this.#bindings.delete(request.bindingId);
      try { process.kill("SIGTERM"); } catch { /* no process remains */ }
      return { acceptance: "rejected", diagnostic: "claude_code_journal_unavailable" };
    }
    this.#attachProcess(state);
    return { acceptance: "accepted", transportRequestId: nativeBindingRef };
  }

  async #submitDelivery(request: ProviderPortBindingRequest, rawRequest: unknown): Promise<{ readonly acceptance: "accepted" | "rejected"; readonly transportRequestId?: string; readonly diagnostic?: string }> {
    if (!isSubmitDeliveryRequest(rawRequest)) return { acceptance: "rejected", diagnostic: "claude_code_delivery_request_invalid" };
    const state = this.#bindings.get(request.bindingId);
    if (!state || state.closed || state.protocolRejected) return { acceptance: "rejected", diagnostic: "claude_code_binding_not_ready" };
    const commandUuid = createClaudeCodeCommandUuid({ bindingId: request.bindingId, idempotencyKey: rawRequest.idempotencyKey });
    const existing = state.deliveries.get(commandUuid);
    if (state.activeCommandUuid && state.activeCommandUuid !== commandUuid) {
      return { acceptance: "rejected", diagnostic: "claude_code_binding_delivery_busy" };
    }
    const correlation: ClaudeCodeCliDeliveryCorrelation = existing ?? Object.freeze({
      commandUuid,
      inputSubmissionId: rawRequest.inputSubmissionId,
      ...(rawRequest.invocationId ? { invocationId: rawRequest.invocationId } : {}),
    });
    if (!existing) {
      try {
        await this.#appendJournal(state.bindingId, { kind: "delivery", ...correlation });
      } catch {
        return { acceptance: "rejected", diagnostic: "claude_code_journal_unavailable" };
      }
      state.deliveries.set(commandUuid, correlation);
    }
    state.activeCommandUuid = commandUuid;
    try {
      await writeJsonLine(state.process.stdin, {
        type: "user",
        uuid: commandUuid,
        message: { role: "user", content: rawRequest.content },
      });
      return { acceptance: "accepted", transportRequestId: commandUuid };
    } catch {
      return { acceptance: "rejected", diagnostic: "claude_code_delivery_write_failed" };
    }
  }

  async #requestInterrupt(request: ProviderPortBindingRequest, rawRequest: unknown): Promise<{ readonly acceptance: "accepted" | "rejected"; readonly transportRequestId?: string; readonly diagnostic?: string }> {
    if (!isInterruptRequest(rawRequest)) return { acceptance: "rejected", diagnostic: "claude_code_interrupt_request_invalid" };
    const state = this.#bindings.get(request.bindingId);
    if (!state || state.closed) return { acceptance: "rejected", diagnostic: "claude_code_binding_not_ready" };
    const requestId = randomUUID();
    try {
      await this.#appendJournal(state.bindingId, {
        kind: "interrupt",
        requestId,
        ...(state.activeCommandUuid ? { commandUuid: state.activeCommandUuid } : {}),
        ...(rawRequest.invocationId ? { invocationId: rawRequest.invocationId } : {}),
      });
      await writeJsonLine(state.process.stdin, {
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      });
      return { acceptance: "accepted", transportRequestId: requestId };
    } catch {
      return { acceptance: "rejected", diagnostic: "claude_code_interrupt_write_failed" };
    }
  }

  async #releaseBinding(request: ProviderPortBindingRequest): Promise<{ readonly acceptance: "accepted" | "rejected"; readonly diagnostic?: string }> {
    const state = this.#bindings.get(request.bindingId);
    if (!state || state.closed) return { acceptance: "accepted" };
    state.releaseRequested = true;
    try {
      await this.#appendJournal(state.bindingId, { kind: "release" });
      state.process.stdin.end();
      state.process.kill("SIGTERM");
      return { acceptance: "accepted" };
    } catch {
      return { acceptance: "rejected", diagnostic: "claude_code_release_failed" };
    }
  }

  #attachProcess(state: BindingState): void {
    state.process.stderr.resume();
    state.process.stdout.setEncoding("utf8");
    state.process.stdout.on("data", (chunk: string | Buffer) => {
      state.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(state.stdoutBuffer, "utf8") > MAX_FRAME_BYTES) {
        state.stdoutBuffer = "";
        this.#queueFrame(state, { type: "claude-code.host.closed", uuid: randomUUID(), reason: "frame_too_large", expected: false });
        return;
      }
      let boundary = state.stdoutBuffer.indexOf("\n");
      while (boundary >= 0) {
        const line = state.stdoutBuffer.slice(0, boundary);
        state.stdoutBuffer = state.stdoutBuffer.slice(boundary + 1);
        if (line.trim()) {
          try {
            this.#queueFrame(state, JSON.parse(line));
          } catch {
            this.#queueFrame(state, { type: "claude-code.host.closed", uuid: randomUUID(), reason: "frame_not_json", expected: false });
          }
        }
        boundary = state.stdoutBuffer.indexOf("\n");
      }
    });
    state.process.once("error", () => this.#queueClose(state, "process_error"));
    state.process.once("close", (exitCode, signal) => this.#queueClose(state, signal ? "process_signal" : `process_exit_${exitCode ?? "unknown"}`));
  }

  #queueFrame(state: BindingState, frame: unknown): void {
    state.writeTail = state.writeTail
      .then(() => this.#recordFrame(state, frame))
      .catch(() => undefined);
  }

  #queueClose(state: BindingState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    this.#queueFrame(state, { type: "claude-code.host.closed", uuid: randomUUID(), reason, expected: state.releaseRequested });
    void state.writeTail.finally(() => {
      this.#bindings.delete(state.bindingId);
      for (const subscription of state.subscriptions) subscription.close();
      state.subscriptions.clear();
    });
  }

  async #recordFrame(state: BindingState, frame: unknown): Promise<void> {
    const cursor = String(++state.cursor);
    const init = readClaudeCodeCliInit(frame);
    if (init && !this.#initMatchesBinding(state, init)) {
      state.protocolRejected = true;
      await this.#appendAndPublish(state, cursor, frame, [bindingUnavailableFact({ frame, state, cursor })]);
      this.#stopAfterProtocolRejection(state);
      return;
    }

    // The CLI does not necessarily emit init until its first user frame. Record
    // every such frame durably, but do not publish a lifecycle fact until the
    // pinned init has established the native Binding identity and capabilities.
    if (!state.initialized && !init) {
      const raw = asRecord(frame);
      if (raw.type !== "claude-code.host.closed") {
        await this.#appendJournal(state.bindingId, {
          kind: "frame", sourceInstanceId: state.sourceInstanceId, cursor, frame, nativeFacts: [],
        });
        state.preInitFrames.push(Object.freeze({ cursor, frame }));
        return;
      }
    }

    if (init) state.initialized = true;
    await this.#appendAndPublish(state, cursor, frame, this.#mapFrame(state, cursor, frame));
    if (init) await this.#flushPreInitFrames(state);
  }

  #mapFrame(state: BindingState, cursor: string, frame: unknown): readonly NativeProviderFact[] {
    return mapClaudeCodeCliFrame(frame, {
      sourceInstanceId: state.sourceInstanceId,
      cursor,
      disposition: state.disposition,
      activeCorrelation: activeCorrelation(state),
      correlationForCommandUuid: (commandUuid) => state.deliveries.get(commandUuid),
    });
  }

  async #flushPreInitFrames(state: BindingState): Promise<void> {
    const frames = state.preInitFrames.splice(0, state.preInitFrames.length);
    for (const entry of frames) {
      await this.#appendAndPublish(state, entry.cursor, entry.frame, this.#mapFrame(state, entry.cursor, entry.frame));
    }
  }

  async #appendAndPublish(state: BindingState, cursor: string, frame: unknown, nativeFacts: readonly NativeProviderFact[]): Promise<void> {
    await this.#appendJournal(state.bindingId, { kind: "frame", sourceInstanceId: state.sourceInstanceId, cursor, frame, nativeFacts });
    for (const fact of nativeFacts) {
      for (const subscription of state.subscriptions) subscription.push(fact);
    }
    const raw = asRecord(frame);
    if (raw.type === "result" || (raw.type === "command_lifecycle" && raw.state === "cancelled")) {
      const commandUuid = string(raw.user_message_uuid) ?? string(raw.command_uuid);
      if (commandUuid && state.activeCommandUuid === commandUuid) state.activeCommandUuid = undefined;
    }
  }

  #stopAfterProtocolRejection(state: BindingState): void {
    try { state.process.stdin.end(); } catch { /* close event remains the fact source */ }
    try { state.process.kill("SIGTERM"); } catch { /* process may already be gone */ }
  }

  #initMatchesBinding(state: BindingState, init: { readonly sessionId: string; readonly providerVersion: string; readonly capabilities: readonly string[] }): boolean {
    return init.sessionId === state.nativeBindingRef
      && init.providerVersion === state.profile.providerVersion
      && cliInitSupportsRequiredCapabilities(init);
  }

  #profileSupported(profile: ExecutionProfileDefinition): boolean {
    return isSafeCliValue(profile.model)
      && profile.capabilityPolicy.allowedTools.length === 0
      && profile.capabilityPolicy.maxConcurrentTurns === 1
      && profile.capabilityPolicy.maxNativeChildren === 0
      && profile.capabilityPolicy.requiredCapabilities
        .every((capability) => CLAUDE_CODE_PROVEN_CAPABILITIES.includes(capability));
  }

  async #appendJournal(bindingId: string, entry: JournalEntry): Promise<void> {
    await mkdir(this.#journalDirectory, { recursive: true, mode: 0o700 });
    await appendFile(this.#journalPath(bindingId), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async #readJournal(bindingId: string): Promise<readonly JournalEntry[]> {
    try {
      const body = await readFile(this.#journalPath(bindingId), "utf8");
      const entries: JournalEntry[] = [];
      for (const line of body.split("\n")) {
        if (!line) continue;
        try {
          const entry = parseJournalEntry(JSON.parse(line));
          if (entry) entries.push(entry);
        } catch {
          // An incomplete trailing write cannot manufacture a Provider fact.
        }
      }
      return Object.freeze(entries);
    } catch (error) {
      if (isMissingFile(error)) return Object.freeze([]);
      throw new Error("claude_code_journal_read_failed");
    }
  }

  #journalPath(bindingId: string): string {
    const digest = createHash("sha256").update(requiredString(bindingId, "claude_code_binding_id_required")).digest("hex");
    return join(this.#journalDirectory, `${digest}.jsonl`);
  }
}

type BindingState = {
  readonly bindingId: string;
  readonly nativeBindingRef: string;
  readonly disposition: "create" | "resume";
  readonly profile: ExecutionProfileDefinition;
  readonly sourceInstanceId: string;
  readonly process: ClaudeCodeProcess;
  readonly deliveries: Map<string, ClaudeCodeCliDeliveryCorrelation>;
  readonly subscriptions: Set<FactSubscription>;
  cursor: number;
  stdoutBuffer: string;
  writeTail: Promise<void>;
  activeCommandUuid?: string;
  protocolRejected?: boolean;
  releaseRequested: boolean;
  initialized: boolean;
  preInitFrames: BufferedNativeFrame[];
  closed: boolean;
};

type BufferedNativeFrame = Readonly<{ readonly cursor: string; readonly frame: unknown }>;

type JournalEntry =
  | Readonly<{ readonly kind: "binding"; readonly nativeBindingRef: string; readonly disposition: "create" | "resume"; readonly sourceInstanceId: string }>
  | Readonly<{ readonly kind: "delivery"; readonly commandUuid: string; readonly inputSubmissionId: string; readonly invocationId?: string }>
  | Readonly<{ readonly kind: "interrupt"; readonly requestId: string; readonly commandUuid?: string; readonly invocationId?: string }>
  | Readonly<{ readonly kind: "release" }>
  | Readonly<{ readonly kind: "frame"; readonly sourceInstanceId: string; readonly cursor: string; readonly frame: unknown; readonly nativeFacts: readonly NativeProviderFact[] }>;

function lastJournalBinding(entries: readonly JournalEntry[]): Extract<JournalEntry, { readonly kind: "binding" }> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "binding") return entry;
  }
  return undefined;
}

/** Recover only the current native-session chain; another native ref is a hard boundary. */
function recoverDeliveryState(entries: readonly JournalEntry[], nativeBindingRef: string): {
  readonly deliveries: Map<string, ClaudeCodeCliDeliveryCorrelation>;
  readonly activeCommandUuid?: string;
} {
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "binding" && entry.nativeBindingRef !== nativeBindingRef) {
      start = index + 1;
      break;
    }
  }
  const deliveries = new Map<string, ClaudeCodeCliDeliveryCorrelation>();
  const active = new Set<string>();
  for (const entry of entries.slice(start)) {
    if (entry.kind === "delivery") {
      deliveries.set(entry.commandUuid, Object.freeze({
        commandUuid: entry.commandUuid,
        inputSubmissionId: entry.inputSubmissionId,
        ...(entry.invocationId ? { invocationId: entry.invocationId } : {}),
      }));
      active.add(entry.commandUuid);
      continue;
    }
    if (entry.kind !== "frame") continue;
    const terminal = terminalCommandUuid(entry.frame);
    if (terminal) active.delete(terminal);
  }
  const activeCommandUuid = [...active].at(-1);
  return activeCommandUuid ? { deliveries, activeCommandUuid } : { deliveries };
}

function terminalCommandUuid(frame: unknown): string | undefined {
  const raw = asRecord(frame);
  if (raw.type === "result") return string(raw.user_message_uuid);
  if (raw.type === "command_lifecycle" && raw.state === "cancelled") return string(raw.command_uuid);
  return undefined;
}

class FactSubscription implements AsyncIterable<NativeProviderFact>, AsyncIterator<NativeProviderFact> {
  readonly #pending: NativeProviderFact[] = [];
  #resolver: ((result: IteratorResult<NativeProviderFact>) => void) | undefined;
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterator<NativeProviderFact> {
    return this;
  }

  next(): Promise<IteratorResult<NativeProviderFact>> {
    const value = this.#pending.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#resolver = resolve; });
  }

  push(fact: NativeProviderFact): void {
    if (this.#closed) return;
    if (this.#resolver) {
      const resolve = this.#resolver;
      this.#resolver = undefined;
      resolve({ done: false, value: fact });
      return;
    }
    this.#pending.push(fact);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const resolve = this.#resolver;
    this.#resolver = undefined;
    resolve?.({ done: true, value: undefined });
  }
}

const defaultSpawn: ClaudeCodeProcessSpawner = (command, args, options) => spawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

function claudeCodeArgs(input: { readonly profile: ExecutionProfileDefinition; readonly nativeBindingRef: string; readonly disposition: "create" | "resume"; readonly bootstrap: ProviderPortBindingRequest["bootstrap"] }): readonly string[] {
  return Object.freeze([
    "--safe-mode",
    "--model", input.profile.model,
    "--tools", "",
    "--permission-mode", "plan",
    "--append-system-prompt", renderProviderSessionBootstrap(input.bootstrap),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--replay-user-messages",
    "--verbose",
    "-p",
    input.disposition === "resume" ? "--resume" : "--session-id",
    input.nativeBindingRef,
  ]);
}

function bindingUnavailableFact(input: { readonly frame: unknown; readonly state: BindingState; readonly cursor: string }): NativeProviderFact {
  const raw = asRecord(input.frame);
  return Object.freeze({
    kind: "claude-code.binding.unavailable",
    providerEventId: string(raw.uuid) ?? `claude-code:${input.state.sourceInstanceId}:${input.cursor}`,
    sourceInstanceId: input.state.sourceInstanceId,
    cursor: input.cursor,
    payload: { reason: "claude_code_init_protocol_mismatch" },
  });
}

function activeCorrelation(state: BindingState): ClaudeCodeCliDeliveryCorrelation | undefined {
  return state.activeCommandUuid ? state.deliveries.get(state.activeCommandUuid) : undefined;
}

function requireBindingRequest(value: unknown): ProviderPortBindingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("claude_code_binding_request_invalid");
  const request = value as ProviderPortBindingRequest;
  requiredString(request.bindingId, "claude_code_binding_id_required");
  requiredAbsolutePath(request.workspace?.cwd, "claude_code_workspace_cwd_invalid");
  if (!request.executionProfile) throw new Error("claude_code_execution_profile_required");
  return request;
}

function isEnsureBindingRequest(value: unknown): value is ProviderPortBindingRequest & Readonly<{ readonly disposition: "create" | "resume" }> {
  return Boolean(value && typeof value === "object" && ((value as { disposition?: unknown }).disposition === "create" || (value as { disposition?: unknown }).disposition === "resume"));
}

function isSubmitDeliveryRequest(value: unknown): value is ProviderPortBindingRequest & Readonly<{
  readonly inputSubmissionId: string;
  readonly idempotencyKey: string;
  readonly content: string;
}> {
  if (!value || typeof value !== "object") return false;
  const request = value as { inputSubmissionId?: unknown; idempotencyKey?: unknown; content?: unknown };
  return Boolean(string(request.inputSubmissionId) && string(request.idempotencyKey) && typeof request.content === "string");
}

function isInterruptRequest(value: unknown): value is ProviderPortBindingRequest & Readonly<{ readonly idempotencyKey: string }> {
  return Boolean(value && typeof value === "object" && string((value as { idempotencyKey?: unknown }).idempotencyKey));
}

function parseJournalEntry(value: unknown): JournalEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nativeBindingRef = string(record.nativeBindingRef);
  const sourceInstanceId = string(record.sourceInstanceId);
  const commandUuid = string(record.commandUuid);
  const inputSubmissionId = string(record.inputSubmissionId);
  const requestId = string(record.requestId);
  const invocationId = string(record.invocationId);
  const cursor = string(record.cursor);
  if (record.kind === "binding" && nativeBindingRef && sourceInstanceId
    && (record.disposition === "create" || record.disposition === "resume")) {
    return Object.freeze({ kind: "binding", nativeBindingRef, sourceInstanceId, disposition: record.disposition });
  }
  if (record.kind === "delivery" && commandUuid && inputSubmissionId) {
    return Object.freeze({ kind: "delivery", commandUuid, inputSubmissionId, ...(invocationId ? { invocationId } : {}) });
  }
  if (record.kind === "interrupt" && requestId) {
    return Object.freeze({ kind: "interrupt", requestId, ...(commandUuid ? { commandUuid } : {}), ...(invocationId ? { invocationId } : {}) });
  }
  if (record.kind === "release") return Object.freeze({ kind: "release" });
  if (record.kind === "frame" && sourceInstanceId && cursor && Array.isArray(record.nativeFacts)) {
    const nativeFacts = record.nativeFacts.filter(isNativeProviderFact);
    return Object.freeze({ kind: "frame", sourceInstanceId, cursor, frame: record.frame, nativeFacts: Object.freeze(nativeFacts) });
  }
  return undefined;
}

function isNativeProviderFact(value: unknown): value is NativeProviderFact {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && string((value as { kind?: unknown }).kind)
    && (string((value as { providerEventId?: unknown }).providerEventId)
      || (string((value as { sourceInstanceId?: unknown }).sourceInstanceId) && string((value as { cursor?: unknown }).cursor))));
}

function writeJsonLine(stream: Writable, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function requiredString(value: unknown, code: string): string {
  const result = string(value);
  if (!result) throw new Error(code);
  return result;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Values which become a discrete Claude CLI argv entry, never a shell fragment. */
function isSafeCliValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value);
}

function requiredAbsolutePath(value: unknown, code: string): string {
  const path = requiredString(value, code);
  if (!isAbsolute(path)) throw new Error(code);
  return path;
}

function freezeEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") throw new Error("claude_code_environment_invalid");
    result[name] = value;
  }
  return Object.freeze(result);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}
