import { describe, expect, it } from "vitest";
import type { MetaAgentTurnRequest } from "./meta.js";

describe("MetaAgentPort contract", () => {
  it("carries only frozen configuration context and no Task execution authority", () => {
    const request: MetaAgentTurnRequest = {
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
  });
});
