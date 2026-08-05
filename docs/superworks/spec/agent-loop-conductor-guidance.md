# Agent Loop Conductor Guidance: onlyopencode

日期：2026-08-05
状态：当前 Conductor 与 Card 语义

## Conductor 的职责

Conductor 是 Task owner。它读取持久 Task 状态和已返回结果，决定是否派发、纠正、
复核、交付或向用户提问。它不创建 Task/Run、改写生命周期、停止 Session、选择新
Provider 或把 Card 变成固定工作流。

```text
user input / Provider result
  -> Conductor reads Task state
  -> zero or more scoped dispatch decisions
  -> Coordinator records receipt/result
  -> Conductor receives the next durable fact
```

没有“必须先 Searcher、再 Reviewer、最后 Publisher”的隐藏路线。Card 是可用能力，
不是 Runtime 的步骤或完成门槛。

## Conductor 可见的上下文

Conductor 在每次决策可读取：

- Task title、goal、cwd、不可变 Template Version 与 Conductor Charter；
- 每张 Card 的 `agentId`、显示名、模型和 **Dispatch profile**；
- 当前 Run 的 Dispatch、Provider result、artifact reference、用户输入和取消事实；
- 明确引用的其他 Session 结果。

它不接收 Worker 的隐藏 system prompt、Provider 凭据、通用文件系统权限或任意其他
Task 的 Session。

## Worker Card

首次派发某 Card 时，Runtime 为当前 Task Run 创建/绑定它的 Worker Provider Session，
并注入该 Card 的 Worker system prompt。后续同一 Run 对该 Card 的 assignment 复用同一
Session。不同 Task 或不同 Run 不复用该 Session。

每个 assignment 必须记录 `dispatchId`、目标 `agentId`、具体输入、输入回执、Provider
result 或失败事实。Worker 不具有 Agent Workspace MCP，不能自己派发其他 Card。

## 用户消息与完成

用户对 Conductor 的消息是 Task input，不是对 Worker 的隐式改写。`delivery_ready` 后
的消息继续原 Conductor Session；Achieve、拉回继续、新建 Task 与删除的身份规则只以
`task-template-runtime-model.md` 为准，Conductor 只在 Task/Run service 完成合法状态迁移
后收到新的输入。

若 Conductor 决定让 Publisher 交付，必须通过 Publisher dispatch 获得 artifact 结果。
若不使用 Publisher，它应在可见结果中说明原因；Runtime 不可替它选择路线。

## Meta Agent 边界

Template Meta Agent 是独立的 Template Design Session。它只能读取/修改一个 Draft，
以 Patch 提议整体 Template、Conductor 或 `@card-id` Card 的修改；它不能保存 Version、
创建 Task、启动 Run 或派发 Worker。保存永远由用户触发。
