import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES,
  CLAUDE_CODE_PROVEN_CAPABILITIES,
  cliInitSupportsRequiredCapabilities,
  createClaudeCodeCommandUuid,
  mapClaudeCodeCliFrame,
  readClaudeCodeCliInit,
} from "./index.js";

describe("Claude Code stream-json protocol mapper", () => {
  it("maps only the observed init, receipt, result, and interrupt facts", () => {
    const correlation = { commandUuid: "b7f3a78c-6a20-4a3e-a61c-9087f4dc0ec9", inputSubmissionId: "input_1", invocationId: "invocation_1" };
    const context = {
      sourceInstanceId: "claude-code-cli:host_1",
      cursor: "1",
      disposition: "create" as const,
      activeCorrelation: correlation,
      correlationForCommandUuid: (commandUuid: string) => commandUuid === correlation.commandUuid ? correlation : undefined,
    };

    const init = {
      type: "system", subtype: "init", uuid: "event_init", session_id: "a8349077-50de-49f7-b1a4-38c0a38c15fb",
      claude_code_version: "2.1.222", capabilities: [...CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES],
    };
    expect(readClaudeCodeCliInit(init)).toMatchObject({ sessionId: init.session_id, providerVersion: "2.1.222" });
    expect(cliInitSupportsRequiredCapabilities(readClaudeCodeCliInit(init))).toBe(true);
    expect(mapClaudeCodeCliFrame(init, context)).toMatchObject([{
      kind: "claude-code.binding.created",
      providerEventId: "event_init",
      payload: { nativeBindingRef: init.session_id },
    }]);

    expect(mapClaudeCodeCliFrame({
      type: "command_lifecycle", uuid: "event_started", command_uuid: correlation.commandUuid, state: "started",
    }, { ...context, cursor: "2" })).toMatchObject([{
      kind: "claude-code.delivery.receipt",
      inputSubmissionId: "input_1",
      invocationId: "invocation_1",
      nativeMessageId: "event_started",
    }]);

    expect(mapClaudeCodeCliFrame({
      type: "result", uuid: "event_result", user_message_uuid: correlation.commandUuid,
      is_error: false, terminal_reason: "completed", result: "done", duration_ms: 12,
    }, { ...context, cursor: "3" })).toMatchObject([
      {
        kind: "claude-code.assistant.final",
        providerEventId: "event_result:assistant_final",
        invocationId: "invocation_1",
        nativeMessageId: "event_result",
        payload: { content: "done" },
      },
      {
        kind: "claude-code.turn.completed",
        providerEventId: "event_result:turn_terminal",
        invocationId: "invocation_1",
        nativeTurnId: "event_result",
        payload: { result: { text: "done", terminalReason: "completed" } },
      },
    ]);

    expect(mapClaudeCodeCliFrame({
      type: "command_lifecycle", uuid: "event_cancelled", command_uuid: correlation.commandUuid, state: "cancelled",
    }, { ...context, cursor: "4" })).toMatchObject([{
      kind: "claude-code.interrupt.confirmed",
      invocationId: "invocation_1",
    }]);
  });

  it("keeps final text for a non-Invocation managed SessionTurn", () => {
    const correlation = { commandUuid: "b7f3a78c-6a20-4a3e-a61c-9087f4dc0ec8", inputSubmissionId: "input_relay" };
    const facts = mapClaudeCodeCliFrame({
      type: "result",
      uuid: "event_relay_result",
      user_message_uuid: correlation.commandUuid,
      is_error: false,
      terminal_reason: "completed",
      result: "relay reply",
    }, {
      sourceInstanceId: "claude-code-cli:host_relay",
      cursor: "1",
      disposition: "create" as const,
      activeCorrelation: correlation,
      correlationForCommandUuid: (commandUuid: string) => commandUuid === correlation.commandUuid ? correlation : undefined,
    });

    expect(facts).toMatchObject([
      { kind: "claude-code.assistant.final", inputSubmissionId: "input_relay", payload: { content: "relay reply" } },
      { kind: "claude-code.turn.completed", inputSubmissionId: "input_relay" },
    ]);
    expect(facts[0]).not.toHaveProperty("invocationId");
  });

  it("does not invent a final message from an empty or failed terminal result", () => {
    const correlation = { commandUuid: "command_1", inputSubmissionId: "input_1", invocationId: "invocation_1" };
    const context = {
      sourceInstanceId: "claude-code-cli:host_1",
      cursor: "5",
      disposition: "resume" as const,
      activeCorrelation: correlation,
      correlationForCommandUuid: (commandUuid: string) => commandUuid === correlation.commandUuid ? correlation : undefined,
    };

    const empty = mapClaudeCodeCliFrame({
      type: "result", uuid: "event_empty", user_message_uuid: correlation.commandUuid,
      is_error: false, terminal_reason: "completed", result: "",
    }, context);
    expect(empty).toMatchObject([{ kind: "claude-code.turn.completed" }]);
    expect(empty).toHaveLength(1);

    const whitespace = mapClaudeCodeCliFrame({
      type: "result", uuid: "event_whitespace", user_message_uuid: correlation.commandUuid,
      is_error: false, terminal_reason: "completed", result: "  \n  ",
    }, { ...context, cursor: "5.1" });
    expect(whitespace).toMatchObject([{ kind: "claude-code.turn.completed" }]);
    expect(whitespace).toHaveLength(1);

    const failed = mapClaudeCodeCliFrame({
      type: "result", uuid: "event_failed", user_message_uuid: correlation.commandUuid,
      is_error: true, terminal_reason: "failed", result: "provider error",
    }, { ...context, cursor: "6" });
    expect(failed).toMatchObject([{ kind: "claude-code.turn.failed" }]);
    expect(failed).toHaveLength(1);
  });

  it("uses a deterministic valid UUID for an idempotency retry", () => {
    const first = createClaudeCodeCommandUuid({ bindingId: "binding_1", idempotencyKey: "input:1" });
    expect(createClaudeCodeCommandUuid({ bindingId: "binding_1", idempotencyKey: "input:1" })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("declares only live-proven capabilities", () => {
    expect(CLAUDE_CODE_CAPABILITIES).toEqual(CLAUDE_CODE_PROVEN_CAPABILITIES);
    expect(CLAUDE_CODE_CAPABILITIES).toEqual(expect.arrayContaining([
      "create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt",
    ]));
    expect(CLAUDE_CODE_CAPABILITIES).not.toEqual(expect.arrayContaining([
      "attention_reply", "native_child", "presentation",
    ]));
  });
});
