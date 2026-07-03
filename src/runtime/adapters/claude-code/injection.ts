import type { Agent } from "../../../types";
import type { NativeRuntimeFile } from "../../nativeBridge";

// Worker sessions intentionally launch as provider-native Claude Code terminals.
// Conductor orchestration lives in ./conductorInjection.

export type ClaudeCodeWorkerLaunch = {
  args: string[];
  files: NativeRuntimeFile[];
  agentName: "";
};

export function buildClaudeCodeWorkerLaunch(_input: { agent: Agent }): ClaudeCodeWorkerLaunch {
  return {
    args: [],
    files: [],
    agentName: "",
  };
}
