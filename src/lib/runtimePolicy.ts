import type { RuntimePolicy } from "../types";

export const opencodeAgentModel = "opencode-go/deepseek-v4-flash";

export function createRunRuntimePolicy({
  agentId,
  runId,
}: {
  agentId: string;
  runId: string;
}): RuntimePolicy {
  return {
    permissionMode: "ask-before-write",
    sandboxMode: "workspace-write",
    effort: "medium",
    cliCommand: commandForAgent(agentId),
    policyPath: `.agent-workspace/runs/${runId}/policy.json`,
  };
}

export function commandForAgent(_agentId: string) {
  return `opencode --model ${opencodeAgentModel}`;
}
