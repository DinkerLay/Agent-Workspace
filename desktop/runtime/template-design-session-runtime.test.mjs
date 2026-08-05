import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTemplateDesignSessionRuntime } = require("./template-design-session-runtime.cjs");
const { test } = await import("node:test");

test("reuses one persistent empty Template Design provider Session without starting a Provider turn", async () => {
  const fixture = createFixture();
  const input = {
    target: { kind: "existing_template_version", templateId: "deepsearch" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  };
  const first = await fixture.runtime.getOrCreateDesignSession({
    templateId: "deepsearch",
    cwd: input.cwd,
  });
  const second = await fixture.runtime.getOrCreateDesignSession(input);

  assert.equal(first.draftId, second.draftId);
  assert.equal(first.providerSessionId, "ses_design001");
  assert.equal(second.providerSessionId, "ses_design001");
  assert.equal(fixture.clientCalls.createSession.length, 1);
  assert.equal(fixture.clientCalls.promptAsync.length, 0, "opening a Template Design Session must not create a bootstrap conversation turn");
  assert.equal(fixture.serviceCalls.bindProviderSession.length, 1);
  assert.equal(fixture.managerCalls.ensureOwner.length, 1);
  assert.equal(fixture.managerCalls.releaseOwner.length, 1);
  assert.deepEqual(fixture.hostConfigCalls, [{ cwd: "/tmp/template-design-runtime" }]);
  assert.deepEqual(fixture.managerCalls.ensureOwner[0].config, {
    content: { default_agent: "build", tools: { "agent_workspace_template_designer_*": false } },
  });
  assert.equal(fixture.manager.ownerLeases.has(`template-design:${first.draftId}`), false, "the provisioning lease is not retained after session creation");
  assert.ok(fixture.manager.ownerLeases.has("task-run:task-1:run-1"), "an unrelated Task Run owner remains on the shared Host");

  const created = fixture.clientCalls.createSession[0];
  assert.equal(created.agent, "agent_workspace_template_designer");
  assert.equal(Object.hasOwn(created, "timeoutMs"), false, "Session cold-start policy belongs to the shared OpenCode client");
  assert.deepEqual(created.metadata, {
    agentWorkspaceKind: "template_design",
    agentWorkspaceDraftId: first.draftId,
  });
  assert.equal(Object.hasOwn(created, "taskId"), false);
  assert.equal(Object.hasOwn(created, "runId"), false);
});

test("creates the dedicated Template Meta Agent Session with an explicitly selected provider variant", async () => {
  const fixture = createFixture();
  const session = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "new_template", draftId: "template-design-variant" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
    modelVariant: "max",
  });

  assert.equal(session.modelVariant, "max");
  assert.equal(session.draftJson.conductor.modelVariant, "max");
  assert.deepEqual(fixture.clientCalls.createSession[0].model, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "max",
  });
  assert.equal(fixture.clientCalls.createSession[0].agent, "agent_workspace_template_designer");
  assert.equal(fixture.clientCalls.promptAsync.length, 0, "the official WebUI still owns the first Meta Agent turn");
});

test("creates a new Draft from the exact selected immutable Template Version", async () => {
  const fixture = createFixture();
  const historical = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "existing_template_version", templateId: "deepsearch", templateVersion: 7 },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });

  assert.equal(historical.templateId, "deepsearch");
  assert.equal(historical.baseTemplateVersion, 7);
  assert.equal(historical.draftJson.name, "DeepSearch v7");
  assert.equal(historical.draftJson.conductor.charter, "Historical charter.");
  assert.deepEqual(fixture.templateReadCalls, [{ templateId: "deepsearch", templateVersion: 7 }]);

  const current = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "existing_template_version", templateId: "deepsearch", templateVersion: 10 },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });
  assert.equal(current.baseTemplateVersion, 10);
  assert.notEqual(current.draftId, historical.draftId, "a historical Version gets its own Draft identity");
  assert.deepEqual(fixture.templateReadCalls, [
    { templateId: "deepsearch", templateVersion: 7 },
    { templateId: "deepsearch", templateVersion: 10 },
  ]);
});

test("keeps the same active Draft and Provider Session after a Version checkpoint", async () => {
  const fixture = createFixture();
  const input = {
    target: { kind: "existing_template_version", templateId: "deepsearch", templateVersion: 7 },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  };
  const first = await fixture.runtime.getOrCreateDesignSession(input);
  await fixture.runtime.saveDesignDraft({ draftId: first.draftId, expectedRevision: first.revision });

  const [reopened, retry] = await Promise.all([
    fixture.runtime.getOrCreateDesignSession(input),
    fixture.runtime.getOrCreateDesignSession(input),
  ]);

  assert.equal(fixture.drafts.get(first.draftId).status, "active", "a checkpoint does not terminally close the Draft");
  assert.equal(reopened.draftId, first.draftId, "continuing the same source keeps the Draft identity");
  assert.equal(reopened.draftId, retry.draftId, "concurrent reopen returns the same active Draft");
  assert.equal(reopened.status, "active");
  assert.equal(reopened.baseTemplateVersion, 7);
  assert.equal(reopened.draftJson.name, "DeepSearch v7", "the exact historical body is preserved");
  assert.equal(reopened.providerSessionId, "ses_design001", "a checkpoint keeps the Meta Agent Provider Session");
  assert.equal(fixture.clientCalls.createSession.length, 1, "continuation must not create another Provider Session");
  assert.equal(fixture.serviceCalls.createOrGetActiveExistingTemplateDraft.length, 2);

  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({ ...input, model: "opencode-go/gpt-5.7-luna" }),
    /template_design_runtime_draft_model_mismatch/,
  );
  assert.equal(fixture.clientCalls.createSession.length, 1, "a conflicting request cannot create another Provider Session");
});

test("rejects an exact historical target when a Reader returns a different Version", async () => {
  const fixture = createFixture({
    readTemplate: async ({ templateId }) => templateId === "deepsearch"
      ? {
        id: "deepsearch",
        version: 10,
        name: "DeepSearch",
        source: "manual",
        conductor: { model: "opencode-go/gpt-5.6-luna" },
        agents: [{ id: "searcher-0" }],
        limits: { maxConcurrentSessions: 2, maxDispatchesPerDecision: 2 },
        delivery: { artifactPath: "", ownerAgentId: "" },
      }
      : undefined,
  });

  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({
      target: { kind: "existing_template_version", templateId: "deepsearch", templateVersion: 7 },
      cwd: "/tmp/template-design-runtime",
      model: "opencode-go/gpt-5.6-luna",
    }),
    /template_design_runtime_template_version_mismatch/,
  );
  assert.equal(fixture.clientCalls.createSession.length, 0, "an exact historical Draft never falls back to the latest Provider Session");
});

test("keeps a shared Host only for an open Template Design page and saves through the Draft service", async () => {
  const fixture = createFixture();
  const session = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "existing_template_version", templateId: "deepsearch" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });
  const page = await fixture.runtime.openDesignSessionPage({ draftId: session.draftId });

  assert.equal(page.presentation, "direct_url");
  assert.equal(page.providerSessionId, session.providerSessionId);
  assert.equal(page.draftId, session.draftId);
  assert.equal(page.presentationLeaseId, "template-design-presentation:uuid-2");
  assert.equal(fixture.manager.ownerLeases.has(`template-design:${session.draftId}`), true);
  assert.equal(fixture.pageCalls.length, 1);
  assert.equal(fixture.pageCalls[0].server.origin, "http://127.0.0.1:44222");
  assert.deepEqual(fixture.clientCalls.getSession, [{ cwd: "/tmp/template-design-runtime", providerSessionId: "ses_design001" }]);

  assert.equal(await fixture.runtime.releaseDesignSessionPage({ draftId: session.draftId, leaseId: page.presentationLeaseId }), true);
  assert.equal(fixture.manager.ownerLeases.has(`template-design:${session.draftId}`), false);
  assert.ok(fixture.manager.ownerLeases.has("task-run:task-1:run-1"), "releasing the presentation lease does not release a Task Run owner");

  const saved = await fixture.runtime.saveDesignDraft({ draftId: session.draftId, expectedRevision: session.revision });
  assert.equal(fixture.serviceCalls.saveDraft.length, 1);
  assert.deepEqual(fixture.serviceCalls.saveDraft[0], { draftId: session.draftId, expectedRevision: session.revision });
  assert.equal(saved.draft.status, "active");
  assert.deepEqual(saved.savedTemplate, { id: "deepsearch", version: 11 });
  assert.equal(fixture.clientCalls.createSession.length, 1, "saving does not create another provider Session");
  const continuedPage = await fixture.runtime.openDesignSessionPage({ draftId: saved.draft.draftId });
  assert.equal(continuedPage.presentation, "direct_url");
  assert.equal(continuedPage.providerSessionId, session.providerSessionId, "the same provider session remains presentable after save");
  await fixture.runtime.releaseDesignSessionPage({ draftId: saved.draft.draftId, leaseId: continuedPage.presentationLeaseId });
});

test("requires a Server Manager runtime config wrapper instead of silently dropping raw OpenCode content", async () => {
  const fixture = createFixture({
    hostConfigFactory: () => ({ default_agent: "build" }),
  });

  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({
      target: { kind: "existing_template_version", templateId: "deepsearch" },
      cwd: "/tmp/template-design-runtime",
      model: "opencode-go/gpt-5.6-luna",
    }),
    /template_design_runtime_host_config_content_required/,
  );
  assert.equal(fixture.managerCalls.ensureOwner.length, 0, "raw config must not reach Server Manager");
});

test("creates one stable blank Draft Session for a new Template without an automatic Provider turn", async () => {
  const fixture = createFixture();
  const input = {
    target: { kind: "new_template", draftId: "template-design-new-storage-chain" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  };
  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({
      target: input.target,
      cwd: input.cwd,
    }),
    /template_design_runtime_model_required/,
  );
  const [first, second] = await Promise.all([
    fixture.runtime.getOrCreateDesignSession(input),
    fixture.runtime.getOrCreateDesignSession(input),
  ]);

  assert.equal(first.draftId, "template-design-new-storage-chain");
  assert.equal(second.draftId, first.draftId);
  assert.equal(first.templateId, undefined);
  assert.equal(first.baseTemplateVersion, undefined);
  assert.equal(first.providerSessionId, "ses_design001");
  assert.equal(fixture.clientCalls.createSession.length, 1, "same draftId is serialized before Provider creation");
  assert.equal(fixture.clientCalls.promptAsync.length, 0, "the first Provider turn remains the user's official WebUI message");
  assert.deepEqual(first.draftJson, {
    id: "template-c6072ceaa4f19a74",
    name: "Untitled Agent Loop",
    source: "manual",
    conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "" },
    agents: [],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "", ownerAgentId: "" },
  });

  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({ ...input, cwd: "/tmp/other-project" }),
    /template_design_runtime_draft_cwd_mismatch/,
  );
  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({ ...input, model: "opencode-go/gpt-5.7-luna" }),
    /template_design_runtime_draft_model_mismatch/,
  );

  const existing = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "existing_template_version", templateId: "deepsearch" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });
  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({
      target: { kind: "new_template", draftId: existing.draftId },
      cwd: "/tmp/template-design-runtime",
      model: "opencode-go/gpt-5.6-luna",
    }),
    /template_design_runtime_draft_target_mismatch/,
  );
});

test("rejects a conflicting concurrent request for the same new Draft before it can share a Provider result", async () => {
  const enteredCreate = deferred();
  const releaseCreate = deferred();
  const fixture = createFixture({
    onCreateSession: async () => {
      enteredCreate.resolve();
      await releaseCreate.promise;
    },
  });
  const input = {
    target: { kind: "new_template", draftId: "template-design-new-concurrent" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  };
  const first = fixture.runtime.getOrCreateDesignSession(input);
  await enteredCreate.promise;
  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession({ ...input, model: "opencode-go/gpt-5.7-luna" }),
    /template_design_runtime_draft_model_mismatch/,
  );
  releaseCreate.resolve();
  await first;
  assert.equal(fixture.clientCalls.createSession.length, 1);
});

test("keeps one active Draft and one retry Session when a prior provision times out", async () => {
  let createAttempts = 0;
  const retryEntered = deferred();
  const releaseRetry = deferred();
  const fixture = createFixture({
    onCreateSession: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("opencode_server_request_timeout");
      retryEntered.resolve();
      await releaseRetry.promise;
    },
  });
  const input = {
    target: { kind: "existing_template_version", templateId: "deepsearch", templateVersion: 7 },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  };

  await assert.rejects(
    () => fixture.runtime.getOrCreateDesignSession(input),
    /opencode_server_request_timeout/,
  );
  const [draft] = Array.from(fixture.drafts.values());
  assert.equal(draft.status, "active");
  assert.equal(draft.providerSessionId, undefined, "a failed create leaves the durable Draft retryable instead of inventing a Session");

  const firstRetry = fixture.runtime.getOrCreateDesignSession(input);
  await retryEntered.promise;
  const secondRetry = fixture.runtime.getOrCreateDesignSession(input);
  releaseRetry.resolve();
  const [first, second] = await Promise.all([firstRetry, secondRetry]);

  assert.equal(first.draftId, draft.draftId);
  assert.equal(second.draftId, draft.draftId);
  assert.equal(first.providerSessionId, "ses_design002");
  assert.equal(second.providerSessionId, "ses_design002");
  assert.equal(fixture.clientCalls.createSession.length, 2, "the explicit retry made one additional Provider request, not one per caller");
  assert.equal(fixture.serviceCalls.bindProviderSession.length, 1);
});

test("keeps checkpointed Drafts in the active public Draft index", async () => {
  const fixture = createFixture();
  const active = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "new_template", draftId: "template-design-new-list" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });
  const saved = await fixture.runtime.getOrCreateDesignSession({
    target: { kind: "existing_template_version", templateId: "deepsearch" },
    cwd: "/tmp/template-design-runtime",
    model: "opencode-go/gpt-5.6-luna",
  });
  await fixture.runtime.saveDesignDraft({ draftId: saved.draftId, expectedRevision: saved.revision });

  const listed = await fixture.runtime.listActiveDesignSessions({ cwd: "/tmp/template-design-runtime" });
  assert.deepEqual(listed.map((draft) => draft.draftId), [active.draftId, saved.draftId]);
  assert.equal(listed[0].name, "Untitled Agent Loop");
  assert.equal(listed[1].status, "active");
  assert.equal(listed[1].providerSessionId, saved.providerSessionId);
});

function createFixture({ hostConfigFactory, onCreateSession, readTemplate: readTemplateOverride } = {}) {
  const serviceCalls = {
    createOrGetDraft: [],
    createOrGetActiveExistingTemplateDraft: [],
    listActiveDrafts: [],
    bindProviderSession: [],
    saveDraft: [],
    discardDraft: [],
  };
  const drafts = new Map();
  const templateDesignService = {
    async createOrGetDraft(input) {
      serviceCalls.createOrGetDraft.push(input);
      assert.equal(Object.hasOwn(input.draftJson, "version"), false, "Draft body excludes immutable Version metadata");
      assert.equal(Object.hasOwn(input.draftJson, "archivedAt"), false, "Draft body excludes archive projection metadata");
      const existing = drafts.get(input.draftId);
      if (existing) return { draft: existing, created: false };
      const draft = {
        draftId: input.draftId,
        templateId: input.templateId,
        baseTemplateVersion: input.baseTemplateVersion,
        cwd: input.cwd,
        model: input.model,
        ...(input.modelVariant ? { modelVariant: input.modelVariant } : {}),
        draftJson: input.draftJson,
        revision: 1,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      drafts.set(draft.draftId, draft);
      return { draft, created: true };
    },
    async createOrGetActiveExistingTemplateDraft(input) {
      serviceCalls.createOrGetActiveExistingTemplateDraft.push(input);
      assert.equal(Object.hasOwn(input.draftJson, "version"), false, "Draft body excludes immutable Version metadata");
      assert.equal(Object.hasOwn(input.draftJson, "archivedAt"), false, "Draft body excludes archive projection metadata");
      const active = Array.from(drafts.values()).find((draft) => (
        draft.status === "active"
        && draft.templateId === input.templateId
        && draft.baseTemplateVersion === input.baseTemplateVersion
        && draft.cwd === input.cwd
      ));
      if (active) return { draft: active, created: false };
      const draft = {
        draftId: `template-design-existing-${drafts.size + 1}`,
        templateId: input.templateId,
        baseTemplateVersion: input.baseTemplateVersion,
        cwd: input.cwd,
        model: input.model,
        ...(input.modelVariant ? { modelVariant: input.modelVariant } : {}),
        draftJson: input.draftJson,
        revision: 1,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      drafts.set(draft.draftId, draft);
      return { draft, created: true };
    },
    async readDraft({ draftId }) { return drafts.get(draftId); },
    async listActiveDrafts({ cwd }) {
      serviceCalls.listActiveDrafts.push({ cwd });
      return Array.from(drafts.values())
        .filter((draft) => draft.status === "active" && draft.cwd === cwd)
        .map((draft) => ({
          draftId: draft.draftId,
          templateId: draft.templateId,
          baseTemplateVersion: draft.baseTemplateVersion,
          cwd: draft.cwd,
          model: draft.model,
          ...(draft.modelVariant ? { modelVariant: draft.modelVariant } : {}),
          name: draft.draftJson.name,
          revision: draft.revision,
          providerSessionId: draft.providerSessionId,
          status: draft.status,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        }));
    },
    async bindProviderSession(input) {
      serviceCalls.bindProviderSession.push(input);
      const draft = drafts.get(input.draftId);
      assert.equal(input.expectedRevision, draft.revision);
      const next = { ...draft, providerSessionId: input.providerSessionId, revision: draft.revision + 1 };
      drafts.set(next.draftId, next);
      return next;
    },
    async applyStructuredPatch() { throw new Error("not_exposed_by_runtime"); },
    async saveDraft(input) {
      serviceCalls.saveDraft.push(input);
      const draft = drafts.get(input.draftId);
      assert.equal(input.expectedRevision, draft.revision);
      const next = { ...draft, status: "active", revision: draft.revision + 1 };
      drafts.set(next.draftId, next);
      return { draft: next, savedTemplate: { id: "deepsearch", version: 11 } };
    },
    async discardDraft(input) {
      serviceCalls.discardDraft.push(input);
      const draft = drafts.get(input.draftId);
      const next = { ...draft, status: "discarded", revision: draft.revision + 1 };
      drafts.set(next.draftId, next);
      return next;
    },
  };
  const clientCalls = { createSession: [], promptAsync: [], getSession: [] };
  const hostConfigCalls = [];
  const client = {
    async createSession(input) {
      clientCalls.createSession.push(input);
      await onCreateSession?.(input);
      return { id: `ses_design${String(clientCalls.createSession.length).padStart(3, "0")}` };
    },
    async promptAsync(input) { clientCalls.promptAsync.push(input); return { accepted: true, providerSessionId: input.providerSessionId }; },
    async getSession(input) { clientCalls.getSession.push(input); return { id: input.providerSessionId }; },
  };
  const managerCalls = { ensureOwner: [], releaseOwner: [] };
const ownerLeases = new Map([["task-run:task-1:run-1", new Set(["runtime"])]]);
  const server = { ownerId: "shared", cwd: "/tmp/template-design-runtime", origin: "http://127.0.0.1:44222", pid: 44222 };
  const openCodeServerManager = {
    async ensureOwner(input) {
      managerCalls.ensureOwner.push(input);
      const leases = ownerLeases.get(input.ownerId) ?? new Set();
      leases.add(input.leaseId);
      ownerLeases.set(input.ownerId, leases);
      return { ...server, ownerId: input.ownerId };
    },
    getOwner({ ownerId }) {
      return ownerLeases.has(ownerId) ? { ...server, ownerId } : undefined;
    },
    clientForOwner({ ownerId }) {
      if (!ownerLeases.has(ownerId)) throw new Error("owner_not_ready");
      return client;
    },
    async releaseOwner({ ownerId, leaseId }) {
      managerCalls.releaseOwner.push({ ownerId, leaseId });
      const leases = ownerLeases.get(ownerId);
      if (!leases?.delete(leaseId)) return false;
      if (!leases.size) ownerLeases.delete(ownerId);
      return true;
    },
  };
  const pageCalls = [];
  let uuid = 0;
  const templateReadCalls = [];
  const readTemplate = async (input) => {
    templateReadCalls.push(input);
    if (readTemplateOverride) return readTemplateOverride(input);
    if (input.templateId !== "deepsearch") return undefined;
    const version = input.templateVersion ?? 10;
    if (![7, 10].includes(version)) return undefined;
    return {
      id: "deepsearch",
      version,
      name: version === 7 ? "DeepSearch v7" : "DeepSearch",
      source: "manual",
      conductor: {
        model: "opencode-go/gpt-5.6-luna",
        charter: version === 7 ? "Historical charter." : "Current charter.",
      },
      agents: [{ id: "searcher-0" }],
      limits: { maxConcurrentSessions: 2, maxDispatchesPerDecision: 2 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    };
  };
  const runtime = createTemplateDesignSessionRuntime({
    templateDesignService,
    openCodeServerManager,
    readTemplate,
    createHostConfig: (input) => {
      hostConfigCalls.push(input);
      return hostConfigFactory?.(input) ?? {
        content: { default_agent: "build", tools: { "agent_workspace_template_designer_*": false } },
      };
    },
    resolveOpenCodeSessionPage: async (input) => {
      pageCalls.push(input);
      return {
        presentation: "direct_url",
        providerSessionId: input.providerSessionId,
        url: `http://127.0.0.1:44222/session/${input.providerSessionId}`,
      };
    },
    randomUUID: () => `uuid-${++uuid}`,
  });
  return {
    runtime,
    drafts,
    templateReadCalls,
    serviceCalls,
    clientCalls,
    managerCalls: { ...managerCalls, ownerLeases },
    manager: { ownerLeases },
    hostConfigCalls,
    pageCalls,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
