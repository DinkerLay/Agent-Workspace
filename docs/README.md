# Agent Workspace 文档入口

状态：当前唯一文档入口
更新日期：2026-08-02

本项目当前只实现一种产品运行模式：**Agent Loop**。用户保存的是带版本的
Loop Template；Task 创建时复制该版本形成不可变 Task Architecture；每次
Start 创建新的 Task Run。Workflow、Graph、Template Blueprint、旧 TaskBoard
和 Nested Workflow Harness 都不是当前产品能力。

## 从这里开始

1. 先读 [`superworks/spec/spec_readme.md`](superworks/spec/spec_readme.md)：当前规范目录与优先级。
2. 涉及 Template、Task、Run 或状态时，读
   [`superworks/spec/task-template-runtime-model.md`](superworks/spec/task-template-runtime-model.md)。
3. 涉及代码位置或状态写入者时，读
   [`superworks/spec/code-ownership-and-layer-map.md`](superworks/spec/code-ownership-and-layer-map.md)。
4. 只从 [`superworks/plans/README.md`](superworks/plans/README.md) 选择当前执行计划。

随机打开一份 research、bug、archive 或旧 plan 不能用来判断当前产品行为。

## 当前对象和状态源

| 对象 / 事实 | 唯一 owner | 当前持久化 |
| --- | --- | --- |
| Template identity/version、Task、Task Architecture、Run、command/revision/outbox、布局 | Task/Template/Run service | `agent-loop-v1.sqlite` |
| Dispatch attempt、input receipt、wakeup、cancel receipt | Dispatch Coordinator | Task 项目下 `.agent-workspace/runtime/` |
| PTY identity、incarnation、liveness、transport receipt | Terminal Runtime | `terminal-runtime.sqlite`、Host 状态与原始诊断日志 |
| OpenCode session/message/turn、result、attention、failure | OpenCode Provider Adapter | Provider 原始数据库的只读事实与 Runtime 投影 |
| 选中项、弹窗、未保存表单和输入草稿 | Renderer | 仅 UI 状态 |

不同存储可以共同存在，但不能为同一个事实提供两个写入者。向上的 UI 数据必须
来自可重建的 typed read model，不能从 PTY 文本或页面缓存推断 Task 生命周期。

当前 `desktop/session-store.cjs` 仍是兼容期的共用物理容器，并不代表它拥有一个
通用 Session 状态。生产组合只传递 owner-scoped capabilities：Terminal 写
`terminalState`，Provider 写 `providerState`，Coordinator 写 Dispatch/Wakeup
记录，Task/Run service 通过 outbox 发布 Timeline 投影。旧 `recordState` 只允许
历史 Harness/fixture 兼容使用，不能出现在新的生产调用链中。

## Template 到 Task 的当前链路

```text
Template brief/manual edit
  -> unsaved Template Draft
  -> explicit Save
  -> immutable Loop Template Version
  -> Create Task snapshots exact version
  -> queued Task
  -> Start creates fresh Run + Conductor Session
  -> Coordinator / Terminal / Provider record their own facts
  -> pure TaskRunReadModel projects those typed owner facts for UI
  -> Conductor claims delivery_ready
  -> user may mark Task achieved
```

`achieved` 只能确认已经存在的 `delivery_ready`；Worker 完成、文件存在、PTY
退出或模型输出 “done” 都不能直接完成 Task。

当前 Runtime 负责收集各 owner 的事实，`TaskRunReadModel` 只做纯投影；读取 Run
不会再写入默认布局。Renderer 首次加载后通过命令返回值和语义 invalidation
刷新，不轮询 Task/Run，也不从 PTY 文本推断生命周期。

## 目录含义

- `superworks/spec/`：当前产品与架构规范。只有其 README 列出的文件具有当前权威性。
- `superworks/plans/`：当前可执行计划；完成、审计和废弃材料全部在 `archive/` 或 `deprecated/`。
- `superworks/design/`：入口说明；历史 mockup 全部在 `archive/`，不代表当前 UI。
- `research/`：外部事实和产品调研证据，不是当前产品规范。
- `bugs/`：问题记录和历史诊断，是否仍有效必须由当前计划或测试确认。
- `analysis/`：用户/任务生成的分析产物，不是项目架构依据。

运行时机器状态和任务产物不能写入本目录。运行时元数据写入 Task 项目的
`.agent-workspace/` 或规范指定的应用数据目录。
