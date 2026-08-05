const AGENT_CARD_KINDS = new Set(["researcher", "publisher", "reviewer", "general"]);

function createLoopTemplateStore({
  db,
  defaultModel,
  now = () => new Date().toISOString(),
  randomUUID,
} = {}) {
  if (!db?.prepare) throw new Error("Loop Template Store requires a database.");
  if (!defaultModel) throw new Error("Loop Template Store requires a default model.");
  if (typeof randomUUID !== "function") throw new Error("Loop Template Store requires randomUUID.");
  migrateTemplateIdentityMetadata(db);

  function listTemplates({ includeArchived = false } = {}) {
    return db
      .prepare(
        `SELECT t.*, identity.archived_at FROM agent_loop_template_versions t
         INNER JOIN agent_loop_templates identity ON identity.template_id = t.template_id
         INNER JOIN (
           SELECT template_id, MAX(version) AS version FROM agent_loop_template_versions GROUP BY template_id
         ) latest ON latest.template_id = t.template_id AND latest.version = t.version
         WHERE (? = 1 OR identity.archived_at IS NULL)
         ORDER BY t.updated_at DESC, t.template_id ASC`,
      )
      .all(includeArchived ? 1 : 0)
      .map((row) => deserializeLoopTemplate(row, { defaultModel }));
  }

  function templateById(templateId, version) {
    const row = Number.isInteger(version)
      ? db.prepare(
          `SELECT version.*, identity.archived_at
           FROM agent_loop_template_versions version
           INNER JOIN agent_loop_templates identity ON identity.template_id = version.template_id
           WHERE version.template_id = ? AND version.version = ?`,
        ).get(templateId, version)
      : db.prepare(
          `SELECT version.*, identity.archived_at
           FROM agent_loop_template_versions version
           INNER JOIN agent_loop_templates identity ON identity.template_id = version.template_id
           WHERE version.template_id = ? ORDER BY version.version DESC LIMIT 1`,
        ).get(templateId);
    return row ? deserializeLoopTemplate(row, { defaultModel }) : undefined;
  }

  /**
   * Immutable Version history for one Template identity.  This is deliberately
   * separate from `listTemplates`, which remains the current-Template picker
   * used by the ordinary Task flow.  Archive state belongs to the identity,
   * so historical versions stay inspectable even after that identity is
   * archived; their stored bodies are never rewritten.
   */
  function listTemplateVersions({ templateId } = {}) {
    const id = required(templateId, "templateId");
    return db
      .prepare(
        `SELECT version.*, identity.archived_at
         FROM agent_loop_template_versions version
         INNER JOIN agent_loop_templates identity ON identity.template_id = version.template_id
         WHERE version.template_id = ?
         ORDER BY version.version DESC`,
      )
      .all(id)
      .map((row) => deserializeLoopTemplate(row, { defaultModel }));
  }

  function saveTemplate(input) {
    const normalized = normalizeLoopTemplate(input, { defaultModel });
    const existing = templateById(normalized.id);
    const version = existing ? existing.version + 1 : 1;
    const createdAt = now();
    db.prepare(
      `INSERT INTO agent_loop_templates (template_id, archived_at, created_at, updated_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(template_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(normalized.id, createdAt, createdAt);
    db.prepare(
      `INSERT INTO agent_loop_template_versions
       (template_id, version, name, source, conductor_json, agents_json, limits_json, delivery_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      normalized.id,
      version,
      normalized.name,
      normalized.source,
      JSON.stringify(normalized.conductor),
      JSON.stringify(normalized.agents),
      JSON.stringify(normalized.limits),
      JSON.stringify(normalized.delivery),
      createdAt,
      createdAt,
    );
    return templateById(normalized.id, version);
  }

  function copyTemplate({ templateId, name }) {
    const source = required(templateById(required(templateId, "templateId")), "loop_template_not_found");
    const id = `loop-${safeSegment(name || `${source.name} copy`)}-${randomUUID().slice(0, 6)}`;
    return saveTemplate({ ...source, id, name: required(name || `${source.name} copy`, "name"), source: "manual" });
  }

  function archiveTemplate({ templateId }) {
    const template = required(templateById(required(templateId, "templateId")), "loop_template_not_found");
    const timestamp = now();
    // Archive is identity-level metadata projected onto every stored
    // version by this Store read model. Immutable version bodies never change.
    db.prepare("UPDATE agent_loop_templates SET archived_at = ?, updated_at = ? WHERE template_id = ?").run(timestamp, timestamp, template.id);
    return templateById(template.id);
  }

  function deleteTemplate({ templateId }) {
    const id = required(templateId, "templateId");
    const references = Number(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_tasks WHERE template_id = ?").get(id)?.count ?? 0);
    if (references) throw new Error("loop_template_is_referenced_by_task");
    db.prepare("DELETE FROM agent_loop_template_versions WHERE template_id = ?").run(id);
    db.prepare("DELETE FROM agent_loop_templates WHERE template_id = ?").run(id);
    return { deleted: true, templateId: id };
  }

  return {
    archiveTemplate,
    copyTemplate,
    deleteTemplate,
    listTemplates,
    listTemplateVersions,
    normalizeTemplate: (input) => normalizeLoopTemplate(input, { defaultModel }),
    saveTemplate,
    templateById,
  };
}

function migrateTemplateIdentityMetadata(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_loop_templates (
      template_id TEXT PRIMARY KEY, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const columns = db.prepare("PRAGMA table_info(agent_loop_template_versions)").all();
  const hadArchivedAt = columns.some((column) => String(column.name) === "archived_at");
  const versions = db.prepare("SELECT * FROM agent_loop_template_versions ORDER BY template_id, version ASC").all();
  const identities = new Map();
  for (const row of versions) {
    const current = identities.get(row.template_id);
    identities.set(row.template_id, {
      templateId: row.template_id,
      archivedAt: row.archived_at || current?.archivedAt || null,
      createdAt: current?.createdAt || row.created_at,
      updatedAt: row.updated_at,
    });
  }
  const insertIdentity = db.prepare(
    `INSERT INTO agent_loop_templates (template_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(template_id) DO UPDATE SET
       archived_at = COALESCE(agent_loop_templates.archived_at, excluded.archived_at),
       updated_at = CASE WHEN excluded.updated_at > agent_loop_templates.updated_at THEN excluded.updated_at ELSE agent_loop_templates.updated_at END`,
  );
  for (const identity of identities.values()) {
    insertIdentity.run(identity.templateId, identity.archivedAt, identity.createdAt, identity.updatedAt);
  }
  if (!hadArchivedAt) return;
  db.exec(`
    CREATE TABLE agent_loop_template_versions_without_identity (
      template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
      conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
    ) STRICT;
    INSERT INTO agent_loop_template_versions_without_identity
      (template_id, version, name, source, conductor_json, agents_json, limits_json, delivery_json, created_at, updated_at)
      SELECT template_id, version, name, source, conductor_json, agents_json, limits_json, delivery_json, created_at, updated_at
      FROM agent_loop_template_versions;
    DROP TABLE agent_loop_template_versions;
    ALTER TABLE agent_loop_template_versions_without_identity RENAME TO agent_loop_template_versions;
  `);
}

function normalizeAgentCards(input, { defaultModel, allowEmpty = false, strictPromptContract = false } = {}) {
  if (!Array.isArray(input)) throw new Error("loop_template_agents_invalid");
  const agents = input.map((card) => normalizeAgentCard(card, { defaultModel, strictPromptContract }));
  if (!allowEmpty && !agents.length) throw new Error("loop_template_requires_agent_card");
  if (new Set(agents.map((item) => item.id)).size !== agents.length) {
    throw new Error("loop_template_agent_card_id_duplicate");
  }
  return agents;
}

function normalizeAgentCard(input = {}, { defaultModel, strictPromptContract = false } = {}) {
  if (strictPromptContract) assertStrictAgentCardContract(input);
  const id = safeSegment(input.id || input.name || "agent");
  const identity = {
    id,
    name: required(input.name || id, "agent.name").slice(0, 80),
    kind: normalizeAgentCardKind(input.kind, input),
    model: String(input.model || defaultModel),
    ...(normalizeModelVariant(input.modelVariant) ? { modelVariant: normalizeModelVariant(input.modelVariant) } : {}),
    mcp: normalizeAllowlist(input.mcp),
    skills: normalizeAllowlist(input.skills),
  };
  if (hasPromptSplitFields(input)) {
    const dispatchProfile = input.dispatchProfile;
    if (
      !isRecord(dispatchProfile)
      || !Object.hasOwn(input, "workerSystemPrompt")
      || !String(dispatchProfile.title ?? "").trim()
      || !String(dispatchProfile.description ?? "").trim()
      || !String(input.workerSystemPrompt ?? "").trim()
    ) {
      throw new Error("loop_template_agent_card_prompt_contract_incomplete");
    }
    return {
      ...identity,
      dispatchProfile: {
        title: String(required(dispatchProfile.title, "agent.dispatchProfile.title")).trim().slice(0, 160),
        description: String(required(dispatchProfile.description, "agent.dispatchProfile.description")).trim().slice(0, 1200),
      },
      workerSystemPrompt: String(required(input.workerSystemPrompt, "agent.workerSystemPrompt")).trim().slice(0, 6000),
    };
  }
  // Legacy cards deliberately remain a separate contract. In particular, do
  // not infer a new Worker system prompt from `instructions`: older Template
  // Versions and Task Architecture snapshots must keep their original runtime
  // semantics until a person explicitly upgrades the Card in a new Version.
  return {
    ...identity,
    role: String(input.role || "Session Agent").trim().slice(0, 300),
    instructions: String(input.instructions || "").trim().slice(0, 2000),
    expectedOutput: String(input.expectedOutput || "").trim().slice(0, 600),
  };
}

function hasPromptSplitFields(input) {
  return Boolean(input && typeof input === "object")
    && (Object.hasOwn(input, "dispatchProfile") || Object.hasOwn(input, "workerSystemPrompt"));
}

/**
 * New Template Design Draft patches must choose one complete Card contract.
 * This is intentionally stricter than historical Version deserialization:
 * old immutable Versions remain readable, while a mutable Draft never guesses
 * whether a `systemPrompt` is a legacy note or a Worker system prompt.
 */
function assertStrictAgentCardContract(input) {
  if (!isRecord(input)) throw new Error("loop_template_agent_card_contract_invalid");
  if (!String(input.id || input.name || "").trim()) {
    throw new Error("loop_template_agent_card_identity_required");
  }

  const promptSplit = hasPromptSplitFields(input);
  const legacyFields = ["role", "instructions", "expectedOutput"].filter((field) => Object.hasOwn(input, field));
  const allowedFields = promptSplit
    ? new Set(["id", "name", "kind", "model", "modelVariant", "mcp", "skills", "dispatchProfile", "workerSystemPrompt"])
    : new Set(["id", "name", "kind", "model", "modelVariant", "mcp", "skills", "role", "instructions", "expectedOutput"]);

  if (promptSplit && (legacyFields.length || Object.hasOwn(input, "systemPrompt"))) {
    throw new Error("loop_template_agent_card_prompt_contract_mixed");
  }
  if (!promptSplit && Object.hasOwn(input, "systemPrompt")) {
    throw new Error("loop_template_agent_card_prompt_contract_mixed");
  }
  if (!promptSplit) {
    if (!legacyFields.length || !legacyFields.some((field) => String(input[field] ?? "").trim())) {
      throw new Error("loop_template_agent_card_legacy_contract_incomplete");
    }
  }
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new Error("loop_template_agent_card_contract_unknown_field");
  }
  if (promptSplit && isRecord(input.dispatchProfile)) {
    for (const field of Object.keys(input.dispatchProfile)) {
      if (field !== "title" && field !== "description") {
        throw new Error("loop_template_agent_card_prompt_contract_mixed");
      }
    }
  }
}

function isPromptSplitAgentCard(card) {
  return Boolean(card && typeof card === "object")
    && isRecord(card.dispatchProfile)
    && typeof card.dispatchProfile.title === "string"
    && typeof card.dispatchProfile.description === "string"
    && typeof card.workerSystemPrompt === "string";
}

function normalizeLoopTemplate(input, { defaultModel } = {}) {
  const id = safeSegment(input?.id || input?.name || "agent-loop");
  const agents = normalizeAgentCards(Array.isArray(input?.agents) ? input.agents : [], { defaultModel });
  const limits = input?.limits && typeof input.limits === "object" ? input.limits : {};
  const delivery = normalizeDelivery({
    artifactPath: String(input?.delivery?.artifactPath || "").trim(),
    ownerAgentId: input?.delivery?.ownerAgentId,
  });
  return {
    id,
    name: required(input?.name, "template.name").slice(0, 120),
    source: ["seed", "generated", "manual"].includes(String(input?.source)) ? String(input.source) : "manual",
    conductor: {
      role: String(input?.conductor?.role || "Conductor").trim().slice(0, 100),
      model: String(input?.conductor?.model || defaultModel),
      ...(normalizeModelVariant(input?.conductor?.modelVariant)
        ? { modelVariant: normalizeModelVariant(input.conductor.modelVariant) }
        : {}),
      charter: String(input?.conductor?.charter || input?.conductor?.instructions || "").trim().slice(0, 6000),
    },
    agents,
    limits: {
      maxConcurrentSessions: boundedInt(limits.maxConcurrentSessions, 3, 1, 8),
      maxDispatchesPerDecision: boundedInt(limits.maxDispatchesPerDecision, 3, 1, 8),
    },
    delivery,
  };
}

function templateSnapshot(template) {
  return {
    id: template.id,
    version: template.version,
    name: template.name,
    conductor: template.conductor,
    agents: template.agents,
    limits: template.limits,
    delivery: template.delivery,
  };
}

function deserializeLoopTemplate(row, { defaultModel } = {}) {
  const conductor = JSON.parse(row.conductor_json);
  return {
    id: row.template_id,
    version: Number(row.version),
    name: row.name,
    source: row.source,
    conductor: {
      ...conductor,
      charter: String(conductor?.charter || conductor?.instructions || "").trim(),
    },
    agents: JSON.parse(row.agents_json).map((card) => normalizeAgentCard(card, { defaultModel })),
    limits: JSON.parse(row.limits_json),
    delivery: normalizeStoredDelivery(JSON.parse(row.delivery_json)),
    archivedAt: row.archived_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAgentCardKind(value, input = {}) {
  const requested = String(value || "").trim().toLowerCase();
  if (AGENT_CARD_KINDS.has(requested)) return requested;
  const dispatchProfile = isRecord(input.dispatchProfile) ? input.dispatchProfile : {};
  const description = `${input.id || ""} ${input.name || ""} ${input.role || ""} ${input.instructions || ""} ${dispatchProfile.title || ""} ${dispatchProfile.description || ""}`.toLowerCase();
  if (/(review|reviewer|validator|审查|校验|验收)/i.test(description)) return "reviewer";
  if (/(publish|publisher|consolidat|writer|author|synthesi[sz]|交付|整合|汇总|发布|撰写)/i.test(description)) return "publisher";
  if (/(research|search|analyst|researcher|调研|搜索|研究|分析)/i.test(description)) return "researcher";
  return "general";
}

function normalizeDelivery(input = {}) {
  const originalPath = String(input.artifactPath || "").trim();
  const ownerAgentId = String(input.ownerAgentId || "").trim();
  if (!originalPath) return { artifactPath: "", ownerAgentId };
  return { artifactPath: normalizeArtifactPath(originalPath), ownerAgentId };
}

function normalizeStoredDelivery(input = {}) {
  return {
    artifactPath: String(input?.artifactPath || "").trim(),
    ownerAgentId: String(input?.ownerAgentId || "").trim(),
  };
}

function normalizeArtifactPath(value) {
  const relative = String(value ?? "").trim().replace(/^\/+/, "");
  if (!relative || relative.split(/[\\/]+/).includes("..")) throw new Error("loop_artifact_path_invalid");
  return relative;
}

function normalizeAllowlist(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

function normalizeModelVariant(value) {
  if (value === undefined || value === null) return undefined;
  const variant = String(value).trim();
  return variant ? variant.slice(0, 120) : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`Agent Loop Runtime requires ${field}.`);
  return value;
}

function safeSegment(value) {
  const result = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error("Agent Loop Runtime identity is required.");
  return result;
}

module.exports = {
  createLoopTemplateStore,
  deserializeLoopTemplate,
  isPromptSplitAgentCard,
  migrateTemplateIdentityMetadata,
  normalizeAgentCard,
  normalizeAgentCards,
  normalizeLoopTemplate,
  normalizeStoredDelivery,
  templateSnapshot,
};
