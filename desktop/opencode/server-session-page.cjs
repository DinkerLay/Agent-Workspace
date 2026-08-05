const path = require("node:path");

/**
 * Resolves the version-pinned official OpenCode Web UI page for a Provider
 * Session.  This is deliberately a Host-owned capability: renderer code gets
 * a page handle, never a Server API client or a guessed route format.
 */
function createOpenCodeServerSessionPageResolver({
  serverOrigin,
  fetchImpl = globalThis.fetch,
  expectedProviderVersion,
  expectedOpenApiVersion = "3.1.0",
  requiresCredential = false,
  presentationGateway,
} = {}) {
  const origin = normalizeLoopbackOrigin(serverOrigin ?? process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4099");
  let capability;

  async function openSessionPage({ providerSessionId, cwd, presentationLeaseId, beforeProviderUserMessage } = {}) {
    const sessionId = String(providerSessionId ?? "").trim();
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) return unavailable("provider_session_id_invalid");
    if (!String(cwd ?? "").trim()) return unavailable("provider_session_cwd_missing", sessionId);
    if (requiresCredential) return unavailable("authenticated_web_ui_requires_main_owned_surface", sessionId);

    const host = await capabilityForHost();
    if (host.presentation === "unavailable") return { ...host, providerSessionId: sessionId };
    const presentation = await resolvePresentationRoute({
      providerSessionId: sessionId,
      cwd,
      presentationLeaseId,
      beforeProviderUserMessage,
    });
    if (presentation.presentation === "unavailable") return { ...presentation, providerSessionId: sessionId };
    return {
      presentation: "direct_url",
      providerSessionId: sessionId,
      providerVersion: host.providerVersion,
      openApiSchemaVersion: host.openApiSchemaVersion,
      // OpenCode 1.18.13 was verified locally: this route opens that exact
      // Session page. Keep the encoding here so UI code never depends on an
      // internal Web UI URL shape.
      url: `${presentation.origin}${presentation.pathPrefix}/${encodeOpenCodeDirectory(cwd)}/session/${encodeURIComponent(sessionId)}`,
    };
  }

  async function resolvePresentationRoute({ providerSessionId, cwd, presentationLeaseId, beforeProviderUserMessage }) {
    // Template Design and any read-only official Session page intentionally
    // stay direct. A Task Conductor page supplies the preflight callback, so
    // it must never fall back to a bypass URL if scoped gateway registration
    // fails.
    if (typeof beforeProviderUserMessage !== "function") return { presentation: "route", origin, pathPrefix: "" };
    if (!String(presentationLeaseId ?? "").trim()) return unavailable("opencode_presentation_lease_missing");
    if (typeof presentationGateway?.registerPresentation !== "function") {
      return unavailable("opencode_presentation_gateway_unavailable");
    }
    try {
      const registration = await presentationGateway.registerPresentation({
        providerSessionId,
        cwd: String(cwd),
        leaseId: String(presentationLeaseId),
        beforeProviderUserMessage,
      });
      const gatewayOrigin = normalizeLoopbackOrigin(registration?.origin);
      const pathPrefix = String(registration?.pathPrefix ?? "");
      if (!pathPrefix.startsWith("/") || pathPrefix.includes("//")) throw new Error("opencode_presentation_gateway_path_invalid");
      return { presentation: "route", origin: gatewayOrigin, pathPrefix };
    } catch {
      return unavailable("opencode_presentation_gateway_unavailable");
    }
  }

  async function capabilityForHost() {
    if (!capability) capability = readHostCapability();
    return capability;
  }

  async function readHostCapability() {
    if (typeof fetchImpl !== "function") return unavailable("opencode_server_fetch_unavailable");
    try {
      const [healthResponse, documentResponse] = await Promise.all([
        fetchImpl(`${origin}/global/health`),
        fetchImpl(`${origin}/doc`),
      ]);
      if (!healthResponse?.ok || !documentResponse?.ok) return unavailable("opencode_server_unavailable");
      const [health, document] = await Promise.all([healthResponse.json(), documentResponse.json()]);
      const providerVersion = String(health?.version ?? "").trim();
      if (health?.healthy !== true || !providerVersion) return unavailable("opencode_server_unhealthy");
      if (expectedProviderVersion && providerVersion !== expectedProviderVersion) return unavailable("opencode_server_version_mismatch");
      if (String(document?.openapi ?? "") !== expectedOpenApiVersion) return unavailable("opencode_openapi_schema_mismatch");
      return {
        presentation: "capability",
        providerVersion,
        openApiSchemaVersion: expectedOpenApiVersion,
      };
    } catch {
      return unavailable("opencode_server_unavailable");
    }
  }

  return { openSessionPage, resetCapability: () => { capability = undefined; } };
}

function normalizeLoopbackOrigin(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("opencode_server_origin_must_be_loopback_http");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("opencode_server_origin_must_not_contain_credentials_or_path");
  }
  return parsed.origin;
}

function encodeOpenCodeDirectory(cwd) {
  return Buffer.from(path.resolve(String(cwd)), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function unavailable(reason, providerSessionId) {
  return {
    presentation: "unavailable",
    ...(providerSessionId ? { providerSessionId } : {}),
    reason,
  };
}

module.exports = {
  createOpenCodeServerSessionPageResolver,
  encodeOpenCodeDirectory,
  normalizeLoopbackOrigin,
};
