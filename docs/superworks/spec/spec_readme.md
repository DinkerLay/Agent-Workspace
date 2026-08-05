# Superworks Spec README

日期：2026-08-05
状态：onlyopencode 当前规范索引

除下表所列文件外，`spec/archive/` 中的内容均为历史证据。当前产品不包含 Orca、PTY
终端、Workflow/Graph、Browser Runtime Bridge 或自定义聊天运行时。

## 当前权威

| 规范 | 负责范围 |
| --- | --- |
| `agent-loop-v1.md` | 唯一产品模式、OpenCode Server/Web UI Session Host、Conductor 与 Session Agent 边界 |
| `task-template-runtime-model.md` | Draft/Version/Task/Run/Session 数据模型与生命周期，包括 Achieve 后拉回继续 |
| `agent-loop-conductor-guidance.md` | Conductor Charter、Card 语义、用户消息与无隐藏编排规则 |
| `product-interaction-map.md` | Templates、Tasks、Task Session 页面与 artifact 的可见交互 |
| `code-ownership-and-layer-map.md` | Renderer、IPC、Task/Run service、Gateway、Provider 的代码所有权与单向依赖 |
| `development-instrumentation.md` | 语义事实、证据、脱敏与真实浏览器 E2E 记录 |

## 不可变边界

- Agent Loop 是唯一当前模式；不存在 Graph、Workflow、固定角色顺序或 Runtime 隐藏路由。
- 一个规范化项目目录共享一个 OpenCode Server；Task/Run/Session identity 仍相互隔离。
- 官方 OpenCode Web UI 是唯一 Session 对话页；Renderer 不伪造 Provider 对话。
- Conductor 是唯一 Workspace 派发者；Worker 没有 Workspace 控制面 MCP。
- Runtime 记录命令、Provider 事实和投影，不决定下一张 Card、交付质量或业务路线。
- 生命周期的唯一详细定义是 `task-template-runtime-model.md`；其他规范和计划只能引用它。

## 修改路由

1. Template、Task、Run、Session、Achieve、删除或状态迁移：`task-template-runtime-model.md`。
2. Conductor Charter、Card 注入、Meta Agent 或派发上下文：`agent-loop-conductor-guidance.md`。
3. 页面入口、对话、Task Session 目录、artifact 或布局：`product-interaction-map.md`。
4. owner、IPC、Gateway 或模块位置：`code-ownership-and-layer-map.md`。
5. 证据、日志、真实浏览器验收：`development-instrumentation.md` 与当前 E2E 计划。

历史资料已按来源移动到 `archive/`。它们不覆盖本目录中的任何定义。
