import type { Agent } from "../../../types";
import type { NativeRuntimeFile } from "../../nativeBridge";

// Worker sessions intentionally launch as provider-native opencode terminals.
// Conductor orchestration lives in ./conductorInjection.

export type OpenCodeWorkerLaunch = {
  env: Record<string, string>;
  runtimeFiles: NativeRuntimeFile[];
  agentName: "";
  args: string[];
};

export function buildOpenCodeWorkerLaunch(input: { agent: Agent }): OpenCodeWorkerLaunch {
  return {
    env: {},
    runtimeFiles: [],
    agentName: "",
    args: input.agent.model ? ["--model", input.agent.model] : [],
  };
}
