# Agent Workspace

Agent Workspace 是 local-first、有人监督、可恢复的多 Agent 工作台。它不是任何一个 CLI 的
Web UI：不可变 Template Version 生成冻结的 Task Architecture，统一 Runtime 再协调 Task、Run、
Logical Session、Provider Binding、输入、Invocation、事实、产物与用户验收。

```text
AgentLoop Renderer (Web / Electron)
  -> RuntimeClient (IPC or authenticated HTTP/WSS)
  -> Runtime Host (SQLite, lifecycle, outbox, artifact service)
  -> ProviderPort -> OpenCode | Codex | Claude Code
```

当前权威产品目标是 Runtime-backed AgentLoop：任务三栏、Task Setup、Task-local Session Tabs、统一 Chat、
Session Presentation、Timeline、Template Studio、配置期 Meta Agent、已完成与回收站。用户可明确向 Card
发送内容；Runtime 记录 HumanIntervention、全文同步给 Conductor，busy Card 只允许 interrupt-then-send。
它不嵌入 OpenCode WebUI，不直接调用 Provider，不持有 PTY、SQLite、本地文件系统、Provider credential
或原生 Session identity。

## Start

```bash
pnpm start       # Runtime Host + formal AgentLoop + Electron
pnpm start:web   # 同一 Runtime Host + formal AgentLoop browser surface
```

`./start.sh` 和 `npm start` 与 `pnpm start` 相同。正式 Browser surface 默认使用
`http://127.0.0.1:5188`；若端口已被占用，启动器会选择下一个可用端口并打印地址。

Provider 只在 Host 注册，并必须匹配固定版本、protocol fingerprint 与已验证 capability。当前只有
锁定的 Codex App Server 完成 managed-core native lifecycle evidence；OpenCode/Claude Code Profile
可编辑、导入和分享，但 Host 会拒绝启动未证明核心 Stop/recovery 语义的 Profile。

## Source of truth

- [Architecture](docs/architecture.md)：唯一产品、状态、目录、Provider、Web/Desktop 边界与测试真相。
- [Implementation plan](docs/implementation-plan.md)：唯一可执行计划与剩余 gate。
- [Documentation entry point](docs/README.md)：当前文档与 VCS 历史边界。

历史设计、旧 OpenCode-only lifecycle、旧 PTY/Orca shell、旧 WebUI 和 mockup 已从 working tree 移除；
需要历史证据时只从 VCS 恢复，不能重新作为 compatibility 输入。

## Layout

```text
apps/
  workbench/       formal AgentLoop Web/Electron Renderer
  desktop/         Electron main/preload/Host supervisor
  runtime-host/    Host composition, SQLite, auth, Provider registration
packages/
  runtime-contracts/ runtime-client/ runtime-domain/ runtime-application/
  runtime-store/ provider-port/ provider-opencode/ provider-codex/
  provider-claude-code/ conductor-tools/ workbench-ui/ test-kit/
tests/
  contracts/ integration/ e2e/
```

Templates live in Runtime SQLite as Draft, immutable Version and archive metadata. Explicit
`.agent-template.yaml` / `.agent-template.zip` files are one-way import/export packages for sharing,
not a watched second writer. The Template Studio lets a user manually edit each execution profile's
Provider, model, pin, permission mode and capability policy before publishing a new immutable Version.

## Verify

```bash
npm run typecheck
npm test
npm run test:contracts
npm run test:integration
npm run test:e2e
npm run verify
```

Runtime machine data is in `.agent-workspace-v2/` and ignored by Git. Do not delete it, Provider
state, credentials or workspace files without a separate path-specific recovery decision.
