import { describe, expect, it } from "vitest";
import {
  normalizePermissionRequest,
  normalizeSessionNotification,
} from "./normalizer.js";
import { GenerationPrivateIdentityMap } from "./private-identity-map.js";

describe("ACP safe interaction normalization", () => {
  it("produces a stable promptDigest from safe shape only", () => {
    const left = interaction("raw-session-left", "raw-tool-left", "raw-option-left");
    const right = interaction("raw-session-right", "raw-tool-right", "raw-option-right");

    expect(left.promptDigest).toBe(right.promptDigest);
    expect(left.promptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const serialized = JSON.stringify({ left, right });
    for (const raw of [
      "raw-session-left",
      "raw-session-right",
      "raw-tool-left",
      "raw-tool-right",
      "raw-option-left",
      "raw-option-right",
      "/private/workspace/stable",
      "/private/additional/stable",
    ]) expect(serialized).not.toContain(raw);
  });

  it("preserves ordinary markdown whitespace in bounded Agent message chunks", () => {
    const identities = identityMap("raw-session-markdown");
    const text = "# Result\n\n- first\t`code`\r\n- second";

    expect(normalizeSessionNotification({
      notification: {
        sessionId: "raw-session-markdown",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
      identities,
      bindingHandle: "binding_handle_safe",
      attemptId: "session_execution_attempt_safe",
      privateDirectories: [],
    })).toMatchObject({ kind: "agent_message_chunk", text });
  });

  it.each([
    "unsafe\u0000message",
    "x".repeat(256 * 1024 + 1),
  ])("rejects unsafe Agent message text before public observation", (text) => {
    const identities = identityMap("raw-session-message-invalid");

    expect(() => normalizeSessionNotification({
      notification: {
        sessionId: "raw-session-message-invalid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
      identities,
      bindingHandle: "binding_handle_safe",
      attemptId: "session_execution_attempt_safe",
      privateDirectories: [],
    })).toThrowError("acp_agent_message_text_invalid");
  });

  it.each([
    "unsafe\u0000title",
    "x".repeat(4 * 1024 + 1),
  ])("rejects unsafe tool titles before public observation", (title) => {
    const identities = identityMap("raw-session-tool-invalid");

    expect(() => normalizeSessionNotification({
      notification: {
        sessionId: "raw-session-tool-invalid",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "raw-tool-invalid",
          title,
        },
      },
      identities,
      bindingHandle: "binding_handle_safe",
      attemptId: "session_execution_attempt_safe",
      privateDirectories: [],
    })).toThrowError("acp_tool_title_invalid");
  });

  it.each([
    "unsafe\u0000choice",
    "x".repeat(4 * 1024 + 1),
  ])("rejects unsafe permission choice labels before public observation", (name) => {
    const identities = identityMap("raw-session-choice-invalid");

    expect(() => normalizePermissionRequest({
      request: {
        sessionId: "raw-session-choice-invalid",
        toolCall: { toolCallId: "raw-tool-choice-invalid", title: "Review" },
        options: [{
          optionId: "raw-option-choice-invalid",
          name,
          kind: "allow_once",
        }],
      },
      identities,
      bindingHandle: "binding_handle_safe",
      attemptId: "session_execution_attempt_safe",
      privateDirectories: [],
    })).toThrowError("acp_permission_option_name_invalid");
  });
});

function identityMap(rawSessionId: string): GenerationPrivateIdentityMap {
  let sequence = 0;
  const identities = new GenerationPrivateIdentityMap({
    generationId: "generation_safe",
    createOpaqueId: (kind) => `${kind}_${++sequence}`,
  });
  identities.bindSession("binding_handle_safe", rawSessionId);
  return identities;
}

function interaction(rawSessionId: string, rawToolCallId: string, rawOptionId: string) {
  const identities = identityMap(rawSessionId);
  return normalizePermissionRequest({
    request: {
      sessionId: rawSessionId,
      toolCall: {
        toolCallId: rawToolCallId,
        title: "Apply /private/workspace/stable/file.ts and /private/additional/stable/file.ts",
        status: "pending",
      },
      options: [{
        optionId: rawOptionId,
        name: "Allow /private/additional/stable once",
        kind: "allow_once",
      }],
    },
    identities,
    bindingHandle: "binding_handle_safe",
    attemptId: "session_execution_attempt_safe",
    privateDirectories: [
      "/private/workspace/stable",
      "/private/additional/stable",
    ],
  });
}
