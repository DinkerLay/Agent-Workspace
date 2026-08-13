import { describe, expect, it } from "vitest";
import { validateMetaAgentTurnRequest, type MetaAgentTurnRequest } from "./meta.js";

describe("MetaAgentPort contract", () => {
  it("carries only frozen configuration context and no Task execution authority", () => {
    const request: MetaAgentTurnRequest = {
      metaSessionId: "meta_session_contract",
      metaTurnId: "meta_turn_contract",
      userMetaMessageId: "meta_message_contract_user",
      idempotencyKey: "meta-contract-turn-1",
      mode: "task_setup",
      profile: {
        metaProfileId: "meta_profile_contract",
        provider: "codex",
        model: "gpt-5.6",
        providerVersion: "0.146.0",
        protocolFingerprint: "sha256:contract",
        capabilityPolicy: {
          requiredCapabilities: [],
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
      targetRevision: 4,
      systemInstructions: "Propose configuration patches only.",
      outputSchema: {
        type: "object",
        required: ["summary", "rationale", "operations"],
      },
      context: { title: "Research", goal: "Return a reviewable proposal." },
      transcript: [{ metaMessageId: "meta_message_prior", role: "assistant", content: "Ready." }],
      content: "Change the depth to deep.",
    };

    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "taskId", "runId", "logicalSessionId", "bindingId", "workspace", "cwd",
      "agentCard", "credential", "nativeSession", "nativeTurn", "tools",
    ]) expect(serialized).not.toContain(`\"${forbidden}`);
    expect(request.profile.capabilityPolicy.allowedTools).toEqual([]);
    const validated = validateMetaAgentTurnRequest(request);
    expect(validated).toEqual(request);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.context)).toBe(true);
    (request.context as { title: string }).title = "mutated by caller";
    expect(validated.context).toMatchObject({ title: "Research" });
  });

  it("requires the owning Meta Session and rejects every extra authority field", () => {
    const request = metaRequest();
    expect(() => validateMetaAgentTurnRequest({
      ...request,
      metaSessionId: undefined,
    })).toThrow(/meta_session|session/i);

    for (const [field, value] of [
      ["taskId", "task_forbidden"],
      ["runId", "run_forbidden"],
      ["workspaceId", "workspace_forbidden"],
      ["cwd", "/private/workspace"],
      ["tools", ["invoke_agent"]],
      ["credential", "secret"],
      ["nativeSessionId", "native-session"],
      ["nativeTurnId", "native-turn"],
      ["nativeRequestId", "native-request"],
    ] as const) {
      expect(() => validateMetaAgentTurnRequest({ ...request, [field]: value }), field)
        .toThrow(/field|authority|request/i);
    }

    expect(() => validateMetaAgentTurnRequest({
      ...request,
      context: { nested: { workspace: "/private/workspace" } },
    })).toThrow(/context|authority/i);

    for (const field of [
      "taskId",
      "taskRunId",
      "runId",
      "workspaceId",
      "cwd",
      "tools",
      "credential",
      "nativeBindingRef",
      "nativeSessionId",
      "nativeTurnId",
      "nativeRequestId",
    ]) {
      expect(() => validateMetaAgentTurnRequest({
        ...request,
        context: { nested: { [field]: "forbidden" } },
      }), `nested ${field}`).toThrow(/context|authority/i);
    }

    expect(() => validateMetaAgentTurnRequest({
      ...request,
      profile: {
        ...request.profile,
        capabilityPolicy: {
          ...request.profile.capabilityPolicy,
          requiredCapabilities: ["native_child"],
        },
      },
    })).toThrow(/capabilities_forbidden|authority/i);
  });
});

function metaRequest(): MetaAgentTurnRequest {
  return {
    metaSessionId: "meta_session_contract",
    metaTurnId: "meta_turn_contract",
    userMetaMessageId: "meta_message_contract_user",
    idempotencyKey: "meta-contract-turn-1",
    mode: "task_setup",
    profile: {
      metaProfileId: "meta_profile_contract",
      provider: "codex",
      model: "gpt-5.6",
      providerVersion: "host-observed",
      protocolFingerprint: "host-observed",
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
    targetRevision: 4,
    systemInstructions: "Propose configuration patches only.",
    outputSchema: { type: "object", required: ["summary", "rationale", "operations"] },
    context: { title: "Research", goal: "Return a reviewable proposal." },
    transcript: [{ metaMessageId: "meta_message_prior", role: "assistant", content: "Ready." }],
    content: "Change the depth to deep.",
  };
}
