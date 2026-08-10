import { describe, expect, it } from "vitest";
import { createFakeProvider, providerFactFixture } from "../../test-kit/src";
import {
  applyProviderFactToInput,
  createProviderSessionBinding,
  recordDeliveryEffect,
  stageInputSubmission,
} from "./index";

describe("runtime-domain", () => {
  it("requires a ProviderFact, rather than a local effect, to confirm input receipt", async () => {
    const now = "2026-08-06T00:00:00.000Z";
    const binding = createProviderSessionBinding({
      bindingId: "binding_001",
      taskId: "task_001",
      runId: "run_001",
      logicalSessionId: "logical_session_001",
      executionProfileId: "profile_conductor",
      provider: "opencode",
      now,
    });
    const input = stageInputSubmission({
      inputSubmissionId: "input_001",
      sourceInboxItemId: "inbox_001",
      taskId: binding.taskId,
      runId: binding.runId,
      logicalSessionId: binding.logicalSessionId,
      bindingId: binding.bindingId,
      contentMessageId: "message_001",
      content: "continue",
      sequenceNumber: 1,
      idempotencyKey: "input-key-001",
      now,
    });
    const provider = createFakeProvider({ now: () => now });
    const effect = await provider.submitDelivery({ bindingId: binding.bindingId, inputSubmissionId: input.inputSubmissionId });
    const pendingReceipt = recordDeliveryEffect(input, effect, now);

    expect(pendingReceipt.status).toBe("effect_accepted");
    expect(provider.facts).toHaveLength(0);

    const received = applyProviderFactToInput(pendingReceipt, providerFactFixture({
      kind: "input_received",
      correlation: { inputSubmissionId: input.inputSubmissionId, nativeMessageId: "native-message-001" },
    }), now);
    expect(received.status).toBe("provider_received");
  });
});
