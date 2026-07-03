import { buildConductorRuntimeBundle, type ConductorRuntimeInput } from "../conductorRuntime";
import type { NativeRuntimeFile } from "../../nativeBridge";

export type OpenCodeConductorInjection = {
  env: Record<string, string>;
  files: NativeRuntimeFile[];
};

export function buildOpenCodeConductorInjection(input: ConductorRuntimeInput): OpenCodeConductorInjection {
  const bundle = buildConductorRuntimeBundle(input);
  const config = {
    $schema: "https://opencode.ai/config.json",
    instructions: [`${bundle.runtimeRoot}/system.md`],
    mcp: {
      agent_workspace_conductor: {
        type: "local",
        command: ["node", input.mcpServerPath],
        enabled: true,
        environment: {
          AGENT_WORKSPACE_TOOL_BRIDGE_URL: input.bridgeUrl,
          AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: input.bridgeToken,
        },
      },
    },
    tools: {
      "agent_workspace_conductor_*": true,
    },
  };

  return {
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    files: bundle.files,
  };
}
