# Task, Template, And Runtime Model: onlyopencode

日期：2026-08-05
状态：当前数据与生命周期来源

本文件是 Template、Task、Run、Session 和生命周期的唯一详细定义。页面、Gateway
和测试计划只能引用它，不能各自创造另一套状态规则。

## 持久对象

| 对象 | 含义 | Owner |
| --- | --- | --- |
| Template Design Draft | 可连续修改、尚未复用的模板草案 | Template Design service |
| Template Design Session | 专用于一个 Draft 的 Meta Agent OpenCode Session | Template Design service + OpenCode Server |
| Loop Template / Version | 稳定 identity 与不可变版本 | Template store |
| Task Architecture | Task 对已保存 Version、用户目标和项目目录的快照 | Task store |
| Task | 用户可见的工作项和生命周期 owner | Task store |
| Task Run | 一次明确开始的 Task 执行身份 | Task/Run service |
| Session binding | Task Run 中逻辑 Conductor/Worker 与 Provider Session 的绑定 | Runtime projection |
| Dispatch | Conductor 的一次 Card assignment 及其回执 | Dispatch Coordinator |
| Artifact reference | 已验证、可追溯的项目内交付物 | Runtime index |

Draft 和 Template Design Session 不能创建 Task、Run、Dispatch 或 artifact。只有用户
显式保存 Draft，才产生新的不可变 Version。

## Template、Card 与上下文注入

每个 Card 保存两份不同内容：

| 内容 | 注入对象 | 时机 |
| --- | --- | --- |
| Dispatch profile | Conductor | Task Architecture 被读取、Conductor 作派发决定时 |
| Worker system prompt | 该 Card 的 Worker Provider Session | 此 Card 首次在某个 Task Run 被实际派发时 |

Conductor Charter 与用户 Task 目标作为 Conductor 的任务上下文。Conductor 能看见 Card
的 Dispatch profile，不能把 Worker system prompt 当作派发说明改写。每次 dispatch 的
具体 assignment、输入和验收标准由 Conductor 决定。模型、MCP、Skills 是 Provider
配置，不构成新的 Agent 类型或固定编排。

## 创建 Task

```text
saved Template Version + title + goal + explicit writable project cwd
  -> Task Architecture snapshot
  -> queued Task
  -> user Start
  -> fresh Task Run + Conductor Provider Session binding
```

项目目录是用户明确选择或通过受控“新建文件夹”命令创建的 cwd；不得默认为 Agent
Workspace 仓库。不同 Task 可以选择同一 cwd，但 Task identity 不同就必须有不同的
Run、Session binding、Dispatch 和 artifact 索引。

## 生命周期

| 用户动作 / 条件 | 正确结果 |
| --- | --- |
| Start queued Task | 创建该 Task 的新 Run 与新的 Conductor Provider Session。 |
| delivery_ready 后发送消息 | 同一 Task、同一 Run、同一 Conductor Provider Session 继续。 |
| Achieve | 记录用户接受当前交付；Task/Run 与 Conductor Session binding 保留，不停止 Server。 |
| 拉回继续 | 用户明确操作后，Runtime 先验证原 Provider Session 可恢复；成功则 `Task achieved → running`、`Run achieved → running`，所有 identity 不变。 |
| 原 Session 不可恢复 | 保持原 Task/Run 为历史；不自动创建 Run 或伪造新会话。用户可显式“基于历史新建 Task”。 |
| 基于历史新建 Task | 创建新的 Task ID，再 Start 创建新的 Run/Conductor Session；即使 cwd 相同也不复用旧身份。 |
| Stop 后 Restart | Stop 结束当前 Run；Restart 创建新 Run，不恢复旧 Provider Session。 |

`Achieve` 不是删除，也不是资源泄漏：闲置页面 lease 可释放，Provider Session binding
作为历史身份保留；共享 OpenCode Server 按 cwd 管理，不按 Task 常驻进程。

## 删除

回收与彻底删除是待实施的两步产品能力：

1. **移入回收站**：从普通列表隐藏，但保留 Task、Run、Session binding、历史和受管
   artifact；放回后仍是同一 Task。
2. **彻底删除**：仅在回收站中明确确认；清理 Task、Run、Session binding、presentation
   lease、Runtime 数据与用户选择删除的受管 artifact。

无论哪一步，均不得隐式删除用户项目目录中的未受管文件。永久删除后不得再“拉回”
原 Session。

## 交付与状态写入

Conductor 可以决定是否派发 Publisher/Reviewer，但如果 Template 已声明 Publisher 为
最终交付 owner，artifact 必须可追溯为 `artifact → Dispatch → Card → Provider Session`。
Conductor 不得把自己写出的文件伪装成 Publisher 交付。

Task/Run service 是生命周期的唯一 writer；Coordinator 写 Dispatch/Wakeup，Provider
Adapter 投影 Provider 事实，Gateway 只校验已授权的 presentation lease。Renderer 只保留
视图状态并提交携带 `commandId` 与 `expectedRevision` 的 typed command。
