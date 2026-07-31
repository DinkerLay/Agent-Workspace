"use strict";

/**
 * Pure projection of Run control and Terminal Runtime facts for the Task
 * surface. This module deliberately performs no persistence or terminal I/O:
 * the Agent Loop Runtime owns the durable transition and Terminal Runtime owns
 * the terminal fact.
 */
function projectConductorContinuity({ runStatus, terminal } = {}) {
  const terminalStatus = String(terminal?.status ?? "not_live");
  if (terminalStatus === "running") {
    return {
      state: "connected",
      terminalStatus: "live",
      canSend: true,
      message: "Conductor 已连接；后续消息会继续当前原生 Session。",
    };
  }
  if (terminalStatus === "stopping") {
    return {
      state: "stopping",
      terminalStatus,
      canSend: false,
      message: "Conductor 终端正在停止；暂时不能发送消息。",
    };
  }
  if (["stopped", "achieved", "failed"].includes(String(runStatus))) {
    return {
      state: "closed",
      terminalStatus,
      canSend: false,
      message: "当前 Run 已结束；不能向历史 Conductor Session 发送消息。",
    };
  }
  return {
    state: "recovery_required",
    terminalStatus,
    canSend: true,
    message: "Conductor 暂未连接；发送消息会自动继续当前任务。",
  };
}

function isLiveConductorTerminal(terminal) {
  return String(terminal?.status ?? "") === "running";
}

module.exports = { isLiveConductorTerminal, projectConductorContinuity };
