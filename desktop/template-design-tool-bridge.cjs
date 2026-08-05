const crypto = require("node:crypto");
const http = require("node:http");

const MAX_JSON_BYTES = 256 * 1024;
const TEMPLATE_DRAFT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const PATCH_OPERATIONS = new Set(["add", "replace", "remove"]);
const PATCH_ROOTS = new Set(["name", "conductor", "agents", "limits", "delivery"]);

/**
 * The Template Design bridge is deliberately separate from the Conductor
 * bridge. Its only durable writer is TemplateDesignSessionService, and it
 * exposes no Task, Run, Dispatch, filesystem, or Version-save capability.
 */
function createTemplateDesignToolBridge({ templateDesignService, onDraftChanged } = {}) {
  const service = requiredObject(templateDesignService, "template_design_session_service");
  if (
    typeof service.readScopedDraft !== "function"
    || typeof service.readProviderSessionBinding !== "function"
    || typeof service.applyStructuredPatch !== "function"
  ) {
    throw new Error("template_design_session_service_capabilities_missing");
  }

  return {
    readDraft(input) {
      const { draftId, capabilitySecret } = bindingForProviderSession(service, input);
      return presentDraft(service.readScopedDraft({ draftId, capabilitySecret }));
    },
    applyPatch(input) {
      const { draftId, capabilitySecret } = bindingForProviderSession(service, input);
      const expectedRevision = requiredRevision(input?.expectedRevision);
      const operationId = requiredId(input?.operationId, "template_design_operation_id_invalid");
      const patch = validatePatch(input?.patch);
      const result = service.applyStructuredPatch({ draftId, capabilitySecret, expectedRevision, operationId, patch });
      if (!result?.replayed && typeof onDraftChanged === "function") {
        try {
          onDraftChanged({
            draftId: result?.draft?.draftId ?? draftId,
            type: "template_design.draft_patched",
            revision: Number(result?.draft?.revision ?? expectedRevision),
          });
        } catch {
          // Presentation invalidation is derived. A renderer listener must
          // never make an already-committed Draft patch look like a failure.
        }
      }
      return presentPatchResult(result);
    },
    providerSessionBindingStatus(input) {
      const providerSessionId = requiredProviderSessionId(input?.providerSessionId);
      return { bound: Boolean(service.readProviderSessionBinding({ providerSessionId })) };
    },
  };
}

async function startTemplateDesignToolBridgeHttpServer({ bridge, token = crypto.randomUUID(), host = "127.0.0.1" } = {}) {
  const handlers = {
    read_draft: bridge?.readDraft,
    apply_patch: bridge?.applyPatch,
  };
  if (
    Object.values(handlers).some((handler) => typeof handler !== "function")
    || typeof bridge?.providerSessionBindingStatus !== "function"
  ) {
    throw new Error("template_design_tool_bridge_handlers_missing");
  }
  const expectedToken = Buffer.from(String(token));
  if (!expectedToken.length) throw new Error("template_design_tool_bridge_token_required");

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return writeJson(response, 400, { error: "invalid_request_target" });
    }
    if (request.method !== "POST") return writeJson(response, 404, { error: "not_found" });
    if (!authorizationMatches(request.headers.authorization, expectedToken)) return writeJson(response, 401, { error: "unauthorized" });
    const bindingHandler = url.pathname === "/binding/status"
        ? bridge.providerSessionBindingStatus
        : undefined;
    if (bindingHandler) {
      try {
        const result = await bindingHandler(await readJsonBody(request));
        return writeJson(response, 200, result);
      } catch (error) {
        return writeJson(response, httpStatusForError(error), { error: error instanceof Error ? error.message : "template_design_session_binding_invalid" });
      }
    }
    const match = url.pathname.match(/^\/tools\/([A-Za-z_]+)$/);
    if (!match) return writeJson(response, 404, { error: "not_found" });
    const handler = handlers[match[1]];
    if (!handler) return writeJson(response, 404, { error: "unknown_tool" });
    try {
      const result = await handler(await readJsonBody(request));
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, httpStatusForError(error), { error: error instanceof Error ? error.message : "template_design_tool_failed" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("template_design_tool_bridge_address_unavailable");
  return {
    server,
    token: String(token),
    url: `http://${formatHostForUrl(host)}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function presentDraft(draft) {
  if (!draft) throw new Error("template_design_draft_not_found");
  return {
    draftId: String(draft.draftId),
    templateId: optionalId(draft.templateId),
    baseTemplateVersion: optionalPositiveInteger(draft.baseTemplateVersion),
    cwd: String(draft.cwd),
    model: String(draft.model),
    revision: Number(draft.revision),
    status: String(draft.status),
    draft: cloneJson(draft.draftJson),
  };
}

function presentPatchResult(result) {
  if (!result?.draft) throw new Error("template_design_patch_result_invalid");
  return {
    draft: presentDraft(result.draft),
    replayed: result.replayed === true,
  };
}

function validatePatch(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("template_design_patch_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("template_design_patch_operation_invalid");
    const op = String(item.op ?? "");
    const path = String(item.path ?? "");
    if (!PATCH_OPERATIONS.has(op) || !validPatchPath(path)) throw new Error("template_design_patch_operation_invalid");
    if (op === "remove") {
      if (Object.hasOwn(item, "value")) throw new Error("template_design_patch_remove_value_forbidden");
      return { op, path };
    }
    if (!Object.hasOwn(item, "value")) throw new Error("template_design_patch_value_required");
    return { op, path, value: cloneJson(item.value, "template_design_patch_value_invalid") };
  });
}

function validPatchPath(value) {
  if (!value.startsWith("/") || value.length > 512 || value.includes("//")) return false;
  const segments = value.slice(1).split("/");
  if (!PATCH_ROOTS.has(unescapePointer(segments[0]))) return false;
  return segments.every(validPointerSegment);
}

function validPointerSegment(segment) {
  if (!segment || !validPointerEscapes(segment)) return false;
  return !["__proto__", "prototype", "constructor"].includes(unescapePointer(segment));
}

function validPointerEscapes(segment) {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== "~") continue;
    if (!["0", "1"].includes(segment[index + 1])) return false;
    index += 1;
  }
  return true;
}

function unescapePointer(value) {
  return String(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function requiredRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("template_design_expected_revision_invalid");
  return value;
}

function requiredId(value, reason) {
  const id = String(value ?? "").trim();
  if (!TEMPLATE_DRAFT_ID.test(id)) throw new Error(reason);
  return id;
}

function requiredCapabilitySecret(value) {
  const secret = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(secret)) throw new Error("template_design_draft_capability_invalid");
  return secret;
}

function bindingForProviderSession(service, input) {
  const providerSessionId = requiredProviderSessionId(input?.providerSessionId);
  const binding = service.readProviderSessionBinding({ providerSessionId });
  if (!binding) throw new Error("template_design_session_binding_invalid");
  return {
    draftId: requiredId(binding.draftId, "template_design_draft_id_invalid"),
    capabilitySecret: requiredCapabilitySecret(binding.capabilitySecret),
  };
}

function requiredProviderSessionId(value) {
  const sessionId = String(value ?? "").trim();
  if (!TEMPLATE_DRAFT_ID.test(sessionId)) throw new Error("template_design_provider_session_id_invalid");
  return sessionId;
}

function optionalId(value) {
  const id = String(value ?? "").trim();
  return TEMPLATE_DRAFT_ID.test(id) ? id : undefined;
}

function optionalPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cloneJson(value, errorMessage = "template_design_json_invalid") {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(errorMessage);
    return JSON.parse(serialized);
  } catch {
    throw new Error(errorMessage);
  }
}

function requiredObject(value, reason) {
  if (!value || typeof value !== "object") throw new Error(reason);
  return value;
}

function authorizationMatches(header, expectedToken) {
  const actual = Buffer.from(String(header ?? ""));
  const expected = Buffer.from(`Bearer ${expectedToken.toString("utf8")}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
      request.resume();
      reject(toolHttpError("template_design_tool_body_too_large", 413));
      return;
    }
    let bytes = 0;
    let body = "";
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_JSON_BYTES) {
        request.resume();
        rejectOnce(toolHttpError("template_design_tool_body_too_large", 413));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        rejectOnce(toolHttpError("template_design_tool_body_invalid_json", 400));
      }
    });
    request.on("error", rejectOnce);
  });
}

function toolHttpError(message, status) {
  const error = new Error(message);
  error.httpStatus = status;
  return error;
}

function httpStatusForError(error) {
  return error?.httpStatus === 413 ? 413 : 400;
}

function formatHostForUrl(host) {
  const value = String(host);
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

module.exports = {
  createTemplateDesignToolBridge,
  startTemplateDesignToolBridgeHttpServer,
  validatePatch,
};
