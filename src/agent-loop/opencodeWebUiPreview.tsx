import { useEffect, useState } from "react";
import {
  openNativeAgentLoopOpenCodeSessionPage,
  releaseNativeAgentLoopOpenCodeSessionPage,
  type NativeOpenCodeSessionPage,
} from "../runtime/nativeBridge";

type PageState =
  | { state: "loading" }
  | { state: "ready"; page: NativeOpenCodeSessionPage }
  | { state: "error"; message: string };

/**
 * The Workbench receives an exact, Host-resolved page handle for a persisted
 * Provider binding. It neither knows OpenCode's route grammar nor talks to the
 * OpenCode Server API directly.
 */
export function OpenCodeSessionPage({
  runId,
  sessionId,
  sessionName,
  presentationEpoch,
}: {
  runId: string;
  sessionId: string;
  sessionName: string;
  presentationEpoch: string;
}) {
  const [state, setState] = useState<PageState>({ state: "loading" });

  useEffect(() => {
    let active = true;
    let presentationLeaseId: string | undefined;
    setState({ state: "loading" });
    void openNativeAgentLoopOpenCodeSessionPage({ runId, sessionId })
      .then((page) => {
        if (!active) {
          if (page?.presentationLeaseId) {
            void releaseNativeAgentLoopOpenCodeSessionPage({ runId, sessionId, leaseId: page.presentationLeaseId });
          }
          return;
        }
        presentationLeaseId = page?.presentationLeaseId;
        setState({
          state: "ready",
          page: page ?? { presentation: "unavailable", reason: "opencode_session_page_not_supported" },
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState({ state: "error", message: reason instanceof Error ? reason.message : "无法读取 OpenCode Session 页面。" });
      });
    return () => {
      active = false;
      if (presentationLeaseId) {
        void releaseNativeAgentLoopOpenCodeSessionPage({ runId, sessionId, leaseId: presentationLeaseId });
      }
    };
  }, [presentationEpoch, runId, sessionId]);

  if (state.state === "loading") {
    return <div className="agent-loop-opencode-page-state"><strong>正在连接 OpenCode Session…</strong></div>;
  }
  if (state.state === "error") {
    return <div className="agent-loop-opencode-page-state"><strong>无法打开 OpenCode Session</strong><span>{state.message}</span></div>;
  }
  if (state.page.presentation !== "direct_url" || !state.page.url) {
    return <div className="agent-loop-opencode-page-state"><strong>此 Session 尚无可打开的 OpenCode 页面</strong><span>{pageUnavailableMessage(state.page.reason)}</span></div>;
  }
  return <div className="agent-loop-opencode-web-ui" data-opencode-session-page={state.page.providerSessionId ?? sessionId}>
    <iframe title={`${sessionName} OpenCode Web UI`} src={state.page.url} />
  </div>;
}

function pageUnavailableMessage(reason?: string) {
  if (reason === "provider_session_not_bound") return "等待 OpenCode Server 为这个 Task Session 记录 providerSessionId。旧 PTY 历史不会被冒充成新的 Provider Session。";
  if (reason === "provider_session_missing") return "保存的 OpenCode Session 已不存在。Runtime 已阻止创建替代 Session，请从 Task 恢复流程处理。";
  if (reason === "provider_session_reconcile_unavailable") return "Runtime 暂时无法校验保存的 OpenCode Session；不会猜测或创建替代 Session。";
  if (reason === "opencode_server_unavailable") return "OpenCode Server 当前不可用；不会退回到终端界面。";
  if (reason === "opencode_server_version_mismatch" || reason === "opencode_openapi_schema_mismatch") return "本机 OpenCode 版本与已验证的 Session 页面能力不匹配。";
  return "Runtime 尚未提供这个 Provider Session 的官方页面句柄。";
}
