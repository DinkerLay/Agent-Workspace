# Agent Workspace

Agent Workspace 是 local-first、有人监督、可恢复的多 Agent 工作台。不可变 Template Version 生成冻结的 Task
Architecture，统一 Runtime 协调 Task、Run、Card Session Slot / LogicalSession、Message / Inbox / Turn、
Files & Changes 与用户验收。

目标 Provider 边界是 ACP-first、production ACP-only：

```text
AgentLoop Renderer (Web / Electron)
  -> RuntimeClient (IPC or authenticated HTTP(S)/WS(S))
  -> Runtime Host
  -> Orchestration Runtime（per TaskRun）
  -> Session Runtime（per LogicalSession）
  -> ACP Client -> ACP Agent
  -> current installed OpenCode / Codex / Claude Agent runtime
```

Agent Workspace 不直接调用 OpenCode REST、Codex App Server、Claude stream-json 或 Provider SDK；这些细节只允许
存在于独立 ACP Agent/wrapper 内。当前代码仍处于 direct→ACP cutover：统一 Task/Run/UI kernel 可复用，但 ACP Client、
Profile resolution、raw-ID隔离、Task/Meta composition与新release matrix尚未全部落地。因此旧native diagnostics和
direct-provider release bundle不能作为当前完成证据。

Conductor公开编排面仍只有四个动作：`invoke_agent(agentCardId)`、`send_to_session(sessionId, payload)`、
`interrupt_session(sessionId)`、`close_session(sessionId)`。Meta是配置期Draft assistant；Achieve只能由用户显式
触发，且不自动Stop。

## Start

```bash
pnpm start       # Runtime Host + formal AgentLoop + Electron
pnpm start:web   # 同一 Runtime Host + formal AgentLoop browser surface
```

`./start.sh`、`npm start`和`pnpm start`在启动前都会按对应锁文件同步依赖：优先使用
`pnpm-lock.yaml`，没有 pnpm 时使用 `package-lock.json`。首次启动或拉取更新后的首次启动需要网络下载依赖；同步失败时不会启动
旧的 Runtime Host 代码。切换完成前，正式入口仍可能在Host内发现旧direct composition；这不代表
ACP Provider已接通。不得为绕过ACP capability缺失恢复fallback或第二套UI。

## Provider与版本原则

OpenCode和Codex必须分别作为真实ACP Task Profile通过当前安装的discovery、`initialize`协商、managed lifecycle与所需
role capability的live qualification。一个Provider不能替另一个出证；“OpenCode Task + Codex companion”不再满足
双Provider完成口径。Meta使用独立ACP Profile/process/no-tool权限域。

Template/Profile只保存portable requirement：Provider family、ACP Agent kind、protocol major、model/config intent、
required capabilities与permission policy。Host每个Binding/generation解析当前安装并生成`LocalResolutionSeal`与
process-local `ACPQualification`。observed version/hash/fingerprint只用于本次运行的drift fence，不是仓库allowlist；
安装更新后重新discovery/qualification即可重新available。

raw ACP session/request/option/tool ID、absolute cwd、credential与wire payload只留在Host-private map。Domain、SQLite、
ProviderFact、UI和evidence只使用Workspace opaque ID与脱敏observation。

## Source of truth

- [Architecture](docs/architecture.md)：唯一产品、owner、OR/SR、ACP、Host、Web/Desktop与验证真相；Section 4.0记录
  ACP-first原型差异决议。
- [Implementation plan](docs/implementation-plan.md)：唯一ACP cutover执行计划、当前phase与逐Phase代码迁移账本。
- [Documentation entry point](docs/README.md)：文档边界与当前实现状态。

操作说明受上述权威约束：

- [Runtime Host Provider configuration](apps/runtime-host/PROVIDER_CONFIGURATION.md)
- [Integration evidence](tests/integration/README.md)
- [Actual-operation journeys](tests/journeys/README.md)

## Layout

```text
apps/
  workbench/       formal AgentLoop Web/Electron Renderer
  desktop/         Electron main/preload/Host supervisor
  runtime-host/    Host composition, SQLite, ACP resolution/process/auth
packages/
  runtime-contracts/ runtime-client/ runtime-domain/ runtime-application/
  runtime-store/ provider-port/ provider-acp/ conductor-tools/ workbench-ui/ test-kit/
tests/
  contracts/ integration/ e2e/ journeys/
```

`provider-acp/`是计划中的唯一production Provider实现；在相应phase落地前该路径可以尚不存在。现有
`provider-opencode`、`provider-codex`、`provider-claude-code`与Host direct bridges是atomic cutover后的删除目标，
不是并存架构。

## Verify

文档/静态阶段可运行：

```bash
npm run typecheck
npm run test:vitest
npm run test:desktop
npm run test:integration
npm run test:e2e
npm run test:formal-dev-launcher
npm run verify:session-id-cutover
git diff --check
```

`npm run verify:release`仍是未来唯一aggregate release claim，但在ACP-only production graph、OpenCode ACP、Codex ACP、
独立ACP Meta和fresh matrix完成前必须fail closed，不能运行旧direct native cell得到exit 0。新matrix的cell数在实现时
重新冻结，不继承旧26；缺当前wrapper/credential/capability时退出`2 / BLOCKED_CAPABILITY`，assertion失败退出1，
只有同一次fresh ACP bundle全部required PASS才退出0。

Runtime machine data位于`.agent-workspace-v2/`且被Git忽略。没有单独、path-specific恢复决定时，不得删除它、Provider
state、credential或Workspace文件。
