const { normalizeLoopbackOrigin } = require("./server-session-page.cjs");

const OPEN_CODE_SESSION_CREATE_TIMEOUT_MS = 60_000;

/**
 * Small Host-only client for the version-pinned OpenCode Server API.  It is
 * intentionally not exposed to the renderer: Tasks bind logical Sessions to
 * Provider Session ids, while the renderer receives only a page handle.
 */
function createOpenCodeServerClient({
  serverOrigin,
  fetchImpl = globalThis.fetch,
  expectedProviderVersion,
  expectedOpenApiVersion = "3.1.0",
  requestTimeoutMs = 15_000,
  sessionCreateTimeoutMs = OPEN_CODE_SESSION_CREATE_TIMEOUT_MS,
} = {}) {
  const origin = normalizeLoopbackOrigin(serverOrigin);

  async function health() {
    const [healthBody, document] = await Promise.all([
      request("/global/health"),
      request("/doc"),
    ]);
    const version = String(healthBody?.version ?? "").trim();
    if (healthBody?.healthy !== true || !version) throw new Error("opencode_server_unhealthy");
    if (expectedProviderVersion && version !== expectedProviderVersion) throw new Error("opencode_server_version_mismatch");
    if (String(document?.openapi ?? "") !== expectedOpenApiVersion) throw new Error("opencode_openapi_schema_mismatch");
    return { providerVersion: version, openApiSchemaVersion: expectedOpenApiVersion };
  }

  async function createSession({ cwd, title, agent, model, metadata, permission, timeoutMs } = {}) {
    const directory = requiredString(cwd, "opencode_server_session_cwd_required");
    const body = withoutUndefined({
      title: optionalString(title),
      agent: optionalString(agent),
      model: normalizeCreateModel(model),
      metadata: metadata && typeof metadata === "object" ? metadata : undefined,
      permission: normalizePermissionRules(permission),
    });
    return request(`/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      body,
      // Creating an empty Session can include one-time Provider/Host setup.
      // Keep control reads short, but give this lifecycle edge the same bounded
      // cold-start window no matter whether it belongs to a Task or Template.
      timeoutMs: timeoutMs ?? sessionCreateTimeoutMs,
    });
  }

  async function promptAsync({ cwd, providerSessionId, text, agent, model, messageId, system, tools, timeoutMs } = {}) {
    const directory = requiredString(cwd, "opencode_server_prompt_cwd_required");
    const sessionId = requiredSessionId(providerSessionId);
    const prompt = requiredString(text, "opencode_server_prompt_text_required");
    await request(`/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      body: withoutUndefined({
        messageID: optionalString(messageId),
        agent: optionalString(agent),
        model: normalizePromptModel(model),
        tools: normalizeTools(tools),
        system: optionalString(system),
        parts: [{ type: "text", text: prompt }],
      }),
      timeoutMs,
    });
    return { accepted: true, providerSessionId: sessionId };
  }

  /**
   * Send one continuation and wait for its Provider turn to finish. OpenCode's
   * async prompt endpoint persists a message but does not serialize subsequent
   * task decisions; callers use this endpoint behind their own Session queue.
   *
   * Do not supply `messageID` here. In the supported local OpenCode 1.18
   * server, a caller-supplied message ID creates the user row but does not run
   * its assistant turn. The completed assistant message returned by this API
   * is the Provider receipt that Runtime persists instead.
   */
  async function sendMessage({ cwd, providerSessionId, text, agent, model, system, tools, timeoutMs } = {}) {
    const directory = requiredString(cwd, "opencode_server_prompt_cwd_required");
    const sessionId = requiredSessionId(providerSessionId);
    const prompt = requiredString(text, "opencode_server_prompt_text_required");
    const response = await request(`/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      body: withoutUndefined({
        agent: optionalString(agent),
        model: normalizePromptModel(model),
        tools: normalizeTools(tools),
        system: optionalString(system),
        parts: [{ type: "text", text: prompt }],
      }),
      timeoutMs,
    });
    return {
      accepted: true,
      providerSessionId: sessionId,
      providerMessageId: optionalString(response?.info?.id),
    };
  }

  async function abort({ cwd, providerSessionId } = {}) {
    const directory = requiredString(cwd, "opencode_server_abort_cwd_required");
    const sessionId = requiredSessionId(providerSessionId);
    return request(`/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(directory)}`, { method: "POST" });
  }

  async function replyPermission({ cwd, requestId, response } = {}) {
    const directory = requiredString(cwd, "opencode_server_permission_cwd_required");
    const id = requiredString(requestId, "opencode_server_permission_request_id_required");
    if (!/^per_[A-Za-z0-9]+$/.test(id)) throw new Error("opencode_server_permission_request_id_invalid");
    const reply = String(response ?? "").trim();
    if (!["once", "always", "reject"].includes(reply)) throw new Error("opencode_server_permission_reply_invalid");
    return request(`/permission/${encodeURIComponent(id)}/reply?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      body: { reply },
    });
  }

  async function messages({ cwd, providerSessionId, limit } = {}) {
    const directory = requiredString(cwd, "opencode_server_messages_cwd_required");
    const sessionId = requiredSessionId(providerSessionId);
    const query = new URLSearchParams({ directory });
    if (Number.isInteger(limit) && limit >= 0) query.set("limit", String(limit));
    return request(`/session/${encodeURIComponent(sessionId)}/message?${query}`);
  }

  async function getSession({ cwd, providerSessionId } = {}) {
    const directory = requiredString(cwd, "opencode_server_session_cwd_required");
    const sessionId = requiredSessionId(providerSessionId);
    return request(`/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`);
  }

  async function request(pathname, { method = "GET", body, timeoutMs } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("opencode_server_fetch_unavailable");
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, Math.max(1, Number(timeoutMs ?? requestTimeoutMs) || 15_000));
    timeout.unref?.();
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch {
      throw new Error(timedOut ? "opencode_server_request_timeout" : "opencode_server_unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) throw new Error(`opencode_server_request_failed:${Number(response?.status) || 0}`);
    if (Number(response.status) === 204) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  return { origin, health, createSession, promptAsync, sendMessage, abort, replyPermission, messages, getSession };
}

function normalizeCreateModel(value) {
  const model = normalizeModel(value);
  return model
    ? {
        providerID: model.providerID,
        id: model.modelID,
        ...(model.variant ? { variant: model.variant } : {}),
      }
    : undefined;
}

function normalizePromptModel(value) {
  const model = normalizeModel(value);
  // OpenCode 1.18's session-create schema owns `variant`; its prompt/message
  // model schema accepts only providerID + modelID. Re-sending a bare model
  // after selecting a variant can therefore both violate the schema and
  // replace the Session's selected variant. Omit model for that continuation.
  if (model?.variant) return undefined;
  return model ? { providerID: model.providerID, modelID: model.modelID } : undefined;
}

function normalizeModel(value) {
  if (!value) return undefined;
  if (typeof value === "object") {
    const providerID = optionalString(value.providerID);
    const modelID = optionalString(value.modelID ?? value.id);
    const variant = optionalString(value.variant ?? value.modelVariant);
    return providerID && modelID ? { providerID, modelID, ...(variant ? { variant } : {}) } : undefined;
  }
  const source = String(value).trim();
  const separator = source.indexOf("/");
  if (separator <= 0 || separator === source.length - 1) throw new Error("opencode_server_model_invalid");
  return { providerID: source.slice(0, separator), modelID: source.slice(separator + 1) };
}

function normalizeTools(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([name, enabled]) => Boolean(optionalString(name)) && typeof enabled === "boolean");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizePermissionRules(value) {
  if (!Array.isArray(value)) return undefined;
  const rules = value
    .map((rule) => ({
      permission: optionalString(rule?.permission),
      pattern: optionalString(rule?.pattern),
      action: optionalString(rule?.action),
    }))
    .filter((rule) => rule.permission && rule.pattern && ["allow", "deny", "ask"].includes(rule.action));
  return rules.length ? rules : undefined;
}

function requiredSessionId(value) {
  const sessionId = requiredString(value, "opencode_server_session_id_required");
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("opencode_server_session_id_invalid");
  return sessionId;
}

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function requiredString(value, reason) {
  const text = optionalString(value);
  if (!text) throw new Error(reason);
  return text;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

module.exports = { OPEN_CODE_SESSION_CREATE_TIMEOUT_MS, createOpenCodeServerClient, normalizeModel };
