import { buildConductorSystemPrompt } from "../../orchestration/conductor-tools/conductorPrompt";
import type { TaskSessionPlan } from "../../types";
import type { NativeRuntimeFile } from "../nativeBridge";

export type ConductorRuntimeInput = {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  model: string;
  workerTargets: string[];
  workerSessions: Array<{ id: string; name: string; role: string }>;
  taskSessionPlan?: TaskSessionPlan;
  bridgeUrl: string;
  bridgeToken: string;
  mcpServerPath: string;
};

export type ConductorRuntimeBundle = {
  systemPrompt: string;
  runtimeRoot: string;
  files: NativeRuntimeFile[];
};

export function buildConductorRuntimeBundle(input: ConductorRuntimeInput): ConductorRuntimeBundle {
  const runtimeRoot = `.agent-workspace/runtime/${safeSegment(input.taskId)}/conductor`;
  const systemPrompt = buildConductorSystemPrompt(input);
  return {
    systemPrompt,
    runtimeRoot,
    files: [{ relativePath: `${runtimeRoot}/system.md`, contents: systemPrompt }],
  };
}

export function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
