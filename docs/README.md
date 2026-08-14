# Agent Workspace 文档

日期：2026-08-11

当前产品与实施只有两个权威：

1. [`architecture.md`](architecture.md)：产品、领域 owner、OR / Session Runtime、ACP、Host、Web/Desktop 与安全边界的唯一真相；
   其中 `4.0 ACP-first 原型差异决议`冻结版本解析、writer、Handoff、process粒度与role gate的规范解释。
2. [`implementation-plan.md`](implementation-plan.md)：唯一可执行的 ACP-first 直接切换计划；其中逐Phase代码迁移账本列出
   current anchors、新目标、首个RED、删除阶段与退出条件。

## 实施指导（非权威）

- [`chat-ui-interaction-guidelines.md`](chat-ui-interaction-guidelines.md)：以 Claudian 的 provider-neutral execution/chat
  分层为对照，约束 Meta、Conductor 与 Card Session 共用 Chat shell 时的流式、Thinking、Tool card、Final、停止、
  排队、Provider/Model/Effort 与恢复行为。它只解释如何实现 `architecture.md` 已冻结的统一 Chat，不改变领域 owner、
  Runtime 命令或安全边界。

## 当前方向

Agent Workspace 保留现有的多 Agent 工作台、Conductor 四工具、Task/Run、Slot/generation、Message/Inbox/Input/Turn、
Human priority、Meta、Files & Changes、Achieve、Browser/Electron 与统一 Runtime Host。Provider 执行边界改为：

```text
Workbench
  -> RuntimeClient / authenticated Runtime Bridge
  -> Orchestration Runtime（每个 TaskRun）
  -> Session Runtime（每个 materialized LogicalSession）
  -> ACP Client
  -> ACP Agent
  -> 当前安装的 OpenCode / Codex / Claude Agent runtime
```

正式 Task/Session Provider wire 只允许 ACP。OpenCode REST、Codex App Server、Claude stream-json 与 direct Meta
transport 已作为 superseded 迁移输入移除，不能作为生产 fallback、可选入口或 release 证据。Codex App Server 或
Claude Agent SDK 可以存在于独立 ACP wrapper 内部，但 Agent Workspace 不直接调用它们。

OpenCode 和 Codex 必须分别作为真实 ACP Task Profile 通过当前安装的 discovery、`initialize` 协商、managed lifecycle 与
所需 role capability 的 live qualification。一个 Provider 的 PASS 不能替另一个出证；“OpenCode Task + Codex
companion”也不再满足“双 Provider 已接通”的完成口径。Meta 使用相同 ACP Client 机械层，但必须是独立 Profile、
独立 process、独立 Session 与 no-tool/no-workspace 权限域。

## 版本与本机解析

Template、仓库配置和 UI 不锁 Provider 或 wrapper 版本，也不保存本机 path/hash。它们只冻结 portable Profile
requirement：Provider family、ACP protocol requirement、model/config intent、所需 capability/extension 与 permission policy。

Host 在每次新 Binding 或 Host generation 解析当前安装并生成私有 `LocalResolutionSeal`：

```text
canonical launcher identity + observed artifact/upstream version
+ digest/signature/trust state
+ negotiated ACP/capability/extension fingerprint
+ execution-config digest + observedAt
```

`ACPQualification` 还绑定该 seal、model、实际 behavior probe 与 Host process generation。version/hash/fingerprint
只用于本 generation / release 的 TOCTOU 与 drift fence；安装变化使旧 qualification 失效，但新版本完成重新发现与
qualification 后可以正常 available。不存在仓库 supported-version allowlist、按版本路由或未知新版本天然拒绝。

## 当前实现状态

Session-ID domain/application/Store、统一 Host/Bridge/Workbench/Desktop、四工具、Human priority、Meta/Task Setup、
Files & Changes、Task/Meta ACP composition、UI readiness 与 Host-private raw identity 隔离已经切到 ACP-only production
路径。OpenCode REST、Codex App Server、Claude stream、direct Meta adapters 及其 provider packages 已从 production/release
可达图物理移除；SQLite cutover seal 也禁止 superseded direct writers 在 seal 后继续写入。

Phase 8 fresh release 仍未完成：exact 28-cell matrix 与 cleanup-fenced semantic evidence 已冻结，但 parent 三路
zero-effect input seal、4+4+1 bounded production qualification、aggregate runner safety收口和唯一 fresh all-required run
仍在实施/验证。因此此前 direct-provider 的 native diagnostics、25-cell/26-cell matrix、OpenCode Task + Codex
companion observation 均不能产生最终 release 声明；当前不是 ACP native PASS，也不是 release-ready。

## 产品与安全不变量

- Conductor 仍是 Agent-to-Agent 内容路由的唯一业务决策者；公开工具仍恰好是 `invoke_agent`、
  `send_to_session`、`interrupt_session`、`close_session`。
- OR 持有 TaskRun 协作语义；Session Runtime 持有单 LogicalSession 的 Binding execution、delivery correlation、
  interaction fence、candidate/terminal pairing 与 reconcile。两者不共享 writer。
- Binding service 仍是 Binding/current-binding 的唯一 writer；只有 OR/Message service 能提交 canonical `agent_final`。
- raw ACP session/request/option/tool IDs、absolute path、credential 与 wire payload 只留在 Host / ACP Client 私有映射；
  Runtime domain、SQLite、ProviderFact、UI 与 evidence 只使用 Workspace 生成的 opaque ID 和脱敏 observation。
- Meta 是配置期 Draft assistant，不是 Task Session Runtime 或第二个 Conductor；它不能取得 Task Binding、Gateway、cwd、
  Workspace、Task transcript、Publish/Create/Start/Achieve 权限。
- Renderer 只渲染 typed read model 并提交 typed intent；Browser/Desktop Renderer 不接触 Provider process、ACP wire、
  Store、credential 或 unrestricted filesystem/PTY。
- Achieve 是独立用户命令，不由 Provider final/terminal、文件存在或 Conductor claim触发，也不自动 Stop。

## 操作说明与证据

[`../apps/runtime-host/PROVIDER_CONFIGURATION.md`](../apps/runtime-host/PROVIDER_CONFIGURATION.md)、
[`../tests/integration/README.md`](../tests/integration/README.md) 与
[`../tests/journeys/README.md`](../tests/journeys/README.md) 只是受上述两个权威约束的 ACP迁移/操作说明；它们不能
反向定义架构，也不能把尚未实现的配置、测试命令或native result描述为已经可用/PASS。

ACP release gate 必须在同一 source/build/policy bundle 中分别取得 OpenCode ACP Task、Codex ACP Task、独立 ACP Meta、
Browser、Electron、cross-surface、restart/reconcile 与 Host ledger 的实际证据。fake ACP Agent、`initialize` capability
声明、headless probe、direct native adapter PASS 或旧 bundle 都不能代证。缺当前安装、trusted wrapper、隔离 credential
或 required capability 时必须诚实 `BLOCKED_CAPABILITY`；绝不回退 direct transport。
