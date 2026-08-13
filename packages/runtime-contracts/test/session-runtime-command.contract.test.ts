import { describe, expect, it } from "vitest";
import {
  hashDefinition,
  validateSessionRuntimeCommand,
  type SessionRuntimeCommand,
} from "../src";

describe("SessionRuntimeCommand contract", () => {
  it("is a closed safe command union with exact revision and correlation fields", () => {
    const commands: readonly SessionRuntimeCommand[] = [
      {
        ...scope(),
        type: "session_runtime.submit_delivery",
        inputSubmissionId: "input_1",
        orchestrationSessionTurnId: "session_turn_or_1",
        content: "Implement the bounded change.",
        contentDigest: hashDefinition("Implement the bounded change."),
      },
      {
        ...scope(),
        type: "session_runtime.reconcile_attempt",
        sessionExecutionAttemptId: "session_execution_attempt_1",
        expectedAttemptRevision: 2,
        inputSubmissionId: "input_1",
        orchestrationSessionTurnId: "session_turn_or_1",
      },
      {
        ...scope(),
        type: "session_runtime.request_interrupt",
        sessionExecutionAttemptId: "session_execution_attempt_1",
        expectedAttemptRevision: 2,
        inputSubmissionId: "input_1",
        orchestrationSessionTurnId: "session_turn_or_1",
        sessionControlAuditId: "session_control_1",
      },
      {
        ...scope(),
        type: "session_runtime.respond_interaction",
        sessionExecutionAttemptId: "session_execution_attempt_1",
        expectedAttemptRevision: 2,
        inputSubmissionId: "input_1",
        orchestrationSessionTurnId: "session_turn_or_1",
        interactionId: "interaction_permission-1",
        expectedInteractionRevision: 1,
        choiceId: "choice_allow-once",
      },
    ];

    expect(commands.map((command) => validateSessionRuntimeCommand(command).type)).toEqual([
      "session_runtime.submit_delivery",
      "session_runtime.reconcile_attempt",
      "session_runtime.request_interrupt",
      "session_runtime.respond_interaction",
    ]);
    expect(commands.map(commandKind)).toEqual(["submit", "reconcile", "interrupt", "interaction"]);
    expect(JSON.stringify(commands)).not.toMatch(/acpSessionId|native|requestId|optionId|toolCallId|cwd|\/private\//u);
  });

  it("rejects extra private fields and incomplete causal fences", () => {
    const valid = {
      ...scope(),
      type: "session_runtime.submit_delivery",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_or_1",
      content: "Safe content",
      contentDigest: hashDefinition("Safe content"),
    } as const;
    expect(() => validateSessionRuntimeCommand({ ...valid, acpSessionId: "raw-session" }))
      .toThrow(/session_execution_private_field_forbidden|session_runtime_command_shape_invalid/);
    expect(() => validateSessionRuntimeCommand({ ...valid, bindingHandle: "raw-session" }))
      .toThrow(/session_execution_opaque_id_invalid/);
    const { expectedRuntimeRevision: _missing, ...withoutRevision } = valid;
    expect(() => validateSessionRuntimeCommand(withoutRevision)).toThrow(/session_runtime_command_shape_invalid/);
  });
});

function scope() {
  return {
    commandId: "command_sr-1",
    idempotencyKey: "sr-command-1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_1",
    sessionExecutionRuntimeId: "session_execution_runtime_1",
    expectedRuntimeRevision: 2,
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    bindingHandle: "binding_handle_workspace-1",
  } as const;
}

function commandKind(command: SessionRuntimeCommand): string {
  switch (command.type) {
    case "session_runtime.submit_delivery": return "submit";
    case "session_runtime.reconcile_attempt": return "reconcile";
    case "session_runtime.request_interrupt": return "interrupt";
    case "session_runtime.respond_interaction": return "interaction";
    default: return assertNever(command);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected command: ${JSON.stringify(value)}`);
}
