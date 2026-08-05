# Code Ownership and Layer Map: onlyopencode

日期：2026-08-05
状态：当前维护边界

```text
Renderer
  -> typed Runtime bridge
  -> Electron IPC / local host adapter
  -> Task/Template/Run service
  -> Dispatch Coordinator
  -> OpenCode Server host + Provider Adapter

official OpenCode Web UI
  -> scoped presentation gateway
  -> exact Task/Run/Conductor Provider Session binding
```

| Owner | 负责 | 不负责 |
| --- | --- | --- |
| Renderer | 页面、选择、弹窗、未保存输入、typed command | 文件系统、Provider API、生命周期判断 |
| Native bridge / IPC | 窄类型接口与进程装配 | 业务状态或路由 |
| Task/Template/Run service | Version、Task Architecture、Task/Run 生命周期、revision、outbox | 派发业务路线、解析 Provider 内容 |
| Dispatch Coordinator | dispatch、输入回执、wakeup、取消事实 | Task 完成、重试路线、交付质量 |
| OpenCode Server host | 按 cwd 复用 Server、Provider Session 与官方 Web UI 可用性 | Task 生命周期或跨 Task Session 复用 |
| Provider Adapter | Provider message/result/attention 的只读事实投影 | 发起 Task 命令或决定下一张 Card |
| Presentation gateway | 精确 lease、cwd 与 Provider Session 校验，转发官方页面请求 | 创建 Task/Run/Session 或绕过生命周期 preflight |
| Conductor MCP bridge | 将受限 Conductor 意图提交给 Coordinator | 原始 Provider 访问、生命周期写入 |

## 代码落点

- `src/agent-loop/`：Templates、Tasks、Task Session 页面与纯展示逻辑。
- `src/runtime/nativeBridge.ts`：Renderer 可用的 typed contract。
- `desktop/main.cjs`、`desktop/preload.cjs`：IPC 组合与能力暴露。
- `desktop/runtime/`：Template/Task/Run、Dispatch、读模型与状态迁移 owner。
- `desktop/opencode/`：OpenCode Server、Provider facts、presentation gateway。
- `desktop/conductor-*`：Conductor MCP schema 与 scoped bridge。

每个跨层命令必须先写入 owner 的 durable intent，携带稳定 `commandId` 和
`expectedRevision`；外部副作用失败时保留可恢复事实。任何 read model 不能启动
Session、修复状态、保存默认值或发送 Provider 输入。

当实现 Achieve 拉回、删除、Meta Agent 或目录创建时，先确认唯一 writer，再改 UI。
不允许在 `AgentLoopApp.tsx`、`main.cjs`、Gateway 或 Provider Adapter 中偷偷写另一套
Task 状态。
