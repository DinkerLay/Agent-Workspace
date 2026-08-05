import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createTemplateDesignToolBridge,
  startTemplateDesignToolBridgeHttpServer,
  validatePatch,
} = require("./template-design-tool-bridge.cjs");

const DRAFT_CAPABILITY = "Q2FjYXBhYmlsaXR5LXNjb3BlZC1kcmFmdC10b2tlbi0xMjM0NTY";

function createService() {
  let draft = {
    draftId: "draft_1",
    templateId: "deep-search",
    baseTemplateVersion: 10,
    cwd: "/tmp/project",
    model: "opencode-go/gpt-5.6-luna",
    revision: 2,
    providerSessionId: "ses_design_1",
    status: "active",
    draftJson: {
      id: "deep-search",
      name: "DeepSearch",
      conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "Decide." },
      agents: [],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    },
  };
  return {
    readProviderSessionBinding: ({ providerSessionId }) => {
      if (providerSessionId !== draft.providerSessionId) return undefined;
      return { draftId: draft.draftId, capabilitySecret: DRAFT_CAPABILITY };
    },
    readScopedDraft: ({ draftId, capabilitySecret }) => {
      assert.equal(capabilitySecret, DRAFT_CAPABILITY);
      return draftId === draft.draftId ? draft : undefined;
    },
    applyStructuredPatch: ({ draftId, capabilitySecret, expectedRevision, operationId, patch }) => {
      assert.equal(draftId, draft.draftId);
      assert.equal(capabilitySecret, DRAFT_CAPABILITY);
      assert.equal(expectedRevision, draft.revision);
      assert.equal(operationId, "operation_1");
      assert.deepEqual(patch, [{ op: "replace", path: "/name", value: "Better Search" }]);
      draft = { ...draft, revision: draft.revision + 1, draftJson: { ...draft.draftJson, name: "Better Search" } };
      return { draft, replayed: false };
    },
  };
}

test("Template Design bridge returns only Draft state and applies revisioned patches", () => {
  const changes = [];
  const bridge = createTemplateDesignToolBridge({ templateDesignService: createService(), onDraftChanged: (change) => changes.push(change) });
  assert.deepEqual(bridge.readDraft({ providerSessionId: "ses_design_1" }), {
    draftId: "draft_1",
    templateId: "deep-search",
    baseTemplateVersion: 10,
    cwd: "/tmp/project",
    model: "opencode-go/gpt-5.6-luna",
    revision: 2,
    status: "active",
    draft: {
      id: "deep-search",
      name: "DeepSearch",
      conductor: { role: "Conductor", model: "opencode-go/gpt-5.6-luna", charter: "Decide." },
      agents: [],
      limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
      delivery: { artifactPath: "", ownerAgentId: "" },
    },
  });
  const result = bridge.applyPatch({
    providerSessionId: "ses_design_1",
    expectedRevision: 2,
    operationId: "operation_1",
    patch: [{ op: "replace", path: "/name", value: "Better Search" }],
  });
  assert.equal(result.replayed, false);
  assert.equal(result.draft.revision, 3);
  assert.equal(result.draft.draft.name, "Better Search");
  assert.equal("providerSessionId" in result.draft, false);
  assert.equal("capabilitySecret" in result.draft, false);
  assert.throws(() => bridge.readDraft({ providerSessionId: "ses_other" }), /template_design_session_binding_invalid/);
  assert.deepEqual(changes, [{ draftId: "draft_1", type: "template_design.draft_patched", revision: 3 }]);
});

test("Template Design patch validation prevents prototype paths and unsupported Draft mutation roots", () => {
  assert.throws(() => validatePatch([{ op: "replace", path: "/id", value: "other" }]), /template_design_patch_operation_invalid/);
  assert.throws(() => validatePatch([{ op: "replace", path: "/agents/__proto__", value: {} }]), /template_design_patch_operation_invalid/);
  assert.throws(() => validatePatch([{ op: "replace", path: "/agents/~2bad", value: {} }]), /template_design_patch_operation_invalid/);
  assert.throws(() => validatePatch([{ op: "remove", path: "/name", value: "invalid" }]), /template_design_patch_remove_value_forbidden/);
  assert.deepEqual(validatePatch([{ op: "add", path: "/agents/-", value: { id: "critic" } }]), [{ op: "add", path: "/agents/-", value: { id: "critic" } }]);
});

test("Template Design HTTP bridge rejects unauthenticated or malformed requests without exposing a general RPC", async () => {
  const server = await startTemplateDesignToolBridgeHttpServer({
    bridge: createTemplateDesignToolBridge({ templateDesignService: createService() }),
    token: "template-test-token",
  });
  try {
    const unauthorized = await fetch(`${server.url}/tools/read_draft`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const unknown = await fetch(`${server.url}/tools/nope`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unknown.status, 404);
    const unscoped = await fetch(`${server.url}/tools/read_draft`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unscoped.status, 400);
    assert.equal((await unscoped.json()).error, "template_design_provider_session_id_invalid");
    const crossSession = await fetch(`${server.url}/tools/read_draft`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: JSON.stringify({ providerSessionId: "ses_other" }),
    });
    assert.equal(crossSession.status, 400);
    assert.equal((await crossSession.json()).error, "template_design_session_binding_invalid");
    const bindingStatus = await fetch(`${server.url}/binding/status`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: JSON.stringify({ providerSessionId: "ses_design_1" }),
    });
    assert.equal(bindingStatus.status, 200);
    assert.deepEqual(await bindingStatus.json(), { bound: true });
    const noSecretEndpoint = await fetch(`${server.url}/binding/session`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: JSON.stringify({ providerSessionId: "ses_design_1" }),
    });
    assert.equal(noSecretEndpoint.status, 404);
    const invalid = await fetch(`${server.url}/tools/apply_patch`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: JSON.stringify({ providerSessionId: "ses_design_1", expectedRevision: 2, operationId: "operation_1", patch: [{ op: "replace", path: "/id", value: "other" }] }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /template_design_patch_operation_invalid/);

    const invalidJson = await fetch(`${server.url}/tools/read_draft`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error, "template_design_tool_body_invalid_json");

    const tooLarge = await fetch(`${server.url}/tools/read_draft`, {
      method: "POST",
      headers: { authorization: "Bearer template-test-token", "content-type": "application/json" },
      body: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error, "template_design_tool_body_too_large");
  } finally {
    await server.close();
  }
});
