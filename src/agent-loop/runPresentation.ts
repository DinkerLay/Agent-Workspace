import type { NativeAgentLoopRunDetail } from "../runtime/nativeBridge";

export type WorkbenchActivity = {
  label: string;
  shortLabel: string;
  tone: string;
  attentionCount: number;
};

export function workbenchActivity(
  run: NativeAgentLoopRunDetail | undefined,
  counts?: { activeDispatchCount: number; liveTerminalCount: number },
): WorkbenchActivity {
  const attentionCount = run?.attentions.length ?? 0;
  if (!run) return { label: "未启动", shortLabel: "待启动", tone: "queued", attentionCount };
  if (run.task.status !== "running") {
    return { label: taskStatusLabel(run.task.status), shortLabel: taskStatusLabel(run.task.status), tone: run.task.status, attentionCount };
  }
  const attentionTypes = new Set(run.attentions.map((attention) => String(attention.type ?? "")));
  if (attentionCount) {
    if (attentionTypes.size === 1 && attentionTypes.has("worker_result_available")) {
      return { label: "待 Conductor 处理结果", shortLabel: "待处理", tone: "attention", attentionCount };
    }
    if (attentionTypes.has("conductor_wakeup_queued")) {
      return { label: "等待投递 Conductor 唤醒", shortLabel: "待唤醒", tone: "attention", attentionCount };
    }
    return { label: "需要处理", shortLabel: "待处理", tone: "attention", attentionCount };
  }
  const activeDispatchCount = counts?.activeDispatchCount ?? run.turns.filter((turn) => ["queued", "input_accepted", "delivered", "cancellation_requested", "cancel_failed"].includes(String(turn.dispatchStatus))).length;
  const liveTerminalCount = counts?.liveTerminalCount ?? run.turns.filter((turn) => turn.terminalStatus === "live").length;
  if (activeDispatchCount || liveTerminalCount) return { label: "正在执行", shortLabel: "执行中", tone: "running", attentionCount };
  const conductor = run.turns.find((turn) => turn.purpose === "conductor");
  if (conductor?.details.runtimeState === "waiting_conductor") {
    return { label: "等待 Runtime 事件", shortLabel: "待结果", tone: "waiting", attentionCount };
  }
  return { label: "无活跃会话", shortLabel: "无活动", tone: "waiting", attentionCount };
}

export function nativeTerminalEmptyState(turn: NativeAgentLoopRunDetail["turns"][number]) {
  const dispatchStatus = String(turn.dispatchStatus ?? turn.status);
  if (turn.terminalStatus === "not_started") {
    return {
      emptyTitle: "等待原生 OpenCode Session",
      emptyDetail: turn.purpose === "conductor" ? "Conductor 正在启动。" : "只有 Conductor 派发此卡片后，原生 Session 才会启动。",
    };
  }
  if (dispatchStatus === "result_available") {
    return {
      emptyTitle: "原生 Session 已完成",
      emptyDetail: "Provider 已返回结果；当前 Runtime 没有可附着的 PTY。可通过“终端历史”查看保留记录。",
    };
  }
  return {
    emptyTitle: turn.purpose === "conductor" ? "Conductor 当前不在线" : "原生 Session 当前不在线",
    emptyDetail: "此 Session 已被派发，但当前 Runtime 没有可附着的 PTY。可通过“终端历史”查看保留记录。",
  };
}

export function taskStatusLabel(status: string) {
  return ({ queued: "待启动", running: "运行中", delivery_ready: "已声明交付", stopping: "停止中", stopped: "已停止", deleting: "删除中", achieved: "achieved", archived: "已归档" } as Record<string, string>)[status] ?? status;
}
