const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATE_DESIGNER_AGENT_NAME } = require("../opencode/host-config.cjs");

const TEMPLATE_DESIGNER_TOOL_NAMESPACE = "agent_workspace_template_designer_*";
const CONDUCTOR_TOOL_NAMESPACE = "agent_workspace_conductor_*";

/**
 * Connects one mutable Template Design Draft to its persistent, non-Task
 * OpenCode Session. It deliberately owns no Task, Run, Dispatch, or provider
 * result semantics; Template Design mutations remain in templateDesignService.
 */
function createTemplateDesignSessionRuntime({
  templateDesignService,
  openCodeServerManager,
  readTemplate,
  createHostConfig,
  resolveOpenCodeSessionPage,
  randomUUID = crypto.randomUUID,
} = {}) {
  assertTemplateDesignService(templateDesignService);
  assertServerManager(openCodeServerManager);
  if (typeof readTemplate !== "function") throw new Error("template_design_runtime_read_template_required");
  if (typeof createHostConfig !== "function") throw new Error("template_design_runtime_host_config_required");
  if (typeof resolveOpenCodeSessionPage !== "function") throw new Error("template_design_runtime_page_resolver_required");
  if (typeof randomUUID !== "function") throw new Error("template_design_runtime_random_uuid_required");

  // A historical Template Version is a source, not a Draft identity. Keep
  // concurrent provisioning scoped to the requested source while the Service
  // allocates the actual editable Draft identity.
  const provisioningByScope = new Map();

  /**
   * Opens one persistent Template Design Session for exactly one durable
   * Draft.  A saved Template Version and a brand-new Template use the same
   * command boundary; `target` is the only difference.  The legacy
   * `templateId` shape is retained temporarily for callers that predate the
   * discriminated target, but it always normalizes to the same existing
   * Template Version target before any side effect.
   */
  async function getOrCreateDesignSession(input = {}) {
    const canonicalCwd = canonicalProjectRoot(input.cwd);
    const target = normalizeDesignTarget(input);
    const specification = await designDraftSpecification({
      target,
      cwd: canonicalCwd,
      model: input.model,
      modelVariant: input.modelVariant,
      legacyTemplateId: !input.target ? input.templateId : undefined,
      readTemplate,
    });

    return serializeProvisioning(specification, async () => {
      const created = specification.target.kind === "existing_template_version"
        ? await templateDesignService.createOrGetActiveExistingTemplateDraft(specification)
        : await templateDesignService.createOrGetDraft(specification);
      let draft = requiredDraft(created?.draft);
      assertDraftMatchesSpecification({ draft, specification });
      if (!draft.providerSessionId) {
        draft = await createProviderSessionForDraft(draft);
      }
      return draft;
    });
  }

  async function readDesignSession({ draftId } = {}) {
    return templateDesignService.readDraft({ draftId: requiredString(draftId, "template_design_runtime_draft_id_required") });
  }

  /**
   * Lists only public metadata for active Drafts in one canonical project
   * root. This allows an unsaved new Template to be reopened after navigation
   * or renderer reload without exposing draft capabilities or another
   * project's Drafts.
   */
  async function listActiveDesignSessions({ cwd } = {}) {
    const canonicalCwd = canonicalProjectRoot(cwd);
    const drafts = await templateDesignService.listActiveDrafts({ cwd: canonicalCwd });
    if (!Array.isArray(drafts)) throw new Error("template_design_runtime_active_drafts_invalid");
    return drafts.map((draft) => publicDraftSummary(draft, canonicalCwd));
  }

  async function saveDesignDraft({ draftId, expectedRevision } = {}) {
    return templateDesignService.saveDraft({
      draftId: requiredString(draftId, "template_design_runtime_draft_id_required"),
      expectedRevision,
    });
  }

  async function discardDesignDraft({ draftId, expectedRevision } = {}) {
    return templateDesignService.discardDraft({
      draftId: requiredString(draftId, "template_design_runtime_draft_id_required"),
      expectedRevision,
    });
  }

  async function openDesignSessionPage({ draftId } = {}) {
    const draft = requiredDraft(await readDesignSession({ draftId }));
    if (draft.status !== "active") {
      return unavailablePage({ draft, reason: "template_design_draft_not_active" });
    }
    if (!draft.providerSessionId) {
      return unavailablePage({ draft, reason: "template_design_provider_session_missing" });
    }

    const ownerId = templateDesignOwnerId(draft.draftId);
    const leaseId = `template-design-presentation:${randomUUID()}`;
    let acquired = false;
    try {
      await openCodeServerManager.ensureOwner({
        ownerId,
        cwd: draft.cwd,
        config: await hostRuntimeConfig({ cwd: draft.cwd }),
        leaseId,
      });
      acquired = true;
      const server = openCodeServerManager.getOwner({ ownerId });
      if (!server) throw new Error("template_design_runtime_host_not_ready");
      const client = openCodeServerManager.clientForOwner({ ownerId });
      try {
        await client.getSession({ cwd: draft.cwd, providerSessionId: draft.providerSessionId });
      } catch {
        return unavailablePage({ draft, reason: "template_design_provider_session_unavailable" });
      }
      const page = await resolveOpenCodeSessionPage({
        draftId: draft.draftId,
        cwd: draft.cwd,
        providerSessionId: draft.providerSessionId,
        server,
      });
      if (page?.presentation !== "direct_url") return { ...page, draftId: draft.draftId };
      acquired = false;
      return { ...page, draftId: draft.draftId, presentationLeaseId: leaseId };
    } finally {
      if (acquired) await openCodeServerManager.releaseOwner({ ownerId, leaseId });
    }
  }

  async function releaseDesignSessionPage({ draftId, leaseId } = {}) {
    return openCodeServerManager.releaseOwner({
      ownerId: templateDesignOwnerId(requiredString(draftId, "template_design_runtime_draft_id_required")),
      leaseId: requiredString(leaseId, "template_design_runtime_presentation_lease_required"),
    });
  }

  async function createProviderSessionForDraft(draft) {
    const ownerId = templateDesignOwnerId(draft.draftId);
    const leaseId = `template-design-provision:${randomUUID()}`;
    let acquired = false;
    try {
      await openCodeServerManager.ensureOwner({
        ownerId,
        cwd: draft.cwd,
        config: await hostRuntimeConfig({ cwd: draft.cwd }),
        leaseId,
      });
      acquired = true;
      const client = openCodeServerManager.clientForOwner({ ownerId });
      const created = await client.createSession({
        cwd: draft.cwd,
        title: `Template Draft · ${String(draft.draftJson?.name ?? draft.templateId ?? draft.draftId)}`,
        agent: TEMPLATE_DESIGNER_AGENT_NAME,
        model: openCodeModelSelection({ model: draft.model, modelVariant: draft.modelVariant }),
        metadata: {
          agentWorkspaceKind: "template_design",
          agentWorkspaceDraftId: draft.draftId,
        },
        permission: templateDesignerPermissionRules(),
      });
      const providerSessionId = requiredString(created?.id, "template_design_runtime_provider_session_id_required");
      const bound = requiredDraft(await templateDesignService.bindProviderSession({
        draftId: draft.draftId,
        providerSessionId,
        expectedRevision: draft.revision,
      }));

      // Deliberately create an empty Provider Session. The first Provider turn
      // belongs to the user's actual message in the official WebUI. When that
      // message invokes a Template Designer tool, the Host plugin resolves the
      // Session to this Draft without exposing its capability in model-visible
      // Provider state.
      return bound;
    } finally {
      if (acquired) await openCodeServerManager.releaseOwner({ ownerId, leaseId });
    }
  }

  function serializeProvisioning(specification, work) {
    const key = specification.provisioningKey;
    const existing = provisioningByScope.get(key);
    if (existing) {
      assertCompatibleProvisioningSpecification(existing.specification, specification);
      return existing.promise;
    }
    const entry = { specification, promise: undefined };
    entry.promise = Promise.resolve().then(work).finally(() => {
      if (provisioningByScope.get(key) === entry) provisioningByScope.delete(key);
    });
    provisioningByScope.set(key, entry);
    return entry.promise;
  }

  async function hostRuntimeConfig({ cwd } = {}) {
    const config = await createHostConfig({ cwd });
    if (!config || typeof config !== "object" || Array.isArray(config) || !config.content || typeof config.content !== "object" || Array.isArray(config.content)) {
      throw new Error("template_design_runtime_host_config_content_required");
    }
    return config;
  }

  return {
    getOrCreateDesignSession,
    listActiveDesignSessions,
    readDesignSession,
    saveDesignDraft,
    discardDesignDraft,
    openDesignSessionPage,
    releaseDesignSessionPage,
  };
}

async function designDraftSpecification({ target, cwd, model, modelVariant, legacyTemplateId, readTemplate }) {
  if (target.kind === "new_template") {
    const draftId = requiredString(target.draftId, "template_design_runtime_new_draft_id_required");
    const resolvedModel = requiredString(model, "template_design_runtime_model_required");
    const resolvedModelVariant = optionalModelVariant(modelVariant);
    return {
      target,
      draftId,
      provisioningKey: JSON.stringify({ kind: "new_template", draftId }),
      cwd,
      model: resolvedModel,
      ...(resolvedModelVariant ? { modelVariant: resolvedModelVariant } : {}),
      draftJson: emptyTemplateDraftJson({ draftId, model: resolvedModel, modelVariant: resolvedModelVariant }),
    };
  }

  const requestedTemplateId = requiredString(target.templateId, "template_design_runtime_template_id_required");
  const requestedTemplateVersion = target.templateVersion;
  const template = await readTemplate({
    templateId: requestedTemplateId,
    templateVersion: requestedTemplateVersion,
  });
  if (!template || typeof template !== "object") throw new Error("template_design_runtime_template_not_found");
  const baseTemplateVersion = requiredPositiveInteger(template.version, "template_design_runtime_template_version_required");
  if (requestedTemplateVersion !== undefined && baseTemplateVersion !== requestedTemplateVersion) {
    throw new Error("template_design_runtime_template_version_mismatch");
  }
  const resolvedTemplateId = requiredString(template.id ?? requestedTemplateId, "template_design_runtime_template_id_required");
  // The discriminated command requires its model explicitly.  A pre-target
  // caller may still use the model committed by that immutable Version while
  // the renderer migrates; no ambient model default is consulted.
  const resolvedModel = requiredString(
    model ?? (legacyTemplateId ? template.conductor?.model ?? template.model : undefined),
    "template_design_runtime_model_required",
  );
  const resolvedModelVariant = optionalModelVariant(modelVariant);
  return {
    target: {
      kind: "existing_template_version",
      templateId: resolvedTemplateId,
      templateVersion: baseTemplateVersion,
    },
    provisioningKey: JSON.stringify({
      kind: "existing_template_version",
      templateId: resolvedTemplateId,
      baseTemplateVersion,
      cwd,
    }),
    templateId: resolvedTemplateId,
    baseTemplateVersion,
    cwd,
    model: resolvedModel,
    ...(resolvedModelVariant ? { modelVariant: resolvedModelVariant } : {}),
    // A Template Version read model carries versioning/archive projection
    // fields with optional undefined values. The mutable Draft is only the
    // editable Template body; identity/version metadata stays outside it.
    draftJson: templateDraftJson(template),
  };
}

function normalizeDesignTarget(input = {}) {
  const rawTarget = input?.target;
  if (!rawTarget && input?.templateId) {
    return {
      kind: "existing_template_version",
      templateId: requiredString(input.templateId, "template_design_runtime_template_id_required"),
      templateVersion: optionalPositiveInteger(input.templateVersion, "template_design_runtime_template_version_invalid"),
    };
  }
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    throw new Error("template_design_runtime_target_required");
  }
  const kind = requiredString(rawTarget.kind, "template_design_runtime_target_kind_required");
  if (kind === "existing_template_version") {
    return {
      kind,
      templateId: requiredString(rawTarget.templateId, "template_design_runtime_template_id_required"),
      templateVersion: optionalPositiveInteger(rawTarget.templateVersion, "template_design_runtime_template_version_invalid"),
    };
  }
  if (kind === "new_template") {
    return {
      kind,
      draftId: requiredString(rawTarget.draftId, "template_design_runtime_new_draft_id_required"),
    };
  }
  throw new Error("template_design_runtime_target_kind_invalid");
}

function assertDraftMatchesSpecification({ draft, specification }) {
  if (draft.status !== "active") {
    throw new Error("template_design_runtime_draft_not_active");
  }
  if (canonicalProjectRoot(draft.cwd) !== specification.cwd) {
    throw new Error("template_design_runtime_draft_cwd_mismatch");
  }
  if (draft.model !== specification.model) {
    throw new Error("template_design_runtime_draft_model_mismatch");
  }
  if (optionalModelVariant(draft.modelVariant) !== optionalModelVariant(specification.modelVariant)) {
    throw new Error("template_design_runtime_draft_model_variant_mismatch");
  }
  if (specification.target.kind === "new_template") {
    if (draft.templateId !== undefined || draft.baseTemplateVersion !== undefined) {
      throw new Error("template_design_runtime_draft_target_mismatch");
    }
    return;
  }
  if (draft.templateId !== specification.templateId || draft.baseTemplateVersion !== specification.baseTemplateVersion) {
    throw new Error("template_design_runtime_draft_target_mismatch");
  }
}

function assertCompatibleProvisioningSpecification(left, right) {
  if (left.cwd !== right.cwd) throw new Error("template_design_runtime_draft_cwd_mismatch");
  if (left.model !== right.model) throw new Error("template_design_runtime_draft_model_mismatch");
  if (optionalModelVariant(left.modelVariant) !== optionalModelVariant(right.modelVariant)) {
    throw new Error("template_design_runtime_draft_model_variant_mismatch");
  }
  if (left.target.kind !== right.target.kind) throw new Error("template_design_runtime_draft_target_mismatch");
  if (left.target.kind === "existing_template_version") {
    if (left.target.templateId !== right.target.templateId || left.target.templateVersion !== right.target.templateVersion) {
      throw new Error("template_design_runtime_draft_target_mismatch");
    }
  }
  if (left.target.kind === "new_template" && left.target.draftId !== right.target.draftId) {
    throw new Error("template_design_runtime_draft_target_mismatch");
  }
}

function publicDraftSummary(draft, canonicalCwd) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("template_design_runtime_active_draft_invalid");
  }
  if (draft.status !== "active" || canonicalProjectRoot(draft.cwd) !== canonicalCwd) {
    throw new Error("template_design_runtime_active_draft_scope_invalid");
  }
  return {
    draftId: requiredString(draft.draftId, "template_design_runtime_draft_id_required"),
    templateId: draft.templateId ? requiredString(draft.templateId, "template_design_runtime_template_id_required") : undefined,
    baseTemplateVersion: draft.baseTemplateVersion === undefined
      ? undefined
      : requiredPositiveInteger(draft.baseTemplateVersion, "template_design_runtime_template_version_required"),
    cwd: canonicalCwd,
    model: requiredString(draft.model, "template_design_runtime_model_required"),
    ...(optionalModelVariant(draft.modelVariant) ? { modelVariant: optionalModelVariant(draft.modelVariant) } : {}),
    name: String(draft.name ?? "").trim(),
    revision: requiredPositiveInteger(draft.revision, "template_design_runtime_draft_revision_required"),
    providerSessionId: draft.providerSessionId ? requiredString(draft.providerSessionId, "template_design_runtime_provider_session_id_required") : undefined,
    status: "active",
    createdAt: requiredString(draft.createdAt, "template_design_runtime_draft_created_at_required"),
    updatedAt: requiredString(draft.updatedAt, "template_design_runtime_draft_updated_at_required"),
  };
}

function emptyTemplateDraftJson({ draftId, model, modelVariant }) {
  const digest = crypto.createHash("sha256").update(requiredString(draftId, "template_design_runtime_new_draft_id_required")).digest("hex").slice(0, 16);
  return {
    id: `template-${digest}`,
    name: "Untitled Agent Loop",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: requiredString(model, "template_design_runtime_model_required"),
      ...(optionalModelVariant(modelVariant) ? { modelVariant: optionalModelVariant(modelVariant) } : {}),
      charter: "",
    },
    agents: [],
    limits: {
      maxConcurrentSessions: 3,
      maxDispatchesPerDecision: 3,
    },
    delivery: {
      artifactPath: "",
      ownerAgentId: "",
    },
  };
}

function templateDesignerPermissionRules() {
  return [
    { permission: CONDUCTOR_TOOL_NAMESPACE, pattern: "*", action: "deny" },
    { permission: TEMPLATE_DESIGNER_TOOL_NAMESPACE, pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "*", action: "deny" },
  ];
}

function unavailablePage({ draft, reason }) {
  return {
    presentation: "unavailable",
    draftId: draft.draftId,
    providerSessionId: draft.providerSessionId,
    reason,
  };
}

function openCodeModelSelection({ model, modelVariant } = {}) {
  const variant = optionalModelVariant(modelVariant);
  const id = requiredString(model, "template_design_runtime_model_required");
  if (!variant) return id;
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error("template_design_runtime_model_invalid");
  }
  return {
    providerID: id.slice(0, separator),
    modelID: id.slice(separator + 1),
    variant,
  };
}

function optionalModelVariant(value) {
  if (value === undefined || value === null) return undefined;
  const variant = String(value).trim();
  return variant ? variant.slice(0, 120) : undefined;
}

function templateDesignOwnerId(draftId) {
  return `template-design:${requiredString(draftId, "template_design_runtime_draft_id_required")}`;
}

function templateDraftJson(template) {
  const body = {
    id: requiredString(template?.id, "template_design_runtime_template_id_required"),
    name: requiredString(template?.name, "template_design_runtime_template_name_required"),
    source: requiredString(template?.source, "template_design_runtime_template_source_required"),
    conductor: template?.conductor,
    agents: template?.agents,
    limits: template?.limits,
    delivery: template?.delivery,
  };
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    throw new Error("template_design_runtime_template_body_not_serializable");
  }
}

function canonicalProjectRoot(cwd) {
  const resolved = path.resolve(requiredString(cwd, "template_design_runtime_cwd_required"));
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(resolved);
  } catch {
    return resolved;
  }
}

function assertTemplateDesignService(service) {
  for (const name of ["createOrGetDraft", "createOrGetActiveExistingTemplateDraft", "listActiveDrafts", "readDraft", "bindProviderSession", "applyStructuredPatch", "saveDraft", "discardDraft"]) {
    if (typeof service?.[name] !== "function") throw new Error(`template_design_runtime_service_method_required:${name}`);
  }
}

function assertServerManager(manager) {
  for (const name of ["ensureOwner", "getOwner", "clientForOwner", "releaseOwner"]) {
    if (typeof manager?.[name] !== "function") throw new Error(`template_design_runtime_server_manager_method_required:${name}`);
  }
}

function requiredDraft(value) {
  if (!value || typeof value !== "object") throw new Error("template_design_runtime_draft_not_found");
  return value;
}

function requiredPositiveInteger(value, reason) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(reason);
  return number;
}

function optionalPositiveInteger(value, reason) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredPositiveInteger(value, reason);
}

function requiredString(value, reason) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(reason);
  return text;
}

module.exports = {
  createTemplateDesignSessionRuntime,
  templateDesignOwnerId,
  templateDesignerPermissionRules,
  templateDraftJson,
};
