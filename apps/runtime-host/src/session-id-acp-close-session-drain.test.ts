import { describe, expect, it, vi } from "vitest";
import { createSessionIdAcpCloseSessionDrain } from "./session-id-acp-close-session-drain.js";

const COMMAND = Object.freeze({
  taskId: "task_close_drain",
  runId: "run_close_drain",
  expectedRevision: 3,
  conductorSessionId: "logical_session_close_conductor",
  conductorSessionTurnId: "session_turn_close_conductor",
  commandId: "command_close_drain",
  idempotencyKey: "close:drain",
  sessionId: "logical_session_close_worker",
});

describe("Session-ID ACP close-session Host drain", () => {
  it("returns public closed only after retirement and completion commit", async () => {
    const order: string[] = [];
    const stageClose = vi.fn(() => {
      order.push("stage");
      return {
        disposition: "retirement_required" as const,
        sessionControlAuditId: "session_control_close_drain",
        bindingRetirementIntentId: "binding_retirement_close_drain",
      };
    });
    const retireBindingForClose = vi.fn(async () => {
      order.push("retire");
      return {
        disposition: "released" as const,
        bindingRetirementIntentId: "binding_retirement_close_drain",
        bindingId: "binding_close_drain",
        replayed: false,
      };
    });
    const completeClose = vi.fn(() => {
      order.push("complete");
      return { status: "closed" as const };
    });
    const drain = createSessionIdAcpCloseSessionDrain({
      owner: { stageClose, completeClose },
      provider: { retireBindingForClose },
    });

    await expect(drain.closeSession(COMMAND)).resolves.toEqual({ status: "closed" });
    expect(order).toEqual(["stage", "retire", "complete"]);
    expect(completeClose).toHaveBeenCalledWith({
      command: COMMAND,
      bindingRetirementIntentId: "binding_retirement_close_drain",
    });
    expect(JSON.stringify(await drain.closeSession(COMMAND))).not.toMatch(/bindingRetirement|sessionControl/u);
  });

  it.each([
    { disposition: "closed" as const, result: { status: "closed" as const } },
    { disposition: "rejected" as const, result: { status: "rejected" as const, reason: "session_close_lane_not_safe" } },
  ])("does not drain terminal stage disposition $disposition", async (stage) => {
    const retireBindingForClose = vi.fn();
    const completeClose = vi.fn();
    const drain = createSessionIdAcpCloseSessionDrain({
      owner: { stageClose: () => stage, completeClose },
      provider: { retireBindingForClose },
    });
    await expect(drain.closeSession(COMMAND)).resolves.toEqual(stage.result);
    expect(retireBindingForClose).not.toHaveBeenCalled();
    expect(completeClose).not.toHaveBeenCalled();
  });

  it("keeps the durable close pending when native retirement is unresolved", async () => {
    const completeClose = vi.fn();
    const drain = createSessionIdAcpCloseSessionDrain({
      owner: {
        stageClose: () => ({
          disposition: "retirement_required" as const,
          sessionControlAuditId: "session_control_close_drain",
          bindingRetirementIntentId: "binding_retirement_close_drain",
        }),
        completeClose,
      },
      provider: {
        retireBindingForClose: async () => { throw new Error("native cleanup unknown"); },
      },
    });
    await expect(drain.closeSession(COMMAND)).rejects.toThrow("native cleanup unknown");
    expect(completeClose).not.toHaveBeenCalled();
  });

  it("fails closed on a cross-intent Provider result", async () => {
    const completeClose = vi.fn();
    const drain = createSessionIdAcpCloseSessionDrain({
      owner: {
        stageClose: () => ({
          disposition: "retirement_required" as const,
          sessionControlAuditId: "session_control_close_drain",
          bindingRetirementIntentId: "binding_retirement_close_drain",
        }),
        completeClose,
      },
      provider: {
        retireBindingForClose: async () => ({
          disposition: "released" as const,
          bindingRetirementIntentId: "binding_retirement_other",
          bindingId: "binding_close_drain",
          replayed: false,
        }),
      },
    });
    await expect(drain.closeSession(COMMAND)).rejects.toThrow("session_close_retirement_result_mismatch");
    expect(completeClose).not.toHaveBeenCalled();
  });
});
