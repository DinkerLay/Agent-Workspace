import type {
  CallSessionInput,
  CallSessionResult,
  ReadSessionInput,
  ReadSessionResult,
  ReadTaskStateInput,
  ReadTaskStateResult,
} from "../orchestration/conductor-tools";
import type { TaskSessionPlan } from "../types";
import type { OpencodeProcessStat } from "./opencode";

export type NativeRuntimeStatus = {
  available: boolean;
  mode: "browser" | "desktop";
  message: string;
  opencodePath?: string;
  opencodeVersion?: string;
  ptyAvailable?: boolean;
  ptyBackend?: string;
  conductorToolBridgeUrl?: string;
  conductorToolBridgeToken?: string;
  conductorMcpServerPath?: string;
};

export type NativeOpencodeInput = {
  cwd: string;
  message: string;
  model?: string;
};

export type NativeOpencodeResult = {
  ok: boolean;
  command: string;
  cwd: string;
  model?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
};

export type NativeTaskDraft = {
  projectPath?: string;
  projectName?: string;
  title?: string;
  summary?: string;
  templateId?: string;
  model?: string;
  labels?: string[];
  artifactPath?: string;
  outputHints?: string[];
  agentHints?: string[];
  sessionPlan?: TaskSessionPlan;
};

export type NativeTaskDraftInput = {
  message: string;
  projectPath: string;
  projectName?: string;
  model?: string;
  currentDraft?: NativeTaskDraft;
};

export type NativeTaskDraftResult = {
  ok: boolean;
  assistantMessage: string;
  draft?: NativeTaskDraft;
  draftPatch?: NativeTaskDraft;
  sessionPlan?: TaskSessionPlan;
  sessionPlanPatch?: TaskSessionPlan;
  missingFields: string[];
  assumptions: string[];
  command?: string;
  cwd?: string;
  raw?: string;
  error?: string;
};

export type NativeOpencodeAgent = {
  name: string;
  kind: string;
};

export type NativeOpencodeAgentListResult = {
  ok: boolean;
  agents: NativeOpencodeAgent[];
  stdout?: string;
  stderr?: string;
};

export type NativeOpencodeProcessInspection = {
  ok: boolean;
  processes: OpencodeProcessStat[];
  error?: string;
};

export type NativeVerificationInput = {
  cwd: string;
  runId: string;
  command: string;
  timeoutMs?: number;
};

export type NativeVerificationResult = {
  ok: boolean;
  command: string;
  cwd: string;
  runId: string;
  status: "passed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: number | string | null;
  durationMs: number;
  artifactPath: string;
  logPath: string;
  error?: string;
};

export type NativePtySession = {
  id: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  model?: string;
  backend: "pty" | "process";
  status: "running" | "stopping" | "stopped";
  cols: number;
  rows: number;
  stdin?: "pipe" | "ignore";
  transcript: string[];
  cursor?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: number | string | null;
};

export type NativeRuntimeFile = {
  relativePath: string;
  contents: string;
};

export type NativePtyEvent =
  | {
      type: "data";
      id: string;
      chunk: string;
      cursor: number;
    }
  | {
      type: "exit";
      id: string;
      status: "stopped";
      exitCode?: number | null;
      signal?: number | string | null;
      cursor: number;
    };

export type NativeRuntimeBridge = {
  getRuntimeStatus(): Promise<NativeRuntimeStatus>;
  runOpencode(input: NativeOpencodeInput): Promise<NativeOpencodeResult>;
  generateTaskDraft?(input: NativeTaskDraftInput): Promise<NativeTaskDraftResult>;
  listOpencodeAgents?(): Promise<NativeOpencodeAgentListResult>;
  inspectOpencodeProcesses?(): Promise<NativeOpencodeProcessInspection>;
  runVerification?(input: NativeVerificationInput): Promise<NativeVerificationResult>;
  startPty?(input: {
    id?: string;
    taskId?: string;
    command: string;
    args?: string[];
    cwd: string;
    model?: string;
    cols?: number;
    rows?: number;
    stdin?: "pipe" | "ignore";
    requirePty?: boolean;
    env?: Record<string, string>;
    runtimeFiles?: NativeRuntimeFile[];
  }): Promise<NativePtySession>;
  getPty?(input: { id: string }): Promise<NativePtySession | undefined>;
  readPty?(input: { id: string; cursor: number }): Promise<NativePtySession | undefined>;
  writePty?(input: { id: string; text: string }): Promise<NativePtySession | undefined>;
  resizePty?(input: { id: string; cols: number; rows: number }): Promise<NativePtySession | undefined>;
  stopPty?(input: { id: string }): Promise<NativePtySession | undefined>;
  onPtyEvent?(callback: (event: NativePtyEvent) => void): () => void;
  callSession?(input: CallSessionInput): Promise<CallSessionResult>;
  readTaskState?(input: ReadTaskStateInput): Promise<ReadTaskStateResult | undefined>;
  readSession?(input: ReadSessionInput): Promise<ReadSessionResult | undefined>;
};

declare global {
  interface Window {
    agentWorkspace?: {
      native: NativeRuntimeBridge;
    };
  }
}

export const browserRuntimeStatus: NativeRuntimeStatus = {
  available: false,
  mode: "browser",
  message: "浏览器模式无法直接启动本地 opencode。请使用桌面壳运行。",
};

export const defaultOpencodeRunModel = "opencode-go/deepseek-v4-flash";

export async function getNativeRuntimeStatus(): Promise<NativeRuntimeStatus> {
  return window.agentWorkspace?.native.getRuntimeStatus() ?? browserRuntimeStatus;
}

export async function runNativeOpencode(input: NativeOpencodeInput): Promise<NativeOpencodeResult> {
  const request = {
    ...input,
    model: input.model ?? defaultOpencodeRunModel,
  };

  if (!window.agentWorkspace?.native) {
    return {
      ok: false,
      command: `opencode run --format json --model ${request.model}`,
      cwd: request.cwd,
      model: request.model,
      stdout: "",
      stderr: browserRuntimeStatus.message,
      exitCode: null,
      durationMs: 0,
      error: browserRuntimeStatus.message,
    };
  }

  return window.agentWorkspace.native.runOpencode(request);
}

export async function generateNativeTaskDraft(input: NativeTaskDraftInput): Promise<NativeTaskDraftResult> {
  const request = {
    ...input,
    model: input.model ?? defaultOpencodeRunModel,
  };

  return window.agentWorkspace?.native.generateTaskDraft?.(request) ?? {
    ok: false,
    assistantMessage: "桌面壳不可用，无法调用 opencode 生成任务配置。",
    missingFields: [],
    assumptions: [],
    error: browserRuntimeStatus.message,
  };
}

export async function listNativeOpencodeAgents(): Promise<NativeOpencodeAgentListResult> {
  return window.agentWorkspace?.native.listOpencodeAgents?.() ?? {
    ok: false,
    agents: [],
    stderr: browserRuntimeStatus.message,
  };
}

export async function inspectNativeOpencodeProcesses(): Promise<NativeOpencodeProcessInspection> {
  return window.agentWorkspace?.native.inspectOpencodeProcesses?.() ?? {
    ok: false,
    processes: [],
    error: browserRuntimeStatus.message,
  };
}

export async function runNativeVerification(input: NativeVerificationInput): Promise<NativeVerificationResult> {
  const fallback = {
    ok: false,
    command: input.command,
    cwd: input.cwd,
    runId: input.runId,
    status: "failed" as const,
    stdout: "",
    stderr: browserRuntimeStatus.message,
    exitCode: null,
    signal: null,
    durationMs: 0,
    artifactPath: `.agent-workspace/runs/${input.runId}/verification.json`,
    logPath: `.agent-workspace/runs/${input.runId}/verification.log`,
    error: browserRuntimeStatus.message,
  };

  return window.agentWorkspace?.native.runVerification?.(input) ?? fallback;
}

export async function startNativePtySession(input: {
  id?: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd: string;
  model?: string;
  cols?: number;
  rows?: number;
  stdin?: "pipe" | "ignore";
  requirePty?: boolean;
  env?: Record<string, string>;
  runtimeFiles?: NativeRuntimeFile[];
}): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.startPty?.(input);
}

export async function getNativePtySession(id: string): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.getPty?.({ id });
}

export async function readNativePtySession(id: string, cursor: number): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.readPty?.({ id, cursor });
}

export async function writeNativePtySession(id: string, text: string): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.writePty?.({ id, text });
}

export async function resizeNativePtySession(
  id: string,
  size: { cols: number; rows: number },
): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.resizePty?.({ id, ...size });
}

export async function stopNativePtySession(id: string): Promise<NativePtySession | undefined> {
  return window.agentWorkspace?.native.stopPty?.({ id });
}

export function subscribeNativePtyEvents(callback: (event: NativePtyEvent) => void): () => void {
  return window.agentWorkspace?.native.onPtyEvent?.(callback) ?? (() => undefined);
}

export async function callNativeSession(input: CallSessionInput): Promise<CallSessionResult> {
  return (
    window.agentWorkspace?.native.callSession?.(input) ?? {
      ok: false,
      dispatchId: "",
      taskId: input.taskId,
      toSessionId: input.toSessionId,
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "unknown",
      resultState: "none",
      turnPolicy: "recover_or_stop",
      errorCode: "route_validation_failed",
      message: browserRuntimeStatus.message,
      error: browserRuntimeStatus.message,
    }
  );
}

export async function readNativeSession(input: ReadSessionInput): Promise<ReadSessionResult | undefined> {
  return window.agentWorkspace?.native.readSession?.(input);
}

export async function readNativeTaskState(input: ReadTaskStateInput): Promise<ReadTaskStateResult | undefined> {
  return window.agentWorkspace?.native.readTaskState?.(input);
}
