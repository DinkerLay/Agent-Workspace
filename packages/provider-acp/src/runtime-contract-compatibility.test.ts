import {
  assertBindingHandle,
  assertInteractionChoiceId,
  assertInteractionId,
  assertSessionExecutionSafeValue,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  createManagedAcpV1Client,
  type AcpSessionObservation,
} from "./index.js";
import { FakeAcpV1Agent } from "./fake-agent.js";

describe("provider-acp and Session Runtime opaque-ID contract", () => {
  it("emits only SR-compatible Binding, interaction, and choice correlations", async () => {
    const raw = {
      sessionId: "raw-session-contract-secret",
      toolCallId: "raw-tool-contract-secret",
      optionId: "raw-option-contract-secret",
    };
    const observations: AcpSessionObservation[] = [];
    const agent = new FakeAcpV1Agent({ rawSessionId: raw.sessionId });
    agent.queuePrompt(async ({ handlers, request }) => {
      const permission = await handlers.requestPermission({
        sessionId: request.sessionId,
        toolCall: {
          toolCallId: raw.toolCallId,
          title: "Apply the safe change",
          status: "pending",
        },
        options: [{
          optionId: raw.optionId,
          name: "Allow once",
          kind: "allow_once",
        }],
      });
      expect(permission).toEqual({
        outcome: { outcome: "selected", optionId: raw.optionId },
      });
      return { stopReason: "end_turn" };
    });
    let opaqueSequence = 0;
    const client = createManagedAcpV1Client({
      connect: (handlers) => agent.connect(handlers),
      generationId: "host_generation_contract",
      createOpaqueId: (kind) => `${kind}_${++opaqueSequence}`,
      onObservation: (observation) => {
        observations.push(observation);
      },
    });
    await client.initialize({
      protocolMajor: 1,
      requiredCapabilities: ["session_new", "session_prompt", "permission"],
      requiredExtensions: [],
    });
    const binding = await client.ensureBinding({
      bindingHandle: "binding_handle_contract",
      disposition: "create",
      workspaceDirectory: "/private/workspace/contract",
      mcpServers: [],
      configuration: { model: "fake-model", options: [] },
    });
    const prompt = client.submitPrompt({
      bindingHandle: binding.bindingHandle,
      attemptId: "session_execution_attempt_contract",
      content: "request permission",
    });
    const interaction = await waitForInteraction(observations);

    assertBindingHandle(binding.bindingHandle);
    assertInteractionId(interaction.interactionId);
    assertInteractionChoiceId(interaction.choices[0].choiceId);
    await client.respondToInteraction({
      bindingHandle: binding.bindingHandle,
      attemptId: interaction.attemptId,
      interactionId: interaction.interactionId,
      choiceId: interaction.choices[0].choiceId,
    });
    const settlement = await prompt;

    const terminal = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "prompt_terminal" }> =>
        entry.kind === "prompt_terminal",
    );
    const receipt = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "delivery_receipt" }> =>
        entry.kind === "delivery_receipt",
    );
    expect(settlement.receiptDigest).toBe(receipt?.receiptDigest);
    expect(terminal?.receiptDigest).toBe(receipt?.receiptDigest);
    assertSessionExecutionSafeValue({ binding, observations, settlement });
    const serialized = JSON.stringify({ binding, observations, settlement });
    for (const rawValue of Object.values(raw)) expect(serialized).not.toContain(rawValue);
  });
});

async function waitForInteraction(
  observations: AcpSessionObservation[],
): Promise<Extract<AcpSessionObservation, { kind: "interaction_requested" }>> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const interaction = observations.find(
      (entry): entry is Extract<AcpSessionObservation, { kind: "interaction_requested" }> =>
        entry.kind === "interaction_requested",
    );
    if (interaction) return interaction;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("interaction_not_observed");
}
