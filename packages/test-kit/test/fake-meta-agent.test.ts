import type { MetaAgentTurnRequest } from "@agent-workspace/provider-port";
import { describe, expect, it } from "vitest";
import { createFakeMetaAgent } from "../src";

describe("FakeMetaAgent contract harness", () => {
  it("records start/reconcile independently and exposes explicit ambiguous outcomes", async () => {
    const provider = createFakeMetaAgent({ provider: "opencode" });
    const request: MetaAgentTurnRequest = {
      metaSessionId: "meta_session_fake",
      metaTurnId: "meta_turn_fake",
      userMetaMessageId: "meta_message_fake_user",
      idempotencyKey: "fake-meta-turn-1",
      mode: "template_design",
      profile: {
        metaProfileId: "meta_profile_fake",
        provider: "opencode",
        model: "free-model",
        providerVersion: "fake",
        protocolFingerprint: "fake",
        capabilityPolicy: {
          requiredCapabilities: [],
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
      targetRevision: 2,
      systemInstructions: "Propose a Draft patch only.",
      outputSchema: { type: "object" },
      context: { title: "Deep research" },
      transcript: [],
      content: "Use a different model for the analyst.",
    };

    provider.setNextAcceptance("unknown");
    expect(await provider.startMetaTurn(request)).toBe("unknown");
    expect(provider.started).toEqual([request]);
    provider.setReconciliation(request.metaTurnId, {
      state: "returned",
      finalText: '{"assistantMessage":"Ready."}',
      observedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await provider.reconcileMetaTurn(request)).toEqual({
      state: "returned",
      finalText: '{"assistantMessage":"Ready."}',
      observedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(provider.reconciled).toEqual([request]);
  });
});
