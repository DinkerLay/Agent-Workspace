import { describe, expect, it } from "vitest";
import { createFakeProvider, providerEffectHasNoFact, providerFactFixture } from "../src";

describe("FakeProvider contract harness", () => {
  it("records local Effects separately from emitted ProviderFacts", async () => {
    const provider = createFakeProvider({ now: () => "2026-08-06T00:00:00.000Z" });
    const effect = await provider.submitDelivery({
      bindingId: "binding_001",
      inputSubmissionId: "input_001",
      effectId: "effect_submit_001",
    });
    expect(effect.acceptance).toBe("accepted");
    expect(provider.effects).toEqual([effect]);
    expect(providerEffectHasNoFact(provider, effect)).toBe(true);
    provider.emitFact(providerFactFixture({
      kind: "input_received",
      correlation: { inputSubmissionId: "input_001", nativeMessageId: "msg-001" },
    }));
    expect(providerEffectHasNoFact(provider, effect)).toBe(false);
    expect(await provider.reconcileBinding({ bindingId: "binding_001" })).toHaveLength(1);
  });

  it("can make transport acceptance unknown without inventing a Provider fact", async () => {
    const provider = createFakeProvider();
    provider.setNextAcceptance("request_interrupt", "unknown");
    const effect = await provider.requestInterrupt({ bindingId: "binding_001" });
    expect(effect.acceptance).toBe("unknown");
    expect(provider.facts).toHaveLength(0);
  });
});
