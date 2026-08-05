const childProcess = require("node:child_process");
const { resolveOpencodePath } = require("../opencode-runner.cjs");

const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * Provider-owned, read-only view of the models that the installed OpenCode
 * CLI currently exposes. The Renderer never reads OpenCode config, provider
 * credentials, or raw verbose output directly.
 *
 * `opencode models --verbose` is the only source for selectable models and
 * reasoning variants. A historical model can be requested by id so that an
 * immutable Template/Task snapshot remains displayable even after the
 * Provider catalog changes; it is never reported as selectable.
 */
function createOpencodeModelCapabilityRegistry({
  resolvePath = resolveOpencodePath,
  execFile = childProcess.execFile,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  let cached;
  let inFlight;

  async function list({ historicalModelIds, forceRefresh = false } = {}) {
    const current = await currentCatalog({ forceRefresh });
    return mergeHistoricalModels(current, historicalModelIds);
  }

  async function refresh() {
    return currentCatalog({ forceRefresh: true });
  }

  function currentCatalog({ forceRefresh }) {
    if (!forceRefresh && cached && now() - cached.fetchedAt < cacheTtlMs) {
      return Promise.resolve(cached.result);
    }
    // `opencode models --verbose` can take close to a second on a populated
    // Host. Never synchronously block Electron's main process, and collapse
    // concurrent model-selector opens into one Provider read.
    if (inFlight) return inFlight;
    inFlight = readCurrentModelCapabilities({ resolvePath, execFile })
      .then((result) => {
        cached = { fetchedAt: now(), result };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  function invalidate() {
    cached = undefined;
  }

  return Object.freeze({ list, refresh, invalidate });
}

async function readCurrentModelCapabilities({ resolvePath = resolveOpencodePath, execFile = childProcess.execFile } = {}) {
  const opencodePath = resolvePath();
  if (!opencodePath) {
    return {
      ok: false,
      source: "unavailable",
      models: [],
      error: "opencode_model_catalog_unavailable",
    };
  }

  try {
    const stdout = await runOpenCodeCommand(execFile, opencodePath, ["models", "--verbose"]);
    const models = parseOpencodeVerboseModelList(stdout);
    if (models.length) {
      return {
        ok: true,
        source: "opencode-cli-verbose",
        models,
      };
    }
  } catch {
    // Older OpenCode releases may not support --verbose. Fall through to the
    // documented basic list, which deliberately exposes no variant controls.
  }

  try {
    const stdout = await runOpenCodeCommand(execFile, opencodePath, ["models"]);
    return {
      ok: true,
      source: "opencode-cli-list",
      models: parseOpencodeModelList(stdout),
    };
  } catch {
    return {
      ok: false,
      source: "unavailable",
      models: [],
      error: "opencode_model_catalog_unavailable",
    };
  }
}

function runOpenCodeCommand(execFile, command, args) {
  return new Promise((resolve, reject) => {
    try {
      execFile(command, args, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout ?? ""));
      });
    } catch (error) {
      reject(error);
    }
  });
}

function parseOpencodeVerboseModelList(output) {
  const source = stripAnsi(String(output ?? ""));
  const models = [];
  let cursor = 0;

  while (cursor < source.length) {
    const remaining = source.slice(cursor);
    const header = /(?:^|\n)\s*([^\s]+\/[^\s]+)\s*\r?\n\s*(\{)/.exec(remaining);
    if (!header) break;

    const modelId = header[1];
    const objectStart = cursor + header.index + header[0].lastIndexOf("{");
    const parsed = parseJsonObjectAt(source, objectStart);
    if (!parsed) {
      cursor = objectStart + 1;
      continue;
    }
    cursor = parsed.end;
    const capability = modelCapabilityFromVerboseRecord(modelId, parsed.value);
    if (capability) models.push(capability);
  }

  return uniqueCapabilities(models);
}

function parseOpencodeModelList(output) {
  const candidates = [];
  for (const line of stripAnsi(String(output ?? "")).split(/\r?\n/)) {
    const match = /(?:^|\s)([A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+)(?:\s|$)/.exec(line);
    if (!match) continue;
    const capability = historicalCapability(match[1], "available");
    if (capability) candidates.push(capability);
  }
  return uniqueCapabilities(candidates);
}

function mergeHistoricalModels(result, historicalModelIds) {
  const models = uniqueCapabilities(result.models ?? []);
  const known = new Set(models.map((model) => model.id));
  for (const id of normalizeModelIds(historicalModelIds)) {
    if (known.has(id)) continue;
    const historical = historicalCapability(id, "historical");
    if (!historical) continue;
    models.push(historical);
    known.add(id);
  }
  return {
    ok: result.ok === true,
    source: result.source,
    models: models.map(cloneCapability),
    ...(result.error ? { error: result.error } : {}),
  };
}

function modelCapabilityFromVerboseRecord(label, value) {
  const fromLabel = splitModelId(label);
  if (!fromLabel || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const providerId = safeString(value.providerID) ?? fromLabel.providerId;
  const modelId = safeString(value.id) ?? fromLabel.modelId;
  const id = `${providerId}/${modelId}`;
  const capabilities = value.capabilities && typeof value.capabilities === "object" && !Array.isArray(value.capabilities)
    ? value.capabilities
    : {};
  const variants = value.variants && typeof value.variants === "object" && !Array.isArray(value.variants)
    ? Object.entries(value.variants)
      .map(([variantId, variant]) => {
        const id = safeString(variantId);
        if (!id) return undefined;
        const reasoningEffort = variant && typeof variant === "object" && !Array.isArray(variant)
          ? safeString(variant.reasoningEffort)
          : undefined;
        return { id, ...(reasoningEffort ? { reasoningEffort } : {}) };
      })
      .filter(Boolean)
    : [];

  return {
    id,
    providerId,
    modelId,
    name: safeString(value.name) ?? id,
    availability: "available",
    status: safeString(value.status) ?? "unknown",
    capabilities: {
      reasoning: capabilities.reasoning === true,
    },
    variants,
  };
}

function historicalCapability(value, availability) {
  const parsed = splitModelId(value);
  if (!parsed) return undefined;
  return {
    id: `${parsed.providerId}/${parsed.modelId}`,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    name: `${parsed.providerId}/${parsed.modelId}`,
    availability,
    status: "unknown",
    capabilities: { reasoning: false },
    variants: [],
  };
}

function uniqueCapabilities(models) {
  const unique = new Map();
  for (const model of models) {
    if (!model?.id || unique.has(model.id)) continue;
    unique.set(model.id, model);
  }
  return [...unique.values()];
}

function normalizeModelIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function splitModelId(value) {
  const id = String(value ?? "").trim();
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  const providerId = id.slice(0, separator).trim();
  const modelId = id.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function parseJsonObjectAt(source, start) {
  if (source[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      return { value: JSON.parse(source.slice(start, index + 1)), end: index + 1 };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function safeString(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function cloneCapability(model) {
  return {
    ...model,
    capabilities: { ...model.capabilities },
    variants: model.variants.map((variant) => ({ ...variant })),
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  createOpencodeModelCapabilityRegistry,
  parseOpencodeModelList,
  parseOpencodeVerboseModelList,
  readCurrentModelCapabilities,
  runOpenCodeCommand,
};
