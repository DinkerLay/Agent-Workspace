import {
  validateAcpMetaAgentTurnRequest,
  type AcpMetaAgentPort,
} from "@agent-workspace/provider-port";
import {
  isRuntimeId,
  validateAcpProfileReadinessObservation,
  validateMetaProfileOptionDefinitionV3,
  type AcpProfileReadinessObservation,
  type MetaProfileOptionId,
  type MetaSessionId,
} from "@agent-workspace/runtime-contracts";
import {
  acpMetaProfileIdentity,
  type AcpMetaAgentRegistration,
} from "@agent-workspace/runtime-application";
import type { AcpMetaProviderComposition } from "./acp-meta-provider-composition.js";

/**
 * Converts one Host-owned ACP Meta composition into option-scoped application
 * registrations. No Provider family is exposed as a routing key.
 */
export function createAcpMetaAgentRegistrations(
  composition: AcpMetaProviderComposition,
): readonly AcpMetaAgentRegistration[] {
  assertComposition(composition);
  return Object.freeze(composition.listMetaProfileOptions().map((value) => {
    const option = validateMetaProfileOptionDefinitionV3(value);
    return Object.freeze({
      option,
      port: createOptionPort(composition, option),
    });
  }));
}

function createOptionPort(
  composition: AcpMetaProviderComposition,
  option: ReturnType<typeof validateMetaProfileOptionDefinitionV3>,
): AcpMetaAgentPort {
  const sessions = new Map<MetaSessionId, "create" | "resume">();
  const profileIdentity = acpMetaProfileIdentity(option.profile);

  const port: AcpMetaAgentPort = {
    async checkMetaProfileReadiness(metaProfileOptionId) {
      assertOption(metaProfileOptionId, option.metaProfileOptionId);
      return validateReadiness(
        await composition.checkMetaProfileReadiness(metaProfileOptionId),
        option,
      );
    },

    async openMetaSession(value) {
      const input = exactOpenInput(value);
      assertOption(input.metaProfileOptionId, option.metaProfileOptionId);
      const existing = sessions.get(input.metaSessionId);
      if (existing && existing !== input.disposition) {
        throw new Error("acp_meta_adapter_disposition_conflict");
      }
      const opened = await composition.openMetaSession(input);
      const readiness = validateReadiness(opened.readiness, option);
      if (opened.available) sessions.set(input.metaSessionId, input.disposition);
      return Object.freeze({
        available: opened.available,
        readiness,
      });
    },

    async startMetaTurn(value) {
      const request = validateAcpMetaAgentTurnRequest(value);
      assertSessionProfile(request.metaSessionId, request.profile);
      return composition.startMetaTurn(request);
    },

    async reconcileMetaTurn(value) {
      const request = validateAcpMetaAgentTurnRequest(value);
      assertSessionProfile(request.metaSessionId, request.profile);
      return composition.reconcileMetaTurn(request);
    },

    async closeMetaSession(value) {
      const metaSessionId = exactCloseInput(value);
      if (!sessions.has(metaSessionId)) {
        throw new Error("acp_meta_adapter_session_not_open");
      }
      await composition.closeMetaSession({ metaSessionId });
      sessions.delete(metaSessionId);
    },

    close() {
      return composition.close();
    },
  };
  return Object.freeze(port);

  function assertSessionProfile(
    metaSessionId: MetaSessionId,
    profile: Parameters<typeof acpMetaProfileIdentity>[0],
  ): void {
    if (!sessions.has(metaSessionId)) {
      throw new Error("acp_meta_adapter_session_not_open");
    }
    if (acpMetaProfileIdentity(profile) !== profileIdentity) {
      throw new Error("acp_meta_adapter_profile_mismatch");
    }
  }
}

function validateReadiness(
  value: unknown,
  option: ReturnType<typeof validateMetaProfileOptionDefinitionV3>,
): AcpProfileReadinessObservation {
  const readiness = validateAcpProfileReadinessObservation(value);
  if (readiness.profileRevisionId !== option.profile.profileRevisionId
    || readiness.providerFamily !== option.profile.providerFamily
    || readiness.acpAgentKind !== option.profile.acpAgentKind
    || readiness.role !== "meta"
    || readiness.model !== option.profile.model) {
    throw new Error("acp_meta_adapter_readiness_profile_mismatch");
  }
  return readiness;
}

function assertOption(
  actual: MetaProfileOptionId,
  expected: MetaProfileOptionId,
): void {
  if (actual !== expected) throw new Error("acp_meta_adapter_option_mismatch");
}

function exactOpenInput(value: unknown): Readonly<{
  metaSessionId: MetaSessionId;
  metaProfileOptionId: MetaProfileOptionId;
  disposition: "create" | "resume";
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_meta_adapter_open_input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (!sameKeys(input, ["disposition", "metaProfileOptionId", "metaSessionId"])
    || !isRuntimeId(input.metaSessionId, "meta_session")
    || typeof input.metaProfileOptionId !== "string"
    || (input.disposition !== "create" && input.disposition !== "resume")) {
    throw new Error("acp_meta_adapter_open_input_invalid");
  }
  return Object.freeze({
    metaSessionId: input.metaSessionId,
    metaProfileOptionId: input.metaProfileOptionId as MetaProfileOptionId,
    disposition: input.disposition,
  });
}

function exactCloseInput(value: unknown): MetaSessionId {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_meta_adapter_close_input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (!sameKeys(input, ["metaSessionId"])
    || !isRuntimeId(input.metaSessionId, "meta_session")) {
    throw new Error("acp_meta_adapter_close_input_invalid");
  }
  return input.metaSessionId;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function assertComposition(
  value: unknown,
): asserts value is AcpMetaProviderComposition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_meta_adapter_composition_invalid");
  }
  const candidate = value as Record<string, unknown>;
  for (const method of [
    "listMetaProfileOptions",
    "checkMetaProfileReadiness",
    "openMetaSession",
    "startMetaTurn",
    "reconcileMetaTurn",
    "closeMetaSession",
    "close",
  ]) {
    if (typeof candidate[method] !== "function") {
      throw new Error("acp_meta_adapter_composition_invalid");
    }
  }
}
