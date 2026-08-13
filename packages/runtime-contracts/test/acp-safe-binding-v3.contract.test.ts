import { describe, expect, it } from "vitest";
import {
  cloneAcpSafeSessionBindingRecordV3,
  validateAcpSafeSessionBindingRecordV3,
  type AcpSafeSessionBindingRecordV3,
} from "../src";
import { InMemoryAcpSafeSessionBindingRepository } from "../../test-kit/src";

describe("ACP-safe Session Binding v3", () => {
  it("round-trips only an opaque binding handle through its owner repository", () => {
    const repository = new InMemoryAcpSafeSessionBindingRepository();
    const binding = bindingRecord();

    repository.insert(binding);
    repository.setCurrent(binding.logicalSessionId, binding.bindingId);

    expect(repository.get(binding.bindingId)).toEqual(cloneAcpSafeSessionBindingRecordV3(binding));
    expect(repository.getCurrentForLogicalSession(binding.logicalSessionId)).toEqual(binding);
    expect(JSON.stringify(repository.snapshot())).not.toMatch(
      /acpSessionId|nativeBindingRef|requestId|optionId|cwd|canonicalDirectory|workspacePath|\/private\//u,
    );
  });

  it("rejects extra raw ACP identity, cwd and path fields", () => {
    const binding = bindingRecord();
    expect(() => validateAcpSafeSessionBindingRecordV3({ ...binding, acpSessionId: "raw-session" }))
      .toThrow(/binding_v3_shape_invalid|private_field_forbidden/);
    expect(() => validateAcpSafeSessionBindingRecordV3({ ...binding, cwd: "/private/workspace" }))
      .toThrow(/binding_v3_shape_invalid|private_field_forbidden/);
    expect(() => validateAcpSafeSessionBindingRecordV3({ ...binding, workspacePath: "../workspace" }))
      .toThrow(/binding_v3_shape_invalid|private_field_forbidden/);
    expect(() => validateAcpSafeSessionBindingRecordV3({ ...binding, bindingHandle: "raw-acp-session" }))
      .toThrow(/opaque_id_invalid/);
    const { profileRevisionId: _missingRevision, ...withoutRevision } = binding;
    expect(() => validateAcpSafeSessionBindingRecordV3(withoutRevision)).toThrow(/binding_v3_shape_invalid/);
    expect(() => validateAcpSafeSessionBindingRecordV3({ ...binding, profileRevisionId: "profile_worker-r2" }))
      .toThrow(/binding_v3_id_invalid/);
  });

  it("keeps the immutable Profile revision correlation when status advances", () => {
    const repository = new InMemoryAcpSafeSessionBindingRepository();
    const binding = bindingRecord();
    repository.insert(binding);

    repository.update({ ...binding, status: "recovering", revision: 2, updatedAt: "2026-08-12T00:00:01.000Z" }, 1);
    expect(repository.get(binding.bindingId)).toMatchObject({
      status: "recovering",
      executionProfileId: binding.executionProfileId,
      profileRevisionId: binding.profileRevisionId,
    });
    expect(() => repository.update({
      ...repository.get(binding.bindingId)!,
      profileRevisionId: "profile_revision_worker-2",
      revision: 3,
      updatedAt: "2026-08-12T00:00:02.000Z",
    }, 2)).toThrow(/scope_immutable/);
  });
});

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}
