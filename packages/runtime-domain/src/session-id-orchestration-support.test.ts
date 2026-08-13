import { describe, expect, it } from "vitest";
import { materializeCardSessionGeneration, retireCardSessionGeneration } from "./card-session-slots";
import { advanceConductorPlanningFence, assertCurrentConductorPlanningTurn } from "./planning-fences";
import { createSessionIdOrchestrationKernel } from "./session-id-orchestration";
import { appendSessionLaneItem, assertSessionLaneCanClose, suppressPendingOrdinaryLaneItems } from "./session-lanes";
import { createSessionControlAudit, settleSessionControlAudit } from "./session-controls";
import { createFileStateAnchor, createWorkspaceFileObservation } from "./workspace-file-observations";

const NOW = "2026-08-11T00:00:00.000Z";

describe("Session-ID orchestration domain support", () => {
  it("opens and retires explicit Card generations without implicit reuse", () => {
    const firstInput = {
      taskId: "task_domain",
      runId: "run_domain",
      agentCardId: "agent_card_worker",
      executionProfileId: "profile_worker",
      cardSessionSlotId: "card_session_slot_worker",
      sessionId: "logical_session_worker_g1",
      now: NOW,
    };
    const first = materializeCardSessionGeneration(firstInput);

    expect(first.generation.executionProfileId).toBe("profile_worker");
    expect(() => materializeCardSessionGeneration({
      taskId: "task_domain",
      runId: "run_domain",
      agentCardId: "agent_card_worker",
      cardSessionSlotId: "card_session_slot_missing_profile",
      sessionId: "logical_session_missing_profile",
      now: NOW,
    } as unknown as Parameters<typeof materializeCardSessionGeneration>[0]))
      .toThrow("card_session_generation_execution_profile_id_invalid");

    expect(() => materializeCardSessionGeneration({
      slot: first.slot,
      taskId: "task_domain",
      runId: "run_domain",
      agentCardId: "agent_card_worker",
      executionProfileId: "profile_worker",
      cardSessionSlotId: "card_session_slot_worker",
      sessionId: "logical_session_worker_other",
      now: NOW,
    })).toThrow("card_session_slot_current_exists");

    const retired = retireCardSessionGeneration({ ...first, now: NOW });
    const second = materializeCardSessionGeneration({
      slot: retired.slot,
      taskId: "task_domain",
      runId: "run_domain",
      agentCardId: "agent_card_worker",
      executionProfileId: "profile_worker",
      cardSessionSlotId: "card_session_slot_worker",
      sessionId: "logical_session_worker_g2",
      now: NOW,
    });
    expect(second.generation.generation).toBe(2);
    expect(retired.generation.lifecycle).toBe("closed");
  });

  it("keeps the lane ordered and close conservative", () => {
    const first = appendSessionLaneItem({
      items: [],
      item: {
        inboxItemId: "inbox_first",
        taskId: "task_domain",
        runId: "run_domain",
        sessionId: "logical_session_worker",
        renderedMessageId: "message_first",
        priority: "ordinary",
        forwardId: "message_forward_first",
      },
      now: NOW,
    });
    const held = appendSessionLaneItem({
      items: [first],
      item: {
        inboxItemId: "inbox_human",
        taskId: "task_domain",
        runId: "run_domain",
        sessionId: "logical_session_worker",
        renderedMessageId: "message_human",
        priority: "human",
        humanInterventionId: "human_intervention_one",
      },
      initialState: "held_by_human_intervention",
      now: NOW,
    });

    expect(held).toMatchObject({ sequence: 2, causalPredecessorInboxItemId: "inbox_first" });
    expect(() => assertSessionLaneCanClose([first, held], "logical_session_worker"))
      .toThrow("session_close_lane_not_safe");

    const suppressed = suppressPendingOrdinaryLaneItems({
      items: [first, held],
      sessionId: "logical_session_worker",
      now: NOW,
      reason: "task_stopped",
    });
    expect(suppressed.affectedInboxItemIds).toEqual(["inbox_first"]);
    expect(suppressed.items).toEqual([
      expect.objectContaining({ inboxItemId: "inbox_first", state: "suppressed", reason: "task_stopped" }),
      held,
    ]);
  });

  it("fences stale Conductor turns and advances explicitly", () => {
    const first = advanceConductorPlanningFence({
      planningFenceId: "planning_fence_1",
      taskId: "task_domain",
      runId: "run_domain",
      sourceCommandId: "command_1",
      conductorSessionTurnId: "session_turn_conductor_1",
      now: NOW,
    });
    const second = advanceConductorPlanningFence({
      previous: first,
      planningFenceId: "planning_fence_2",
      taskId: "task_domain",
      runId: "run_domain",
      sourceCommandId: "command_2",
      conductorSessionTurnId: "session_turn_conductor_2",
      now: NOW,
    });

    expect(() => assertCurrentConductorPlanningTurn(second, "session_turn_conductor_1"))
      .toThrow("conductor_planning_fence_stale");
    expect(() => assertCurrentConductorPlanningTurn(second, "session_turn_conductor_2")).not.toThrow();
    expect(second.previousConductorSessionTurnId).toBe("session_turn_conductor_1");
  });

  it("records accepted and terminal control states separately", () => {
    const requested = createSessionControlAudit({
      sessionControlAuditId: "session_control_interrupt",
      taskId: "task_domain",
      runId: "run_domain",
      sessionId: "logical_session_worker",
      commandId: "command_interrupt",
      idempotencyKey: "interrupt:1",
      kind: "conductor_interrupt",
      now: NOW,
    });
    const accepted = settleSessionControlAudit({ audit: requested, state: "accepted", now: NOW });
    const confirmed = settleSessionControlAudit({ audit: accepted, state: "confirmed", now: NOW });

    expect([requested.state, accepted.state, confirmed.state]).toEqual(["requested", "accepted", "confirmed"]);
    expect(() => settleSessionControlAudit({ audit: confirmed, state: "unknown", now: NOW }))
      .toThrow("session_control_transition_invalid");
  });

  it("creates verified file observations and optional value anchors only", () => {
    const observation = createWorkspaceFileObservation({
      workspaceFileObservationId: "workspace_file_observation_report",
      taskId: "task_domain",
      runId: "run_domain",
      workspaceRelativePath: "reports/result.md",
      content: "# Result\n",
      source: "verified_tool",
      now: NOW,
    });
    expect(observation).toMatchObject({
      state: "available",
      workspaceRelativePath: "reports/result.md",
      source: "verified_tool",
    });
    expect(createFileStateAnchor(observation, "accepted output")).toEqual({
      workspaceRelativePath: "reports/result.md",
      observedDigest: observation.contentDigest,
      label: "accepted output",
    });
    expect(() => createWorkspaceFileObservation({
      workspaceFileObservationId: "workspace_file_observation_escape",
      taskId: "task_domain",
      workspaceRelativePath: "../escape.md",
      source: "unverified",
      now: NOW,
    })).toThrow("workspace_observation_path_invalid");
  });

  it("snapshots ordered Message references and rejects unknown or cross-run Sessions", () => {
    const kernel = createSessionIdOrchestrationKernel({
      now: () => NOW,
      createSessionId: () => "logical_session_worker_g1",
      executionProfileIdForAgentCard: () => "profile_worker",
      resolveMessageReference: (reference) => ({
        content: reference.kind === "full_message" ? "Full evidence." : "Selected risk.",
        contentDigest: reference.kind === "full_message" ? "digest_full" : "digest_relay",
      }),
    });
    kernel.invokeAgent({ runId: "run_domain", agentCardId: "agent_card_worker", idempotencyKey: "invoke:1" });
    kernel.sendToSession({
      runId: "run_domain",
      sessionId: "logical_session_worker_g1",
      idempotencyKey: "send:refs:1",
      payload: {
        messageRefs: [
          { kind: "full_message", sourceMessageId: "message_source" },
          { kind: "relay_block", sourceMessageId: "message_source", relayBlockId: "relay_block_risk" },
        ],
      },
    });

    expect(kernel.snapshot().forwards[0]?.orderedReferenceSnapshots).toEqual([
      { ordinal: 0, kind: "full_message", sourceMessageId: "message_source", contentDigest: "digest_full" },
      {
        ordinal: 1,
        kind: "relay_block",
        sourceMessageId: "message_source",
        relayBlockId: "relay_block_risk",
        contentDigest: "digest_relay",
      },
    ]);
    expect(() => kernel.sendToSession({
      runId: "run_other",
      sessionId: "logical_session_worker_g1",
      idempotencyKey: "send:cross-run",
      payload: { content: "No." },
    })).toThrow("orchestration_session_scope_mismatch");
    expect(() => kernel.sendToSession({
      runId: "run_domain",
      sessionId: "logical_session_unknown",
      idempotencyKey: "send:unknown",
      payload: { content: "No." },
    })).toThrow("orchestration_session_unknown");
  });
});
