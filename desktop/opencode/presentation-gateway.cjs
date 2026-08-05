const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const GATEWAY_PREFIX = "/_agent-workspace/presentation";
const PRESENTATION_COOKIE_PREFIX = "agent_workspace_presentation_";
const MAX_INTERCEPT_BODY_BYTES = 1_000_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * A narrow, loopback-only presentation gateway for the official OpenCode Web
 * UI. It is not a general Server proxy: an opaque, revocable presentation
 * lease is required for every request. Only a registered Conductor Session's
 * composer POST is paused before it reaches the Provider.
 */
function createOpenCodePresentationGateway({
  upstreamOrigin,
  createServer = http.createServer,
  request = http.request,
  randomUUID = crypto.randomUUID,
  host = "127.0.0.1",
  port = 0,
  maxInterceptBodyBytes = MAX_INTERCEPT_BODY_BYTES,
} = {}) {
  const upstream = normalizeLoopbackOrigin(upstreamOrigin);
  const registrations = new Map();
  const sockets = new Set();
  let server;
  let origin;
  let starting;

  async function registerPresentation({ ownerId, leaseId, providerSessionId, cwd, beforeProviderUserMessage } = {}) {
    const owner = requiredString(ownerId, "opencode_presentation_owner_required");
    const lease = requiredString(leaseId, "opencode_presentation_lease_required");
    const sessionId = requiredProviderSessionId(providerSessionId);
    const directory = path.resolve(requiredString(cwd, "opencode_presentation_cwd_required"));
    if (typeof beforeProviderUserMessage !== "function") {
      throw new Error("opencode_presentation_before_user_message_required");
    }
    await ensureListening();
    const key = registrationKey(owner, lease);
    const token = opaqueToken(randomUUID);
    registrations.set(key, {
      key,
      ownerId: owner,
      leaseId: lease,
      token,
      providerSessionId: sessionId,
      cwd: directory,
      beforeProviderUserMessage,
      createdAt: Date.now(),
    });
    return {
      origin,
      pathPrefix: `${GATEWAY_PREFIX}/${encodeURIComponent(token)}`,
      token,
    };
  }

  async function releasePresentation({ ownerId, leaseId } = {}) {
    const key = registrationKey(
      requiredString(ownerId, "opencode_presentation_owner_required"),
      requiredString(leaseId, "opencode_presentation_lease_required"),
    );
    const released = registrations.delete(key);
    if (!registrations.size) await close();
    return released;
  }

  async function releaseOwner({ ownerId } = {}) {
    const owner = requiredString(ownerId, "opencode_presentation_owner_required");
    let released = 0;
    for (const [key, registration] of registrations) {
      if (registration.ownerId !== owner) continue;
      registrations.delete(key);
      released += 1;
    }
    if (!registrations.size) await close();
    return released;
  }

  async function ensureListening() {
    if (origin) return origin;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = createServer((incoming, outgoing) => {
        void handleRequest(incoming, outgoing);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.once("error", reject);
      server.listen({ host, port }, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("opencode_presentation_gateway_address_invalid"));
          return;
        }
        origin = `http://${address.address}:${address.port}`;
        resolve(origin);
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function close() {
    registrations.clear();
    if (!server) {
      origin = undefined;
      return false;
    }
    const closing = server;
    server = undefined;
    origin = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => closing.close(() => resolve()));
    return true;
  }

  async function handleRequest(incoming, outgoing) {
    try {
      const target = requestTarget(incoming);
      const prefixed = registrationForPrefix(target.pathname);
      const registration = prefixed?.registration ?? registrationForCookie(incoming, target.pathname);
      if (!registration) {
        rejectGatewayRequest(outgoing, 404, "opencode_presentation_lease_not_found");
        return;
      }
      const upstreamPath = prefixed?.upstreamPath ?? requestPath(incoming);
      if (!isPresentationRequestAllowed({
        incoming,
        target,
        upstreamPath,
        registration,
        prefixed: Boolean(prefixed),
      })) {
        rejectGatewayRequest(outgoing, 403, "opencode_presentation_request_not_allowed");
        return;
      }
      // OpenCode recognizes its Session route only from the origin root. A
      // Conductor initially reaches us through an opaque prefix so this
      // gateway can establish its scoped lease. Seed the HttpOnly lease cookie
      // and then move the browser to the canonical root route; subsequent UI
      // assets and API calls are resolved by that cookie.
      if (shouldRedirectInitialSessionNavigation({ incoming, prefixed, upstreamPath })) {
        redirectToCookieBoundSessionPage({ outgoing, target, upstreamPath, token: registration.token });
        return;
      }
      const composerSessionId = composerProviderSessionId(incoming, target);
      if (composerSessionId === registration.providerSessionId) {
        const body = await readBoundedBody(incoming, maxInterceptBodyBytes);
        const input = parseComposerInput(body, randomUUID);
        if (!registrationIsActive(registration)) {
          throw gatewayError(404, "opencode_presentation_lease_not_found");
        }
        await registration.beforeProviderUserMessage({
          providerSessionId: registration.providerSessionId,
          inputId: input.inputId,
          text: input.text,
        });
        // A page close, Task stop, or a replacement registration may happen
        // while the Task/Run preflight persists its durable input intent. A
        // released presentation lease must fail closed before any Provider
        // request can cross this gateway.
        if (!registrationIsActive(registration)) {
          throw gatewayError(404, "opencode_presentation_lease_not_found");
        }
        await proxyRequest({ incoming, outgoing, upstreamPath, body, presentationCookie: prefixed?.registration.token });
        return;
      }
      await proxyRequest({ incoming, outgoing, upstreamPath, presentationCookie: prefixed?.registration.token });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 409;
      rejectGatewayRequest(outgoing, statusCode, error?.publicCode ?? "opencode_presentation_user_input_not_accepted");
    }
  }

  function registrationForPrefix(pathname) {
    const prefix = `${GATEWAY_PREFIX}/`;
    if (!pathname.startsWith(prefix)) return undefined;
    const rest = pathname.slice(prefix.length);
    const separator = rest.indexOf("/");
    if (separator <= 0) return undefined;
    const token = safelyDecode(rest.slice(0, separator));
    const registration = [...registrations.values()].find((item) => item.token === token);
    if (!registration) return undefined;
    return { registration, upstreamPath: `/${rest.slice(separator + 1)}` };
  }

  function registrationForCookie(incoming, pathname) {
    const names = presentationCookieNames(incoming.headers.cookie);
    if (!names.length) return undefined;
    const candidates = [...registrations.values()]
      .filter((item) => names.includes(`${PRESENTATION_COOKIE_PREFIX}${item.token}`));
    if (!candidates.length) return undefined;
    const sessionId = providerSessionIdFromPath(pathname);
    if (sessionId) return candidates.find((item) => item.providerSessionId === sessionId) ?? candidates.at(-1);
    return candidates.at(-1);
  }

  function registrationIsActive(registration) {
    return registrations.get(registration.key) === registration;
  }

  function isPresentationRequestAllowed({ incoming, target, upstreamPath, registration, prefixed }) {
    const method = String(incoming.method ?? "GET").toUpperCase();
    const directory = presentationRequestDirectory({ incoming, target });
    if (directory.present && (!directory.valid || directory.value !== registration.cwd)) return false;
    const sessionId = providerSessionIdFromPath(target.pathname);
    if (sessionId && sessionId !== registration.providerSessionId) return false;
    if (prefixed) {
      if (sessionId && !isBoundPrefixedSessionRoute({ upstreamPath, registration })) return false;
      return method === "GET" || method === "HEAD";
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const composerSessionId = composerProviderSessionId(incoming, target);
      return Boolean(
        composerSessionId
        && composerSessionId === registration.providerSessionId
        && directory.valid
        && directory.value === registration.cwd,
      );
    }
    return method === "GET" || method === "HEAD" || method === "OPTIONS";
  }

  function proxyRequest({ incoming, outgoing, upstreamPath, body, presentationCookie }) {
    return new Promise((resolve, reject) => {
      const headers = proxyRequestHeaders(incoming.headers, upstream);
      const upstreamRequest = request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method: incoming.method,
        path: upstreamPath,
        headers,
      }, (upstreamResponse) => {
        const responseHeaders = proxyResponseHeaders(upstreamResponse.headers);
        if (presentationCookie) {
          const cookie = presentationLeaseCookie(presentationCookie);
          const prior = responseHeaders["set-cookie"];
          responseHeaders["set-cookie"] = prior ? [...(Array.isArray(prior) ? prior : [prior]), cookie] : [cookie];
        }
        outgoing.writeHead(Number(upstreamResponse.statusCode) || 502, responseHeaders);
        upstreamResponse.once("error", reject);
        upstreamResponse.pipe(outgoing);
        upstreamResponse.once("end", resolve);
      });
      upstreamRequest.once("error", reject);
      if (body !== undefined) {
        upstreamRequest.end(body);
        return;
      }
      incoming.pipe(upstreamRequest);
    });
  }

  return {
    registerPresentation,
    releasePresentation,
    releaseOwner,
    close,
    get origin() { return origin; },
    get registrationCount() { return registrations.size; },
  };
}

function shouldRedirectInitialSessionNavigation({ incoming, prefixed, upstreamPath }) {
  if (!prefixed || String(incoming?.method ?? "GET").toUpperCase() !== "GET") return false;
  if (!String(incoming?.headers?.accept ?? "").toLocaleLowerCase().includes("text/html")) return false;
  return /^\/[A-Za-z0-9_-]+\/session\/ses_[A-Za-z0-9]+$/.test(String(upstreamPath ?? ""));
}

function redirectToCookieBoundSessionPage({ outgoing, target, upstreamPath, token }) {
  outgoing.writeHead(302, {
    location: `${upstreamPath}${target.search}`,
    "cache-control": "no-store",
    "set-cookie": presentationLeaseCookie(token),
  });
  outgoing.end();
}

function presentationLeaseCookie(token) {
  return `${PRESENTATION_COOKIE_PREFIX}${token}=1; Path=/; HttpOnly; SameSite=Strict`;
}

function requestTarget(incoming) {
  return new URL(requestPath(incoming), "http://presentation-gateway.invalid");
}

function requestPath(incoming) {
  const value = String(incoming?.url ?? "");
  return value.startsWith("/") ? value : "/";
}

function composerProviderSessionId(incoming, target) {
  if (String(incoming?.method ?? "").toUpperCase() !== "POST") return undefined;
  const match = target.pathname.match(/(?:^|\/)session\/([^/]+)\/(message|prompt_async)$/);
  if (!match) return undefined;
  return safelyDecode(match[1]);
}

function providerSessionIdFromPath(pathname) {
  const match = String(pathname ?? "").match(/(?:^|\/)session\/([^/]+)(?:\/|$)/);
  const sessionId = match ? safelyDecode(match[1]) : "";
  // `/session/status` is a directory-scoped OpenCode Web UI read, not a
  // Provider Session route. Treat only a syntactically valid Provider Session
  // id as session-scoped so the lease still protects cross-session reads while
  // the official UI can refresh its own status.
  return /^ses_[A-Za-z0-9]+$/.test(sessionId) ? sessionId : undefined;
}

function isBoundPrefixedSessionRoute({ upstreamPath, registration }) {
  const match = String(upstreamPath ?? "").match(/^\/([^/]+)\/session\/([^/]+)(?:\/|$)/);
  if (!match) return false;
  return match[1] === encodeOpenCodeDirectory(registration.cwd)
    && safelyDecode(match[2]) === registration.providerSessionId;
}

function encodeOpenCodeDirectory(cwd) {
  return Buffer.from(path.resolve(String(cwd)), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * The pinned OpenCode Web UI sends its project directory in
 * `x-opencode-directory` for composer POSTs. GET/HEAD navigation may still
 * use the query parameter, so the gateway accepts either representation only
 * when it resolves to the presentation's registered cwd.  It deliberately
 * fails closed when both representations disagree or a header is malformed.
 */
function presentationRequestDirectory({ incoming, target }) {
  const queryValues = target.searchParams.getAll("directory");
  const hasQuery = queryValues.length > 0;
  const query = hasQuery ? queryValues[0] : undefined;
  const header = decodePresentationDirectoryHeader(incoming?.headers?.["x-opencode-directory"]);
  if (!hasQuery && !header.present) return { present: false, valid: false, value: undefined };
  if (queryValues.length > 1 || (hasQuery && !query) || !header.valid) return { present: true, valid: false, value: undefined };
  if (hasQuery && header.present && query !== header.value) return { present: true, valid: false, value: undefined };
  return { present: true, valid: true, value: query ?? header.value };
}

function decodePresentationDirectoryHeader(value) {
  if (value === undefined) return { present: false, valid: true, value: undefined };
  if (Array.isArray(value) || typeof value !== "string" || !value) return { present: true, valid: false, value: undefined };
  try {
    const decoded = decodeURIComponent(value);
    return decoded ? { present: true, valid: true, value: decoded } : { present: true, valid: false, value: undefined };
  } catch {
    return { present: true, valid: false, value: undefined };
  }
}

function parseComposerInput(body, randomUUID) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw gatewayError(400, "opencode_presentation_composer_body_invalid");
  }
  const callerInputId = optionalString(parsed?.messageID ?? parsed?.messageId);
  const inputId = callerInputId ?? `webui:${opaqueToken(randomUUID)}`;
  const texts = Array.isArray(parsed?.parts)
    ? parsed.parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
    : [];
  const text = texts.length ? texts.join("\n") : String(parsed?.text ?? "");
  return { inputId, text };
}

function readBoundedBody(incoming, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    incoming.on("data", (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    incoming.once("error", reject);
    incoming.once("end", () => {
      if (tooLarge) {
        reject(gatewayError(413, "opencode_presentation_composer_body_too_large"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function proxyRequestHeaders(headers, upstream) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = String(name).toLowerCase();
    if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    forwarded[lower] = value;
  }
  forwarded.host = upstream.host;
  return forwarded;
}

function proxyResponseHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP_HEADERS.has(String(name).toLowerCase()) || value === undefined) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function presentationCookieNames(header) {
  return String(header ?? "")
    .split(";")
    .map((item) => item.trim().split("=", 1)[0])
    .filter((name) => name.startsWith(PRESENTATION_COOKIE_PREFIX));
}

function rejectGatewayRequest(response, statusCode, code) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error: code }));
}

function gatewayError(statusCode, publicCode) {
  const error = new Error(publicCode);
  error.statusCode = statusCode;
  error.publicCode = publicCode;
  return error;
}

function registrationKey(ownerId, leaseId) { return `${ownerId}\u0000${leaseId}`; }
function requiredProviderSessionId(value) {
  const id = requiredString(value, "opencode_presentation_provider_session_required");
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error("opencode_presentation_provider_session_invalid");
  return id;
}
function requiredString(value, code) { const text = String(value ?? "").trim(); if (!text) throw new Error(code); return text; }
function optionalString(value) { const text = String(value ?? "").trim(); return text || undefined; }
function opaqueToken(randomUUID) { return String(randomUUID()).replace(/[^A-Za-z0-9_-]/g, ""); }
function safelyDecode(value) { try { return decodeURIComponent(String(value)); } catch { return ""; } }

function normalizeLoopbackOrigin(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("opencode_presentation_upstream_must_be_loopback_http");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("opencode_presentation_upstream_must_not_contain_path");
  }
  return parsed;
}

module.exports = {
  createOpenCodePresentationGateway,
  GATEWAY_PREFIX,
};
