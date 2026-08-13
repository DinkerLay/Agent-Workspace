import { describe, expect, it } from "vitest";
import {
  cloneAcpV3BindingRetirementIntentRecord,
  type AcpV3BindingRetirementIntentRecord,
} from "../src";

describe("ACP v3 Binding retirement intent contract", () => {
  it("accepts one exact safe pending intent", () => {
    expect(cloneAcpV3BindingRetirementIntentRecord(intent())).toEqual(intent());
  });

  it("rejects extra fields and Host-private identities or paths", () => {
    for (const unsafe of [
      { extra: true },
      { rawSessionId: "native-secret" },
      { absoluteCwd: "/Users/private/workspace" },
      { providerPath: "/private/acp-agent" },
    ]) {
      expect(() => cloneAcpV3BindingRetirementIntentRecord({ ...intent(), ...unsafe } as never)).toThrow();
    }
  });

  it("makes unknown terminal for automatic execution and requires a safe failure code", () => {
    expect(() => cloneAcpV3BindingRetirementIntentRecord({
      ...intent(),
      state: "unknown",
      attempts: 1,
      revision: 2,
    } as never)).toThrow("acp_binding_retirement_failure_code_required");
    expect(cloneAcpV3BindingRetirementIntentRecord({
      ...intent(),
      state: "unknown",
      attempts: 1,
      failureCode: "acp_binding_retirement_cleanup_unconfirmed",
      revision: 2,
    })).toMatchObject({ state: "unknown", attempts: 1 });
  });
});

const NOW = "2026-08-12T00:00:00.000Z";

function intent(): AcpV3BindingRetirementIntentRecord {
  return {
    bindingRetirementIntentId: "binding_retirement_worker-1",
    commandId: "command_retire-worker-1",
    idempotencyKey: "task-stop:worker-1",
    taskId: "task_acp-v3",
    runId: "run_acp-v3",
    logicalSessionId: "logical_session_worker-1",
    bindingId: "binding_acp-v3",
    bindingRevision: 1,
    bindingHandle: "binding_handle_acp-v3",
    executionProfileId: "profile_acp-v3",
    profileRevisionId: "profile_revision_acp-v3",
    providerFamily: "opencode",
    sessionControlAuditId: "session_control_task-stop-worker-1",
    state: "pending",
    attempts: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
