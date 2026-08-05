# Development Instrumentation and E2E Evidence: onlyopencode

日期：2026-08-05
状态：当前诊断与验收规则

## 记录什么

| 事实 | 记录者 |
| --- | --- |
| Task/Run 命令、revision、状态迁移 | Task/Run service |
| dispatch、输入回执、wakeup、取消 | Dispatch Coordinator |
| Provider Session、message、result、attention | Provider Adapter 投影 |
| presentation lease 与 Gateway 拒绝原因 | Gateway（不含凭据） |
| artifact 路径与 owner chain | Runtime artifact index |

Timeline 只展示语义事实与用户可见的 Conductor 结果，不存 Provider 凭据、完整隐藏
prompt 或无界原始输出。所有事件带 Task/Run identity、时间、actor 和可追溯引用。

## 真实浏览器 E2E

浏览器验收以
[`../plans/opencode-server-webui-browser-e2e-v1.plan.md`](../plans/opencode-server-webui-browser-e2e-v1.plan.md)
为准：必须通过当前产品的官方 OpenCode Web UI 完成真实 Template、Task、Conductor
对话、Worker dispatch、交付和生命周期操作。

每个案例将截图、console/network、状态快照、artifact 和 `result.md` 写到
`/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/<case-id>/`；文档和代码只留在
仓库。页面截图、mock、手工 API 请求或模型一句“done”均不能单独证明通过。

失败记录至少包含：案例目录、产品/OpenCode 版本、Template Version、Task/Run/Provider
Session identity、用户浏览器步骤、实际错误、状态快照和是否存在受管 artifact。不得把
测试项目或真实产物写入仓库根目录。
