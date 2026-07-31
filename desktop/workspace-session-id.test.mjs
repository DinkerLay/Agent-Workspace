import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isCanonicalWorkspaceSessionId, taskIdFromWorkspaceSessionId } from "./workspace-session-id.cjs";

describe("Workspace Session identity", () => {
  it("accepts initial and isolated re-run Agent Loop Session identities", () => {
    assert.equal(isCanonicalWorkspaceSessionId("opencode:project:task:researcher"), true);
    assert.equal(isCanonicalWorkspaceSessionId("opencode:project:task:run-123:researcher"), true);
    assert.equal(taskIdFromWorkspaceSessionId("opencode:project:task:run-123:researcher"), "task");
  });

  it("rejects malformed or over-scoped Workspace Session identities", () => {
    assert.equal(isCanonicalWorkspaceSessionId("opencode:project:task"), false);
    assert.equal(isCanonicalWorkspaceSessionId("opencode:project:task:run-123:researcher:extra"), false);
    assert.equal(isCanonicalWorkspaceSessionId("opencode:project:task:bad scope"), false);
  });
});
