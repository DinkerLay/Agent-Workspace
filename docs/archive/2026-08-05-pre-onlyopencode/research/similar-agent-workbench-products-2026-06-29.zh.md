# 类似 Agent Workspace 逻辑的产品调研

日期：2026-06-29

范围：调研与当前 Agent Workspace / AgentsRoom-like 多 Agent 工作台相似的产品、框架和工作流，回答三个问题：

- 有哪些类似逻辑的产品？
- 它们怎么做任务、运行、编排、验证和交付？
- 我们当前项目按最新 spec 和代码方向怎么做？

本文件以当前项目的最新 durable intent 为准：

- `docs/research/agentsroom-research-2026-06-24.zh.md`
- `docs/research/session-communication-mechanisms-2026-06-28.zh.md`
- `docs/superworks/spec/product-interaction-map.md`
- `docs/superworks/spec/conductor-session-communication.md`
- `docs/superworks/plans/conductor-session-communication.plan.md`

## 一句话结论

> 2026-06-30 修订提示：本文件覆盖面偏宽，包含较多 cloud coding agent、PR agent 和通用 agent framework。当前项目更核心的相似方向应参考 `docs/research/agent-native-collaboration-products-2026-06-30.zh.md`，重点是 Multica、Slock、Wanman 这类 agent-native collaboration workspace / local runtime control plane。

市场上相近产品大致分成三类：

1. 本地/桌面多 Agent 工作台：AgentsRoom、Claude Code Agent View / Agent Teams、Vibe Kanban、AI Agent Board、GitHub Copilot app、Codex app。
2. 云端异步 coding agent：GitHub Copilot cloud agent、OpenAI Codex cloud、Google Jules、Cursor Cloud Agents、Devin、Factory Droids。
3. 通用多 Agent 编排框架：AutoGen Studio、LangGraph / LangSmith Studio、CrewAI。

我们的项目最接近第一类，但不是简单复制。当前方向是：

```text
Board-first task intake
  -> task-scoped Conductor PTY
  -> Conductor-only Agent Workspace MCP tools
  -> provider-native worker PTYs
  -> Shell-owned Session Store / status / events
  -> Review gate / verification / diff / commit context
```

也就是说，我们不是把所有 worker 都改造成能互相发协议消息的 agent，也不是云端 PR 机器人。我们是在本地 desktop shell 中管理真实 CLI session，让 Conductor 通过 Shell 工具调度和读取 worker，而 Shell 保存可审计状态。

## 竞品和相邻产品怎么做

### AgentsRoom

定位：最直接的产品参考。它把多个 Claude Code、Codex、Gemini CLI、OpenCode、Aider 等 CLI agent 放进一个本地多 Agent IDE。

做法：

- 用项目 / 房间承载多个 Agent session。
- 每个 Agent 是一个真实 terminal / PTY session，有角色、provider、model、状态。
- Backlog 任务板把任务从 TODO 拖到 In Progress 后启动临时 Agent。
- Team workflow 是可视化节点图，节点是 Agent，边是 handoff，可设置循环和 max-cycle guard。
- Dev Terminals 单独管理 frontend、backend、worker、database 等长期进程。
- Per-Agent Review 按 Agent 归因 changed files。
- Commit Context 把 Agent 对话作为 commit trailer 或外部 artifact 保留。
- Browser Automation 给项目级 Chromium browser 和 MCP 控制能力，用于真实验证 localhost。

对我们的启发：

- 保留真实 CLI terminal 是正确方向。
- Board、Agent、Terminal、Review、Commit Context 应该是一条工程交付链，而不是聊天窗口集合。
- `done` 不能直接变成 Done，必须进入 Review。

差异：

- AgentsRoom 更强调多 provider 多 terminal 的可视化 cockpit。
- 我们当前更强调 Shell-owned Session Store 和 Conductor 工具边界，避免 worker 自己承担 Agent Workspace 协议。

### Claude Code Agent View

定位：Claude Code 官方的“多后台 session 管理”形态。

做法：

- `claude agents` 在一个终端界面中管理多个后台 Claude Code session。
- session 按 Needs input、Working、Ready for review、Completed 等状态分组。
- 每个后台 session 是完整 Claude Code conversation，可 detach / attach / peek / reply。
- 支持从 shell、agent view、现有 session 中 dispatch 新后台任务。
- session 状态存在 `~/.claude/jobs/<id>/state.json` 等本地目录。
- 支持 worktree 隔离、PR 状态展示、permission mode、model、MCP、plugin、settings 传递。

对我们的启发：

- “后台 session 不是 terminal tab，而是可恢复的 job record”这个模型很关键。
- UI 不必显示完整 transcript；大多数时候显示一行状态、最近输出、是否需要输入就够。
- detach/attach 模型适合我们后续 Workbench 和 session list。

差异：

- Claude Agent View 只管理 Claude Code 自己的 session。
- 我们目标是 provider-agnostic shell，worker 可是 opencode、Claude Code、Codex 等。
- 我们不能把 provider-native subagent 当成另一个 Workspace Session。

### Claude Code Agent Teams

定位：同一个 Claude Code session 内的实验性团队编排。

做法：

- 一个 Claude Code session 作为 team lead。
- teammates 是独立 Claude Code instances，各有自己的 context window。
- 使用共享 task list、mailbox、直接 agent-to-agent messaging。
- 支持 pending / in progress / completed 任务状态和 dependency unblock。
- 支持 plan approval、quality hooks、in-process 或 split panes 显示。
- 团队状态存在 `~/.claude/teams/` 和 `~/.claude/tasks/`。

对我们的启发：

- task list + mailbox 是多 agent 协作的成熟原语。
- plan approval 和 quality hooks 适合借鉴为 Review/verification gate。

差异：

- Claude Teams 允许 teammate 直接互相通信。
- 我们第一版明确禁止 worker-to-worker routing；所有 worker 路由由 Conductor 调用 Shell tools 完成。
- 我们的 route policy 是 Shell-enforced，而不是只靠 agent 遵守共享 task list。

### GitHub Copilot cloud agent

定位：云端异步 coding agent，强绑定 GitHub issue / PR。

做法：

- 从 GitHub Issues、Copilot Chat、dashboard、PR comment、Actions failure 等入口启动 task。
- 在 GitHub Actions-powered ephemeral environment 中研究 repo、制定计划、改代码、跑 tests/linters。
- 创建 branch，push commits，可选择打开 PR。
- PR 和 session logs 是主要 review surface。
- 支持 custom agents、MCP servers、hooks、custom instructions、Copilot Memory、usage metrics。
- 自动化可按 schedule 或 issue opened 等事件触发。

对我们的启发：

- branch / PR / logs 是团队协作天然审查边界。
- 自定义 agent、MCP、hooks 都应作为 runtime policy 和 evidence 记录，而不是隐藏配置。
- GitHub Actions workflow 的运行权限需要显式批准，这对应我们的 permission/review gate。

差异：

- Copilot cloud agent 是云端托管执行，不是本地真实 CLI/PTy workbench。
- 它更像“GitHub 上的异步开发者”，我们的产品更像“本机多 agent IDE 壳”。

### OpenAI Codex cloud / Codex app

定位：Codex 覆盖本地 CLI、桌面 app、IDE extension、web/cloud 多种表面。

做法：

- Codex cloud 每个 task 在自己的 cloud sandbox / cloud environment 中执行。
- 可并行运行多个任务，连接 GitHub 后从任务结果创建 PR。
- Codex app 是桌面 command center，强调多线程、worktrees、Git diff、commit、PR 和 automations。
- GitHub 集成中，`@codex` 可对 PR review、修复 CI、继续已有 PR 上下文。
- Automations 可定期运行背景任务，把 findings 写入 inbox 或自动归档。

对我们的启发：

- 本地 app + cloud task + Git review 可以统一成“task/run/thread”模型。
- automations 的结果应该进入 inbox，而不是直接改 product intent。
- diff pane、chunk review、commit/push/PR 是非常重要的交付界面。

差异：

- Codex 本身是 agent runtime 和产品表面；我们是管理多个 provider-native runtimes 的 shell。
- 我们的 Conductor 工具桥不替代 Codex/Claude/opencode 的内部 agent loop。

### Google Jules

定位：GitHub 连接的异步 coding agent。

做法：

- 用户连接 GitHub，选择 repo 和 branch，提交任务。
- Jules 在 VM 中 clone、安装依赖、改文件。
- 先生成 plan，进入 `AWAITING_PLAN_APPROVAL` 等状态后再执行。
- session 是核心资源，有状态、activity、artifact、change set、bash output、media、PR output。
- 每个 task 在自己的 VM 中运行，可同时启动多个 task。
- 可随时 export 当前 work-in-progress 到 branch 或 PR。

对我们的启发：

- plan approval 状态值得加入任务/Run lifecycle。
- activity/artifact/change-set 模型和我们 `.agent-workspace/runtime/<task-id>/` 很接近。
- “随时导出 WIP branch/PR”比“等 agent 自称完成”更可控。

差异：

- Jules 的 worker runtime 是 Google 托管 VM。
- 我们目前优先本地 PTY 和用户项目路径，不做云执行。

### Cursor Cloud Agents

定位：Cursor 编辑器中的云端背景 agent。

做法：

- Agent 在远程隔离环境中运行，clone repository。
- 可配置环境 setup、startup commands、secrets、MCP servers。
- 通常以 branch / PR 作为交付结果。
- 可从 Cursor、Linear 等入口委派任务，任务完成后通知用户 review。
- Cursor docs 还提供 Cloud Agents API 和 self-hosted worker pool 方向。

对我们的启发：

- `.cursor/environment.json` 这类环境配置说明：agent task 必须有可重复 setup。
- Linear 集成说明任务系统入口不必局限于本 app。
- 云 agent 适合清晰任务，不适合模糊产品判断；我们的 Task Draft Assistant 和 Review gate 正好补这个空缺。

差异：

- Cursor 是 editor-first/cloud execution。
- 我们是 Board-first/local shell orchestration。

### Devin

定位：自治 AI software engineer，主打复杂工程任务。

做法：

- 每个 Devin session 有自己的 sandbox dev environment。
- 提供 Shell、IDE、Browser 三个 session tools，Progress tab 统一记录命令、代码编辑、浏览器活动。
- 用户可以监控、介入、停止 session，并在 webapp 内接管工作。
- 支持 PR preview、PR review、CI monitoring、Slack/Linear/Jira/API/automations 等入口。
- 有 skills、knowledge、repo permissions、network policy、MCP marketplace 等企业控制面。

对我们的启发：

- Shell / IDE / Browser 三件套是完整 coding-agent 环境的最低可用组合。
- Progress tab 统一呈现所有活动，比让用户读 raw transcript 更适合长期任务。
- takeover 能力对应我们的 attach/continue/review。

差异：

- Devin 是一个强 agent 产品，runtime 和平台都自带。
- 我们是多 provider orchestration shell，不把所有执行收敛到单一 vendor agent。

### Factory Droids

定位：跨 SDLC 的软件开发 agent 平台。

做法：

- Droids 可在 CLI、web、Slack/Teams、Linear/Jira、mobile 等入口工作。
- 强调 purpose-built agents 和 organization context。
- 支持 code、review、testing、deployment、incident response 等 SDLC 场景。
- Droid CLI 可在本地项目中启动 session。
- Automated Code Review 通过 GitHub/GitLab PR/MR 事件或评论触发，产生 inline review comments。

对我们的启发：

- “一个平台，多入口”是后续方向，但第一版不应该膨胀到 Slack/mobile。
- Review Droid / QA Droid / Product Droid 这种角色专门化，适合映射为 task template roles。
- 自动 review 仍然要写入 PR/review evidence，而不是直接合并。

差异：

- Factory 更偏企业 agent 平台和 SDLC 自动化。
- 我们当前目标更窄：本地桌面工作台、任务运行、session 管理、review gate。

### Vibe Kanban

定位：开源 AI coding agent Kanban 工作台，和我们 Board-first 方向非常接近。

做法：

- Kanban issues 用于 planning。
- 每个 coding agent workspace 有 branch、terminal、dev server。
- 可 review diff、留 inline comments，并把反馈直接发回 agent。
- 内置 browser preview、devtools、inspect mode、device emulation。
- 支持多个 coding agents：Claude Code、Codex、Gemini CLI、GitHub Copilot、Amp、Cursor、OpenCode、Droid 等。
- 支持 PR 创建、AI-generated description、review on GitHub、merge。

重要状态：

- 该项目 README 显示 Vibe Kanban is sunsetting。它仍然是非常有价值的交互参考，但不应被当作长期产品稳定性参照。

对我们的启发：

- Board-first + workspace/branch/terminal/dev server + diff review 是被验证过的产品形态。
- Inline comments 回灌 agent 是 Review -> continue loop 的好模式。

差异：

- Vibe Kanban 更偏“任务卡直接启动 agent workspace”。
- 我们引入 Conductor 作为任务 owner，让跨 worker 的下一步决策集中到 Conductor + Shell route policy。

### AI Agent Board

定位：开源 drag-and-drop Kanban agent board。

做法：

- Backlog / In Progress / Review / Done 四列。
- 把 task 拖到 In Progress 后配置 repo path、branch、agent type、是否使用 git worktree。
- Start Agent 后实时 streaming progress。
- provider pattern 抽象 Copilot、Claude Code、Codex、OpenCode、Hermes、OpenClaw。
- 每个 provider 的事件归一为 `AgentEvent`，通过 WebSocket 推到 UI。
- Task Groups 支持 2-20 个 child tasks 和 parallelism slider。
- 支持 git worktree isolation、本地 merge、PR、worktree cleanup。

对我们的启发：

- Provider adapter + normalized event stream 是非常直接的实现参考。
- Task Groups 可以作为我们高级 Teams 之前的轻量并行能力。

差异：

- AI Agent Board 的 agent manager 直接 orchestrates sessions。
- 我们的 spec 更强调 Conductor 是 task-level reasoner，Shell 是 route/status/evidence owner，worker 不承担 Workspace protocol。

### AutoGen Studio

定位：低代码/无代码多 Agent workflow 原型工具。

做法：

- Team Builder 用 declarative JSON 或 drag-and-drop 创建 agents、tools、models、termination conditions。
- Playground 交互测试 workflows。
- 支持 profiling、debugging、gallery、Docker code execution safeguard。
- 官方明确说明不是 production-ready app，而是原型和示例 UI。

对我们的启发：

- 可视化 workflow、agent role、tool、termination condition 适合后续 Teams 页面。
- termination condition / max-cycle guard 是防止无限循环的硬约束。

差异：

- AutoGen Studio 是构建 agent 应用的框架 UI。
- 我们不是通用 agent framework IDE，而是面向 coding CLI sessions 的工程工作台。

### LangGraph / LangSmith Studio

定位：状态图式 agent runtime 和可视化 debugging / observability 工具。

做法：

- LangGraph 用 graph nodes/edges 表达长运行、有状态、多 actor workflow。
- Persistence / checkpointer 保存 thread-scoped state，用于 fault tolerance、time travel、conversation continuity。
- Interrupts 支持 human-in-the-loop：暂停执行，保存 state，等待外部输入后恢复。
- LangSmith Studio 可视化、交互、debug 符合 Agent Server API 的 agentic systems，并集成 tracing/eval/prompt engineering。

对我们的启发：

- “状态持久化 + interrupt/resume”是我们的 Session Store、ask_user、Review gate 的理论同构。
- time travel / checkpoint 很适合未来恢复和 replay。

差异：

- LangGraph 是应用 runtime，开发者把 agent workflow 写成 graph。
- 我们的 runtime 是真实 CLI process + Shell store，不要求用户把任务写成 LangGraph。

### CrewAI

定位：多 Agent automation 框架和平台。

做法：

- 以 Agents、Crews、Flows 表达角色、协作和事件驱动 workflow。
- Flows 管理 state、事件、分支、循环、并行和 Python code steps。
- 官方强调 guardrails、memory、knowledge、observability。
- 提供 visual build tools、CLI、API，以及可导出 Python 的 no-code visual editor。

对我们的启发：

- Crews 和 Flows 的边界有助于区分“agent role”和“scheduler workflow”。
- guardrails / observability 是 agent 工作台必须有的一等能力。

差异：

- CrewAI 是 framework-first，多用于业务自动化和 agent app。
- 我们是 product shell-first，重点是本地 coding workflow 的可见、可控、可 review。

## 产品形态对比

| 产品/类别 | 任务入口 | 执行环境 | 多 Agent/并行 | 状态和证据 | 交付门禁 | 与我们的关系 |
| --- | --- | --- | --- | --- | --- | --- |
| AgentsRoom | Backlog / Agent / Team | 本地真实 CLI PTY | 多 provider 多 terminal | terminal、diff、review、commit context | per-agent review / commit | 最直接产品参考 |
| Claude Agent View | terminal agent view | 本地 Claude background process | 多 Claude sessions | `~/.claude/jobs` state、peek、logs | Ready for review / PR | session 管理参考 |
| Claude Agent Teams | lead prompt | 多 Claude instances | lead + teammates + mailbox | shared task list、team dirs | hooks / plan approval | team 模型参考，但不采用第一版 peer routing |
| GitHub Copilot cloud agent | Issue / Chat / PR / Dashboard | GitHub Actions ephemeral env | custom agents / async sessions | session logs、commits、PR | PR review / workflow approval | 云端 PR agent 参考 |
| OpenAI Codex | app / CLI / web / GitHub | 本地 worktree 或 cloud sandbox | 多 task/thread 并行 | thread、diff、Git、PR、automation inbox | review / PR / approval | app/worktree/Git 参考 |
| Google Jules | web / API / GitHub | cloud VM per task | 多 VM task | session state、activity、artifacts、change set | plan approval / PR | plan + artifact 参考 |
| Cursor Cloud Agents | editor / Linear / API | isolated cloud env | cloud background agents | branch、PR、logs、artifacts | PR review | cloud environment setup 参考 |
| Devin | web / desktop / CLI / Slack/Jira | sandbox workspace | parallel cloud agents | Shell/IDE/Browser progress log | PR preview/review/CI | full dev environment 参考 |
| Factory Droids | CLI/web/Slack/Jira | local + cloud agent platform | purpose-built Droids | sessions、PR comments、automation logs | PR/MR review | enterprise SDLC 参考 |
| Vibe Kanban | Kanban issues | workspace with branch/terminal/dev server | multi-agent workspaces | diff、inline comments、browser preview | PR/merge/review | closest Board-first UI reference |
| AI Agent Board | Kanban board | local repo/worktree + agent CLI | provider adapter + task groups | normalized events/WebSocket | Review column / merge/PR | implementation pattern reference |
| AutoGen Studio | visual workflow | framework runtime | agent teams/workflows | profiling/debug/playground | termination conditions | Teams visual reference |
| LangGraph | code-defined graph | graph runtime | multi actor graph | persistence/checkpoint/interrupts | HITL interrupt | state machine reference |
| CrewAI | code/visual/CLI/API | framework runtime | crews + flows | memory/observability/guardrails | hooks/HITL patterns | framework boundary reference |

## 我们项目当前怎么做

### 1. Product shape：Board-first，不是 prompt loop

当前 `product-interaction-map.md` 定义默认入口是 Task Board：

```text
Board
  -> select task
  -> inspect loop/run status
  -> Start Agent from Loop
  -> run-store creates AgentRun
  -> PTY service spawns agent session
  -> git service captures baseline
  -> IDE Workbench opens current run
  -> agent claims done
  -> Review runs verification command and checks diff, transcript, commit context
  -> approval moves task to Done
  -> Runs page keeps audit trail
```

这和 AgentsRoom、Vibe Kanban、AI Agent Board 一样，都把任务板和工程交付链放在核心。但我们多了明确的 Shell-owned evidence boundary。

### 2. Session model：Conductor-centric

最新 spec 明确：

- Conductor 是 task-owner Workspace Session。
- 只有 Conductor 拿到 Agent Workspace MCP tools 和 task-owner runtime injection。
- Worker sessions 保持 provider-native opencode / Claude Code / Codex terminal。
- Worker 不需要加载 Agent Workspace MCP tools。
- Worker 不需要输出自定义 XML/JSON/Workspace Session Message。
- Worker 不直接路由给其他 worker。

工作流是：

```text
Conductor
  -> call_session(worker, assignment)
  -> receives dispatchId immediately
  -> Shell starts/wakes provider-native worker PTY
  -> Shell writes normal assignment text
  -> Shell records transcript/status/events
  -> Conductor read_session(worker)
  -> Conductor decides continue / ask_user / finish_task_claim / another worker
```

这和 Claude Agent Teams 的 peer messaging 不同，也和云端 coding agent 的隐藏执行不同。

### 3. Shell owns runtime facts

Shell owns：

- PTY lifecycle
- transcript raw/clean logs
- status events
- screen snapshots
- Session Store
- route policy
- permission policy
- wakeup hints

Session Store 目标路径：

```text
.agent-workspace/runtime/<task-id>/sessions/<session-id>/
  transcript.raw.log
  transcript.clean.log
  events.jsonl
  state.json
  snapshots/
.agent-workspace/runtime/<task-id>/events.jsonl
```

代码中已有 `desktop/session-store.cjs`，会记录 session started/output/state、dispatch created/delivered，并提供 `readSession`。

### 4. Conductor tools are small and explicit

代码中已有 MCP server / tool bridge 雏形：

- `call_session`
- `read_session`
- `continue_session`
- `read_session_events`
- `ask_user`
- `finish_task_claim`

`desktop/conductor-tool-bridge.cjs` 中 `callSession` 是异步派发：先记录 dispatch，再 start/wake worker，若 worker 正在运行就写入普通 assignment；如果不能立即运行，返回 queued。

`desktop/conductor-mcp-server.cjs` 通过 stdio MCP 暴露这些工具，再转发到本地 HTTP bridge。

### 5. Runtime injection is task-scoped

当前实现有：

- `src/orchestration/conductor-tools/conductorPrompt.ts`
- `src/runtime/adapters/conductorRuntime.ts`
- `src/runtime/adapters/opencode/conductorInjection.ts`
- `src/runtime/adapters/claude-code/conductorInjection.ts`
- `src/runtime/adapters/opencode/injection.ts`
- `src/runtime/adapters/claude-code/injection.ts`

关键边界：

- opencode Conductor 使用 `OPENCODE_CONFIG_CONTENT` 加载 Conductor MCP 和 system instructions。
- Claude Code Conductor 使用 `--mcp-config` 和 `--append-system-prompt`。
- worker launch 的 injection 文件目前是空的，并明确注释：Worker sessions intentionally launch as provider-native terminals。

这符合“不写全局 AGENTS.md / CLAUDE.md，不污染 worker protocol”的 spec。

### 6. Task templates define roles, but routing is Conductor-mediated

`src/runtime/opencode/taskTemplates.ts` 中已有模板：

- research：Conductor / Researcher / Reviewer
- product-logic：Conductor / Planner / Reviewer
- spec-plan：Conductor / Planner / Reviewer
- implementation：Conductor / Executor / QA
- debug-fix：Conductor / Executor / QA

routes 都是：

```text
Conductor -> worker
```

而不是：

```text
Researcher -> Reviewer -> Conductor
```

也就是说，角色模板提供组织结构；实际调度权仍在 Conductor + Shell policy。

### 7. Done is review-gated

当前产品原则：

- `finish_task_claim` 只创建 pending review evidence。
- Review 才能运行 verification、检查 diff、scope commit files、记录 commit context。
- Done 必须经过 Review approval。
- Runs/Audit Trail 保存证据链。

这和 GitHub PR 生态、Codex/Jules/Copilot cloud 的“PR review before merge”一致，但落点是本地 Review page 和 `.agent-workspace/` evidence。

## 我们和竞品的核心差异

### 差异一：不是云 agent，也不是 agent framework

云 agent 产品把执行环境托管起来，最后给用户 PR。我们的项目把执行留在用户本地 CLI/PTY，重点是 shell 管理、可见 terminal、可恢复状态、review gate。

AutoGen/LangGraph/CrewAI 让开发者构建 agent workflow。我们的用户不需要先写 agent graph；他们需要一个能管理真实 coding agents 的桌面工作台。

### 差异二：Conductor 是任务 owner，不是隐藏 scheduler loop

很多产品要么让一个 agent 自己 plan/execute/review，要么让多个 agent 直接对话。我们当前方向更保守：

- Shell 负责状态、权限、路由、证据。
- Conductor 负责阅读、委派、追问、综合。
- Worker 负责执行 scoped assignment。

这个拆分能避免把项目退化成重复 prompt loop。

### 差异三：worker provider-native 是第一版优势

让 worker 保持原生 opencode/Claude/Codex 有几个好处：

- 不依赖每个 provider 都能稳定加载我们的 MCP tools。
- 不要求 worker 遵守自定义结构化输出协议。
- 不把 “system prompt injection” 误当作可靠系统边界。
- 用户仍能看到和接管熟悉的 provider-native TUI。

代价是：

- Shell 必须做好 transcript clean、status detection、event store、cursor read。
- Conductor 不能幻想 worker 已经结构化 report；它必须调用 `read_session` 看证据。

### 差异四：Review/evidence 是产品中心，不是附属功能

竞品普遍把 PR 当作最终审查边界。我们的 MVP 在本地提供类似能力：

- verification command evidence
- staged/unstaged scope
- selected files
- commit proposal
- transcript/context trailer
- redaction gate
- approval event
- audit trail

这让本地 agent workbench 能接近团队工程流程，而不是“agent 说 done 就完了”。

## 设计启发和建议

### 应该借鉴

- 从 AgentsRoom 借鉴三栏 IDE shell、per-agent review、commit context、Dev Terminals。
- 从 Claude Agent View 借鉴 session row 状态、peek/reply、detach/attach、本地 job state。
- 从 Claude Teams 借鉴 plan approval、hooks、task list，但不要第一版采用 peer worker routing。
- 从 Vibe Kanban / AI Agent Board 借鉴 Board-first、workspace/branch/terminal/dev-server、diff comments 回灌 agent。
- 从 Copilot/Jules/Codex 借鉴 plan -> execute -> branch/PR -> review 的异步交付语义。
- 从 LangGraph 借鉴 persistence、interrupt、resume、checkpoint 的状态模型。

### 应该避免

- 不要把 worker 输出里的结构化文本作为主通信协议。
- 不要让 worker 之间互相调度作为第一版能力。
- 不要把 provider-native subagent 伪装成 Workspace Session。
- 不要在 task intake 时就创建 fake run 或 fake progress。
- 不要把 runtime state 写入 `docs/research/`、`docs/superworks/spec/`、`docs/superworks/plans/`。
- 不要为了追赶云端竞品而提前做 mobile sync、Slack/Jira、browser automation、full Teams。

### 当前最合理的产品定位

短期定位：

```text
本地 Board-first multi-agent coding workbench
真实 provider CLI sessions
Conductor-centric orchestration
Shell-owned session/evidence store
Review-gated delivery
```

不是：

- 通用多 agent 框架，
- 单一 vendor coding agent，
- 云端 PR 机器人，
- 无限 loop prompt runner，
- 复杂团队自动化平台。

## 后续可验证问题

1. opencode Conductor MCP 注入是否已经在真实 TUI 首轮稳定可用，而不是把 prompt 粘贴成 user message？
2. `call_session` route policy 是否能阻止非 Conductor caller 或非法 session id？
3. Session Store 是否能在真实 PTY 输出中稳定提供 clean transcript、cursor、state、snapshot？
4. worker idle/waiting/blocked/timeout 判断是否足够保守，不会把自由文本 completion 当成 verified done？
5. Review page 是否能消费 Conductor `finish_task_claim`，并阻止未验证任务进入 Done？
6. Task Board 是否只展示 Conductor runtime preview，而不再展示 worker Workspace Session protocol prompt？

## 调研来源

- AgentsRoom feature pages: <https://agentsroom.dev/features>
- Claude Code Agent View: <https://code.claude.com/docs/en/agent-view>
- Claude Code Agent Teams: <https://code.claude.com/docs/en/agent-teams>
- GitHub Copilot cloud agent overview: <https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent>
- GitHub Copilot cloud agent usage: <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github>
- GitHub Copilot agents concepts: <https://docs.github.com/en/copilot/concepts/agents>
- OpenAI Codex cloud: <https://developers.openai.com/codex/cloud>
- OpenAI Codex GitHub integration: <https://developers.openai.com/codex/integrations/github>
- OpenAI Codex product page: <https://openai.com/codex/>
- Google Jules docs: <https://jules.google/docs/>
- Google Jules API types: <https://jules.google/docs/api/reference/types/>
- Cursor Cloud Agents docs: <https://cursor.com/docs/cloud-agent>
- Cursor Cloud Agent setup docs: <https://cursor.com/docs/cloud-agent/setup>
- Devin intro: <https://docs.devin.ai/get-started/devin-intro>
- Devin session tools: <https://docs.devin.ai/work-with-devin/devin-session-tools>
- Devin product page: <https://devin.ai/>
- Factory docs: <https://docs.factory.ai/welcome>
- Factory automated code review: <https://docs.factory.ai/guides/droid-exec/code-review>
- Vibe Kanban repository: <https://github.com/BloopAI/vibe-kanban>
- AI Agent Board repository: <https://github.com/DanWahlin/ai-agent-board>
- AutoGen Studio docs: <https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/index.html>
- AutoGen Studio announcement: <https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/>
- LangGraph persistence: <https://docs.langchain.com/oss/python/langgraph/persistence>
- LangGraph interrupts: <https://docs.langchain.com/oss/python/langgraph/interrupts>
- LangSmith Studio docs: <https://docs.langchain.com/langsmith/studio>
- CrewAI docs: <https://docs.crewai.com/>
- CrewAI Flows: <https://docs.crewai.com/v1.15.1/en/concepts/flows>
