import { describe, expect, it } from "vitest";
import type {
  AcpMetaAgentTurnRequest,
  MetaAgentTurnAcceptance,
  MetaAgentTurnReconciliation,
} from "@agent-workspace/provider-port";
import type {
  AcpProfileReadinessObservation,
  MetaProfileDefinitionV3,
  MetaProfileOptionDefinitionV3,
  MetaSessionId,
} from "@agent-workspace/runtime-contracts";
import type { AcpMetaProviderComposition } from "./acp-meta-provider-composition.js";
import { createAcpMetaAgentRegistrations } from "./acp-meta-agent-port-adapter.js";

const profile: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_adapter",
  profileRevisionId: "profile_revision_meta-adapter-v1",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "gpt-5.6-sol",
  configIntent: {},
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
} satisfies MetaProfileDefinitionV3);

const readiness: AcpProfileReadinessObservation = Object.freeze({
  profileRevisionId: profile.profileRevisionId,
  providerFamily: profile.providerFamily,
  acpAgentKind: profile.acpAgentKind,
  role: "meta",
  status: "available",
  reasons: [],
  missingCapabilities: [],
  missingExtensions: [],
  model: profile.model,
  observedArtifactVersion: "current",
  observedUpstreamVersion: "current",
});

const option: MetaProfileOptionDefinitionV3 = Object.freeze({
  metaProfileOptionId: "meta_profile_option_adapter",
  title: "Adapter Meta",
  profile,
  readiness,
});

describe("ACP Meta option-scoped Port adapter", () => {
  it("forwards exact create/resume dispositions without exposing Provider-brand routing", async () => {
    const calls: unknown[] = [];
    const composition = controlledComposition(calls);
    const registrations = createAcpMetaAgentRegistrations(composition);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.option).toEqual(option);
    const port = registrations[0]!.port;
    expect("provider" in port).toBe(false);

    await expect(port.checkMetaProfileReadiness(option.metaProfileOptionId))
      .resolves.toEqual(readiness);
    await expect(port.openMetaSession({
      metaSessionId: "meta_session_adapter_create" as MetaSessionId,
      metaProfileOptionId: option.metaProfileOptionId,
      disposition: "create",
    })).resolves.toEqual({ available: true, readiness });
    await expect(port.openMetaSession({
      metaSessionId: "meta_session_adapter_resume" as MetaSessionId,
      metaProfileOptionId: option.metaProfileOptionId,
      disposition: "resume",
    })).resolves.toEqual({ available: true, readiness });

    const request = turnRequest("meta_session_adapter_create" as MetaSessionId, profile);
    await expect(port.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(port.reconcileMetaTurn(request)).resolves.toMatchObject({ state: "returned" });
    expect(calls).toEqual([
      ["readiness", option.metaProfileOptionId],
      ["open", "meta_session_adapter_create", option.metaProfileOptionId, "create"],
      ["open", "meta_session_adapter_resume", option.metaProfileOptionId, "resume"],
      ["start", request],
      ["reconcile", request],
    ]);
  });

  it("rejects wrong option, wrong portable Profile, and disposition drift before delegation", async () => {
    const calls: unknown[] = [];
    const port = createAcpMetaAgentRegistrations(controlledComposition(calls))[0]!.port;
    const metaSessionId = "meta_session_adapter_fenced" as MetaSessionId;

    await expect(port.checkMetaProfileReadiness("meta_profile_option_other"))
      .rejects.toThrow("acp_meta_adapter_option_mismatch");
    await port.openMetaSession({
      metaSessionId,
      metaProfileOptionId: option.metaProfileOptionId,
      disposition: "create",
    });
    await expect(port.openMetaSession({
      metaSessionId,
      metaProfileOptionId: option.metaProfileOptionId,
      disposition: "resume",
    })).rejects.toThrow("acp_meta_adapter_disposition_conflict");
    await expect(port.startMetaTurn(turnRequest(metaSessionId, {
      ...profile,
      profileRevisionId: "profile_revision_meta-adapter-other",
    }))).rejects.toThrow("acp_meta_adapter_profile_mismatch");

    expect(calls).toEqual([
      ["open", metaSessionId, option.metaProfileOptionId, "create"],
    ]);
  });
});

function controlledComposition(calls: unknown[]): AcpMetaProviderComposition {
  return Object.freeze({
    listMetaProfileOptions: () => Object.freeze([option]),
    readMetaProfileOption: (optionId) => optionId === option.metaProfileOptionId ? option : undefined,
    async checkMetaProfileReadiness(optionId) {
      calls.push(["readiness", optionId]);
      return readiness;
    },
    async checkMetaProfileQualificationReport() {
      throw new Error("controlled_meta_qualification_report_not_available");
    },
    async openMetaSession(input) {
      calls.push(["open", input.metaSessionId, input.metaProfileOptionId, input.disposition]);
      return Object.freeze({
        available: true as const,
        session: Object.freeze({
          metaSessionId: input.metaSessionId,
          metaProfileOptionId: input.metaProfileOptionId,
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
          acpAgentKind: profile.acpAgentKind,
          role: "meta" as const,
          model: profile.model,
          status: "ready" as const,
        }),
        readiness,
      });
    },
    async startMetaTurn(request): Promise<MetaAgentTurnAcceptance> {
      calls.push(["start", request]);
      return "accepted";
    },
    async reconcileMetaTurn(request): Promise<MetaAgentTurnReconciliation> {
      calls.push(["reconcile", request]);
      return Object.freeze({
        state: "returned" as const,
        finalText: "{\"operation\":\"answer\",\"message\":\"ok\"}",
        observedAt: "2026-08-12T00:00:00.000Z",
      });
    },
    async closeMetaSession() {},
    async close() {},
  });
}

function turnRequest(
  metaSessionId: MetaSessionId,
  requestProfile: MetaProfileDefinitionV3,
): AcpMetaAgentTurnRequest {
  return Object.freeze({
    metaSessionId,
    metaTurnId: "meta_turn_adapter",
    userMetaMessageId: "meta_message_adapter",
    idempotencyKey: "adapter-idempotency",
    mode: "template_design",
    profile: requestProfile,
    targetRevision: 1,
    systemInstructions: "Return one whole JSON object.",
    outputSchema: { type: "object" },
    context: { draft: { title: "Adapter" } },
    transcript: [],
    content: "Revise this draft.",
  });
}
