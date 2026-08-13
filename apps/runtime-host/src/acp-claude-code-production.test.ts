import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { compileClaudeCodeAcpSessionConfiguration } from "./session-id-acp-production-composition.js";

describe("Claude Code ACP production semantics", () => {
  it.each([
    ["ask", "default"],
    ["preapproved", "bypassPermissions"],
    ["deny", "dontAsk"],
  ] as const)("compiles %s permission policy to the live Claude mode option", (permissionMode, value) => {
    expect(compileClaudeCodeAcpSessionConfiguration(profile(permissionMode))).toEqual({
      model: "claude-opus-5",
      options: [{
        configId: "mode",
        category: "mode",
        type: "select",
        value,
      }],
    });
  });

  it("rejects caller-supplied Claude option bags instead of overriding the Host policy", () => {
    expect(() => compileClaudeCodeAcpSessionConfiguration({
      ...profile("preapproved"),
      configIntent: { mode: "bypassPermissions" },
    })).toThrow(/config_intent_unsupported/);
  });
});

function profile(
  permissionMode: "ask" | "preapproved" | "deny",
): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_claude_code_production",
    profileRevisionId: "profile_revision_claude_code_production_v1",
    providerFamily: "claude-code",
    acpAgentKind: "claude_agent_acp",
    protocolMajor: 1,
    model: "claude-opus-5",
    configIntent: {},
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ],
      allowedTools: [],
      permissionMode,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}
