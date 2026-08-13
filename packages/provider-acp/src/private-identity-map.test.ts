import { describe, expect, it } from "vitest";
import type { AcpOpaqueIdKind } from "./types.js";
import { GenerationPrivateIdentityMap } from "./private-identity-map.js";

function ids(): (kind: AcpOpaqueIdKind) => string {
  let value = 0;
  return (kind) => `${kind}_${++value}`;
}

describe("generation-local ACP identity map", () => {
  it("rejects duplicate, cross-fence, stale, and post-invalidation lookups", () => {
    const identities = new GenerationPrivateIdentityMap({
      generationId: "generation_1",
      createOpaqueId: ids(),
    });
    identities.bindSession("binding_handle_1", "raw-session-1");
    expect(identities.rawSessionFor("binding_handle_1")).toBe("raw-session-1");
    expect(() => identities.bindSession("binding_handle_2", "raw-session-1"))
      .toThrowError("acp_raw_session_already_bound");

    const permission = identities.createPermission({
      bindingHandle: "binding_handle_1",
      attemptId: "session_execution_attempt_1",
      rawToolCallId: "raw-tool-1",
      options: [
        { rawOptionId: "raw-option-1", name: "Allow", kind: "allow_once" },
      ],
    });

    expect(() => identities.selectPermission({
      bindingHandle: "binding_handle_1",
      attemptId: "session_execution_attempt_2",
      interactionId: permission.interactionId,
      choiceId: permission.choices[0].choiceId,
    })).toThrowError("acp_interaction_fence_mismatch");
    expect(identities.selectPermission({
      bindingHandle: "binding_handle_1",
      attemptId: "session_execution_attempt_1",
      interactionId: permission.interactionId,
      choiceId: permission.choices[0].choiceId,
    })).toEqual({ rawOptionId: "raw-option-1" });
    expect(() => identities.selectPermission({
      bindingHandle: "binding_handle_1",
      attemptId: "session_execution_attempt_1",
      interactionId: permission.interactionId,
      choiceId: permission.choices[0].choiceId,
    })).toThrowError("acp_interaction_not_pending");

    identities.invalidate();
    expect(() => identities.rawSessionFor("binding_handle_1"))
      .toThrowError("acp_generation_inactive");
    expect(JSON.stringify(identities)).not.toContain("raw-session-1");
  });

  it.each([
    "tool_handle",
    "interaction",
    "choice",
  ] satisfies readonly AcpOpaqueIdKind[])(
    "rejects an allocator that reuses a %s ID within the generation",
    (duplicateKind) => {
      const sequences = new Map<AcpOpaqueIdKind, number>();
      const identities = new GenerationPrivateIdentityMap({
        generationId: "generation_duplicate",
        createOpaqueId: (kind) => {
          if (kind === duplicateKind) return `${kind}_fixed`;
          const next = (sequences.get(kind) ?? 0) + 1;
          sequences.set(kind, next);
          return `${kind}_${next}`;
        },
      });
      identities.bindSession("binding_handle_duplicate", "raw-session-duplicate");
      identities.createPermission({
        bindingHandle: "binding_handle_duplicate",
        attemptId: "session_execution_attempt_duplicate",
        rawToolCallId: "raw-tool-duplicate",
        options: [{ rawOptionId: "raw-option-first", name: "Allow", kind: "allow_once" }],
      });

      expect(() => identities.createPermission({
        bindingHandle: "binding_handle_duplicate",
        attemptId: "session_execution_attempt_duplicate",
        rawToolCallId: duplicateKind === "tool_handle"
          ? "raw-tool-second"
          : "raw-tool-duplicate",
        options: [{ rawOptionId: "raw-option-second", name: "Reject", kind: "reject_once" }],
      })).toThrowError("acp_opaque_id_duplicate");
    },
  );

  it("rejects a generated opaque ID that equals a raw private value", () => {
    const identities = new GenerationPrivateIdentityMap({
      generationId: "generation_collision",
      createOpaqueId: (kind) => kind === "choice" ? "choice_private" : `${kind}_safe`,
    });
    identities.bindSession("binding_handle_collision", "raw-session-collision");

    expect(() => identities.createPermission({
      bindingHandle: "binding_handle_collision",
      attemptId: "session_execution_attempt_collision",
      rawToolCallId: "raw-tool-collision",
      options: [{ rawOptionId: "choice_private", name: "Allow", kind: "allow_once" }],
    })).toThrowError("acp_opaque_id_collides_with_private_value");
  });
});
