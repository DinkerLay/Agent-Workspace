const crypto = require("node:crypto");
const { normalizeAgentCards: normalizeSharedAgentCards } = require("./loop-template-store.cjs");

// `saved` is retained only so historical rows remain readable. New saves are
// checkpoints: they create an immutable Template Version while the Draft stays
// active and bound to the same Meta Agent Provider Session.
const DRAFT_STATUSES = new Set(["active", "saved", "discarded"]);
const PATCH_OPERATIONS = new Set(["add", "replace", "remove"]);
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Durable owner for a non-Task Template Design Draft and its optional
 * provider-native Meta Agent session. This service deliberately has no Task,
 * Run, Terminal, or Template-Version writer capability. The injected
 * `saveTemplate(draftJson, context)` callback is the only route that can
 * create a reusable immutable Template Version, and it is invoked only by the
 * explicit `saveDraft` command.
 */
function createTemplateDesignSessionService({
  db,
  saveTemplate,
  now = () => new Date().toISOString(),
  randomUUID,
  randomBytes = crypto.randomBytes,
  normalizeAgentCards = normalizeSharedAgentCards,
} = {}) {
  if (!db?.prepare) throw new Error("Template Design Session Service requires a database.");
  if (typeof saveTemplate !== "function") throw new Error("Template Design Session Service requires a saveTemplate callback.");
  if (typeof randomUUID !== "function") throw new Error("Template Design Session Service requires randomUUID.");
  if (typeof randomBytes !== "function") throw new Error("Template Design Session Service requires randomBytes.");
  if (typeof normalizeAgentCards !== "function") throw new Error("Template Design Session Service requires an Agent Card normalizer.");

  migrateTemplateDesignSessionService(db, { randomBytes });

  function createOrGetDraft(input = {}) {
    const draftId = normalizeDraftId(input.draftId || `template-design-${randomUUID()}`);
    const existing = draftById(draftId);
    if (existing) return { draft: existing, created: false };

    const draft = normalizeNewDraft({ ...input, draftId }, { normalizeAgentCards });
    return insertDraft(draft);
  }

  /**
   * Returns the one editable Draft for one immutable Template Version in one
   * project. Saving is a Version checkpoint, not a Draft transition, so a
   * saved checkpoint remains in this same editable Draft and Provider Session.
   * Only a discarded Draft is terminal. Historical rows that were written as
   * `saved` before checkpoint semantics remain terminal for compatibility.
   *
   * This is a service-owned transaction, so concurrent Runtime calls cannot
   * create two active Drafts for the same Template Version/cwd scope.
   */
  function createOrGetActiveExistingTemplateDraft(input = {}) {
    const requested = normalizeNewDraft({
      ...input,
      // This is an instance identity, deliberately unrelated to a historical
      // Template Version's source/provisioning key. A discarded or legacy
      // terminal Draft can never be selected again merely because a caller
      // repeats the same source.
      draftId: `template-design-${randomUUID()}`,
    }, { normalizeAgentCards });
    if (!requested.templateId || requested.baseTemplateVersion === undefined) {
      throw new Error("template_design_existing_template_target_required");
    }

    return transaction(() => {
      const active = activeDraftForExistingTemplate(requested);
      if (active) return { draft: active, created: false };

      if (draftById(requested.draftId)) throw new Error("template_design_draft_id_collision");
      return insertDraft(requested);
    });
  }

  function insertDraft(draft) {
    const timestamp = now();
    db.prepare(
      `INSERT INTO agent_loop_template_design_drafts
       (draft_id, template_id, base_template_version, cwd, model, model_variant, draft_json, revision,
        provider_session_id, capability_secret, last_processed_operation_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL, 'active', ?, ?)`,
    ).run(
      draft.draftId,
      draft.templateId || null,
      draft.baseTemplateVersion ?? null,
      draft.cwd,
      draft.model,
      draft.modelVariant ?? null,
      JSON.stringify(draft.draftJson),
      newCapabilitySecret(randomBytes),
      timestamp,
      timestamp,
    );
    return { draft: required(draftById(draft.draftId), "template_design_draft_not_found"), created: true };
  }

  function readDraft({ draftId } = {}) {
    return draftById(normalizeDraftId(draftId));
  }

  /**
   * Public, capability-free index used to reopen active Template Design
   * Sessions after navigation. It deliberately excludes `draftJson` and the
   * private per-Draft capability; detailed Draft contents remain an explicit
   * read by id through the owner Runtime.
   */
  function listActiveDrafts({ cwd } = {}) {
    const root = requiredString(cwd, "cwd");
    return db.prepare(
      `SELECT draft_id, template_id, base_template_version, cwd, model, model_variant, draft_json,
              revision, provider_session_id, status, created_at, updated_at
       FROM agent_loop_template_design_drafts
       WHERE status = 'active' AND cwd = ?
       ORDER BY updated_at DESC, draft_id ASC`,
    ).all(root).map((row) => {
      const draftJson = normalizeDraftJson(JSON.parse(row.draft_json));
      return {
        draftId: row.draft_id,
        templateId: row.template_id || undefined,
        baseTemplateVersion: row.base_template_version === null || row.base_template_version === undefined
          ? undefined
          : Number(row.base_template_version),
        cwd: row.cwd,
        model: row.model,
        ...(optionalModelVariant(row.model_variant) ? { modelVariant: optionalModelVariant(row.model_variant) } : {}),
        name: String(draftJson.name ?? "").trim(),
        revision: Number(row.revision),
        providerSessionId: row.provider_session_id || undefined,
        status: "active",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Returns the Draft-scoped capability only to the local Template Design
   * runtime so it can place it in that provider Session's system context. It
   * is deliberately separate from the renderer-facing Draft projection.
   */
  function readDraftCapability({ draftId } = {}) {
    const id = normalizeDraftId(draftId);
    const row = draftRowById(id);
    if (!row) throw new Error("template_design_draft_not_found");
    return { draftId: id, capabilitySecret: requiredCapabilitySecret(row.capability_secret) };
  }

  /**
   * Returns the private capability for exactly one active Draft binding. This
   * is intentionally not a renderer-facing query: the local OpenCode Host
   * plugin uses it immediately before a Template Designer MCP tool executes.
   * A provider Session can bind to no more than one Draft, so an LLM cannot
   * choose a different Draft by placing an id in its tool arguments.
   */
  function readProviderSessionBinding({ providerSessionId } = {}) {
    const sessionId = normalizeProviderSessionId(providerSessionId);
    const row = db.prepare(
      "SELECT draft_id, capability_secret FROM agent_loop_template_design_drafts WHERE provider_session_id = ? AND status = 'active'",
    ).get(sessionId);
    if (!row) return undefined;
    return {
      draftId: normalizeDraftId(row.draft_id),
      capabilitySecret: requiredCapabilitySecret(row.capability_secret),
    };
  }

  /**
   * The bridge uses this scoped read rather than the owner-facing readDraft.
   * A host-wide MCP transport credential alone cannot read another Draft.
   */
  function readScopedDraft({ draftId, capabilitySecret } = {}) {
    return scopedDraft({ draftId, capabilitySecret });
  }

  function bindProviderSession({ draftId, providerSessionId, expectedRevision } = {}) {
    const id = normalizeDraftId(draftId);
    const sessionId = normalizeProviderSessionId(providerSessionId);
    return transaction(() => {
      const draft = required(draftById(id), "template_design_draft_not_found");
      // A repeated receipt is already reflected durably and must not create a
      // second revision merely because the caller retried the bridge request.
      if (draft.providerSessionId === sessionId) return draft;
      assertActive(draft);
      assertExpectedRevision(draft.revision, expectedRevision);
      const conflicting = db.prepare(
        "SELECT draft_id FROM agent_loop_template_design_drafts WHERE provider_session_id = ? AND draft_id != ?",
      ).get(sessionId, id);
      if (conflicting) throw new Error("template_design_provider_session_already_bound");
      return updateDraft({
        draft,
        providerSessionId: sessionId,
        lastProcessedOperationId: null,
      });
    });
  }

  /**
   * Applies a constrained RFC-6902-shaped JSON Patch to `draftJson` only:
   * `{ op: "add" | "replace" | "remove", path: "/agents/0/name", value? }`.
   * The durable `operationId` makes an immediate ambiguous transport retry a
   * replay rather than a second revision. It intentionally does not mutate a
   * saved Template Version or any Task Architecture snapshot.
   */
  function applyStructuredPatch({ draftId, capabilitySecret, expectedRevision, operationId, patch } = {}) {
    const id = normalizeDraftId(draftId);
    const normalizedOperationId = requiredString(operationId, "operationId");
    const operations = normalizePatch(patch);
    return transaction(() => {
      const draft = scopedDraft({ draftId: id, capabilitySecret });
      if (draft.lastProcessedOperationId === normalizedOperationId) {
        return { draft, replayed: true };
      }
      assertActive(draft);
      assertExpectedRevision(draft.revision, expectedRevision);
      const nextDraftJson = normalizeDraftForWrite(
        applyPatch(draft.draftJson, operations),
        { defaultModel: draft.model, normalizeAgentCards },
      );
      const next = updateDraft({
        draft,
        draftJson: nextDraftJson,
        lastProcessedOperationId: normalizedOperationId,
      });
      return { draft: next, replayed: false };
    });
  }

  /**
   * Creates one immutable Template Version checkpoint from the current Draft
   * body and keeps the Draft active. Updating its revision is intentional: it
   * records the explicit checkpoint and fences a concurrent retry carrying the
   * same observed revision, so that retry cannot create a second Version.
   */
  function saveDraft({ draftId, expectedRevision } = {}) {
    const id = normalizeDraftId(draftId);
    return transaction(() => {
      const draft = required(draftById(id), "template_design_draft_not_found");
      assertActive(draft);
      assertExpectedRevision(draft.revision, expectedRevision);

      // The callback owns immutable Template Version creation. Supplying a
      // clone prevents it from changing this Service's active Draft in-place.
      const savedTemplate = saveTemplate(cloneJsonValue(draft.draftJson), {
        draftId: draft.draftId,
        templateId: draft.templateId,
        baseTemplateVersion: draft.baseTemplateVersion,
        cwd: draft.cwd,
        model: draft.model,
        ...(draft.modelVariant ? { modelVariant: draft.modelVariant } : {}),
        revision: draft.revision,
      });
      if (savedTemplate && typeof savedTemplate.then === "function") {
        throw new Error("template_design_save_template_callback_must_be_synchronous");
      }
      // Do not terminally mark the Draft as saved. The immutable Version above
      // is the checkpoint; this mutable Draft and its Provider Session remain
      // the continuation surface for subsequent Meta Agent edits.
      //
      // Retain the last patch operation id as well. A delayed replay of the
      // same Provider Patch must stay a replay rather than becoming a second
      // modification after a checkpoint.
      const next = updateDraft({ draft });
      return { draft: next, savedTemplate };
    });
  }

  function discardDraft({ draftId, expectedRevision } = {}) {
    const id = normalizeDraftId(draftId);
    return transaction(() => {
      const draft = required(draftById(id), "template_design_draft_not_found");
      if (draft.status === "discarded") return draft;
      assertActive(draft);
      assertExpectedRevision(draft.revision, expectedRevision);
      return updateDraft({
        draft,
        status: "discarded",
        lastProcessedOperationId: null,
      });
    });
  }

  function draftById(draftId) {
    const row = draftRowById(draftId);
    return row ? deserializeDraft(row, { normalizeAgentCards }) : undefined;
  }

  function draftRowById(draftId) {
    return db.prepare("SELECT * FROM agent_loop_template_design_drafts WHERE draft_id = ?").get(draftId);
  }

  function activeDraftForExistingTemplate(draft) {
    const row = db.prepare(
      `SELECT * FROM agent_loop_template_design_drafts
       WHERE status = 'active' AND template_id = ? AND base_template_version = ? AND cwd = ?
       ORDER BY updated_at DESC, draft_id ASC
       LIMIT 1`,
    ).get(draft.templateId, draft.baseTemplateVersion, draft.cwd);
    return row ? deserializeDraft(row, { normalizeAgentCards }) : undefined;
  }

  function scopedDraft({ draftId, capabilitySecret }) {
    const id = normalizeDraftId(draftId);
    const row = draftRowById(id);
    if (!row || !capabilityMatches(row.capability_secret, capabilitySecret)) {
      // Do not reveal whether a different Draft id exists to a caller that
      // holds only the shared Host transport credential.
      throw new Error("template_design_draft_capability_invalid");
    }
    return deserializeDraft(row, { normalizeAgentCards });
  }

  function updateDraft({ draft, draftJson = draft.draftJson, providerSessionId = draft.providerSessionId, lastProcessedOperationId = draft.lastProcessedOperationId, status = draft.status }) {
    const timestamp = now();
    if (!DRAFT_STATUSES.has(status)) throw new Error("template_design_draft_status_invalid");
    const result = db.prepare(
      `UPDATE agent_loop_template_design_drafts
       SET draft_json = ?, provider_session_id = ?, last_processed_operation_id = ?, status = ?,
           revision = revision + 1, updated_at = ?
       WHERE draft_id = ? AND revision = ?`,
    ).run(
      JSON.stringify(normalizeDraftJson(draftJson)),
      providerSessionId || null,
      lastProcessedOperationId || null,
      status,
      timestamp,
      draft.draftId,
      draft.revision,
    );
    if (!result.changes) throw new Error("template_design_draft_revision_conflict");
    return required(draftById(draft.draftId), "template_design_draft_not_found");
  }

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    applyStructuredPatch,
    bindProviderSession,
    createOrGetActiveExistingTemplateDraft,
    createOrGetDraft,
    discardDraft,
    listActiveDrafts,
    readDraft,
    readDraftCapability,
    readProviderSessionBinding,
    readScopedDraft,
    saveDraft,
  };
}

function migrateTemplateDesignSessionService(db, { randomBytes = crypto.randomBytes } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_loop_template_design_drafts (
      draft_id TEXT PRIMARY KEY,
      template_id TEXT,
      base_template_version INTEGER,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      model_variant TEXT,
      draft_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      provider_session_id TEXT,
      capability_secret TEXT NOT NULL,
      last_processed_operation_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'saved', 'discarded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const columns = db.prepare("PRAGMA table_info(agent_loop_template_design_drafts)").all();
  if (!columns.some((column) => String(column.name) === "model_variant")) {
    db.exec("ALTER TABLE agent_loop_template_design_drafts ADD COLUMN model_variant TEXT");
  }
  if (!columns.some((column) => String(column.name) === "capability_secret")) {
    // SQLite cannot add a NOT NULL column without a default to an existing
    // table. Backfill every legacy Draft synchronously before exposing the
    // service, then all normal writes use the NOT NULL creation shape above.
    db.exec("ALTER TABLE agent_loop_template_design_drafts ADD COLUMN capability_secret TEXT");
  }
  const updateSecret = db.prepare(
    "UPDATE agent_loop_template_design_drafts SET capability_secret = ? WHERE draft_id = ? AND (capability_secret IS NULL OR capability_secret = '')",
  );
  const legacyRows = db.prepare(
    "SELECT draft_id FROM agent_loop_template_design_drafts WHERE capability_secret IS NULL OR capability_secret = ''",
  ).all();
  for (const row of legacyRows) updateSecret.run(newCapabilitySecret(randomBytes), row.draft_id);
}

function deserializeDraft(row, { normalizeAgentCards } = {}) {
  const status = String(row.status || "");
  if (!DRAFT_STATUSES.has(status)) throw new Error("template_design_draft_status_invalid");
  const draftJson = normalizeDraftJson(JSON.parse(row.draft_json));
  return {
    draftId: row.draft_id,
    templateId: row.template_id || undefined,
    baseTemplateVersion: row.base_template_version === null || row.base_template_version === undefined
      ? undefined
      : Number(row.base_template_version),
    cwd: row.cwd,
    model: row.model,
    ...(optionalModelVariant(row.model_variant) ? { modelVariant: optionalModelVariant(row.model_variant) } : {}),
    draftJson,
    validation: deriveDraftValidation(draftJson, {
      defaultModel: row.model,
      normalizeAgentCards,
    }),
    revision: Number(row.revision),
    providerSessionId: row.provider_session_id || undefined,
    lastProcessedOperationId: row.last_processed_operation_id || undefined,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeNewDraft(input, { normalizeAgentCards } = {}) {
  const templateId = optionalString(input.templateId);
  const baseTemplateVersion = optionalPositiveInteger(input.baseTemplateVersion, "baseTemplateVersion");
  if (baseTemplateVersion !== undefined && !templateId) {
    throw new Error("template_design_draft_base_template_requires_template_id");
  }
  const model = requiredString(input.model, "model");
  const modelVariant = optionalModelVariant(input.modelVariant);
  return {
    draftId: normalizeDraftId(input.draftId),
    templateId,
    baseTemplateVersion,
    cwd: requiredString(input.cwd, "cwd"),
    model,
    ...(modelVariant ? { modelVariant } : {}),
    draftJson: normalizeDraftForWrite(input.draftJson, { defaultModel: model, normalizeAgentCards }),
  };
}

function normalizeDraftId(value) {
  const draftId = requiredString(value, "draftId");
  if (draftId.length > 240) throw new Error("template_design_draft_id_too_long");
  return draftId;
}

function normalizeProviderSessionId(value) {
  const sessionId = requiredString(value, "providerSessionId");
  if (sessionId.length > 240) throw new Error("template_design_provider_session_id_too_long");
  return sessionId;
}

function optionalModelVariant(value) {
  if (value === undefined || value === null) return undefined;
  const variant = String(value).trim();
  return variant ? variant.slice(0, 120) : undefined;
}

function normalizePatch(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("template_design_patch_required");
  return value.map((candidate, index) => {
    if (!isPlainObject(candidate)) throw new Error(`template_design_patch_operation_invalid:${index}`);
    const op = String(candidate.op || "").trim();
    if (!PATCH_OPERATIONS.has(op)) throw new Error(`template_design_patch_operation_invalid:${index}`);
    const segments = parseJsonPointer(candidate.path, index);
    const hasValue = Object.hasOwn(candidate, "value");
    if (op === "remove") {
      if (hasValue) throw new Error(`template_design_patch_remove_has_value:${index}`);
      return { op, segments };
    }
    if (!hasValue) throw new Error(`template_design_patch_value_required:${index}`);
    return { op, segments, value: cloneJsonValue(candidate.value) };
  });
}

function parseJsonPointer(value, index) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`template_design_patch_path_invalid:${index}`);
  }
  const segments = value.slice(1).split("/").map((segment) => {
    if (/~(?![01])/u.test(segment)) throw new Error(`template_design_patch_path_invalid:${index}`);
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (UNSAFE_PATH_SEGMENTS.has(decoded)) throw new Error(`template_design_patch_path_unsafe:${index}`);
    return decoded;
  });
  if (!segments.length) throw new Error(`template_design_patch_root_unsupported:${index}`);
  return segments;
}

function applyPatch(draftJson, operations) {
  const next = normalizeDraftJson(draftJson);
  for (const operation of operations) applyPatchOperation(next, operation);
  return normalizeDraftJson(next);
}

function applyPatchOperation(root, operation) {
  const parent = patchParent(root, operation.segments);
  const key = operation.segments.at(-1);
  if (Array.isArray(parent)) {
    if (operation.op === "add") {
      const index = key === "-" ? parent.length : arrayIndex(key, parent.length, { allowEnd: true });
      parent.splice(index, 0, operation.value);
      return;
    }
    const index = arrayIndex(key, parent.length);
    if (operation.op === "replace") {
      parent[index] = operation.value;
      return;
    }
    parent.splice(index, 1);
    return;
  }
  if (!isPlainObject(parent)) throw new Error("template_design_patch_target_invalid");
  if (operation.op === "add") {
    parent[key] = operation.value;
    return;
  }
  if (!Object.hasOwn(parent, key)) throw new Error("template_design_patch_target_missing");
  if (operation.op === "replace") {
    parent[key] = operation.value;
    return;
  }
  delete parent[key];
}

function patchParent(root, segments) {
  let target = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(target)) {
      target = target[arrayIndex(segment, target.length)];
    } else if (isPlainObject(target) && Object.hasOwn(target, segment)) {
      target = target[segment];
    } else {
      throw new Error("template_design_patch_target_missing");
    }
    if (!Array.isArray(target) && !isPlainObject(target)) {
      throw new Error("template_design_patch_target_invalid");
    }
  }
  return target;
}

function arrayIndex(segment, length, { allowEnd = false } = {}) {
  if (!/^(0|[1-9]\d*)$/u.test(segment)) throw new Error("template_design_patch_array_index_invalid");
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) {
    throw new Error("template_design_patch_array_index_invalid");
  }
  return index;
}

function normalizeDraftJson(value) {
  if (!isPlainObject(value)) throw new Error("template_design_draft_json_must_be_object");
  return cloneJsonValue(value);
}

/**
 * Drafts intentionally allow `agents: []` while they are being designed.
 * Once a Card exists, use the same normalizer as immutable Template Versions
 * so model defaults and the explicit/legacy union cannot diverge. This runs
 * before the Draft write; it never guesses aliases such as `systemPrompt`.
 */
function normalizeDraftForWrite(value, { defaultModel, normalizeAgentCards } = {}) {
  const draftJson = normalizeDraftJson(value);
  if (!Object.hasOwn(draftJson, "agents")) throw new Error("loop_template_agents_invalid");
  return {
    ...draftJson,
    agents: requiredAgentCardNormalizer(normalizeAgentCards)(draftJson.agents, {
      defaultModel: requiredString(defaultModel, "model"),
      allowEmpty: true,
      strictPromptContract: true,
    }),
  };
}

/**
 * Validation is a read projection only. It deliberately does not repair old
 * Draft JSON: an invalid historical Draft can be read, replaced with one
 * valid `/agents` array in a later Patch, or discarded by its owner.
 */
function deriveDraftValidation(draftJson, { defaultModel, normalizeAgentCards } = {}) {
  try {
    normalizeDraftForWrite(draftJson, { defaultModel, normalizeAgentCards });
    return { valid: true, issues: [] };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        path: "/agents",
        code: error instanceof Error && error.message ? error.message : "template_design_draft_agents_invalid",
      }],
    };
  }
}

function requiredAgentCardNormalizer(value) {
  if (typeof value !== "function") throw new Error("template_design_draft_agent_card_normalizer_required");
  return value;
}

function cloneJsonValue(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function assertJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error("template_design_draft_json_not_serializable");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_PATH_SEGMENTS.has(key)) throw new Error("template_design_draft_json_unsafe_key");
      assertJsonValue(item);
    }
    return;
  }
  throw new Error("template_design_draft_json_not_serializable");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertActive(draft) {
  if (draft.status !== "active") throw new Error("template_design_draft_not_active");
}

function assertExpectedRevision(actual, expected) {
  if (!Number.isInteger(expected) || expected !== actual) {
    throw new Error("template_design_draft_revision_conflict");
  }
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`template_design_draft_${field}_invalid`);
  return number;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function newCapabilitySecret(randomBytes) {
  const bytes = randomBytes(32);
  if (!bytes || Number(bytes.length) < 32) throw new Error("template_design_draft_capability_secret_unavailable");
  return Buffer.from(bytes).toString("base64url");
}

function requiredCapabilitySecret(value) {
  const secret = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(secret)) throw new Error("template_design_draft_capability_secret_invalid");
  return secret;
}

function capabilityMatches(storedValue, suppliedValue) {
  let expected;
  try {
    expected = Buffer.from(requiredCapabilitySecret(storedValue));
  } catch {
    return false;
  }
  const actual = Buffer.from(String(suppliedValue ?? ""));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requiredString(value, field) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`template_design_draft_${field}_required`);
  return normalized;
}

function required(value, errorCode) {
  if (!value) throw new Error(errorCode);
  return value;
}

module.exports = {
  createTemplateDesignSessionService,
  migrateTemplateDesignSessionService,
};
