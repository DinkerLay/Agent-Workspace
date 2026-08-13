import {
  validateAcpMetaAgentTurnRequest,
  type AcpMetaAgentTurnRequest,
} from "./meta.js";
import { describe, expect, it } from "vitest";

describe("ACP Meta Agent v3 Port contract", () => {
  it("accepts only a frozen portable Meta v3 profile and configuration transcript", () => {
    const request = acpMetaRequest();
    expect(validateAcpMetaAgentTurnRequest(request)).toEqual(request);
    expect(() => validateAcpMetaAgentTurnRequest({
      ...request,
      profile: {
        metaProfileId: "meta_profile_legacy",
        provider: "codex",
        model: "legacy",
        providerVersion: "preserved",
        protocolFingerprint: "preserved",
        capabilityPolicy: request.profile.capabilityPolicy,
      },
    })).toThrow("meta_agent_turn_request_profile_v3_required");
    for (const [field, value] of [
      ["workspace", { workspaceId: "workspace_forbidden" }],
      ["cwd", "/private/forbidden"],
      ["tools", []],
      ["taskId", "task_forbidden"],
      ["rawAcpSessionId", "raw-secret"],
    ] as const) {
      expect(() => validateAcpMetaAgentTurnRequest({ ...request, [field]: value }), field)
        .toThrow("meta_agent_turn_request_fields_invalid");
    }
    expect(() => validateAcpMetaAgentTurnRequest({
      ...request,
      context: { draft: { title: "Safe" }, cwd: "/private/forbidden" },
    })).toThrow("meta_agent_turn_request_authority_forbidden");
  });

  it("rejects exact-profile drift and raw/Task authority nested in transcript-adjacent context", () => {
    const request = acpMetaRequest();
    expect(() => validateAcpMetaAgentTurnRequest({
      ...request,
      profile: { ...request.profile, role: "worker" },
    })).toThrow();
    expect(() => validateAcpMetaAgentTurnRequest({
      ...request,
      profile: { ...request.profile, configIntent: { launcherPath: "/tmp/agent" } },
    })).toThrow();
    expect(() => validateAcpMetaAgentTurnRequest({
      ...request,
      context: { draft: { title: "Safe" }, taskTranscript: [{ content: "secret" }] },
    })).toThrow("meta_agent_turn_request_authority_forbidden");
  });
});

function acpMetaRequest(): AcpMetaAgentTurnRequest {
  return {
    metaSessionId: "meta_session_acp-contract",
    metaTurnId: "meta_turn_acp-contract",
    userMetaMessageId: "meta_message_acp-contract",
    idempotencyKey: "meta-acp-contract-1",
    mode: "template_design",
    profile: {
      metaProfileId: "meta_profile_acp-contract",
      profileRevisionId: "profile_revision_meta-acp-contract",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      role: "meta",
      model: "gpt-5.6-terra",
      configIntent: { reasoningEffort: "medium" },
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    targetRevision: 2,
    systemInstructions: "Return one whole configuration JSON object.",
    outputSchema: { type: "object", required: ["assistantMessage"] },
    context: { draft: { title: "Safe draft" }, validationIssues: [] },
    transcript: [{
      metaMessageId: "meta_message_acp-history",
      role: "assistant",
      content: "Previous configuration guidance.",
    }],
    content: "Refine this configuration.",
  };
}
