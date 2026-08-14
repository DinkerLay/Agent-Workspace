import { describe, expect, it } from "vitest";
import {
  validateSessionIdAcpTaskReadModel,
  type SessionIdAcpTaskReadModel,
} from "../src/acp-task-read-model.js";

const NOW = "2026-08-12T18:00:00.000Z";

describe("ACP Task read-model contract", () => {
  it("accepts the exact renderer-safe ACP projection", () => {
    const model = safeModel();
    expect(validateSessionIdAcpTaskReadModel(model)).toEqual(model);
  });

  it("accepts a Task whose optional PlanningFence is not yet persisted", () => {
    const { planningFence: _planningFence, ...model } = safeModel();
    expect(validateSessionIdAcpTaskReadModel(model)).toEqual(model);
  });

  it.each([
    ["ambiguous session id", { sessionId: "raw-acp-session" }],
    ["native binding", { nativeBindingRef: "native-ref" }],
    ["binding handle", { bindingHandle: "binding_handle_private" }],
    ["attempt identity", { sessionExecutionAttemptId: "session_execution_attempt_private" }],
    ["Provider fact", { providerFact: { kind: "turn_started" } }],
    ["legacy Attention", { attentions: [] }],
    ["absolute cwd", { cwd: "/private/workspace" }],
    ["unknown extra", { extraProjectionField: true }],
  ])("rejects %s fields at the public boundary", (_label, extra) => {
    expect(() => validateSessionIdAcpTaskReadModel({ ...safeModel(), ...extra }))
      .toThrow();
  });

  it("rejects private or misplaced fields inside nested projections", () => {
    const model = safeModel();
    const session = model.sessions[0]!;
    expect(() => validateSessionIdAcpTaskReadModel({
      ...model,
      sessions: [{ ...session, profile: { ...session.profile, bindingHandle: "binding_handle_private" } }],
    })).toThrow();
    expect(() => validateSessionIdAcpTaskReadModel({
      ...model,
      sessions: [{ ...session, binding: { ...session.binding!, detail: "Host-private recovery hint" } }],
    })).toThrow();
    expect(() => validateSessionIdAcpTaskReadModel({
      ...model,
      sessions: [{
        ...session,
        executionGroups: [{ ...session.executionGroups[0]!, activities: [{ kind: "tool_running" }] }],
      }],
    })).toThrow("provider_activity_read_model_invalid");
    expect(() => validateSessionIdAcpTaskReadModel({
      ...model,
      sessions: [{
        ...session,
        executionGroups: [{
          ...session.executionGroups[0]!,
          activities: [{
            activityId: "raw_acp_tool_id",
            kind: "tool",
            title: "Unsafe tool",
            status: "pending",
            observedAt: NOW,
          }],
        }],
      }],
    })).toThrow("provider_activity_read_model_invalid");
  });

  it("rejects the superseded workspace observation identity alias", () => {
    const model = safeModel();
    expect(() => validateSessionIdAcpTaskReadModel({
      ...model,
      files: [{ ...model.files[0]!, observationId: "workspace_observation_readme" }],
    })).toThrow("acp_task_read_model_file_invalid");
  });
});

function safeModel(): SessionIdAcpTaskReadModel {
  return {
    taskId: "task_read_model",
    title: "ACP task",
    goal: "Project canonical state",
    revision: 7,
    runId: "run_read_model",
    runStatus: "running",
    conductorLogicalSessionId: "logical_session_conductor",
    planningFence: {
      planningFenceId: "planning_fence_read_model",
      revision: 7,
      currentConductorSessionTurnId: "session_turn_conductor",
      advancedAt: NOW,
    },
    directory: [{
      agentCardId: "agent_card_researcher",
      title: "Researcher",
      state: "interaction_required",
      currentLogicalSessionId: "logical_session_researcher",
      currentGeneration: 1,
      detail: "Waiting for an authenticated choice",
    }],
    sessions: [{
      logicalSessionId: "logical_session_researcher",
      agentCardId: "agent_card_researcher",
      title: "Researcher",
      kind: "card",
      generation: 1,
      lifecycle: "current",
      state: "interaction_required",
      hasReceivedFirstInstruction: true,
      profile: {
        schemaVersion: 3,
        executionProfileId: "profile_researcher",
        profileRevisionId: "profile_revision_researcher",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        model: "openai/gpt-5",
        role: "researcher",
        permissionMode: "ask",
        allowedTools: [],
        requiredCapabilities: ["provider_receipt"],
        requiredExtensions: [],
        readiness: {
          profileRevisionId: "profile_revision_researcher",
          providerFamily: "opencode",
          acpAgentKind: "native_acp",
          role: "researcher",
          status: "available",
          reasons: [],
          missingCapabilities: [],
          missingExtensions: [],
          model: "openai/gpt-5",
        },
        mutableDuringRun: false,
      },
      binding: { label: "OpenCode ACP", status: "active", recoverable: true },
      messages: [],
      executionGroups: [{
        executionGroupId: "execution_group_session_turn_worker",
        logicalSessionId: "logical_session_researcher",
        sessionTurnId: "session_turn_worker",
        inputSubmissionId: "input_worker",
        providerFamily: "opencode",
        status: "waiting_for_interaction",
        startedAt: NOW,
        updatedAt: NOW,
        activities: [{
          activityId: "provider_activity_safe_progress",
          kind: "assistant_progress",
          contentKind: "response",
          content: "Inspecting evidence",
          observedAt: NOW,
        }],
      }],
      interactions: [{
        interactionId: "interaction_permission",
        interactionRevision: 1,
        choices: [{ choiceId: "choice_allow", label: "Allow once" }],
      }],
      controls: [],
      humanDeliveries: [],
    }],
    timeline: [{
      timelineItemId: "timeline_interaction_permission",
      kind: "interaction_state",
      occurredAt: NOW,
      title: "Interaction requires a choice",
      status: "requested",
      logicalSessionId: "logical_session_researcher",
      interactionId: "interaction_permission",
    }],
    files: [{
      observationId: "workspace_file_observation_readme",
      workspaceRelativePath: "README.md",
      observedAt: NOW,
      currentState: "available",
      source: "verified_tool",
    }],
  };
}
