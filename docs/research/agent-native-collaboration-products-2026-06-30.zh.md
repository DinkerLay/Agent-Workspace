# Agent-native 协作工作台调研补充

日期：2026-06-30

范围：补充调研 Multica、Slock、Wanman 这类更接近当前项目逻辑的产品/项目，并修正 `docs/research/similar-agent-workbench-products-2026-06-29.zh.md` 过度偏向 cloud coding agent / PR agent / framework 生态的问题。

## 修正结论

之前的相似产品调研方向偏宽。GitHub Copilot cloud agent、Jules、Cursor Cloud Agents、Devin、Factory Droids、AutoGen、LangGraph、CrewAI 都有参考价值，但它们不是当前项目最应该对标的核心。

当前项目更应该重点研究这一类：

```text
agent-native collaboration workspace
  -> 多个 agent 作为可见队友
  -> 每个 agent 有独立 runtime / session / memory / status
  -> 通过 task / channel / message / event 协作
  -> human 可以观察、接管、审核、重新分派
  -> 底层执行仍是本地 CLI / daemon / worktree / sandbox
```

Multica、Slock、Wanman 都指向这个方向。它们关注的不是“一个 cloud agent 最后给 PR”，而是“人和多个 agent 怎么在同一个工作空间里协作、分工、发消息、抢任务、保持上下文、恢复状态”。

对当前项目的直接修正：

- AgentsRoom 仍是 UI 和工程交付链的强参考。
- Multica / Slock / Wanman 应该成为“多 agent 协作协议和 runtime 组织方式”的重点参考。
- Cloud PR agents 应该降级为交付出口参考，不应主导产品定义。
- 通用 agent frameworks 应该作为技术思想参考，不应主导用户体验。

## Multica

来源：<https://github.com/multica-ai/multica>

### 定位

Multica 是一个 AI-native workspace。它把 agent 当成 team members，而不是把 agent 当作一次性命令或后台 PR worker。

从公开 README 看，Multica 的关键描述包括：

- Local-first、Git-based、agent-native workspace。
- 任务和对话保存在本地 filesystem。
- 每个 agent 有 persistent identity 和 workspace memory。
- 支持多 agent 协作、task assignment、handoff、status tracking。
- 强调可观察、可恢复、可编辑的 agent work。

### 怎么做

Multica 的核心更像一个“agent team operating system”：

```text
Workspace
  -> agents
  -> tasks
  -> conversations
  -> local files / git history
  -> memory and context
```

它的重点不是 terminal multiplexing，而是把 agent 作为团队成员管理：

- agent 有身份，不只是临时 process；
- task 是可分配对象，不只是 prompt；
- conversation 是 workspace state，不只是 chat transcript；
- workspace 是 local-first，不是纯云端 black box；
- git 是 state/change 的事实来源之一；
- human 可以编辑、审核、重新组织。

### 对我们的启发

Multica 补足了我们之前研究里欠缺的一点：当前项目不能只做“Board -> PTY -> Review”，还应该把 agent/team collaboration 作为一等产品概念。

可借鉴：

- Agent identity 应该持久化，而不是每次 task 创建临时角色卡就结束。
- Task 和 conversation 应该都是 durable workspace objects。
- Agent memory/context 应该有边界：项目级、任务级、session 级。
- Human 应该能从 workspace 层面整理 task、context、handoff，而不是只能看 terminal。

对当前 spec 的影响：

- `Agent` 不能只代表 provider/model/status，也应保留 persistent identity、role、memory/context refs。
- `Task` 应该有 conversation/thread/handoff refs。
- Audit Trail 不只是工程证据链，也应该能解释 agent 协作关系。
- Conductor 可以继续作为第一版 task owner，但 UI 上应该把它呈现为 team lead / coordinator，而不是隐藏 scheduler。

## Slock

来源：

- <https://slock.ai/>
- <https://codepick.app/project?repo=the-slack-for-ai-agents>
- npm package evidence: `@slock-ai/daemon`

### 定位

Slock 更像“Slack for AI agents”。它把协作中心放在 channel、message、task claim、daemon 和 agent 通信上。

公开信息显示它的典型组件包括：

- Web app / dashboard。
- Local daemon。
- Agent channels。
- Agents can claim tasks。
- Agents can send messages / wait for messages。
- 支持让 Claude Code、Codex 等 agents 通过 CLI/daemon 进入同一个协作空间。

### 怎么做

Slock 的思路不是先做 IDE shell，而是先做 communication substrate：

```text
Slock app
  -> channel
  -> agent joins
  -> task posted
  -> agent claims task
  -> agent sends status / result messages
  -> human or other agent reacts
```

它有几个关键产品原语：

- channel：多个 agent 和 human 共同上下文；
- daemon：本地 runtime bridge；
- task claim：避免多个 agent 同时做同一件事；
- message / wait：agent 协作不靠 terminal transcript 猜测；
- dashboard：观察 agent activity。

### 对我们的启发

Slock 对当前项目最重要的提醒是：跨 session 通信不应该只有 Conductor 的 `call_session/read_session`，还应该考虑更一般的 channel/inbox/task-claim 模型。

但第一版不一定要照搬 worker-to-worker message。更稳的取法是：

- Conductor-centric 仍作为第一版路由边界。
- Shell Store 中引入 task inbox / session inbox 概念。
- `call_session` 创建 dispatch 时，同时创建一条 inbox/message event。
- Worker 不需要理解 Workspace protocol，但 Shell 可以把 assignment 作为 channel event 保存。
- 后续如果 worker 支持工具或 daemon，再让它显式 claim/report。

对当前 spec 的影响：

- `.agent-workspace/runtime/<task-id>/events.jsonl` 需要承载 message/inbox/claim 类事件，而不只是 PTY 状态。
- Task Board 可以显示“谁 claim 了这个 task / dispatch”。
- Notifications 不只是 terminal status，也可以是 channel activity。
- `ask_user` 更像 human inbox event，而不是简单 modal。

## Wanman

来源：<https://github.com/chekusu/wanman>

### 定位

Wanman 是一个 agent workforce manager。它的定位比 AgentsRoom 更偏 runtime/control plane，比 Slock 更偏 agent fleet/task execution。

公开 README 的核心描述包括：

- Manage multiple AI coding agents working on tasks simultaneously。
- Agents work in isolated git worktrees。
- Supports Claude Code and Codex CLI。
- Web UI for monitoring tasks and agent progress。
- Task queue / assignment / status tracking。
- Designed for running many coding agents concurrently.

### 怎么做

Wanman 的产品路径大致是：

```text
Task queue
  -> agent worker
  -> isolated git worktree
  -> CLI coding agent
  -> status/progress monitoring
  -> diff/review/merge handoff
```

它比 Slock 更贴近我们当前的 engineering workflow：

- task queue 是入口；
- 每个 task 可以进入独立 worker；
- worker 运行真实 coding CLI；
- worktree 隔离是核心；
- UI 主要看 progress/status；
- human 负责 review/merge。

### 对我们的启发

Wanman 强化了几个当前 spec 已经有但需要更坚定的点：

- 每个 run 应该绑定 worktree/branch/baseline。
- 多 agent 并发时，isolation policy 必须可见。
- Agent progress 不能只靠 terminal，应该有状态/event。
- Review/merge 是 task 完成的门禁。

对当前 spec 的影响：

- `Run Worktree Context` 应该是 MVP core，不是后置优化。
- Task queue 和 worker pool 的关系要清楚：Task 不等于 AgentRun，AgentRun 不等于 Done。
- Worker session 启动失败、worktree 准备失败、merge conflict 都要有产品事件。
- 对 Wanman 这类项目，CLI/worktree/runtime control plane 的参考价值高于 cloud PR agent。

## 三者对比

| 项目 | 更像什么 | 核心对象 | Runtime 形态 | 协作模型 | 对我们的优先级 |
| --- | --- | --- | --- | --- | --- |
| Multica | AI-native workspace / agent team OS | agent, task, conversation, memory, git state | local-first workspace | agent as persistent teammate | 高：产品对象和心智模型 |
| Slock | Slack for AI agents | channel, message, task claim, daemon, agent | local daemon + web app | message/channel/task claim | 高：通信/inbox/task claim 模型 |
| Wanman | agent workforce manager | task queue, worker, worktree, status, diff | local CLI agents + worktrees | queue -> worker -> review | 高：执行/runtime/control plane |
| AgentsRoom | multi-agent desktop IDE | project, agent terminal, backlog, review, commit context | desktop PTY shell | visible multi-agent IDE | 高：界面和工程交付链 |
| Cloud PR agents | remote async developer | issue/task, sandbox, branch, PR | cloud VM/sandbox | async task -> PR | 中：交付出口参考 |
| Agent frameworks | workflow runtime | graph/crew/flow/state | framework process | coded workflow | 中低：实现思想参考 |

## 对当前项目定位的修正

之前的表述是：

```text
本地 Board-first multi-agent coding workbench
真实 provider CLI sessions
Conductor-centric orchestration
Shell-owned session/evidence store
Review-gated delivery
```

修正后应该是：

```text
local-first agent-native collaboration workbench
  -> Task Board / Queue
  -> persistent Agent identities
  -> Conductor as visible team lead
  -> provider-native worker sessions
  -> channel / inbox / dispatch / task-claim events
  -> isolated worktrees and runtime evidence
  -> Review-gated delivery
```

这个修正不推翻 Conductor-centric 第一版。它改变的是产品心智模型：

- Conductor 不是隐藏调度器，而是 workspace 中可见的 task owner / lead。
- Worker 不只是 terminal，而是有 identity/status/context 的 teammate。
- Session Store 不只是 transcript 存储，也应该是协作事件存储。
- Task Board 不只是启动器，也应该显示 claim、handoff、inbox、blocked、review state。

## 当前 spec 应该保留什么

仍然保留：

- Worker sessions 第一版保持 provider-native。
- Worker 不需要加载 Agent Workspace MCP tools。
- 不从 raw terminal 文本解析 task completion。
- `call_session` 异步返回 dispatch id。
- `read_session` 从 Shell-owned Session Store 读。
- Done 必须经过 Review。
- runtime state 写入 `.agent-workspace/`，不写入 product-intent docs。

这些决定和 Multica/Slock/Wanman 并不冲突。

## 当前 spec 应该补什么

### 1. Agent identity / memory refs

当前 `Agent` 偏运行卡片。后续应增加：

- persistent agent id；
- role and responsibility；
- memory/context refs；
- current task/session bindings；
- provider-native runtime profile；
- last inbox activity。

### 2. Channel / inbox / message events

在 Conductor-centric 第一版中，也可以先把 communication event 化：

```text
task.inbox.message.created
dispatch.claim.created
dispatch.delivered
session.reply.observed
human.decision.requested
human.decision.resolved
```

Worker 不一定能主动调用工具，但 Shell 仍可以保存这些事件。

### 3. Task claim model

Task claim 不等于 task status。它回答：

- 谁正在处理？
- 哪个 session / run claim 了？
- claim 是 Conductor 分配，还是 worker 自主 claim？
- claim 是否过期、释放、转交？

第一版可以只有 Conductor-created claim，后续再支持 worker self-claim。

### 4. Worktree/runtime control plane

Wanman 说明 worktree isolation 是多 coding agent 并发的基本盘。当前 spec 已有 Run Worktree Context，但实现计划应把它作为早期真实 runtime requirement。

需要埋点：

- `worktree.prepare.started`
- `worktree.prepare.failed`
- `worktree.bound`
- `baseline.captured`
- `merge.conflict.detected`
- `worktree.cleanup.requested`

### 5. Dashboard 不是只有 terminal

AgentsRoom 强 terminal，Slock 强 channel，Wanman 强 worker status，Multica 强 workspace objects。

我们应该组合成：

```text
Task Board summary
  -> task state
  -> current claim
  -> active sessions
  -> inbox/activity
  -> verification/review gate
  -> evidence links
```

Workbench drill-down 再显示 terminal。

## 不应该照搬什么

- 不要第一版直接做完全开放 worker-to-worker messaging。
- 不要让每个 worker 都必须接入自定义 daemon/protocol。
- 不要把 channel 聊天流当成 Review 证据的替代品。
- 不要做云端 agent marketplace / hosted agent workforce。
- 不要让 task claim 自动等于 task completion。
- 不要因为 Slock 是 Slack-like 就把 UI 退化为聊天产品。

## 推荐下一步

1. 更新 `product-interaction-map.md`：补一段 Agent-native collaboration positioning，说明 Board 还要显示 claim/inbox/activity。
2. 更新 `conductor-session-communication.md`：在不改变第一版 worker provider-native 的前提下，把 dispatch/read_session 解释成 Shell-owned inbox/message events。
3. 更新 `development-instrumentation.md`：补 task claim、inbox、worktree control-plane events。
4. 新建 plan：实现最小 inbox/claim event model，不先做 worker MCP/report_result。

## 调研来源

- Multica GitHub: <https://github.com/multica-ai/multica>
- Slock homepage: <https://slock.ai/>
- Slock project listing / package evidence: <https://codepick.app/project?repo=the-slack-for-ai-agents>
- Wanman GitHub: <https://github.com/chekusu/wanman>
- AgentsRoom research baseline: `docs/research/agentsroom-research-2026-06-24.zh.md`
- Existing broader comparison: `docs/research/similar-agent-workbench-products-2026-06-29.zh.md`
