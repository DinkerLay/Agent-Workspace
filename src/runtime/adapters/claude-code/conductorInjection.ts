import { buildConductorRuntimeBundle, type ConductorRuntimeInput } from "../conductorRuntime";
import type { NativeRuntimeFile } from "../../nativeBridge";

export type ClaudeCodeConductorInjection = {
  args: string[];
  files: NativeRuntimeFile[];
  agentName: "conductor";
};

export function buildClaudeCodeConductorInjection(input: ConductorRuntimeInput): ClaudeCodeConductorInjection {
  const bundle = buildConductorRuntimeBundle(input);
  const mcpConfigPath = `${bundle.runtimeRoot}/claude-mcp.json`;
  const mcpConfig = {
    mcpServers: {
      agent_workspace_conductor: {
        command: "node",
        args: [input.mcpServerPath],
        env: {
          AGENT_WORKSPACE_TOOL_BRIDGE_URL: input.bridgeUrl,
          AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: input.bridgeToken,
        },
      },
    },
  };

  return {
    args: ["--append-system-prompt", bundle.systemPrompt, "--mcp-config", mcpConfigPath],
    files: [...bundle.files, { relativePath: mcpConfigPath, contents: `${JSON.stringify(mcpConfig, null, 2)}\n` }],
    agentName: "conductor",
  };
}
