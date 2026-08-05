import { useEffect, useState } from "react";
import {
  openNativeAgentLoopTemplateDesignSessionPage,
  releaseNativeAgentLoopTemplateDesignSessionPage,
  type NativeOpenCodeSessionPage,
} from "../runtime/nativeBridge";

type PageState =
  | { state: "loading" }
  | { state: "ready"; page: NativeOpenCodeSessionPage }
  | { state: "error"; message: string };

/**
 * The Template Meta Agent is a real, persistent OpenCode Provider Session.
 * This shell obtains the Host-resolved page handle and never tries to mimic
 * OpenCode's composer, parse its DOM, or construct a provider URL itself.
 */
export function TemplateDesignWebUiPreview({
  draftId,
  templateName,
}: {
  draftId: string;
  templateName: string;
}) {
  const [state, setState] = useState<PageState>({ state: "loading" });

  useEffect(() => {
    let active = true;
    let presentationLeaseId: string | undefined;
    setState({ state: "loading" });
    void openNativeAgentLoopTemplateDesignSessionPage({ draftId })
      .then((page) => {
        if (!active) {
          if (page?.presentationLeaseId) {
            void releaseNativeAgentLoopTemplateDesignSessionPage({ draftId, leaseId: page.presentationLeaseId });
          }
          return;
        }
        presentationLeaseId = page?.presentationLeaseId;
        setState({
          state: "ready",
          page: page ?? { presentation: "unavailable", reason: "template_design_session_page_not_supported" },
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState({ state: "error", message: reason instanceof Error ? reason.message : "无法读取 Template Meta Agent 页面。" });
      });
    return () => {
      active = false;
      if (presentationLeaseId) {
        void releaseNativeAgentLoopTemplateDesignSessionPage({ draftId, leaseId: presentationLeaseId });
      }
    };
  }, [draftId]);

  if (state.state === "loading") {
    return <div className="agent-loop-opencode-page-state"><strong>正在连接 Template Meta Agent…</strong></div>;
  }
  if (state.state === "error") {
    return <div className="agent-loop-opencode-page-state"><strong>无法打开 Template Meta Agent</strong><span>{state.message}</span></div>;
  }
  if (state.page.presentation !== "direct_url" || !state.page.url) {
    return <div className="agent-loop-opencode-page-state"><strong>此 Template Draft 暂无可打开的 OpenCode 页面</strong><span>{pageUnavailableMessage(state.page.reason)}</span></div>;
  }
  return <div className="agent-loop-template-design-web-ui" data-template-design-page={state.page.providerSessionId ?? draftId}>
    <iframe title={`${templateName} Template Meta Agent OpenCode Web UI`} src={state.page.url} />
  </div>;
}

function pageUnavailableMessage(reason?: string) {
  if (reason === "template_design_draft_not_active") return "这个历史 Draft 已关闭。请从当前 Template 打开一个新的可编辑 AI 修订 Draft。";
  if (reason === "template_design_provider_session_missing") return "Template Draft 尚未绑定 OpenCode Session；Runtime 不会创建替代页面。";
  if (reason === "template_design_provider_session_unavailable") return "保存的 OpenCode Session 当前不可用；Runtime 不会猜测或替代它。";
  if (reason === "opencode_server_unavailable") return "OpenCode Server 当前不可用；不会退回到一个模拟对话框。";
  if (reason === "opencode_server_version_mismatch" || reason === "opencode_openapi_schema_mismatch") return "本机 OpenCode 版本与已验证的 Template Design 页面能力不匹配。";
  return "Runtime 尚未提供这个 Template Design Session 的官方页面句柄。";
}
