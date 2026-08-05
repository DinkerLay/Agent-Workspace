const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createOpenCodeServerClient } = require("./server-client.cjs");
const { createOpenCodePresentationGateway } = require("./presentation-gateway.cjs");

/**
 * Owns one loopback-only `opencode serve` child per canonical project root.
 * A Task Run or another scoped owner holds a reference to that shared
 * transport, but the host never owns Task/Run lifecycle or Provider Session
 * bindings.
 */
function createOpenCodeServerManager({
  opencodePath,
  spawn = childProcess.spawn,
  fetchImpl = globalThis.fetch,
  reservePort = reserveLoopbackPort,
  expectedProviderVersion,
  expectedOpenApiVersion = "3.1.0",
  startupTimeoutMs = 10_000,
  idleShutdownMs = 30_000,
  now = () => Date.now(),
  wait = delay,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createPresentationGateway = createOpenCodePresentationGateway,
} = {}) {
  if (!String(opencodePath ?? "").trim()) throw new Error("opencode_server_path_required");
  const hosts = new Map();
  const ownerHosts = new Map();

  async function ensureOwner({ ownerId, cwd, config, leaseId = "runtime" } = {}) {
    const key = ownerKey(ownerId);
    const normalizedCwd = canonicalProjectRoot(cwd);
    const previousHostKey = ownerHosts.get(key);
    if (previousHostKey && previousHostKey !== normalizedCwd) {
      throw new Error("opencode_server_owner_cwd_conflict");
    }

    const host = hosts.get(normalizedCwd) ?? createHost({ key: normalizedCwd, cwd: normalizedCwd, config });
    if (!hosts.has(normalizedCwd)) hosts.set(normalizedCwd, host);
    assertHostConfig(host, config);
    cancelIdleShutdown(host);
    const leases = host.ownerLeases.get(key) ?? new Set();
    leases.add(requiredString(leaseId, "opencode_server_lease_id_required"));
    host.ownerLeases.set(key, leases);
    ownerHosts.set(key, host.key);

    if (host.ready) return publicOwnerServer(host, { ownerId: key });
    if (!host.starting) {
      host.starting = start(host, config).finally(() => { host.starting = undefined; });
    }
    await host.starting;
    return publicOwnerServer(host, { ownerId: key });
  }

  function getOwner({ ownerId } = {}) {
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    return host?.ready ? publicOwnerServer(host, { ownerId: key }) : undefined;
  }

  function clientForOwner({ ownerId } = {}) {
    const host = hosts.get(ownerHosts.get(ownerKey(ownerId)));
    if (!host?.ready) throw new Error("opencode_server_owner_not_ready");
    return host.client;
  }

  function subscribeOwner({ ownerId, onEvent } = {}) {
    if (typeof onEvent !== "function") throw new Error("opencode_server_event_listener_required");
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    if (!host?.ready) throw new Error("opencode_server_owner_not_ready");
    const listeners = host.eventListenersByOwner.get(key) ?? new Set();
    listeners.add(onEvent);
    host.eventListenersByOwner.set(key, listeners);
    if (!host.eventLoop) {
      host.eventLoop = consumeHostEvents(host).finally(() => { host.eventLoop = undefined; });
    }
    return () => {
      const current = host.eventListenersByOwner.get(key);
      current?.delete(onEvent);
      if (!current?.size) host.eventListenersByOwner.delete(key);
    };
  }

  async function stopOwner({ ownerId } = {}) {
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    if (!host) return false;
    await host.presentationGateway?.releaseOwner?.({ ownerId: key });
    ownerHosts.delete(key);
    host.ownerLeases.delete(key);
    host.eventListenersByOwner.delete(key);
    if (!host.ownerLeases.size) scheduleIdleShutdown(host);
    return true;
  }

  async function releaseOwner({ ownerId, leaseId } = {}) {
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    if (!host) return false;
    const normalizedLeaseId = requiredString(leaseId, "opencode_server_lease_id_required");
    const leases = host.ownerLeases.get(key);
    if (!leases?.delete(normalizedLeaseId)) return false;
    await host.presentationGateway?.releasePresentation?.({ ownerId: key, leaseId: normalizedLeaseId });
    if (leases.size) return true;
    host.ownerLeases.delete(key);
    ownerHosts.delete(key);
    host.eventListenersByOwner.delete(key);
    if (!host.ownerLeases.size) scheduleIdleShutdown(host);
    return true;
  }

  async function ensureRun({ taskId, runId, cwd, config, leaseId = "runtime" } = {}) {
    const ownerId = runOwnerId(taskId, runId);
    const normalizedCwd = canonicalProjectRoot(cwd);
    const previousHostKey = ownerHosts.get(ownerId);
    if (previousHostKey && previousHostKey !== normalizedCwd) {
      throw new Error("opencode_server_run_cwd_conflict");
    }
    const server = await ensureOwner({ ownerId, cwd, config, leaseId });
    return publicRunServer(server, { taskId, runId });
  }

  function getRun({ taskId, runId } = {}) {
    const server = getOwner({ ownerId: runOwnerId(taskId, runId) });
    return server ? publicRunServer(server, { taskId, runId }) : undefined;
  }

  function clientForRun({ taskId, runId } = {}) {
    const host = hosts.get(ownerHosts.get(runOwnerId(taskId, runId)));
    if (!host?.ready) throw new Error("opencode_server_run_not_ready");
    return host.client;
  }

  function subscribeRun({ taskId, runId, onEvent } = {}) {
    if (typeof onEvent !== "function") throw new Error("opencode_server_event_listener_required");
    const ownerId = runOwnerId(taskId, runId);
    const host = hosts.get(ownerHosts.get(ownerId));
    if (!host?.ready) throw new Error("opencode_server_run_not_ready");
    return subscribeOwner({ ownerId, onEvent });
  }

  /**
   * Registers one revocable official-WebUI presentation route. The shared
   * OpenCode Host owns the proxy transport; a Task/Run only owns this exact
   * lease and its callback for the one bound Provider Session.
   */
  async function registerPresentationGateway({ ownerId, leaseId, providerSessionId, cwd, beforeProviderUserMessage } = {}) {
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    if (!host?.ready) throw new Error("opencode_server_owner_not_ready");
    const normalizedLeaseId = requiredString(leaseId, "opencode_server_lease_id_required");
    if (!host.ownerLeases.get(key)?.has(normalizedLeaseId)) {
      throw new Error("opencode_server_presentation_lease_not_owned");
    }
    // A shared Server can host many Task Runs. The presentation route must
    // remain attached to this owner's canonical Host root, never a caller-
    // supplied sibling directory that happens to reach the same process.
    const requestedPresentationCwd = path.resolve(requiredString(cwd ?? host.cwd, "opencode_server_cwd_required"));
    if (canonicalProjectRoot(requestedPresentationCwd) !== host.cwd) {
      throw new Error("opencode_server_presentation_cwd_conflict");
    }
    if (!host.presentationGateway) {
      host.presentationGateway = createPresentationGateway({ upstreamOrigin: host.origin });
    }
    return host.presentationGateway.registerPresentation({
      ownerId: key,
      leaseId: normalizedLeaseId,
      providerSessionId,
      // Preserve the lexical Task cwd after verifying its canonical root. The
      // official Web UI echoes this same directory in its route/header, while
      // the canonical comparison above prevents a shared Host from accepting
      // another project's directory.
      cwd: requestedPresentationCwd,
      beforeProviderUserMessage,
    });
  }

  async function releasePresentationGateway({ ownerId, leaseId } = {}) {
    const key = ownerKey(ownerId);
    const host = hosts.get(ownerHosts.get(key));
    if (!host?.presentationGateway) return false;
    return host.presentationGateway.releasePresentation({
      ownerId: key,
      leaseId: requiredString(leaseId, "opencode_server_lease_id_required"),
    });
  }

  async function registerRunPresentationGateway({ taskId, runId, ...input } = {}) {
    return registerPresentationGateway({ ...input, ownerId: runOwnerId(taskId, runId) });
  }

  async function releaseRunPresentationGateway({ taskId, runId, leaseId } = {}) {
    return releasePresentationGateway({ ownerId: runOwnerId(taskId, runId), leaseId });
  }

  async function stopRun({ taskId, runId } = {}) {
    return stopOwner({ ownerId: runOwnerId(taskId, runId) });
  }

  async function releaseRun({ taskId, runId, leaseId } = {}) {
    return releaseOwner({ ownerId: runOwnerId(taskId, runId), leaseId });
  }

  async function stopAll() {
    ownerHosts.clear();
    for (const host of [...hosts.values()]) stopHost(host);
  }

  async function start(host, config) {
    host.startError = undefined;
    host.exited = false;
    host.ready = false;
    fs.mkdirSync(host.runtimeDirectory, { recursive: true });
    const port = await reservePort();
    if (host.stopped) throw new Error("opencode_server_host_stopped");
    const origin = `http://127.0.0.1:${port}`;
    const client = createOpenCodeServerClient({
      serverOrigin: origin,
      fetchImpl,
      expectedProviderVersion,
      expectedOpenApiVersion,
    });
    const child = spawn(String(opencodePath), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: host.cwd,
      env: {
        ...process.env,
        ...(config?.environment && typeof config.environment === "object" ? config.environment : {}),
        ...(config?.content && typeof config.content === "object" ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config.content) } : {}),
      },
      stdio: "ignore",
    });
    host.child = child;
    host.origin = origin;
    host.client = client;
    child.once("error", (error) => { host.startError = error instanceof Error ? error.message : "opencode_server_spawn_failed"; });
    child.once("exit", (code, signal) => {
      host.exited = true;
      host.ready = false;
      if (!host.startError) host.startError = `opencode_server_exited:${code ?? "null"}:${signal ?? "none"}`;
    });

    const deadline = now() + Math.max(100, Number(startupTimeoutMs) || 10_000);
    while (now() < deadline) {
      if (host.stopped) throw new Error("opencode_server_host_stopped");
      if (host.startError) throw new Error(host.startError);
      try {
        const capability = await client.health();
        host.ready = true;
        host.capability = capability;
        return;
      } catch (error) {
        if (!isRetryableStartError(error)) throw error;
      }
      await wait(80);
    }
    if (host.child && !host.exited) host.child.kill("SIGTERM");
    throw new Error("opencode_server_start_timeout");
  }

  async function consumeHostEvents(host) {
    while (hosts.get(host.key) === host && host.ready && host.eventListenersByOwner.size) {
      try {
        await consumeOpenCodeEventStream({
          origin: host.origin,
        cwd: host.cwd,
        fetchImpl,
        onEvent: (event) => {
          for (const listeners of host.eventListenersByOwner.values()) {
            for (const listener of listeners) {
              try { listener(event); } catch { /* A Runtime observer must not tear down the Provider stream. */ }
            }
          }
        },
        });
      } catch {
        // Server startup, shutdown, and a dropped HTTP stream are all
        // recoverable. The next loopback connection is authoritative.
      }
      if (hosts.get(host.key) !== host || !host.ready || !host.eventListenersByOwner.size) return;
      await wait(250);
    }
  }

  function scheduleIdleShutdown(host) {
    if (host.idleTimer || host.ownerLeases.size || hosts.get(host.key) !== host) return;
    const shutdownDelay = Math.max(0, Number(idleShutdownMs) || 0);
    if (!shutdownDelay) {
      stopHost(host);
      return;
    }
    host.idleTimer = setTimer(() => {
      host.idleTimer = undefined;
      if (!host.ownerLeases.size) stopHost(host);
    }, shutdownDelay);
    host.idleTimer?.unref?.();
  }

  function cancelIdleShutdown(host) {
    if (!host.idleTimer) return;
    clearTimer(host.idleTimer);
    host.idleTimer = undefined;
  }

  function stopHost(host) {
    if (hosts.get(host.key) !== host) return;
    cancelIdleShutdown(host);
    hosts.delete(host.key);
    host.stopped = true;
    host.ready = false;
    const gateway = host.presentationGateway;
    host.presentationGateway = undefined;
    void gateway?.close?.();
    for (const ownerId of host.ownerLeases.keys()) ownerHosts.delete(ownerId);
    host.ownerLeases.clear();
    host.eventListenersByOwner.clear();
    if (host.child && !host.exited) host.child.kill("SIGTERM");
  }

  function createHost({ key, cwd, config }) {
    return {
      key,
      cwd,
      runtimeDirectory: path.join(cwd, ".agent-workspace", "runtime", "opencode-server"),
      configSignature: stableConfigSignature(config),
      ownerLeases: new Map(),
      eventListenersByOwner: new Map(),
      presentationGateway: undefined,
      ready: false,
      exited: false,
      stopped: false,
    };
  }

  function assertHostConfig(host, config) {
    const signature = stableConfigSignature(config);
    if (host.configSignature !== signature) throw new Error("opencode_server_host_config_conflict");
  }

  return {
    ensureOwner,
    getOwner,
    clientForOwner,
    subscribeOwner,
    releaseOwner,
    stopOwner,
    ensureRun,
    getRun,
    clientForRun,
    subscribeRun,
    registerPresentationGateway,
    releasePresentationGateway,
    registerRunPresentationGateway,
    releaseRunPresentationGateway,
    releaseRun,
    stopRun,
    stopAll,
  };
}

async function consumeOpenCodeEventStream({ origin, cwd, fetchImpl, onEvent }) {
  if (typeof fetchImpl !== "function") throw new Error("opencode_server_fetch_unavailable");
  const response = await fetchImpl(`${origin}/event?directory=${encodeURIComponent(cwd)}`, {
    headers: { accept: "text/event-stream" },
  });
  if (!response?.ok || !response.body) throw new Error("opencode_server_event_stream_unavailable");
  await parseOpenCodeSse(response.body, onEvent);
}

async function parseOpenCodeSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of readableChunks(body)) {
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed provider frames. */ }
    }
  }
}

async function* readableChunks(body) {
  if (typeof body?.[Symbol.asyncIterator] === "function") {
    yield* body;
    return;
  }
  const reader = body?.getReader?.();
  if (!reader) throw new Error("opencode_server_event_stream_not_readable");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function publicOwnerServer(host, { ownerId } = {}) {
  return {
    ownerId: ownerKey(ownerId),
    cwd: host.cwd,
    origin: host.origin,
    pid: host.child?.pid,
    providerVersion: host.capability?.providerVersion,
    openApiSchemaVersion: host.capability?.openApiSchemaVersion,
  };
}

function publicRunServer(server, { taskId, runId } = {}) {
  const { ownerId: _ownerId, ...host } = server;
  return {
    taskId: safeSegment(taskId),
    runId: safeSegment(runId),
    ...host,
  };
}

function isRetryableStartError(error) {
  return ["opencode_server_unavailable", "opencode_server_request_failed:0"].includes(error instanceof Error ? error.message : String(error));
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("opencode_server_port_unavailable")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function requiredString(value, reason) { const text = String(value ?? "").trim(); if (!text) throw new Error(reason); return text; }
function safeSegment(value) { return requiredString(value, "opencode_server_run_identity_required").replace(/[^A-Za-z0-9_-]/g, "-"); }
function runKey(taskId, runId) { return `${safeSegment(taskId)}:${safeSegment(runId)}`; }
function runOwnerId(taskId, runId) { return `task-run:${runKey(taskId, runId)}`; }
function ownerKey(ownerId) { return requiredString(ownerId, "opencode_server_owner_id_required"); }
function canonicalProjectRoot(cwd) {
  const resolved = path.resolve(requiredString(cwd, "opencode_server_cwd_required"));
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(resolved);
  } catch {
    return resolved;
  }
}
function stableConfigSignature(config) {
  return JSON.stringify(config && typeof config === "object" ? config : {});
}

module.exports = { createOpenCodeServerManager, reserveLoopbackPort, parseOpenCodeSse };
