# Session 信息传递机制研究

日期：2026-06-28

范围：研究 Agent Workspace 中多个 Workspace Session 之间的信息传递方式，重点解决 Conductor 如何向其他 session 派发任务、其他 session 如何把结果返回给 Conductor、以及长运行 session、权限请求、自动继续和 loop 控制如何不被 terminal prompt 污染。

## 背景问题

当前基于 terminal 文本协议的方案有三个核心问题：

- “system prompt 注入”在真实 TUI 中表现为向 agent 发送一条 user message，不能作为稳定的系统级规则。
- session 通信依赖模型输出结构化文本，再从 terminal transcript 中解析，容易被 TUI UI、粘贴文本、终端控制字符和模型自由发挥污染。
- Conductor 与 worker session 的信息往返没有可靠事件边界，导致看起来有多个 session 在跑，但 Conductor 未必真正拿到 worker 的最终信息并做下一轮决策。

因此后续方向应该从“terminal 输出解析”转向“tool/MCP 驱动的 session 通信”。Terminal 保留为真实执行和可视化界面，调度和通信则通过 Agent Workspace 自己的工具层完成。

## 后续修订结论

后续产品讨论选择了更保守的 Conductor-centric 方向：只改造 Conductor session，其他 worker session 保持原生 opencode / Claude Code / Codex 交互，不要求 worker 加载 Agent Workspace MCP tools，也不要求 worker 调用 `report_result` / `send_conductor`。

因此本文中“worker session 增加 `send_conductor` / `report_result` 工具”的方案保留为研究过的候选方案，不再作为第一版实现方向。第一版实现应以 `docs/superworks/spec/conductor-session-communication.md` 为准：

```text
Conductor 使用 MCP tools 调度和读取。
Worker sessions 保持 provider-native。
Shell 记录 PTY transcript、status events、snapshots。
Conductor 通过 read_session 查看 Shell-owned Session Store 后做下一步判断。
```

## 术语

- Workspace Session：Agent Workspace 管理的一个真实 PTY/CLI 会话，例如 Conductor、Researcher、Reviewer。
- Provider-native agent/subagent：opencode、Claude Code 等工具内部自己的 agent 或 subagent 能力。它们只能作为当前 Workspace Session 内部工具，不能代表另一个 Workspace Session。
- Shell Router：Agent Workspace 进程内的路由层，负责校验 task、session、route policy、权限和事件记录。
- Session Event Store：`.agent-workspace/` 下的运行时事件存储，记录 dispatch、result、permission、blocked、done、heartbeat 等事件。

## 方案一：`call_session` 同步返回结果

形式：

```text
Conductor calls call_session(to: "Researcher", input: ...)
  -> Shell Router starts/wakes Researcher
  -> waits until Researcher completes
  -> returns Researcher's final result to Conductor as tool result
```

优点：

- 对 Conductor 最简单，像普通函数调用。
- Conductor 的上下文链路清晰，调用返回值就是下一步输入。
- 适合很短的查询、状态读取、摘要读取，例如 `read_session_status` 或 `get_latest_result`。

问题：

- 不适合作为长任务主路径。Research、code implementation、debug loop 都可能持续几分钟到几十分钟，tool 返回容易超时。
- Conductor 会被阻塞，不能同时观察多个 worker session。
- 如果目标 session 出现权限弹窗、需要人工确认、等待网络、等待测试，整个 tool 调用会卡死或失败。
- 容易把多 agent 工作台退化成同步 RPC，而不是可观察、可恢复的 session 编排。

结论：

同步 `call_session` 只能用于短操作，不应该等待目标 session 完成。主路径应该把 `call_session` 改成异步投递：

```text
call_session(...) -> returns { dispatchId, targetSessionId, status: "queued" | "started" }
```

后续结果通过事件、inbox 或 `read_result(dispatchId)` 获取。

## 方案二：监控 worker session 队列并主动唤醒 Conductor

形式：

```text
Worker session updates
  -> Shell monitors session events
  -> Event Store records new result / blocked / permission request
  -> Shell sends a compact message into Conductor session
```

优点：

- Conductor 不需要同步等待 worker。
- 适合长任务，worker 完成或阻塞后再唤醒 Conductor。
- 可以支持多个 worker 并行运行，Conductor 根据事件顺序做下一步决策。
- 能实现 `A -> B -> A -> C -> A -> B -> C` 这种真实编排节奏。

问题：

- 如果监控的是 raw terminal output，会重新回到 transcript 解析问题。
- 如果直接把所有更新都作为 user message 塞给 Conductor，会污染 Conductor 的对话上下文，并且可能在 Conductor 正在思考或输出时打断它。
- 事件太碎会造成噪音，需要合并、去重、节流和优先级。
- Conductor 的“被唤醒”必须有边界：只能在 idle / waiting 状态写入，不能在 busy 状态乱写。

结论：

这个方案适合作为 Conductor 的 inbox/wakeup 机制，但前提是事件来源必须来自结构化 tool call 或 shell-owned event，不应该来自 raw terminal 文本猜测。推荐形态：

```text
worker tool call -> Session Event Store -> Conductor Inbox -> wake Conductor when idle
```

Conductor 接收信息有两种模式：

- Pull：Conductor 主动调用 `read_inbox()` 获取待处理事件。
- Push：Shell 在 Conductor idle 时发送一条 compact wake-up message，提醒它读取 inbox 并决策。

Push 只能用于唤醒和摘要，不承载长正文。长正文、证据、artifact 路径都放在 Event Store 中。

## 方案三：worker session 增加 `send_conductor` / `report_result` 工具

形式：

```text
Researcher calls report_result(...)
  -> Shell Router validates sender session, task, route policy
  -> Event Store records result
  -> Conductor Inbox receives event
  -> Conductor wakes or later reads inbox
```

优点：

- worker 主动、显式地表达“我完成了、我卡住了、我需要 review、我建议下一步”。
- 不依赖 terminal transcript 解析，结构化结果来自 tool arguments。
- route policy 可以强约束。例如 research 模板允许：

```text
Conductor -> Researcher
Researcher -> Reviewer
Reviewer -> Conductor
```

Reviewer 不能直接命令 Researcher，只能把 gap 报给 Conductor。

- 适合记录 durable evidence，例如 research 文件路径、spec 线索、测试日志、diff summary。
- UI 能直接显示 session event，而不是从 TUI 截图里猜状态。

问题：

- 需要让 opencode / Claude Code session 能加载 Agent Workspace MCP tools。
- 需要明确每个 session 的 tool 权限，不同角色能调用的 tool 不同。
- 模型可能不调用工具，仍然只输出自然语言。需要 system-level/tool-level prompt、completion contract 和 fallback 检测。
- 对 provider adapter 要求更高，需要可靠的 task-scoped MCP/config 注入，而不是 terminal 粘贴。

结论：

这是 worker 返回信息的主路径。相比 raw transcript 解析，它更像真实的工作台事件接口。

## 推荐方案：异步 `call_session` + worker `report_result` + Conductor Inbox

单独三种方案都不完整。推荐组合如下：

```text
Conductor
  -> call_session(to: Researcher, assignment)
  -> immediately receives dispatchId

Researcher
  -> works in its own PTY session
  -> may use provider-native subagents/tools internally
  -> calls report_result(dispatchId, result, evidenceRefs, nextAction)

Shell Router
  -> validates route
  -> records event
  -> writes Conductor Inbox
  -> wakes Conductor only when Conductor is idle or waiting

Conductor
  -> reads inbox event
  -> decides next call_session / ask_user / finish / review
```

这比“`call_session` 等到 worker 完整跑完再返回”更稳，也比“监控 terminal 然后塞消息给 Conductor”更可控。

## 推荐工具边界

第一版可以只做少量工具，不要一开始做复杂平台。

### Conductor 可调用

```text
call_session({
  taskId,
  toSessionId,
  assignment,
  expectedOutput,
  evidenceRequirements,
  priority
}) -> { dispatchId, status }
```

```text
read_inbox({
  taskId,
  afterEventId?
}) -> { events[] }
```

```text
ask_user({
  taskId,
  question,
  options?,
  reason
}) -> { requestId, status }
```

```text
finish_task_claim({
  taskId,
  summary,
  evidenceRefs,
  nextRecommendedTask?
}) -> { reviewId, status: "pending_review" }
```

### Worker 可调用

```text
report_result({
  taskId,
  dispatchId,
  status: "completed" | "blocked" | "needs_review",
  summary,
  body,
  evidenceRefs,
  nextAction
}) -> { eventId, deliveredTo: "conductor" | "reviewer" }
```

```text
request_permission({
  taskId,
  dispatchId,
  action,
  reason,
  riskClass
}) -> { permissionRequestId, status }
```

### Router 内部能力

```text
validate_route(fromSessionId, toSessionId, taskTemplate)
append_event(event)
wake_session_if_idle(sessionId, inboxEventId)
start_session_if_needed(sessionId)
classify_permission(action)
```

## Conductor 如何接收信息

Conductor 接收信息不应该只依赖一种方式。

推荐分层：

1. Event Store 是唯一事实源。所有 worker result、permission、blocked、done 都先写事件。
2. Conductor Inbox 是事件视图。只包含 Conductor 需要处理的事件引用和摘要。
3. Wake-up message 只是提醒，不承载事实正文。
4. Conductor 通过 `read_inbox()` 读取完整结构化事件。

示例：

```text
Researcher report_result
  -> event: result.completed
  -> inbox: conductor has unread event
  -> if Conductor idle:
       Shell writes compact wake-up:
       "Agent Workspace: Researcher returned result event evt_123. Call read_inbox to inspect."
  -> Conductor calls read_inbox
  -> Conductor decides next step
```

这样可以避免把 worker 的长报告直接塞进 Conductor terminal，也避免 Conductor 对话被大量无结构文本污染。

## 长运行和超时处理

所有可能超过几秒的 session 调用都必须异步。

规则：

- `call_session` 不等待目标 session 完成，只返回 dispatch id。
- worker 通过 heartbeat / status event 表示仍在运行。
- UI 根据 event store 展示 running、waiting、blocked、needs permission。
- Conductor 可以设置 SLA，例如 10 分钟无 heartbeat 后调用 `read_session_status` 或重新派发。
- tool 返回值只描述“调度请求是否被接收”，不是“任务是否完成”。

## 权限、弹窗、自动继续

这部分不应该由 Conductor prompt 自己硬猜。

需要独立的 Permission Broker 和 Auto-Continue Policy：

```text
session requests action
  -> Permission Broker classifies risk
  -> auto-allow / auto-deny / ask-user / ask-conductor
```

自动继续同理：

```text
session says "下一步我准备继续整理报告"
  -> safe continue
  -> Shell may continue

session says "下一步我准备修改核心源文件"
  -> permission required

session says "有两个产品方向，请你选择"
  -> ask user
```

这些策略应该记录在 event store，而不是只存在 terminal 上下文中。

## 第一版建议

第一版不要直接做完整多 agent 平台。建议按这个顺序推进：

1. 先做 task-scoped MCP/tool gateway，让 session 能调用 `call_session` 和 `report_result`。
2. `call_session` 只做异步投递，返回 `dispatchId`。
3. `report_result` 写 event store，并进入 Conductor inbox。
4. Conductor 通过 `read_inbox` 获取 worker 结果。
5. 只在 Conductor idle/waiting 时发送短 wake-up message，不发送长正文。
6. terminal transcript 只作为 evidence，不作为主通信协议。
7. 后续再加 Permission Broker、Auto-Continue Policy 和 session heartbeat。

## 当前判断

三种机制中，最合适的不是单选，而是：

- 方案三作为 worker 返回结果的主机制。
- 方案二作为 Conductor 接收和被唤醒的机制，但事件来源必须是 tool/event，不是 raw terminal 监控。
- 方案一只保留为短调用或异步投递，不等待长 session 结束。

核心原则：

```text
工具调用负责通信事实。
事件队列负责状态持久化。
Conductor inbox 负责决策输入。
Terminal 负责真实执行和人工观察。
```
