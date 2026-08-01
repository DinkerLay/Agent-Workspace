import assert from "node:assert/strict";
import { createSessionStoreCapabilities } from "./session-store-capabilities.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Session Store owner capabilities", () => {
  it("does not let one owner impersonate another owner's fact writer", () => {
    const calls = [];
    const store = {
      readTaskState(input) { calls.push(["read", input]); return { taskId: input.taskId }; },
      recordTaskEvent(input) { calls.push(["timeline", input]); return input; },
      recordConductorWakeup(input) { calls.push(["coordinator", input]); return input; },
      recordPermissionResolved(input) { calls.push(["provider", input]); return input; },
      recordProviderSessionState(input) { calls.push(["provider-state", input]); return input; },
      recordTerminalState(input) { calls.push(["terminal", input]); return input; },
    };
    const capabilities = createSessionStoreCapabilities(store);

    assert.equal(typeof capabilities.readModel.readTaskState, "function");
    assert.equal(capabilities.readModel.recordTaskEvent, undefined);
    assert.equal(capabilities.taskTimeline.recordConductorWakeup, undefined);
    assert.equal(capabilities.coordinator.recordPermissionResolved, undefined);
    assert.equal(capabilities.provider.recordTerminalState, undefined);
    assert.equal(capabilities.terminal.recordProviderSessionState, undefined);
    assert.equal(capabilities.terminal.recordTaskEvent, undefined);
    assert.equal(Object.isFrozen(capabilities), true);
    assert.equal(Object.isFrozen(capabilities.provider), true);

    capabilities.readModel.readTaskState({ taskId: "task-1" });
    capabilities.coordinator.recordConductorWakeup({ taskId: "task-1" });
    capabilities.provider.recordPermissionResolved({ taskId: "task-1" });
    capabilities.provider.recordProviderSessionState({ taskId: "task-1" });
    capabilities.terminal.recordTerminalState({ taskId: "task-1" });
    assert.deepEqual(calls.map(([owner]) => owner), ["read", "coordinator", "provider", "provider-state", "terminal"]);
  });
});
