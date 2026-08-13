import { describe, expect, it } from "vitest";
import type {
  SessionIdAcpDeliveryStageResult,
  SessionIdAcpDrainableProviderEffect,
} from "@agent-workspace/runtime-application";
import type { SessionIdAcpProviderDrainResult } from "./session-id-acp-provider-drain.js";
import {
  createSessionIdAcpRuntimePump,
  SessionIdAcpRuntimePumpError,
} from "./session-id-acp-runtime-pump.js";

describe("Session-ID ACP Runtime pump", () => {
  it("materializes a missing Card Binding once, restages, and drains the exact v3 intent", async () => {
    const fixture = pumpFixture({
      stages: [idle("binding_not_ready"), staged("provider_effect_card_first")],
    });
    await expect(fixture.pump.pumpDelivery({ logicalSessionId: "logical_session_card" }))
      .resolves.toEqual({
        disposition: "drained",
        stageDisposition: "staged",
        providerEffectIntentId: "provider_effect_card_first",
        sessionExecutionAttemptId: "session_execution_attempt_card",
        providerDisposition: "settled",
        reconciliationRequired: false,
      });
    expect(fixture.ensureCalls).toEqual(["logical_session_card"]);
    expect(fixture.stageCalls).toEqual(["logical_session_card", "logical_session_card"]);
    expect(fixture.drainCalls).toEqual(["provider_effect_card_first"]);
  });

  it("does not materialize a Binding for an idle lane and single-flights one logical Session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = pumpFixture({
      stages: [staged("provider_effect_singleflight")],
      beforeDrain: () => gate,
    });
    const first = fixture.pump.pumpDelivery({ logicalSessionId: "logical_session_card" });
    const second = fixture.pump.pumpDelivery({ logicalSessionId: "logical_session_card" });
    expect(fixture.stageCalls).toHaveLength(1);
    expect(fixture.drainCalls).toHaveLength(1);
    release();
    await Promise.all([first, second]);

    const idleFixture = pumpFixture({ stages: [idle("no_pending_inbox")] });
    await expect(idleFixture.pump.pumpDelivery({ logicalSessionId: "logical_session_card" }))
      .resolves.toEqual({ disposition: "idle", reason: "no_pending_inbox" });
    expect(idleFixture.ensureCalls).toEqual([]);
    expect(idleFixture.drainCalls).toEqual([]);
  });

  it("fails closed if Binding materialization does not make the current Session drainable", async () => {
    const fixture = pumpFixture({
      stages: [idle("binding_not_ready"), idle("binding_not_ready")],
    });
    await expect(fixture.pump.pumpDelivery({ logicalSessionId: "logical_session_card" }))
      .rejects.toMatchObject({ code: "session_id_acp_runtime_pump_binding_not_ready" });
    expect(fixture.ensureCalls).toHaveLength(1);
    expect(fixture.drainCalls).toEqual([]);
  });

  it("stages reconciliation from the persisted Attempt and drains only its returned effect", async () => {
    const fixture = pumpFixture({
      stages: [],
      reconciliation: {
        disposition: "replay",
        commandType: "session_runtime.reconcile_attempt",
        providerEffectIntentId: "provider_effect_reconcile",
        sessionExecutionRuntimeId: "session_execution_runtime_card",
        sessionExecutionAttemptId: "session_execution_attempt_card",
      },
      drainResult: {
        disposition: "reconciling",
        providerEffectIntentId: "provider_effect_reconcile",
        sessionExecutionAttemptId: "session_execution_attempt_card",
        commandType: "session_runtime.reconcile_attempt",
        reconciliationRequired: true,
      },
    });
    await expect(fixture.pump.reconcileAttempt({
      sessionExecutionAttemptId: "session_execution_attempt_card",
    })).resolves.toEqual({
      disposition: "drained",
      stageDisposition: "replay",
      providerEffectIntentId: "provider_effect_reconcile",
      sessionExecutionAttemptId: "session_execution_attempt_card",
      providerDisposition: "reconciling",
      reconciliationRequired: true,
    });
    expect(fixture.reconcileCalls).toEqual(["session_execution_attempt_card"]);
    expect(fixture.drainCalls).toEqual(["provider_effect_reconcile"]);
  });

  it("drains an already-staged interrupt without accepting caller correlation or Provider authority", async () => {
    const fixture = pumpFixture({
      stages: [],
      drainResult: {
        disposition: "reconciling",
        providerEffectIntentId: "provider_effect_interrupt",
        sessionExecutionAttemptId: "session_execution_attempt_card",
        commandType: "session_runtime.request_interrupt",
        reconciliationRequired: true,
      },
    });
    await expect(fixture.pump.drainStagedEffect({
      providerEffectIntentId: "provider_effect_interrupt",
    })).resolves.toMatchObject({
      disposition: "drained",
      providerDisposition: "reconciling",
      reconciliationRequired: true,
    });
    await expect(fixture.pump.drainStagedEffect({
      providerEffectIntentId: "provider_effect_interrupt",
      nativeBindingRef: "raw-session",
    } as never)).rejects.toMatchObject({ code: "session_id_acp_runtime_pump_input_invalid" });
    expect(new SessionIdAcpRuntimePumpError("safe_code")).toMatchObject({
      name: "SessionIdAcpRuntimePumpError",
      code: "safe_code",
    });
  });
});

function pumpFixture(input: Readonly<{
  stages: readonly SessionIdAcpDeliveryStageResult[];
  reconciliation?: SessionIdAcpDrainableProviderEffect;
  drainResult?: SessionIdAcpProviderDrainResult;
  beforeDrain?: () => Promise<void>;
}>) {
  const stages = [...input.stages];
  const ensureCalls: string[] = [];
  const stageCalls: string[] = [];
  const reconcileCalls: string[] = [];
  const drainCalls: string[] = [];
  const pump = createSessionIdAcpRuntimePump({
    deliveryOwner: {
      stageReadyDelivery({ logicalSessionId }) {
        stageCalls.push(logicalSessionId);
        const next = stages.shift();
        if (!next) throw new Error("unexpected_stage");
        return next;
      },
    },
    cardBindingOwner: {
      ensureCurrentCardBinding({ logicalSessionId }) {
        ensureCalls.push(logicalSessionId);
        return {
          disposition: "created",
          taskId: "task_card",
          runId: "run_card",
          logicalSessionId,
          agentCardId: "agent_card_worker",
          executionProfileId: "profile_worker",
          profileRevisionId: "profile_revision_worker",
          providerFamily: "opencode",
          bindingId: "binding_card",
          bindingHandle: "binding_handle_card",
          sessionExecutionRuntimeId: "session_execution_runtime_card",
        };
      },
    },
    orchestrationBridge: {
      stageReconciliation({ sessionExecutionAttemptId }) {
        reconcileCalls.push(sessionExecutionAttemptId);
        if (!input.reconciliation) throw new Error("unexpected_reconciliation");
        return input.reconciliation;
      },
    },
    providerDrain: {
      async drain({ providerEffectIntentId }) {
        drainCalls.push(providerEffectIntentId);
        await input.beforeDrain?.();
        return input.drainResult ?? {
          disposition: "settled",
          providerEffectIntentId,
          sessionExecutionAttemptId: "session_execution_attempt_card",
          commandType: "session_runtime.submit_delivery",
          reconciliationRequired: false,
        };
      },
    },
  });
  return { pump, ensureCalls, stageCalls, reconcileCalls, drainCalls };
}

function idle(
  reason: Extract<SessionIdAcpDeliveryStageResult, { disposition: "idle" }>["reason"],
): SessionIdAcpDeliveryStageResult {
  return Object.freeze({ disposition: "idle", reason });
}

function staged(providerEffectIntentId: string): SessionIdAcpDeliveryStageResult {
  return Object.freeze({
    disposition: "staged",
    inboxItemId: "inbox_card",
    inputSubmissionId: "input_card",
    sessionTurnId: "session_turn_card",
    providerEffectIntentId,
    sessionExecutionRuntimeId: "session_execution_runtime_card",
    sessionExecutionAttemptId: "session_execution_attempt_card",
  });
}
