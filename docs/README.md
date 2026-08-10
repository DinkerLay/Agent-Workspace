# Agent Workspace 文档

日期：2026-08-09

当前产品/实现决策只有两个权威：

1. [`architecture.md`](architecture.md)：产品、Runtime、Provider、Web/Desktop、目录、状态与验证的唯一真相。
2. [`implementation-plan.md`](implementation-plan.md)：唯一可执行的直接重构计划。

**当前默认产品入口：** `start.sh`、`pnpm start` 或 `npm start` → 一个认证的
`apps/runtime-host`、`apps/workbench` 的正式 AgentLoop Renderer 与 `apps/desktop` Electron shell。
`pnpm start:web` 启动同一 Renderer 与 Host 的浏览器开发面。不存在根 `src/`、根 `desktop/`、旧 Vite
或 OpenCode WebUI fallback。

产品交互仍是 AgentLoop：任务三栏、Task Setup、Task-local Session Tabs、统一 Chat、Session Presentation、
Timeline、Template Studio、配置期 Meta Agent、已完成和回收站。所有用户动作经 `RuntimeClient` 到统一
Runtime，Provider 仅存在于 Host 的 `ProviderPort` 后面。协作 Message 与只给人看的 Provider 活动是两层
不同投影，Renderer 不是任一领域事实的 writer。

**消息主权：** 对 Agent ↔ Agent 协作，Conductor 是唯一跨 Session 转递决策者。每个非 Conductor Session
Agent 的完整 final 都由 Runtime 可靠投到 Conductor；Agent 可在
final 中附带零到多个 `relay` 候选片段。只有 Conductor 明确选择转发完整 Message、某个 RelayBlock 或显式
publish 给多个目标后，其他 Agent 才会收到内容。不存在 Shared Relay Space、`read_shared_relays` 或 Agent
之间的直接 Provider 调用。

**用户优先：** 用户可明确向某张 Card 发送内容；Runtime 以 `HumanIntervention` 记录认证来源，把全文与目标
归因透明同步给 Conductor，但不广播 sibling。Card busy 时不排队，只能在 scoped interrupt 确认后发送。
内部 `WakeConductor` 只是由 durable Inbox 派生的调度信号，不恢复旧 Wakeup record。

[`archive/README.md`](archive/README.md) 只记录历史材料已从工作树移除这一事实；当前 checkout
不保留复制的旧规范、研究、设计或计划。需要恢复某一历史版本时使用 VCS，而不是重新把 archive
变成第二份产品真相或兼容输入。

[`../apps/runtime-host/PROVIDER_CONFIGURATION.md`](../apps/runtime-host/PROVIDER_CONFIGURATION.md)
和 [`../tests/integration/README.md`](../tests/integration/README.md) 是由上述两份权威文档约束的
操作说明：它们可以给出命令、版本 pin 与当前 probe 结果，但不得另行定义产品架构或 Provider
能力。任何能力是否可用于受管 Template，以 `architecture.md` 的 managed-core 规则和其中的
证据矩阵为准。
