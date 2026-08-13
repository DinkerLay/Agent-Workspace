import { describe, expect, it } from "vitest";
import { injectClaudeCodeAcpSessionOptions } from "./acp-claude-code-stdio-connection.js";

describe("Claude Code ACP session options", () => {
  it("keeps provider-native tools for Task sessions while disabling ambient settings sources", () => {
    const value = injectClaudeCodeAcpSessionOptions({
      cwd: "/private/wire-cwd",
      mcpServers: [{ type: "http", name: "agent_workspace_conductor" }],
    }, "provider_default");

    expect(value).toEqual({
      cwd: "/private/wire-cwd",
      mcpServers: [{ type: "http", name: "agent_workspace_conductor" }],
      _meta: {
        claudeCode: {
          options: {
            settingSources: [],
          },
        },
      },
    });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("uses an exact empty native tool list only for Meta and rejects caller meta", () => {
    expect(injectClaudeCodeAcpSessionOptions({ cwd: "/private/cwd", mcpServers: [] }, "disabled"))
      .toMatchObject({
        _meta: { claudeCode: { options: { settingSources: [], tools: [] } } },
      });
    expect(() => injectClaudeCodeAcpSessionOptions({ cwd: "/private/cwd", _meta: {} }, "disabled"))
      .toThrow(/session_meta_conflict/);
    expect(() => injectClaudeCodeAcpSessionOptions({}, "invalid" as never))
      .toThrow(/native_tools_policy_invalid/);
  });
});
