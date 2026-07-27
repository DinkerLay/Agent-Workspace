const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MAX_HOOK_BODY_BYTES = 64 * 1024;
const HOOK_PLUGIN_FILE = "agent-workspace-hook.js";

/**
 * Minimal OpenCode hook receiver adapted from Orca's event boundary.
 *
 * The plugin lives in an isolated OpenCode config overlay and only reports
 * provider-native attention. It never answers a permission or a question on
 * behalf of the user. The Runtime associates an authenticated loopback event
 * with one already-owned Workspace Session.
 */
function createOpenCodeHookService({ randomBytes = crypto.randomBytes } = {}) {
  const registrations = new Map();
  let server;
  let endpoint;
  let starting;

  async function registerSession({ sessionId, cwd, onEvent }) {
    const normalizedSessionId = requiredString(sessionId, "sessionId");
    const normalizedCwd = path.resolve(requiredString(cwd, "cwd"));
    if (typeof onEvent !== "function") throw new Error("OpenCode Hook Service requires an onEvent callback.");
    await ensureServer();
    const token = randomBytes(24).toString("base64url");
    registrations.set(normalizedSessionId, { token, onEvent });
    return {
      env: {
        OPENCODE_CONFIG_DIR: ensurePluginConfig(normalizedCwd),
        AGENT_WORKSPACE_HOOK_ENDPOINT: endpoint,
        AGENT_WORKSPACE_HOOK_TOKEN: token,
        AGENT_WORKSPACE_HOOK_SESSION_ID: normalizedSessionId,
      },
    };
  }

  function clearSession(sessionId) {
    registrations.delete(String(sessionId ?? ""));
  }

  async function ensureServer() {
    if (endpoint) return endpoint;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        void handleRequest(request, response);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("OpenCode Hook Service did not receive a local address."));
          return;
        }
        endpoint = `http://127.0.0.1:${address.port}/hook/opencode`;
        resolve(endpoint);
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function handleRequest(request, response) {
    if (request.method !== "POST" || request.url !== "/hook/opencode") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_HOOK_BODY_BYTES) tooLarge = true;
    });
    request.once("error", () => response.writeHead(400).end());
    request.once("end", async () => {
      if (tooLarge) {
        response.writeHead(413).end();
        return;
      }
      let event;
      try {
        event = normalizeHookEvent(JSON.parse(body));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const registration = registrations.get(event.sessionId);
      const token = String(request.headers["x-agent-workspace-hook-token"] ?? "");
      if (!registration || !constantTimeEqual(registration.token, token)) {
        response.writeHead(401).end();
        return;
      }
      try {
        await registration.onEvent(event);
        response.writeHead(202).end();
      } catch {
        // Hook reporting must not terminate the provider run. The next event
        // can still repair a transient Runtime storage failure.
        response.writeHead(202).end();
      }
    });
  }

  async function close() {
    registrations.clear();
    if (!server) return;
    const closing = server;
    server = undefined;
    endpoint = undefined;
    await new Promise((resolve) => closing.close(() => resolve()));
  }

  return { registerSession, clearSession, close };
}

function ensurePluginConfig(cwd) {
  const runtimeRoot = path.join(cwd, ".agent-workspace", "runtime", "opencode-hooks");
  const configuredRoot = process.env.OPENCODE_CONFIG_DIR;
  const configDir = configuredRoot && isDirectory(configuredRoot)
    ? ensureConfigOverlay({ runtimeRoot, sourceDir: path.resolve(configuredRoot) })
    : path.join(runtimeRoot, "shared");
  const pluginsDir = path.join(configDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, HOOK_PLUGIN_FILE), openCodeHookPluginSource(), "utf8");
  return configDir;
}

function ensureConfigOverlay({ runtimeRoot, sourceDir }) {
  const digest = crypto.createHash("sha256").update(sourceDir).digest("hex").slice(0, 24);
  const overlayDir = path.join(runtimeRoot, "overlays", digest);
  fs.mkdirSync(overlayDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "plugins") continue;
    mirrorEntry(path.join(sourceDir, entry.name), path.join(overlayDir, entry.name));
  }
  const sourcePlugins = path.join(sourceDir, "plugins");
  const overlayPlugins = path.join(overlayDir, "plugins");
  fs.mkdirSync(overlayPlugins, { recursive: true });
  if (isDirectory(sourcePlugins)) {
    for (const entry of fs.readdirSync(sourcePlugins, { withFileTypes: true })) {
      if (entry.name === HOOK_PLUGIN_FILE) continue;
      mirrorEntry(path.join(sourcePlugins, entry.name), path.join(overlayPlugins, entry.name));
    }
  }
  return overlayDir;
}

function mirrorEntry(source, target) {
  if (fs.existsSync(target)) return;
  try {
    fs.symlinkSync(source, target, fs.lstatSync(source).isDirectory() ? "dir" : "file");
  } catch {
    // The hook remains optional if an unusual filesystem denies symlinks.
    // Avoid copying a user config tree or credential material into Runtime.
  }
}

function openCodeHookPluginSource() {
  return [
    "const endpoint = process.env.AGENT_WORKSPACE_HOOK_ENDPOINT;",
    "const token = process.env.AGENT_WORKSPACE_HOOK_TOKEN;",
    "const sessionId = process.env.AGENT_WORKSPACE_HOOK_SESSION_ID;",
    "async function post(kind, payload) {",
    "  if (!endpoint || !token || !sessionId) return;",
    "  try {",
    "    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Workspace-Hook-Token': token }, body: JSON.stringify({ sessionId, kind, payload }) });",
    "  } catch { /* Reporting must fail open for the provider session. */ }",
    "}",
    "const messageRoleById = new Map();",
    "export const AgentWorkspaceHook = async () => ({",
    "  event: async ({ event }) => {",
    "    if (!event?.type) return;",
    "    if (event.type === 'message.updated') {",
    "      const info = event.properties?.info;",
    "      if (info?.id && info?.role) messageRoleById.set(info.id, info.role);",
    "      return;",
    "    }",
    "    if (event.type === 'message.part.updated') {",
    "      const part = event.properties?.part;",
    "      const role = part?.messageID ? messageRoleById.get(part.messageID) : undefined;",
    "      if (role === 'assistant' && part?.type === 'text' && part.text) await post('message', { role, text: part.text, sessionID: event.properties?.sessionID });",
    "      return;",
    "    }",
    "    if (event.type === 'permission.asked') { await post('permission', event.properties || {}); return; }",
    "    if (event.type === 'question.asked') { await post('question', event.properties || {}); return; }",
    "    if (event.type === 'session.idle') { await post('status', { type: 'idle', sessionID: event.properties?.sessionID }); return; }",
    "    if (event.type === 'session.error') { await post('status', { type: 'error', sessionID: event.properties?.sessionID, error: event.properties?.error ?? event.error ?? event.properties }); return; }",
    "    if (event.type === 'session.status') {",
    "      const type = event.properties?.status?.type ?? event.status?.type;",
    "      if (type === 'busy' || type === 'idle') await post('status', { type });",
    "    }",
    "  },",
    "});",
    "",
  ].join("\n");
}

function normalizeHookEvent(value) {
  const sessionId = requiredString(value?.sessionId, "sessionId");
  const kind = String(value?.kind ?? "");
  if (!new Set(["permission", "question", "status", "message"]).has(kind)) throw new Error("hook_kind_invalid");
  const payload = value?.payload && typeof value.payload === "object" && !Array.isArray(value.payload) ? value.payload : {};
  return { sessionId, kind, payload: boundedPayload(payload) };
}

function boundedPayload(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => boundedPayload(item, depth + 1));
  if (!value || typeof value !== "object") return String(value).slice(0, 4_000);
  return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, item]) => [key.slice(0, 160), boundedPayload(item, depth + 1)]));
}

function constantTimeEqual(expected, received) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`OpenCode Hook ${field} is required.`);
  return result;
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { createOpenCodeHookService, openCodeHookPluginSource };
