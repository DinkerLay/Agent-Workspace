import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ProtocolPin } from "@agent-workspace/provider-port";
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
  CodexAppServerConnectionInput,
  CodexAppServerInboundMessage,
  CodexAppServerJsonRpcId,
} from "@agent-workspace/provider-codex";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_PROBE_OUTPUT_BYTES = 1024 * 1024;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "OPENAI_API_KEY",
]);

export type CodexAppServerSchemaFiles = Readonly<Record<string, string | Uint8Array>>;

export type CodexAppServerClientInfo = Readonly<{
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}>;

export type CodexAppServerBridgeOptions = Readonly<{
  /** Absolute path to the verified Codex executable, never a shell expression. */
  readonly command: string;
  /** Binding-independent safe cwd for protocol probes. */
  readonly cwd: string;
  /** Explicit allowlist; process.env is never merged into the child environment. */
  readonly environment: Readonly<Record<string, string>>;
  /** Host-private parent directory for temporary generated schema bundles. */
  readonly protocolDirectory: string;
  /** Expected CLI version and canonical generated-schema fingerprint. */
  readonly protocol: ProtocolPin;
  readonly requestTimeoutMs?: number;
  readonly clientInfo?: CodexAppServerClientInfo;
  readonly spawn?: CodexAppServerSpawn;
  /** Test seam for the explicit CLI version + generated-schema verification. */
  readonly protocolProbe?: CodexAppServerProtocolProbe;
}>;

export type CodexAppServerInitialization = Readonly<{
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}>;

export type CodexAppServerSpawnOptions = Readonly<{
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}>;

export interface CodexAppServerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions,
) => CodexAppServerChild;

export type CodexAppServerProtocolProbeInput = Readonly<{
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly protocolDirectory: string;
  readonly expectedProtocol: ProtocolPin;
  readonly timeoutMs: number;
}>;

/**
 * Observes the installed CLI version and its generated App Server schema. It
 * is independently injectable so focused tests never need a real Codex CLI.
 */
export interface CodexAppServerProtocolProbe {
  inspect(input: CodexAppServerProtocolProbeInput): Promise<ProtocolPin>;
}

export type CodexAppServerProtocolCommand = Readonly<{
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}>;

export type CodexAppServerProtocolCommandRunner = (
  input: CodexAppServerProtocolCommand,
) => Promise<Readonly<{ readonly stdout: string }>>;

/** Safe code for logs/UI; raw child output is deliberately never exposed. */
export class CodexAppServerBridgeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexAppServerBridgeError";
    this.code = code;
  }
}

/**
 * Creates a binding-isolated App Server factory. Every child runs exactly
 * `codex app-server --stdio` with shell:false and only the explicit Host
 * environment. The App Server's global user configuration is never inherited
 * implicitly: CODEX_HOME is required in that environment.
 */
export function createCodexAppServerConnectionFactory(options: CodexAppServerBridgeOptions): CodexAppServerConnectionFactory {
  const config = normalizeBridgeOptions(options);
  let probe: Promise<ProtocolPin> | undefined;
  const inspectSingleFlight = (): Promise<ProtocolPin> => {
    if (probe) return probe;
    const pending = inspect(config);
    probe = pending;
    const clear = () => {
      if (probe === pending) probe = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };

  return Object.freeze({
    inspectProtocol(): Promise<ProtocolPin> {
      return inspectSingleFlight();
    },
    async create(input: CodexAppServerConnectionInput): Promise<CodexAppServerConnection> {
      assertProtocolEquals(input.protocol, config.protocol);
      assertAbsolutePath(input.workspace.cwd, "codex_app_server_workspace_cwd_invalid");
      // ProviderPort normally invokes inspectProtocol() before binding work, but
      // the factory itself must also fail closed for any direct caller.
      await inspectSingleFlight();
      const connection = spawnConnection({ ...config, cwd: input.workspace.cwd });
      try {
        await initialize(connection, config);
        return connection;
      } catch (error) {
        await connection.close();
        throw error;
      }
    },
  });
}

/**
 * Stable pin helper for an explicitly generated App Server schema bundle. It
 * hashes sorted relative paths and a digest of each file, not filesystem order.
 * Generated JSON schemas are canonicalized by object key before hashing because
 * Codex can serialize equivalent schema maps in a different key order.
 */
export function createCodexAppServerProtocolPin(input: {
  readonly providerVersion: string;
  readonly schemaFiles: CodexAppServerSchemaFiles;
}): ProtocolPin {
  const providerVersion = requiredText(input.providerVersion, "codex_app_server_provider_version_invalid");
  const entries = Object.entries(input.schemaFiles ?? {});
  if (entries.length === 0) throw new CodexAppServerBridgeError("codex_app_server_schema_files_required");
  const root = createHash("sha256");
  for (const [relativePath, contents] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    assertSchemaPath(relativePath);
    const bytes = canonicalSchemaBytes(relativePath, contents);
    const fileDigest = createHash("sha256").update(bytes).digest("hex");
    root.update(relativePath, "utf8");
    root.update("\0", "utf8");
    root.update(fileDigest, "utf8");
    root.update("\n", "utf8");
  }
  return Object.freeze({
    providerVersion,
    protocolFingerprint: `sha256:${root.digest("hex")}`,
  });
}

function canonicalSchemaBytes(relativePath: string, contents: string | Uint8Array): Buffer {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  if (!relativePath.endsWith(".json")) return bytes;
  try {
    return Buffer.from(canonicalJson(JSON.parse(bytes.toString("utf8"))), "utf8");
  } catch {
    throw new CodexAppServerBridgeError("codex_app_server_schema_json_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Default real protocol probe. It verifies the executable's reported version,
 * regenerates its schema into a unique Host-private child directory, hashes
 * that bundle, and removes only that generated child in all outcomes.
 */
export function createCodexAppServerProtocolProbe(options: Readonly<{
  readonly runCommand?: CodexAppServerProtocolCommandRunner;
}> = {}): CodexAppServerProtocolProbe {
  const runCommand = options.runCommand ?? runCodexProtocolCommand;
  return Object.freeze({
    async inspect(input: CodexAppServerProtocolProbeInput): Promise<ProtocolPin> {
      assertAbsolutePath(input.command, "codex_app_server_command_must_be_absolute");
      assertAbsolutePath(input.cwd, "codex_app_server_cwd_invalid");
      assertAbsolutePath(input.protocolDirectory, "codex_app_server_protocol_directory_invalid");
      const expected = normalizeProtocol(input.expectedProtocol);
      const versionOutput = await runCommand({
        command: input.command,
        args: ["--version"],
        cwd: input.cwd,
        environment: input.environment,
        timeoutMs: input.timeoutMs,
      });
      const providerVersion = parseCodexCliVersion(versionOutput.stdout);
      if (providerVersion !== expected.providerVersion) {
        throw new CodexAppServerBridgeError("codex_app_server_version_mismatch");
      }

      const schemaDirectory = await createSchemaDirectory(input.protocolDirectory);
      try {
        await runCommand({
          command: input.command,
          args: ["app-server", "generate-json-schema", "--out", schemaDirectory],
          cwd: input.cwd,
          environment: input.environment,
          timeoutMs: input.timeoutMs,
        });
        const schemaFiles = await readGeneratedSchemaFiles(schemaDirectory);
        const observed = createCodexAppServerProtocolPin({ providerVersion, schemaFiles });
        if (observed.protocolFingerprint !== expected.protocolFingerprint) {
          throw new CodexAppServerBridgeError("codex_app_server_schema_fingerprint_mismatch");
        }
        return observed;
      } finally {
        await removeSchemaDirectory(schemaDirectory);
      }
    },
  });
}

async function inspect(config: NormalizedBridgeOptions): Promise<ProtocolPin> {
  const observedProtocol = await config.protocolProbe.inspect({
    command: config.command,
    cwd: config.cwd,
    environment: config.environment,
    protocolDirectory: config.protocolDirectory,
    expectedProtocol: config.protocol,
    timeoutMs: config.requestTimeoutMs,
  });
  assertProtocolEquals(normalizeProtocol(observedProtocol), config.protocol);
  const connection = spawnConnection(config);
  try {
    await initialize(connection, config);
    return observedProtocol;
  } finally {
    await connection.close();
  }
}

async function createSchemaDirectory(protocolDirectory: string): Promise<string> {
  try {
    await mkdir(protocolDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(protocolDirectory, "codex-app-server-schema-"));
    await chmod(directory, 0o700);
    return directory;
  } catch {
    throw new CodexAppServerBridgeError("codex_app_server_schema_directory_create_failed");
  }
}

async function removeSchemaDirectory(directory: string): Promise<void> {
  try {
    // `directory` comes solely from mkdtemp() under the Host-provided parent.
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Do not report a successful protocol observation while its Host-private
    // generated bundle remains on disk unexpectedly.
    throw new CodexAppServerBridgeError("codex_app_server_schema_directory_cleanup_failed");
  }
}

async function readGeneratedSchemaFiles(root: string): Promise<CodexAppServerSchemaFiles> {
  const files: Record<string, Uint8Array> = {};
  try {
    await collectSchemaFiles(root, root, files);
  } catch (error) {
    if (error instanceof CodexAppServerBridgeError) throw error;
    throw new CodexAppServerBridgeError("codex_app_server_schema_read_failed");
  }
  if (Object.keys(files).length === 0) throw new CodexAppServerBridgeError("codex_app_server_schema_files_required");
  return Object.freeze(files);
}

async function collectSchemaFiles(root: string, directory: string, files: Record<string, Uint8Array>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSchemaFiles(root, path, files);
      continue;
    }
    if (!entry.isFile()) throw new CodexAppServerBridgeError("codex_app_server_schema_entry_invalid");
    const schemaPath = relative(root, path).split(sep).join("/");
    assertSchemaPath(schemaPath);
    files[schemaPath] = await readFile(path);
  }
}

function parseCodexCliVersion(output: string): string {
  const match = /^codex-cli\s+([^\s]+)\s*$/m.exec(output);
  if (!match?.[1]) throw new CodexAppServerBridgeError("codex_app_server_version_output_invalid");
  return match[1];
}

function runCodexProtocolCommand(input: CodexAppServerProtocolCommand): Promise<Readonly<{ readonly stdout: string }>> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const finish = (value: Readonly<{ readonly stdout: string }> | CodexAppServerBridgeError, failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failed) reject(value);
      else resolve(value as Readonly<{ readonly stdout: string }>);
    };
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* child failure is normalized below */ }
      finish(new CodexAppServerBridgeError("codex_app_server_protocol_probe_timeout"), true);
    }, input.timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutBytes += Buffer.byteLength(text, "utf8");
      if (stdoutBytes > MAX_PROTOCOL_PROBE_OUTPUT_BYTES) {
        try { child.kill("SIGTERM"); } catch { /* normalized below */ }
        finish(new CodexAppServerBridgeError("codex_app_server_protocol_probe_output_too_large"), true);
        return;
      }
      stdout += text;
    });
    // Provider diagnostics may include sensitive installation details. Consume
    // stderr for backpressure but never retain or expose it.
    child.stderr.resume();
    child.once("error", () => finish(new CodexAppServerBridgeError("codex_app_server_protocol_probe_spawn_failed"), true));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new CodexAppServerBridgeError("codex_app_server_protocol_probe_failed"), true);
        return;
      }
      finish(Object.freeze({ stdout }), false);
    });
  });
}

async function initialize(connection: CodexAppServerProcessConnection, config: NormalizedBridgeOptions): Promise<void> {
  await connection.initialize(config.clientInfo);
}

type NormalizedBridgeOptions = Readonly<{
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly protocolDirectory: string;
  readonly protocol: ProtocolPin;
  readonly requestTimeoutMs: number;
  readonly clientInfo: CodexAppServerClientInfo;
  readonly spawn: CodexAppServerSpawn;
  readonly protocolProbe: CodexAppServerProtocolProbe;
}>;

function normalizeBridgeOptions(options: CodexAppServerBridgeOptions): NormalizedBridgeOptions {
  assertAbsolutePath(options.command, "codex_app_server_command_must_be_absolute");
  assertAbsolutePath(options.cwd, "codex_app_server_cwd_invalid");
  assertAbsolutePath(options.protocolDirectory, "codex_app_server_protocol_directory_invalid");
  const protocol = normalizeProtocol(options.protocol);
  const environment = normalizeEnvironment(options.environment);
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new CodexAppServerBridgeError("codex_app_server_request_timeout_invalid");
  }
  const clientInfo: CodexAppServerClientInfo = Object.freeze({
    name: requiredText(options.clientInfo?.name ?? "agent-workspace", "codex_app_server_client_name_invalid"),
    title: options.clientInfo?.title ?? "Agent Workspace",
    version: requiredText(options.clientInfo?.version ?? "1", "codex_app_server_client_version_invalid"),
  });
  return Object.freeze({
    command: options.command,
    cwd: options.cwd,
    environment,
    protocolDirectory: options.protocolDirectory,
    protocol,
    requestTimeoutMs: timeout,
    clientInfo,
    spawn: options.spawn ?? defaultSpawn,
    protocolProbe: options.protocolProbe ?? createCodexAppServerProtocolProbe(),
  });
}

function normalizeEnvironment(value: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexAppServerBridgeError("codex_app_server_environment_required");
  }
  const copied: NodeJS.ProcessEnv = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key) || typeof candidate !== "string" || !candidate) {
      throw new CodexAppServerBridgeError("codex_app_server_environment_invalid");
    }
    copied[key] = candidate;
  }
  const codexHome = copied.CODEX_HOME;
  if (!codexHome || !isAbsolute(codexHome)) {
    throw new CodexAppServerBridgeError("codex_app_server_codex_home_required");
  }
  // Freeze a new object so the caller cannot mutate the child environment after
  // construction. Nothing from process.env is merged here.
  return Object.freeze({ ...copied });
}

function normalizeProtocol(value: ProtocolPin): ProtocolPin {
  const providerVersion = requiredText(value?.providerVersion, "codex_app_server_protocol_version_invalid");
  const protocolFingerprint = requiredText(value?.protocolFingerprint, "codex_app_server_protocol_fingerprint_invalid");
  if (!/^sha256:[a-f0-9]{64}$/i.test(protocolFingerprint)) {
    throw new CodexAppServerBridgeError("codex_app_server_protocol_fingerprint_invalid");
  }
  return Object.freeze({ providerVersion, protocolFingerprint: protocolFingerprint.toLowerCase() });
}

function assertProtocolEquals(actual: ProtocolPin, expected: ProtocolPin): void {
  if (actual?.providerVersion !== expected.providerVersion || actual?.protocolFingerprint !== expected.protocolFingerprint) {
    throw new CodexAppServerBridgeError("codex_app_server_protocol_pin_mismatch");
  }
}

function assertSchemaPath(value: string): void {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CodexAppServerBridgeError("codex_app_server_schema_path_invalid");
  }
}

function assertAbsolutePath(value: string | undefined, code: string): void {
  if (typeof value !== "string" || !isAbsolute(value)) throw new CodexAppServerBridgeError(code);
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexAppServerBridgeError(code);
  return value;
}

const defaultSpawn: CodexAppServerSpawn = (command, args, options) => nodeSpawn(command, [...args], {
  cwd: options.cwd,
  env: options.env,
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
}) as unknown as CodexAppServerChild;

function spawnConnection(config: NormalizedBridgeOptions): CodexAppServerProcessConnection {
  const child = config.spawn(config.command, ["app-server", "--stdio"], {
    cwd: config.cwd,
    env: config.environment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new CodexAppServerProcessConnection(child, config.requestTimeoutMs);
}

class CodexAppServerProcessConnection implements CodexAppServerConnection {
  readonly instanceId = `codex_app_server_${randomUUID()}`;
  readonly #child: CodexAppServerChild;
  readonly #requestTimeoutMs: number;
  readonly #events = new InboundQueue();
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 0;
  #buffer = "";
  #closed = false;
  #initialize: Promise<CodexAppServerInitialization> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(child: CodexAppServerChild, requestTimeoutMs: number) {
    this.#child = child;
    this.#requestTimeoutMs = requestTimeoutMs;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    // Stderr can include native credentials or provider diagnostics. Consume it
    // only to prevent backpressure; never retain or expose it.
    child.stderr.resume();
    child.once("error", () => this.#fail("codex_app_server_spawn_failed"));
    child.once("close", () => this.#fail("codex_app_server_connection_closed"));
  }

  initialize(clientInfo: CodexAppServerClientInfo): Promise<CodexAppServerInitialization> {
    this.#initialize ??= this.request<unknown>("initialize", {
      clientInfo: {
        name: clientInfo.name,
        title: clientInfo.title ?? null,
        version: clientInfo.version,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }).then(validateInitialization);
    return this.#initialize;
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.#closed) throw new CodexAppServerBridgeError("codex_app_server_connection_closed");
    const id = ++this.#nextId;
    const key = requestKey(id);
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        reject(new CodexAppServerBridgeError("codex_app_server_request_timeout"));
      }, this.#requestTimeoutMs);
      this.#pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    try {
      await this.#write({ jsonrpc: "2.0", id, method: requiredText(method, "codex_app_server_method_invalid"), params });
    } catch (error) {
      const pending = this.#pending.get(key);
      this.#pending.delete(key);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new CodexAppServerBridgeError("codex_app_server_stdin_failed"));
      }
    }
    return result;
  }

  events(): AsyncIterable<CodexAppServerInboundMessage> {
    return this.#events.subscribe();
  }

  respond(id: CodexAppServerJsonRpcId, result: unknown): Promise<void> {
    if (!isJsonRpcId(id)) return Promise.reject(new CodexAppServerBridgeError("codex_app_server_response_id_invalid"));
    return this.#write({ jsonrpc: "2.0", id, result });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = new Promise((resolve) => {
      if (this.#closed) {
        resolve();
        return;
      }
      const finish = () => resolve();
      // Stop accepting new requests before asking the owned child to exit. The
      // close event remains the native confirmation, while repeated close calls
      // reuse this same promise.
      this.#fail("codex_app_server_connection_closed");
      this.#child.once("close", finish);
      try {
        this.#child.kill("SIGTERM");
      } catch {
        finish();
      }
      setTimeout(finish, 1_000).unref();
    });
    return this.#closePromise;
  }

  async #write(value: unknown): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(value)}\n`;
    } catch {
      throw new CodexAppServerBridgeError("codex_app_server_message_not_json");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error?: Error | null) => error ? reject(new CodexAppServerBridgeError("codex_app_server_stdin_failed")) : resolve());
    });
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_JSON_LINE_BYTES) {
      this.#fail("codex_app_server_message_too_large");
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail("codex_app_server_invalid_json");
        return;
      }
      this.#handleMessage(message);
      if (this.#closed) return;
    }
  }

  #handleMessage(value: unknown): void {
    const record = asRecord(value);
    if (!record) return this.#fail("codex_app_server_message_invalid");
    const id = record.id;
    const method = typeof record.method === "string" ? record.method : undefined;
    if (isJsonRpcId(id) && ("result" in record || "error" in record)) {
      const pending = this.#pending.get(requestKey(id));
      if (!pending) return;
      this.#pending.delete(requestKey(id));
      clearTimeout(pending.timeout);
      if ("error" in record && record.error !== undefined && record.error !== null) {
        pending.reject(new CodexAppServerBridgeError(jsonRpcErrorCode(record.error) ?? "codex_app_server_rpc_error"));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (!method) return this.#fail("codex_app_server_message_invalid");
    const params = record.params;
    const emittedAtMs = typeof record.emittedAtMs === "number" && Number.isFinite(record.emittedAtMs)
      ? record.emittedAtMs
      : undefined;
    if (isJsonRpcId(id)) {
      this.#events.push({ kind: "server_request", method, params, id, ...(emittedAtMs !== undefined ? { emittedAtMs } : {}) });
      return;
    }
    this.#events.push({ kind: "notification", method, params, ...(emittedAtMs !== undefined ? { emittedAtMs } : {}) });
  }

  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerBridgeError(code));
    }
    this.#pending.clear();
    this.#events.close();
  }
}

type PendingRequest = Readonly<{
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}>;

function validateInitialization(value: unknown): CodexAppServerInitialization {
  const record = asRecord(value);
  return Object.freeze({
    userAgent: requiredText(record?.userAgent, "codex_app_server_initialize_invalid"),
    codexHome: requiredText(record?.codexHome, "codex_app_server_initialize_invalid"),
    platformFamily: requiredText(record?.platformFamily, "codex_app_server_initialize_invalid"),
    platformOs: requiredText(record?.platformOs, "codex_app_server_initialize_invalid"),
  });
}

function requestKey(value: CodexAppServerJsonRpcId): string {
  return `${typeof value}:${String(value)}`;
}

function isJsonRpcId(value: unknown): value is CodexAppServerJsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Preserve only a JSON-RPC's numeric class for an operator-visible failure
 * code. The server's message/data can contain project or account detail and
 * must never leave the Host bridge.
 */
function jsonRpcErrorCode(value: unknown): string | undefined {
  const error = asRecord(value);
  const code = error?.code;
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return undefined;
  const base = `codex_app_server_rpc_${code}`;
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  const category = message.includes("clientusermessageid") || message.includes("client_user_message_id")
    ? "client_user_message_id"
    : message.includes("text_elements") || message.includes("textelements")
      ? "text_elements"
      : message.includes("sandbox")
        ? "sandbox"
        : message.includes("approval")
          ? "approval_policy"
          : message.includes("input")
            ? "input"
            : message.includes("model")
              ? "model"
              : message.includes("cwd")
                ? "cwd"
                : undefined;
  return category ? `${base}_${category}` : base;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A single consumer is sufficient: one App Server connection belongs to one Binding. */
class InboundQueue {
  readonly #items: CodexAppServerInboundMessage[] = [];
  #waiter: ((result: IteratorResult<CodexAppServerInboundMessage>) => void) | undefined;
  #active = false;
  #closed = false;

  push(value: CodexAppServerInboundMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  subscribe(): AsyncIterable<CodexAppServerInboundMessage> {
    if (this.#active) throw new CodexAppServerBridgeError("codex_app_server_observer_already_active");
    this.#active = true;
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<CodexAppServerInboundMessage> {
        return {
          next: () => queue.#next(),
          return: async () => {
            queue.#active = false;
            const waiter = queue.#waiter;
            queue.#waiter = undefined;
            waiter?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  #next(): Promise<IteratorResult<CodexAppServerInboundMessage>> {
    const value = this.#items.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}
