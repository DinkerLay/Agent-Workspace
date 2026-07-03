import { describe, expect, it } from "vitest";
import {
  createOpencodeSessionKey,
  createOpencodeTaskClusterId,
  createRuntimeProjectId,
  createRuntimeTaskId,
  safeSegment,
} from "./sessionKey";

describe("opencode session keys", () => {
  it("creates stable task-scoped session ids", () => {
    expect(
      createOpencodeSessionKey({
        projectId: "project-agent-workspace",
        taskId: "task-research",
        agentId: "conductor",
      }),
    ).toBe("opencode:project-agent-workspace:task-research:conductor");
  });

  it("encodes path-like and spaced ids without collisions", () => {
    expect(
      createOpencodeSessionKey({
        projectId: "/Users/dinker/CODES/Agent Workspace",
        taskId: "Plan Loop #1",
        agentId: "QA Reviewer",
      }),
    ).toBe(
      "opencode:~2f~Users~2f~dinker~2f~CODES~2f~Agent~20~Workspace:Plan~20~Loop~20~~23~1:QA~20~Reviewer",
    );
  });

  it("keeps distinct raw ids distinct after encoding", () => {
    expect(createOpencodeSessionKey({ projectId: "a-b", taskId: "c", agentId: "x" })).not.toBe(
      createOpencodeSessionKey({ projectId: "a/b", taskId: "c", agentId: "x" }),
    );
    expect(createOpencodeTaskClusterId("a-b", "c")).not.toBe(createOpencodeTaskClusterId("a", "b-c"));
  });

  it("creates task cluster ids without runtime process state", () => {
    expect(createOpencodeTaskClusterId("project-agent-workspace", "task-research")).toBe(
      "cluster-project-agent-workspace:task-research",
    );
  });

  it("uses an explicit empty segment for blank ids", () => {
    expect(safeSegment(" \t\n")).toBe("empty");
  });

  it("creates stable runtime project ids from normalized project paths", () => {
    expect(createRuntimeProjectId("/Users/dinker/CODES/TEMP_project/Agent_Test")).toBe(
      createRuntimeProjectId("/Users/dinker/CODES/TEMP_project/Agent_Test/"),
    );
    expect(createRuntimeProjectId("/Users/dinker/CODES/TEMP_project/Agent_Test")).not.toBe(
      createRuntimeProjectId("/Users/dinker/CODES/Agent-Workspace"),
    );
  });

  it("keeps runtime task identity separate from the display task id", () => {
    const firstRuntimeTaskId = createRuntimeTaskId();
    const secondRuntimeTaskId = createRuntimeTaskId();

    expect(firstRuntimeTaskId).toMatch(/^task-[a-z0-9]{6}$/);
    expect(secondRuntimeTaskId).toMatch(/^task-[a-z0-9]{6}$/);
    expect(firstRuntimeTaskId).not.toBe(secondRuntimeTaskId);
    expect(
      createOpencodeSessionKey({
        projectId: "project-runtime-current",
        taskId: firstRuntimeTaskId,
        agentId: "task-intake-001-conductor",
      }),
    ).not.toBe(
      createOpencodeSessionKey({
        projectId: "project-runtime-current",
        taskId: secondRuntimeTaskId,
        agentId: "task-intake-001-conductor",
      }),
    );
  });
});
