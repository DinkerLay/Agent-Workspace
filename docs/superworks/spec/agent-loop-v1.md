# Agent Loop v1: OpenCode Session Orchestration

日期：2026-08-05
状态：当前唯一产品模式

## 范围

Agent Workspace 是基于持久 OpenCode Session 的多 Agent 工作台。它只有 Agent Loop：
Conductor 读任务事实并决定是否派发任意 Agent Card；Runtime 不把 Template 编译成
Graph，也不规定 Searcher、Reviewer 或 Publisher 的固定顺序。

## Session Host

```text
Task / Run service
  -> shared OpenCode Server (one canonical project cwd)
  -> official OpenCode Web UI
  -> Conductor Session and dispatched Worker Sessions
```

- 一个项目目录复用一个 OpenCode Server，不为每个 Task 或 Run 常驻单独 Server。
- 每个 Task Run 仍拥有自己的逻辑 Conductor / Worker Session identity，不能跨 Task 复用。
- 官方 Web UI 是唯一的 Session 对话界面；Task 页面只管理选择、授权的 presentation
  lease 和 Workspace 的语义投影。
- 关闭页面释放 presentation lease，不等同于停止 Provider Session 或删除历史。

## 控制循环

```text
user input / worker result
  -> Conductor reads durable Task state
  -> Conductor may dispatch zero or more Cards
  -> Coordinator records dispatch and Provider facts
  -> meaningful fact wakes the same Conductor Session
  -> Conductor decides the next action or records delivery_ready
```

Conductor 是唯一拥有 Workspace MCP 的 Session。Worker 只获得本次 assignment 和自身
Card 的 Worker System Prompt；它们没有派发、停止 Task 或修改生命周期的能力。

## Template 和 Card

Template Draft 经用户显式保存后才成为不可变 Template Version。Task 创建时快照该版本。
每张 Card 有两种不同上下文：

- **Dispatch profile**：仅给 Conductor，用于判断何时、为何派发该 Card。
- **Worker system prompt**：仅在该 Card 首次物化为 Worker Provider Session 时注入。

模型、MCP、Skills 是 Provider 可用能力的约束或选择；它们不是额外的 Agent 类型，
也不能形成 Runtime 的固定编排。

## Task 与完成

Task、Run 和 Session 的状态与身份由
[`task-template-runtime-model.md`](task-template-runtime-model.md) 定义。特别是：

- `delivery_ready` 后，用户可在同一 Conductor Session 继续对话；
- `Achieve` 是用户接受当前交付，不是 Session 销毁；
- `拉回继续` 成功时接续同一 Task、同一 Run、同一 Conductor Provider Session；
- 用户显式基于历史新建另一个 Task 时，才创建新的 Task/Run/Session，即使项目目录相同；
- Stop 和彻底删除是不同的用户命令，不由 Conductor 推断或执行。

## 非范围

没有 PTY/Terminal 页面、Orca Runtime、Graph/Workflow、隐藏的 Publisher 路由、
Renderer 直连 OpenCode API、或按 Task 创建 OpenCode Server 的实现。
