# Agent Workspace Direct Refactor Plan

日期：2026-08-09
状态：**当前唯一可执行计划**
架构来源：[`architecture.md`](architecture.md)

## 成功定义

完成不是 UI 有三个 Provider 按钮，也不是把 AgentLoop 换成通用控制台。完成时，新的 Runtime Host 从
干净 schema 启动，OpenCode、Codex、Claude Code 通过同一 ProviderPort，并由保留的 AgentLoop
产品交互经 RuntimeClient 驱动。未绑定 Session 可选择 frozen Task Profile；已绑定 Session 的跨 Provider
或模型选择必须形成显式、可审计的 Binding handoff，而不是改写 native session。Web/Desktop 共用同一
Renderer；Task Run 使用 Task-local Session Tabs 与统一 Chat；用户可以显式直达 Card，Runtime 以
HumanIntervention 记录来源、完整同步给 Conductor，并在 busy Card 上严格执行 interrupt-then-send。配置期
Meta Agent 只修改用户可审阅的 Template/Task Setup Draft。不存在第二个 lifecycle、Provider 页面 iframe、
PTY-only 控制面、兼容 adapter 或双 writer。

## 数据安全边界（仅适用于未来明确要求的数据迁移或删除）

本次源码硬切换不迁移、读取或删除既有**历史/legacy** Runtime 数据。只有未来由用户明确要求迁移或删除
这些历史数据时，才必须：

1. 盘点活跃 TaskRun、Provider Host、旧数据库和项目 `.agent-workspace/runtime/**`；
2. 由用户明确停止/放弃活跃旧 Run；
3. 由用户确认导出时间戳数据包（SQLite、JSONL、artifact manifest、checksum）；
4. 新 Host 创建独立空 schema，永远不读取或写入该导出数据包；
5. 永远不删除用户 cwd、未受管文件、Provider 原生会话或凭据。

用户数据的物理删除需另一次针对具体路径的明确确认。

Phase 5A / 5B / 5C / 5D 是对当前正式 Runtime Store/contract 的前向演进，而不是恢复 legacy data 或保留兼容路径：它必须
以 versioned migration 保留同一 Task/Run/Binding identity、显式 backfill current-binding pointer、可在测试
副本上验证和重跑；迁移完成后只读取新 canonical 字段，不双写、不保留 old-query alias，也不删除用户 cwd、
Provider 原生会话或凭据。

## Phase 0 — 单一文档与切换清单（已完成）

**输出：** `docs/architecture.md` 与本计划成为唯一当前文件；旧规范、计划、研究与设计在核对后
从工作树移除，不保留复制的 archive payload。`docs/archive/README.md` 只说明 VCS 是历史恢复
来源。更新 `AGENTS.md`、README 和所有入口，不允许再引用旧路径。

**完成条件：** 当前 `docs/` 根目录只有 README、Architecture、Plan，`docs/archive/` 最多只有
其 README；所有运行时规则都能从 Architecture 找到，所有实施步骤都能从本文件找到。已完成：历史 payload
不在 working tree，VCS 是唯一历史恢复位置。

## Phase 1 — Workspace、Contract 与纯 Kernel

**创建：**

```text
apps/workbench  apps/desktop  apps/runtime-host
packages/runtime-contracts runtime-client runtime-domain runtime-application
packages/runtime-store provider-port conductor-tools workbench-ui test-kit
```

**实现：** JSON-serializable commands/read models、Task/Run/Binding/Message/Forward/HumanIntervention/
Inbox/Input/Turn/Invocation/Attention state machines、outbox、Template Library（Draft/immutable Version/archive）与显式 YAML/zip
import-export、fake Provider contract harness、Conductor-scoped `invoke_agent` / `relay_message` /
`publish_message` MCP。Template package 直接升级为 v2、无 v1 Runtime 执行分支；从 frozen Task Architecture
编译 session bootstrap，Conductor 只看 Card dispatch metadata，Worker 只看自己的 prompt/scope；动态 assignment
保持 `invocationId` 关联，但普通 relay 仍以独立 SessionTurn 完整回传。
`Achieve` 是直接的用户 acceptance 记录（可无 Artifact/Run），不引入 Conductor claim 或 delivery-ready gate。

**验收：** fake Provider 可跑完整 Task/SessionTurn/Invocation 生命周期，覆盖 staged/received/ambiguous
input、dedup、stale Attention、interrupt confirmed/unknown、restart、background child 和
unavailable capability；Template import 必须在写库前校验、相同 hash 幂等、同 version 不同 hash
拒绝、发布后 Version 不可变、Task Snapshot 不随模板更新改变；正式 Runtime 只以
`packages/workbench-ui/src/agent-loop` 的交互测试作为产品验收素材，不存在替代 lifecycle import。

## Phase 2 — Runtime Host、Store 与统一 Bridge

**实现：** Runtime Host composition、SQLite schema、authentication、IPC/HTTPS/WSS Runtime
Bridge、semantic invalidation、redacted observability。新 Store 至少包括：

```text
templates/template_versions/template_assets/template_design_sessions
tasks/task_runs/logical_sessions/provider_hosts/provider_session_bindings
commands/outbox/session_messages/relay_blocks/message_forward_batches/message_forwards/message_forward_selections
human_interventions/session_inbox_items/input_submissions/session_turns/invocations
provider_facts/provider_fact_dedup/attentions/async_operations
artifacts/presentation_leases/evidence_references
```

**验收：** 空 profile 重启后可恢复自身 Task/Run/Input/SessionTurn/Invocation facts；没有 raw stream、
filesystem、PTY 或 generic append-event bridge。

## Phase 3 — 三家 Provider 协议 Spike

分别对 OpenCode、Codex App Server、Claude Code 官方 SDK/协议锁定版本、schema fingerprint，
验证 create/resume、input correlation、receipt、reconcile、attention、interrupt terminal、
native child、presentation、资源策略以及 bootstrap 原生字段的接受/恢复语义。

**门槛：** `provider_received` 只能由 native id 或带 evidence 的原生历史 marker 确认；
accepted/idle/latest message 不够。未知能力必须保持 unavailable。每次 probe 必须记录锁定
Provider version、protocol/schema fingerprint、脱敏 native trace、reconcile 结论和重跑命令。

当前 Provider 的已证实能力、版本 pin 和残余风险只记录在
[`architecture.md` 的 Provider 证据矩阵](architecture.md#当前-provider-证据矩阵2026-08-06)。本计划不
复制该事实表；RuntimeApplication outbox、Task/Run recovery、Bridge、Desktop 与 Browser 仍需独立的
可失败验证，不能以 ProviderPort 成功推断。

## Phase 4 — Provider Adapters

实现 `provider-opencode`、`provider-codex`、`provider-claude-code`。Adapter 只负责原生
host/session/thread/turn、ProviderFact、reconcile、interrupt、attention、presentation 与冻结 bootstrap
的 Provider-native 映射；它们不能写 Task/Run/Forward/Inbox/Turn/Invocation 结论，也不能拼入/泄露其他 Card prompt。

**验收：** 只有已经完成 Phase 3 证据并可被本地 Host 接受为 managed Run 的 Adapter，才能同时通过
fake-provider contract suite 与版本锁定 integration harness，包括 Host restart、重复 event、unknown
handoff、stale permission、取消和 async child。不存在“代码已有 Adapter，所以可上线”的例外。

## Phase 5 — AgentLoop-preserving Runtime Bridge、Desktop 与 Browser（当前正式入口）

**实现：** AgentLoop Runtime controller layer 保留 AgentLoop 的任务三栏、Task Setup、Task-local Session
Tabs、统一 Chat、Session Presentation、Timeline、回收站、Artifact 预览与 Template Studio；它只把既有 UI intent 映射到 typed
Runtime commands/read models，并以 typed Runtime bridge 作为唯一 lifecycle 路径。Desktop
Main/Preload/HostSupervisor 与 Browser RuntimeClient 只承载受控 bridge。不得增加 generic 页面、另一套
交互或 Provider 直连；`apps/workbench` 必须承载迁入后的正式 AgentLoop Renderer，现有 generic
Workbench 不得作为可选产品 surface 保留。

**当前工作树状态（不得视为本 Phase 已验收）：** 已有的 Renderer / Runtime 迁移尝试、启动命令、页面截图或
fake-provider 测试都不证明原 AgentLoop 交互被保留。当前实现必须被当作待重做的实现素材，而不是产品参考；
尤其不得把它已经替换为的通用 Runtime 控制台、缺失的 Session 对话页，或 bridge 失败页面当作正式 Surface。

实现前先在本计划任务记录中列出并验收以下交互契约：左侧 Task/已完成/回收站；Task Setup/Create；中央
Task-local Session Tabs 与统一 Chat；Task 总入口固定目标 Conductor；Card Composer 明确目标、human 来源与
Conductor 全文同步；busy Card 只允许 interrupt-then-send；Stop、模型/Provider/Profile 手动选择；工具活动、
变更、权限与 Artifact 作为 human-only 投影；右侧 Session
目录与 Timeline；Template Studio 的 Card/Profile 手动编辑、导入、导出与发布。新 UI 可以视觉优化，但每项必须
经 `RuntimeClient` 重新接到统一 Runtime，不能因为 Provider 统一而删除交互。

当前缺口必须直说：Session Presentation 尚未被证明具有完整 typed transcript/tool/change/typed-permission
projection、Provider/Profile readiness、Provider/Profile Picker、Binding lineage/handoff，也没有 Meta Agent
或三家真实 Provider 的 Browser/Desktop 完整旅程。因此不得把当前页面、timeline、启动成功或 fake-provider
测试称为“统一 Provider 对话页面已完成”。

**剩余验收：** 同一用户旅程在 Desktop IPC 与 Browser bridge 均通过：Template、Task Setup/Create、Start、
Conductor Input、Card HumanIntervention、Invocation、Attention、scoped interrupt、Stop、Artifact、Achieve、
Host restart。每个 inputSubmissionId 只产生一条 receipt；默认启动必须仍进入 AgentLoop，且创建 Task、
选择/打开/切换 Session Tab、Timeline、Achieve、Template 版本与 Import/Export 均有真实 UI/E2E 证据。

**未完成边界：** 独立 Template Design Service / Meta Agent、以及 Card capability scope 与 Provider
tool policy 的强制交集必须先各自实现并通过隔离测试；不能以当前 bootstrap 字段映射冒充完成。

## Phase 5A — Conductor-owned Message、Forward 与 Turn Kernel（当前优先修正）

**目标：** 让一次 Session Agent 回信、一次 Conductor 内容选择和一次目标 Agent 输入走同一条
provider-neutral、可恢复的路径。Conductor 是唯一的协作读者和转递决策者；Session Agent 绝不直接读取
其他 Session 的消息、RelayBlock 或共享数据库。用户直达 Card 是认证的人类控制路径，不是 Conductor
Forward：它必须形成 HumanIntervention、明确 Turn 归因、Card Message 与 Conductor 完整透明说明。

```text
Task/User Message
  -> Conductor Inbox -> Conductor SessionTurn
  -> Conductor 选择 full_message / relay_block
  -> MessageForward -> rendered target SessionMessage
  -> target SessionInboxItem -> InputSubmission -> SessionTurn
  -> ProviderPort -> ProviderFact(assistant_final + terminal)
  -> 完整 agent_final SessionMessage -> Conductor Inbox

Explicit human -> Card
  -> HumanIntervention -> Card user_input Message/Inbox/Turn
  -> complete Conductor mirror Message/Inbox/Turn
  -> no sibling delivery
```

每个**非 Conductor** Session Agent turn 的完整 final Message 必须自动、可靠地回到 Conductor；Conductor 的
用户可见 final 只进入其自身会话投影，不会自投递。来源 Agent 可以在其完整 final 中给出零到多个 RelayBlock，
表示“我希望这段内容可被转递”；Conductor 可选择不转、转完整 Message、转一个或多个 block，或显式 publish
给多个目标。RelayBlock 不读取 Artifact、不解析文件、不复制 Provider 原生 transcript，也不会因为存在而自动
唤醒或发送任一 Agent。

所有实际交给 Provider 模型阅读的内容都来自已持久化 `SessionMessage` 的完整正文，并以 Provider `user` role
投递；真实来源由 Runtime 写入 Turn 的 `initiator` / `trigger`，绝不能用 native `user` role 猜测。成功的每个
非 Conductor SessionTurn 恰好一条 canonical final；human-direct Turn 的 final 仍回 Conductor，但不创建或
结算 Conductor Invocation。

**直接切换：** 删除 `contextRefs -> ContextPacket -> InvocationResult.result_json -> Wakeup -> Conductor
read_result()` 作为产品协作路径，并删除 `visibility: private|shared|direct`、Shared Relay Space、
`read_shared_relays`、旧 result/wakeup 记录与任何 sibling pull API。它们不能以 compatibility façade 留在
Runtime、Provider、Conductor MCP 或 Renderer 中；不保留迁移期 read alias。

**Canonical Relay grammar：** 使用唯一 fenced `relay` 语法，不接受任意 HTML/XML/Markdown 片段作为路由指令。
有效 block 在完整 `agent_final` 持久化后由确定性 parser 提取；无效或超限 block 只保留为完整 Message 文本。

````text
```relay
topic: game.turn
to: risk_reviewer       # 可选建议；Conductor 可忽略或改选目标
audience: publish       # 可选建议；不产生广播权限
format: text/markdown
---
希望由 Conductor 转给 Reviewer 的正文。
```
````

`to` 与 `audience` 只记录来源 Agent 的建议，绝不是目标白名单、读取授权或自动 dispatch 指令。完整 Message 和
所有 RelayBlock 对 Conductor 可见；其他 Session 一律不可见，直到 Conductor 写入一个可审计的
`MessageForward`。没有 RelayBlock 的文字只是完整 final 的私有其余内容，仍会完整送给 Conductor。

### 5A.0 实施前冻结与直接重做边界

当前工作树中任何已经开始的 `SessionMessage` / `RelayBlock` / Inbox / Invocation 临时代码，都不是本节的
兼容基线。实现开始时先用以下检查把它与本架构逐项比对；含 Shared Relay、Agent pull、visibility、单个
`originMessageId`、仅 Invocation 才回传 final、或 generic Wakeup 的部分必须删除或重写，不能包一层适配器。

```text
允许保留：ProviderPort 的事实映射、Task/Run/Binding 身份、AgentLoop 的既有交互结构
必须重做：消息跨 Session 可见性、final 回传、Forward 谱系、Inbox/Input/Turn 关联、Conductor MCP routing
绝不保留：shared-read、visibility policy、result/wakeup 协作表、Provider-to-Provider 直连、旧 UI fallback
```

在实现任务开始前，维护者必须在本计划对应任务记录中写明：用户动作、唯一 writer、commandId /
expectedRevision、idempotency key、外部 Provider effect、reconcile 路径、验证命令。这个记录是实现追踪，
不是额外的产品真相文件。

### 5A.1 Contract、领域与 Store

**必须修改：**

- `packages/runtime-contracts/src/ids.ts`：增加 `message_*`、`relay_block_*`、`message_forward_batch_*`、
  `message_forward_*`、`forward_selection_*`、`human_intervention_*`、`inbox_*`、`session_turn_*`；移除新路径对
  `wakeup_*` / `invocation_result_*` 的依赖，
  不保留写入或读取 alias。
- `packages/runtime-contracts/src/records.ts`：定义 `SessionMessageRecord`、`RelayBlockRecord`、
  `MessageForwardRecord`、`MessageForwardBatchRecord`、有序 `MessageForwardSelectionRecord`、
  `HumanInterventionRecord`、`SessionInboxItemRecord`、`SessionTurnRecord`。
  RelayBlock 只有内容、来源、digest、parser version、可选 route hint；**没有 visibility 字段**。Forward 必须保存
  Conductor decision turn、command/idempotency/revision fence、目标、mode、所有 selection 与
  `renderedMessageId`。publish batch 必须冻结 canonical ordered target IDs、selection digest、fanoutKey 与每目标
  派生 idempotency key，不能在重试时重新计算目标。Inbox 只保存目标、已渲染 Message、可选 Forward、return target、delivery Input 和状态；
  不保存可被伪造的单个 source/block 字段。`agent_final` 必须带 source LogicalSession/SessionTurn；非 Conductor
  Turn 的 `replyToLogicalSessionId` 必须是该 Run 的 Conductor，并恰好生成一条 Conductor Inbox。Invocation
  保留 assignment/final 关联，但不再决定一条 final 是否回到 Conductor；删除 generic
  `InvocationResultRecord.result` 与 `WakeupRecord`。HumanIntervention 保存认证 human intent、目标 Card/Turn、
  可选 affected Invocation、mode、Card/Conductor Message ID 与 durable state；Turn 保存 `initiator`、`trigger`、
  `humanInterventionId?`、`affectedSessionTurnId?`；`session_agent_return` 明确表示完整 Agent final 作为下一次
  Conductor 输入的触发来源，不能被误记为 recovery 或 Invocation；Provider `user` role 不能替代这些归因字段。
- `packages/runtime-contracts/src/commands.ts`：把 `invoke_agent.contextRefs` 直接替换为 typed ordered
  `messageSelections`（`full_message | relay_block`）；定义仅 Conductor scope 可调用的 `invoke_agent`、
  `relay_message` 和 `publish_message`。`relay_message` 至少有一个 selection；`publish_message` 先持久化 immutable
  batch，再为每个显式目标产生独立 Forward。三者均带 `commandId + taskId + runId + expectedTaskRevision + decidedBySessionTurnId +
  idempotencyKey`，publish 再带 `fanoutKey`；重试不重复 Forward/Inbox/Turn。`invoke_agent` 的 instruction、
  acceptance criteria 和 ordered selections 必须写进 rendered `agent_assignment` envelope，而不是只留在 Invocation
  或临时 tool arguments。增加认证用户的 `session.sendHumanMessage`、`session.interruptThenSend`、
  `session.requestInterrupt` 与 Attention/Permission response command；它们都带 command/revision/idempotency fence，
  目标必须显式且属于当前 Task/Run。Conductor 不获得 generic Runtime command、Provider、Store、filesystem、
  Stop 或 Achieve 权限，只能 scoped cancel 自己的 Invocation/Turn。
- `packages/runtime-contracts/src/read-models.ts`：为用户 Renderer 提供经授权的 Task 消息/Forward/Inbox/Turn
  时间线；为 Conductor tool context 提供同一 Task/Run 的完整消息视图（稳定 `messageId`、来源 Session/Card、完整
  正文、ordered `relayBlockId/topic/format/digest`、Forward audit）；为 Session Agent 的 Provider input 只投影
  它自己的 prompt 与经 Forward/HumanIntervention 渲染的 Message。用户读模型显示真实 initiator/target/trigger、
  Conductor mirror、interrupt 状态与“未发送草稿”阻塞原因；三种读模型不能互相替代，且都不得返回
  ProviderFact payload、native id、cwd、凭据或任意 Artifact 正文。
- `packages/runtime-domain/src/messages.ts`：实现严格 Relay parser、确定性 block ID/digest、selection 验证、
  Forward 的有序谱系、完整/精确 block 的目标正文渲染。parser 不用 LLM、不解析 Agent 产物、不执行或授权路由。
  `to` / `audience` 只能被保留为 hint。
- `packages/runtime-domain/src/session-turns.ts`（或等价的纯 domain owner）：实现 Inbox claim/stage/receipt/
  recover、Turn 的 fact 汇合、非 Conductor final -> Conductor Inbox，以及 Conductor turn 的 user-surface
  completion。Attention、Handoff 与 Stop 的 active 判定必须基于 InputSubmission / SessionTurn；Invocation 仅在
  存在时作为附属元数据。实现 HumanIntervention 的 direct / interrupt-then-send 状态机、用户优先冲突规则、
  late final 原归因与 human Turn 不结算 Invocation。不得让 `Invocation` 成为普通 relay 或 final 回传的前提。
- `packages/runtime-domain/src/task-timeline.ts`：只由 Message / Forward / Inbox / Input / Turn 的 durable 记录
  投影对话、派发、relay、publish 与 delivery；不把 ProviderFact 泛型 payload 伪装为 Agent 正文。
- `packages/runtime-store/src/sqlite.ts`、`repositories.ts`：新增 `session_messages`、`relay_blocks`、
  `message_forward_batches`、`message_forwards`、`message_forward_selections`、`human_interventions`、
  `session_inbox_items`、`session_turns`
  与必要索引；对 batch `(task_id, run_id, idempotency_key)`、每目标 `(publish_batch_id, target_logical_session_id)`
  建唯一约束。Input 保存
  `inbox_item_id`，Turn 保存 `input_submission_id`。以 versioned migration 删除 `wakeups`、
  `invocation_results.result_json`、visibility/shared-relay schema 和所有旧读 API。旧活跃 Run 标记为
  `migration-interrupted` 的失败历史、Task 解除 active Run 后回到 queued，必须在新模型中显式 Start；保留
  Template、Task Architecture、历史 Run、Workspace Authorization 与已验证 Artifact（已删除 Invocation 来源置空），
  但绝不伪造 `agent_final`、双写或恢复旧 routing path。

**完成条件：** Message、RelayBlock、Forward/ForwardBatch、HumanIntervention、Inbox、Input 与 Turn 各有唯一
writer；相同 ProviderFact/command 重放不会重复 final、block、Forward、Card/Conductor mirror Inbox 或 native
delivery；invalid block 和来源 Agent 的 route hint 没有任何自动路由副作用；human direct 不广播、不伪装为
Conductor Invocation，busy Card 在 interrupt confirmed 前没有新 InputSubmission。

### 5A.2 Runtime、Provider 与 Conductor 工具

**必须修改：**

- `packages/runtime-application/src/runtime-application.ts`：Task Start 创建 Task Goal Message + Root Conductor
  InboxItem；user input、assignment、relay、publish 与 worker return 都先落 Message/Forward/Inbox，再由一个
  Turn Coordinator 创建 InputSubmission/outbox。删除 `turn_completed -> InvocationResult + Wakeup` 的旧链。每个
  非 Conductor SessionTurn 的 final 完成时，无条件创建 Conductor InboxItem；不能等待或依赖 Invocation。
  `publish_message` 的 outbox/reconcile 必须以已持久化 batch target snapshot 补齐缺失目标；不重复已有 target，也不接受
  同一 batch key 变更 selections/targets。认证 human 直达 Card 时先写 HumanIntervention，再在同一可恢复用例中
  创建 Card 完整 Message 与 Conductor 完整 mirror；没有 sibling fan-out。busy Card 只写 interrupt intent，旧 Turn
  安全收束前不创建新用户 Message/Input/Turn。
- Turn Coordinator 只能在 target current Binding 无 active turn、无 unresolved Attention、无 Handoff、Task 未
  Stop 时 claim。`input_received` 才标记 delivered；`transport_unknown` 进入 ambiguous/reconcile，绝不自动重发。
  当 Conductor 可安全接收时，系统把其 InboxItem stage 成下一条 Input，这就是唯一 durable “唤醒”机制。
  Host 可以发只含引用的 `WakeConductor` 内部信号，但没有 Wakeup 表/record；恢复只扫描 Inbox，送给模型的
  Input 必须包含完整 Message 正文与来源 envelope。
- 三个 Provider adapter：`packages/provider-opencode/`、`packages/provider-codex/`、
  `packages/provider-claude-code/` 都必须把真实原生终态映射为可关联的
  `assistant_final(content, inputSubmissionId/sessionTurnId)` 与 terminal fact。Codex/OpenCode 先补真实正文获取
  probe；没有可靠 final 内容的 Profile 不得宣称支持自动 Session Agent 回信。
- `packages/conductor-tools/src/runtime-conductor-gateway.ts` 与 MCP schema：只暴露
  `invoke_agent(messageSelections)`、`relay_message(messageSelections)`、`publish_message(messageSelections, targets)`
  以及仅对当前 Conductor 自己 Invocation/Turn 的 `request_scoped_interrupt` 和必要 Task 状态查询。删除正常协作
  的 `read_result(s)` pull 路径与全部 `read_shared_relays`；Session Agent
  不获得任一 routing tool。`relay_message` 不创建 Invocation，适用于游戏/模拟中的 A -> B 普通消息；两者的
  target 仍只能由 Conductor 命令确定。Conductor 不能发 human command、回复 Permission、Stop/Restart Task 或
  撤回 HumanIntervention。
- `apps/runtime-host/src/runtime-host.ts`：在 ProviderFact reconcile、turn 空闲、Handoff 完成与 Host recovery 后驱动
  Turn Coordinator；Provider Adapter、Renderer 和 Conductor 都不能绕过它直接向 Provider 写消息。

**完成条件：** A final 自动、完整回到 Conductor Inbox；Conductor 可选 full 转 A -> B，也可只转一个 block；
B 收到后无论是 Invocation 还是普通 relay 都完整回到 Conductor；无 Provider-to-Provider 直连、无 polling、无
raw provider transcript 传递。

### 5A.3 Conductor 转递审计、UI 与权限

- `MessageForward` 是唯一的跨 Session 可见性开关。Conductor 的每个 selection 都必须记录来源、顺序、digest、
  mode、目标、decision turn、command/idempotency/revision fence 与渲染后的目标 Message；跨 Task/Run、未知
  Message/block、未知目标、重复 block、非 Conductor decision turn 或 stale Conductor command 都拒绝。相同 key
  的重试返回同一结果，有意再次转发必须使用新 key。publish audit 还显示 immutable batch、目标快照及每个 target
  的 delivery 状态。来源 Agent 的 `to` / `audience` 提示只显示给 Conductor，不产生权限。
- 公共内容只由 `publish_message` 的显式 fan-out 实现：每个目标有各自的 Forward/Inbox/receipt/Turn。不存在
  Shared Relay Space、topic subscription、隐式广播、Agent pull 或“一个公开块所有 Agent 自动可读”。
- `packages/workbench-ui/src/agent-loop/agent-loop-model.ts`、`agent-loop-runtime-controller.ts`、
  `AgentLoopSessionPresentation.tsx`：保持既有 AgentLoop 三栏与 Composer；显示完整 final、可折叠 RelayBlock、
  Conductor 的 Forward audit、Inbox/Turn 状态与目标会收到的预览。Task 普通 Composer 固定目标 Conductor；Card
  Composer 明确显示 `human -> Card X`、Conductor 全文同步与 busy 时 `interrupt_then_send`，且中断确认前文字只是
  本地草稿。Renderer 只提交 typed commands，不声明 initiator、不解析 block、不持久化或直接投递，也不把
  Session Agent 变成可浏览 sibling transcript 的聊天界面。
- 用户 Renderer 可以在其 Task 审计视图查看完整协作消息；这是用户权限，不等于 Agent 之间互相可读。全量
  ProviderFact、native id、cwd、credential、Artifact 正文均不进入 Renderer 或 Conductor routing context。

### 5A.4 测试与真实调试门

以下案例是实现前必须先写成失败测试、实现后必须同时通过的验收矩阵：

| 案例 | 输入与路径 | 必须证明 |
| --- | --- | --- |
| A 无 RelayBlock 回信 | A Turn final -> Conductor Inbox | Conductor 收到 A 的完整正文；B 没有 Inbox/Provider input；不产生 Achieve。 |
| full 转发 | Conductor 选 A 的 `full_message` -> B `invoke_agent` | B 得到 A 的完整原文（包含全部 block）；B final 仍经自己的 Turn 完整回 Conductor。 |
| 精确 block 转发 | Conductor 选 A 的一个 `relay_block` -> B | B 只得到该 block 的正文、来源、topic、format；绝不得到 A 的其他文字。 |
| 多 block 有序选择 | A final 含 3 个 block；Conductor 依次选 #3、#1 给 B | B 只收到 #3 后 #1；未选 block 和 A 的其余正文不泄漏；A 全文仍完整留给 Conductor。 |
| A -> B -> A 游戏回合 | 两次 `relay_message`，每次由 Conductor 选择 block | 没有 Provider-to-Provider 直连；两个 Agent 的完整 final 都进入 Conductor；Forward/Turn 链可审计。 |
| 公共棋盘 | Conductor `publish_message` 同一 block 给 A/B/C | 三个独立 target delivery；没有 shared store/read tool，任一 target 的失败不吞掉其余状态。 |
| human direct 空闲 Card | 用户明确发给 A | 一个 HumanIntervention；A 收到完整 user_input；Conductor 收到完整 mirror 与 human/target 归因；B/C 无 Inbox；A final 不创建/结算 Invocation。 |
| busy Card 中断后发送 | A 正在处理 Conductor Invocation；用户写新消息 | 先只有本地草稿 + durable interrupt intent；confirmed interrupted 后才创建 human Turn；无并发/queue；旧 Invocation 不归到新 Turn。 |
| interrupt 与 late final 竞态 | interrupt 请求后旧 A Turn 先返回 final | 保存并回传旧 final，保留 conductor_invocation 归因和 interruptionRequested；随后再安全创建 human Turn；不重复 final/notice。 |
| interrupt unknown | Provider 未证明中断完成 | 用户文字保持未发送；没有新 Message/Input/Turn；UI 可等待、重试或放弃；Conductor 不能覆盖。 |
| 用户优先冲突 | 用户 Attention/Permission/scoped interrupt 与 Conductor cancel 同时到达 | 认证用户命令优先；Conductor 只可取消自己的 Invocation/Turn，不能代答 Permission、Stop Task 或撤回人类内容。 |
| fan-out 中断恢复 | publish batch 已创建 A/B，Host 在 C 前重启并以相同 key 重试 | 只补 C；A/B 不生成第二条 Forward/Inbox/Input；不同 target 集或 selection digest 的重试被拒绝。 |
| 路由建议不是权限 | A 写 `to` / `audience: publish`，Conductor 不转或改转 C | 不创建 B/C Inbox；或只创建 Conductor 实际选择的 C；来源提示无自动副作用。 |
| 乱序与重放 | `assistant_final` / terminal 任意先后、重复、重连 replay | 仅一个完整 final、一个 Conductor Inbox、一个 finalMessageId；不重复 native delivery。 |
| 忙碌与恢复 | Conductor busy/Attention/Handoff/Stop，或 Host 在 pending/staged/ambiguous 重启 | Inbox 正确 pending/suppressed；不会并发 turn、不会自动重发 ambiguous、不会丢失 final。 |
| 无法取回 final | Provider 只有 terminal、没有关联内容 | Runtime 只写可读 `runtime_notice` 给 Conductor；不伪造 Agent final 或 RelayBlock。 |
| Provider 三家一致 | OpenCode、Codex、Claude Code 各跑 final-content + receipt + terminal probe | 任一家缺少证据即该 Profile 在自动 Session Agent 协作模式 unavailable。 |
| Browser/Desktop 旅程 | Task Goal -> Conductor -> A -> Conductor -> block/full -> B -> Conductor | 保留 AgentLoop 页面和交互；无 native id、raw Provider payload、cwd、Artifact 正文或 shared-read UI 泄漏。 |

层级测试必须覆盖：domain 的 parser/selection/turn state、store 的 migration/forward selection ordering、
application 的 durable outbox/reconcile、fake Provider 的 receipt/terminal 乱序、Conductor MCP 的 scope 拒绝、
Runtime Bridge 的脱敏错误、Browser 与 Electron 的同一旅程。任何截图、单一 Provider happy-path、UI 能打开或
Agent 自称完成都不构成替代。

**Phase 5A 完成门：** 上述 contracts、domain/store、fake Provider、HumanIntervention/scoped-interrupt harness、
Host restart、Conductor MCP、Browser、
Desktop 与每家被允许进入自动协作模式的真实 Provider probe 全部通过，且代码中不存在 shared-read、visibility
或旧 result/wakeup 协作路径，才可以称消息 Runtime 已统一。

**实施记录（2026-08-09）：** Phase 5A 的离线 kernel cutover 已按本节直接重做：contracts、domain/parser、
SQLite v9 owner stores、Runtime application/coordinator、Conductor gateway、Runtime Bridge、AgentLoop Session Tabs /
Composer / HumanIntervention 投影，以及 Codex/Claude managed turn 的 final-content 关联均已接入新 Message / Forward /
Inbox / Input / SessionTurn 谱系。focused harness 已覆盖无 block 回传、full/block 有序选择、publish fan-out
部分写入恢复、human idle/busy/unknown/late-final/receipt-crash、乱序重放、scope 拒绝与 UI draft/tab
无副作用；全量 `npm run verify` 是本次切换的本地完成检查。正式 Web 入口已用隔离数据和锁定 Codex
`0.146.0` 跑通一个真实 Task：Browser 创建/启动 → Task Goal receipt/final → Host restart 后恢复同一 final →
Composer follow-up receipt/live final → idle Stop → Host restart 恢复 release/stopped；页面无 framework overlay，
console 无 warning/error。该证据覆盖单 Conductor Session，不替代多 Session A → B 或 Electron 旅程。

本记录**不表示 Phase 5A 完成门已通过**：OpenCode `1.18.15` 已取得可审计的真实 final-content/tool/activity
live+recovery probe，但它既不匹配当前 `1.18.13` managed pin，也未证明 target-correlated interrupt；Claude
Code 仍缺完整 managed lifecycle 原生证据，真实多 Session A → Conductor → B Browser 旅程与 Electron
原生 Provider 旅程尚未取得证据。未通过这些门之前，除上表明确列出的 Codex 单 Session 能力外，不得扩大
宣称自动 Session Agent 协作；Phase 5B/5C 的 Profile/Meta 设计门也不得由本次 kernel 实现替代。

## Phase 5B — Unified Session Profile Selection And Provider Handoff

**目标：** 在不替换 AgentLoop 任务三栏、Task 创建、Template Studio、Timeline、Artifact、Achieve 或
现有 Composer 交互的前提下，补齐统一对话页缺失的 Provider/Profile 选择。Runtime 只拥有一个
provider-neutral `session.select_profile` / `session.handoff` 用例；Codex、OpenCode、Claude Code 继续只
实现既有 `ProviderPort.ensureBinding`、`submitDelivery`、`observe/reconcile`、`interrupt` 和
`presentation`。不为任何 Provider 编写跨 Provider adapter。

### 5B.0 先冻结用户行为与错误边界

**参考证据（不引入依赖）：** 本地镜像 `.references/claudian` 的 `c23f804` 中，
`src/features/chat/tabs/Tab.ts:1311-1348` 只让 blank/unbound Tab 选择 Provider；`:1351-1357` 明确拒绝
bound conversation 的跨 Provider 修改；`TabModelSelectionCoordinator.ts:33-110` 提供 revision fence、
初始化去重与失败回滚。吸收这些选择并发语义，不复制 Obsidian host、Tab、Vault 或它的“必须新 Conversation”
产品限制。

```text
Template Studio
  -> 用户手工配置多个 Execution Profile（Provider / model / pin / policy）
  -> Card 保留一个 default executionProfileId
  -> 发布后所有候选 Profile 冻结进 Task Architecture Snapshot

Task Session（未绑定）
  -> Provider/Profile Picker 选择 Snapshot 内候选
  -> Runtime readiness 通过才持久化选项；不创建 native session

Task Session（已绑定）
  -> 用户点“切换执行 Provider / Model”
  -> 显示 source、target、权限差异、不可用原因、将传递的 Handoff Context
  -> 显式确认 session.handoff
  -> 新 Binding ready 后 stage 第一条 Context；它是正常 InputSubmission
  -> 只有该 Context 得到 receipt/reconcile evidence 后 target 才成为 current；source 留在 lineage
```

禁止以下行为：修改既有 Binding 的 `provider`、`nativeBindingRef`、`executionProfileId` 或 ProviderFact；把
source 的 native thread/session/token/state 传给 target；自动 Stop source；以 Provider finish、Agent claim
或 Handoff successful 触发 Achieve；在 Renderer 持久化 Provider 真实状态；使用全局“上一次 Provider”改写
其他 Task；把 unavailable Profile 悄悄替换为 OpenCode/Codex/Claude Code。

`session.handoff` 的 v1 前置条件是 source 为 current Binding、没有 active InputSubmission / SessionTurn（若有
Invocation 只是其附属元数据）、没有 unresolved
Attention，且 target Profile 已通过 Host capability gate。若不满足，UI 显示原因并只允许用户先等待或显式
Stop；v1 不提供隐式排队、隐藏 cancellation 或“复制整个原生对话”。模型变更与跨 Provider 变更都走这个
相同路径。未来 provider-native in-place model reconfigure 必须另立通用 Port capability、原生证据和测试，
不能在 Runtime 写 Provider 分支。

### 5B.1 先补足可审阅的 Unified Session Projection

当前 `ProviderFact` / Timeline 只能证明 lifecycle，不能安全地把 raw provider payload 当作跨 Provider 的
聊天上下文。因此 Handoff UI 之前必须先把既有统一对话页补为 typed projection，而不是重新嵌入 OpenCode
WebUI：

- `packages/runtime-contracts/src/read-models.ts`：协作正文继续来自不可变 `SessionMessage`；另加入按 Binding /
  SessionTurn 归属的 `ProviderActivityReadModel`（assistant progress、tool、change、web）和后续 typed
  attention/handoff/artifact references。每一项必须有稳定 id、source Binding 和用户审计展示范围；只有完整
  SessionMessage 或允许的 RelayBlock 才能成为 Handoff context。不得透传 raw Provider event、native id、cwd
  或 credentials。
- `packages/provider-opencode/`、`packages/provider-codex/`、`packages/provider-claude-code/`：只在 adapter
  边界把各自原生 stream/history 规范化为可去重 ProviderFact / presentation facts；不把 Provider UI、HTML
  页面或 private transcript 格式带进 Runtime。未证明的 transcript/tool/change capability 显示 unavailable，
  不能伪造相同内容。
- `packages/runtime-application/src/runtime-application.ts`、`packages/runtime-store/src/repositories.ts`：以
  ProviderFact 的 durable、可重建投影产生 transcript/change/attention read model；read builder 无副作用，
  不以“为了补全历史”为由发送输入、启动 Binding 或修复 Provider state。
- `packages/workbench-ui/src/agent-loop/agent-loop-model.ts` 与
  `AgentLoopSessionPresentation.tsx`：用这些 typed items 还原原 AgentLoop 的会话、工具、变更、权限、
  artifact 与 composer 交互；旧 OpenCode iframe 只作为历史参考，不能回迁。

`HandoffContext` 只允许引用用户在 UI 中审阅后选择的完整 SessionMessage 或允许的 RelayBlock。产物可以
由用户先在 final Message 中说明，但 Runtime 不读取/解析其正文；源 Session 缺少可安全选择的 Message 时，
切换按钮必须显示“当前 Provider 尚无法安全导出上下文”，而不是把 native transcript 偷传给 target。

**完成条件：** 同一 Session Workspace 可清楚显示 source Binding segment 的用户/助手/工具/变更/权限事实；
各 Binding segment 不混淆；选择 Handoff context 可以由测试证明只包含 UI 可见、授权项。

### 5B.2 Contract、领域与 Store：先形成一个可证明的切换内核

**必须修改：**

- `packages/runtime-contracts/src/ids.ts`：加入 `SessionHandoffId` / `handoff_*`，不暴露 native id。
- `packages/runtime-contracts/src/commands.ts`：加入明确用户命令
  `session.select_profile`（仅 unbound Session）和 `session.handoff`（已绑定 Session）；两者都带
  `commandId + expectedRevision + expectedSessionRevision`。handoff 还必须带 source
  `bindingId + bindingRevision`、target `executionProfileId`、`sessionHandoffId`、`messageSelections` 与
  idempotency key。这里的 context 只能是 typed `messageSelections`（完整 Message 或允许的 RelayBlock），
  不得接受原始 Provider 名称、模型字符串、cwd、Artifact 正文或 native state。
- `packages/runtime-contracts/src/records.ts`：把 `LogicalSessionRecord.executionProfileId` 明确拆成 Card
  `defaultExecutionProfileId`、用户 `selectedExecutionProfileId`、`currentBindingId` 与 session revision；为
  `ProviderSessionBindingRecord` 加 immutable predecessor/segment lineage、routing state
  (`current | handoff_pending | superseded`)；新增 `SessionHandoffRecord`，状态至少为
  `requested | provisioning_target | target_ready | context_staged | awaiting_receipt | completed | failed |
  recovery_required | cancelled`。Provider 的 transport status 与 routing status 分开，`superseded` 绝不等于
  native 已停止。
- `packages/runtime-contracts/src/read-models.ts`：定义可由 typed Session Profile Options query 返回的
  `SessionProfileOptionReadModel`（profile、provider、model、pin、policy、availability、selected/default），
  并为 Task projection 增加 `CurrentBindingReadModel`、`BindingLineageReadModel` 与
  `SessionHandoffReadModel`。不返回 cwd、
  credentials、native refs、raw streams 或 opaque provider state。
- `packages/runtime-domain/src/bindings.ts`、`packages/runtime-domain/src/tasks.ts`：实现 unbound profile
  selection、handoff state transition、source fencing、target promotion 和 stale command rejection 的纯函数；
  `packages/runtime-domain/src/session-bootstrap.ts` 必须移除“LogicalSession Profile 等于 Card default
  Profile”的错误不变式，bootstrap 仍只由 Card 身份、prompt 和 scope 编译；
  `packages/runtime-domain/src/templates.ts` 只校验 Profile reference 存在于 frozen Architecture，不把 Host
  availability 当成模板格式校验。
- `packages/runtime-store/src/sqlite.ts`、`packages/runtime-store/src/repositories.ts`：新增
  `session_handoffs` 与 lineage/current-routing 字段、索引、迁移和 owner-scoped repository methods。
  把 `findBindingForLogicalSession` 拆成 `getCurrentBinding` 与 `listBindingsForLogicalSession`；禁止
  `ORDER BY created_at LIMIT 1` 充当产品 routing。当前正式 schema 的已有 Binding 必须做一次可验证的
  canonical migration/backfill（同一 LogicalSession 的当前实现本已选择 latest row，则迁移显式记录该选择）；
  迁移后删除旧查询入口、双写与 alias，不保留 compatibility façade。

**完成条件：** 在纯 domain/store 测试中能证明：同一 LogicalSession 的 source / target Binding 可顺序
存在；source native identity 不变；target 不包含任何 source native field；target 失败时 source 仍为 current；
旧 Binding 的 late ProviderFact 不会改写 target；重复 commandId/idempotency key 不生成第二个 Handoff 或
Binding。

### 5B.3 Runtime Application、Host readiness 与 outbox

**必须修改：**

- `packages/runtime-application/src/runtime-application.ts`：新增上述两个 command handler；所有普通
  input、Card invocation、Attention、presentation、reconcile 和 Stop 改为使用明确的 current/listed Binding。
  target `binding_observed` 只允许 stage 正常、可见的 Handoff Context Input；只有 target 的
  `input_received` 才能提升 current pointer、更新 selected Profile 并把 source 标为 superseded。source
  不被 `releaseBinding` 或 `requestInterrupt` 自动处理。
- 同文件的 `profileForBinding`、`#dispatchOutbox`、`reconcileBinding`、`observeBinding`、
  `#assertBindingsInterruptAvailable` 与 `#start/#restart/#invoke` 路径：Profile 一律从 Binding 或 selected
  LogicalSession 的 frozen Architecture reference 解析。把当前 `task.start` 对全部
  `architecture.definition.executionProfiles` 的 availability 检查改为只 gate 当前 Conductor Profile；Worker/
  alternative Profile 在 materialize/selection 时再 gate，否则一个不可用备用 Provider 会错误阻止可用
  Provider 启动。
- `packages/runtime-application/src/provider.ts` 与 `packages/provider-port/src/index.ts`：复用现有
  `describeCapabilities`、`ensureBinding`、`submitDelivery`，仅补足 provider-neutral 的 Profile readiness
  query/cache contract。因为 `RuntimeApplication.read()` 是同步投影，而 capability 探测是异步调用，新增
  具体 typed Session Profile Options query（并在 command 时重复 preflight），不能把原生探测塞进 read
  builder。v1 不添加 `switchProvider`、`migrateThread` 或 Provider-specific reconfigure API。
- `apps/runtime-host/src/runtime-host.ts`、`apps/runtime-host/src/provider-composition.ts`：Host-owned profile
  readiness cache/invalidation，版本/pin/capability 变化只发 semantic Runtime invalidation。Renderer 读它
  不会启动 Provider native session。
- `apps/runtime-host/src/runtime-bridge.ts` 与 `packages/runtime-client/src/http.ts`：先修正已有
  `runtime_bridge_request_failed:400`。Bridge 必须传递一个 typed、脱敏的 Runtime error envelope（例如
  `provider_unavailable:codex`），Http client 解析该 envelope；不再丢弃 400 response body 只显示状态码。
  UI 根据 Profile readiness 预先禁用 Start/Handoff，command handler 仍做最终 gate。
- `packages/runtime-client/src/index.ts` 及 Desktop preload/Browser transport 的既有 RuntimeClient
  composition：加入上述 typed Session Profile Options query，确保 Web 与 Electron 走同一 request/result
  schema，不在任一 Renderer 直连 Provider。

**完成条件：** Runtime 不出现 `provider === "codex" | "opencode" | "claude-code"` 的业务分支；所有
target creation 都是同一 outbox/ProviderFact 链；Host 重启后能从 durable handoff/intents 继续 reconcile，
不重复 native target；Provider unavailable 从 Host 一直到 Browser/Desktop 显示同一个具体原因。

### 5B.4 保留 AgentLoop UI，替换的仅是旧 Provider 对话承接面

**必须修改：**

- `packages/workbench-ui/src/agent-loop/agent-loop-model.ts`：把新 read models 投影成 ViewModel，不猜测
  Binding 当前性，不依据 timeline 文本推断 Provider 状态。
- `packages/workbench-ui/src/agent-loop/agent-loop-runtime-controller.ts`：新增 typed selection/handoff methods；
  保持 `createInputSubmissionIntent`、Stop、Attention、Achieve 的现有职责，不在 UI 直接调 Provider。
- `packages/workbench-ui/src/agent-loop/AgentLoopSessionPresentation.tsx`：在现有 Unified Session Workspace
  的 header/composer 工具栏增加 Provider/Profile Picker、readiness badge、Binding lineage 与 Handoff
  confirmation sheet。继续保留对话、Composer、Stop、typed Attention、Timeline/Artifact 入口；不要把它
  换成裸的 Runtime 控制台。source/target transcript 通过 Binding lineage 可切换查看，handoff line 是清晰的
  timeline item，不能混在两家 Provider 的原生消息里假装同一 native thread。
- `packages/workbench-ui/src/agent-loop/AgentLoopRuntimeApp.tsx` 与
  `packages/workbench-ui/src/agent-loop/AgentLoopTaskSurface.tsx`：只负责把上述 view state 和 dialog
  intent 接到 controller；保持左侧 Task 列表、中央对话、右侧 Session Directory/Timeline/Artifact 的既有
  AgentLoop 信息架构。
- `packages/workbench-ui/src/agent-loop/AgentLoopTemplateStudio.tsx` 与
  `agent-loop-template-studio-controller.ts`：恢复/补齐可见的 Profile CRUD 与 Card default Profile 编辑；
  Provider、model、version、permission policy 都可手动调，发布前可校验、导入导出时保留。此修改只影响未来
  Template Version/Task Snapshot，绝不回写已存在 Task。
- `packages/workbench-ui/src/agent-loop/agent-loop.css`：只为上述控件增加局部样式；不重做
  AgentLoop layout，也不添加 Provider brand 的业务分支。

Renderer 可以采用 Claudian 式的 `SessionTargetSelectionCoordinator` 来处理快速点击：每次选择有递增 revision，
同 target 的 readiness request 合并，后一次选择胜出，失败只在仍为当前选择时回滚到稳定 UI。它只保存
短暂 view state；真正 profile selection、handoff、Binding routing、failure 均以 Runtime command/result
为准。不要复制 Claudian 的 Obsidian `Tab`、`TabManager`、Vault、全局 `lastSelectedChatModel`、native history
directory 或 warm process pool。

**完成条件：** Browser 与 Desktop 看到相同 AgentLoop 交互：未绑定时可选 Profile；已绑定时打开明确
Handoff 对话框；unavailable 有原因和 Setup/Refresh 动作；快速切换不把旧结果覆盖新选择；没有 iframe、
raw stream、PTY 或 Provider SDK 进入 Renderer。

### 5B.5 测试与真实调试矩阵（实现前先写失败用例）

| 层 | 文件/路径 | 必须证明 |
| --- | --- | --- |
| Domain | `packages/runtime-domain/src/domain.test.ts`（必要时拆出 `bindings.test.ts`） | unbound select、handoff transition、source fence、stale revision、重复 idempotency |
| Store | `packages/runtime-store/src/sqlite.test.ts`、`repositories.test.ts` | migration/backfill、current pointer、lineage 查询、无 latest-row 猜测 |
| Application | `packages/runtime-application/src/runtime-application.test.ts` | outbox ordering、target failure rollback、late source fact、restart reconcile、Stop covers source+target、Achieve 独立 |
| Port/Adapter | `packages/provider-port/src/provider-port.test.ts`；三家 adapter/host bridge test | target request never receives source `nativeBindingRef`/state；只走 ensure/submit/reconcile |
| Host/Bridge | `apps/runtime-host/src/runtime-host.test.ts`、`runtime-bridge.test.ts` | readiness invalidation、typed 400 error envelope、profile gate |
| Renderer | `agent-loop-model.test.ts`、`agent-loop-runtime-controller.test.ts`、`AgentLoopSessionPresentation.test.tsx`、`AgentLoopRuntimeApp.test.tsx`、`AgentLoopTemplateStudio.test.tsx` | picker、manual profile editor、confirmation、rapid-click latest-wins、unavailable、lineage，且保留现有交互 |
| E2E | `tests/e2e/` 新增 Browser + Desktop IPC journey | create Task → unbound select → Start → handoff → receipt → Stop/Achieve；桥接不泄露 native id |
| Native | `tests/integration/native-provider-lifecycle-smoke.test.ts` | 对每个宣称可用的 Provider 跑 create/handoff target/receipt/reconcile/restart/interrupt；未有证据则 UI unavailable |

真实调试必须至少重放以下失败案例：

1. Template 同时含 Codex、OpenCode、Claude Code Profile，但只有 Codex 当前 Host 通过 managed-core gate：
   Codex 可以 Start，另两项显示 unavailable，不能导致 400 或自动回退。
2. 已绑定 Codex Session 有未完成 turn/Attention 时尝试换 Claude：Runtime 拒绝，不会中断 Codex、不创建
   Claude Binding。
3. idle Codex → OpenCode handoff：target Binding 的 request 不含 Codex native ref；target observed 后只
   stage context，只有 target Input receipt 后才 current；用户确认的 context 只有一条 target Input receipt。
4. target transport accepted 后 Host 重启：reconcile 不能再创建第二个 target；source/target lineage 和
   handoff status 仍可读。
5. target create 失败、profile pin 改变、或 selection A→B→A 快速点击：最终 UI 与 durable Runtime 都只保留
   当前用户选择，source 仍可继续。
6. 用户随时 Achieve：无论 Handoff、Agent output、Artifact 或 Provider terminal 如何，只有用户 command
   写 achievement，active Run 不被偷偷结束。

**Phase 5B 完成门：** 以上 contract、fake-provider、Bridge、Browser、Desktop 和至少一个每家已宣称
available 的原生 Provider 证据全部通过后，才可以说“统一 Provider 对话承接面完成”。页面截图、一个
Provider 的 happy-path、adapter 编译通过或 Agent 自称完成均不构成该门的替代。

## Phase 5C — Managed Chat Presentation And Task-local Session Tabs

**目标：** 用一个 Provider-neutral Chat shell 显示 Conductor/Card 的真实协作 Message 和 human-only Provider
活动；用 Task-local Session Tabs 快速切换已 materialize LogicalSession，而不让 Tab/Chat 成为第二个 writer。

**依赖：** Phase 5A 的 Message/HumanIntervention/Turn provenance 与 Phase 5B 的 Profile/Binding read model。
未通过 5A 时不得用 UI 临时消息模拟 human direct；未通过 5B 时不得从 Provider 页面或 raw payload拼状态。

**必须修改：**

- `packages/runtime-contracts/src/read-models.ts`：定义 `ChatSessionPresentation`、稳定 ID 的
  `collaboration_message | provider_activity | attention | handoff | artifact_or_change` item、明确 target 的
  composer capability/blocked reason、Session summary 与 unread/attention/failure 状态；不返回 raw native ID、
  cwd、credential 或 Provider payload。
- `packages/workbench-ui/src/agent-loop/`：增加/重构 `SessionTabBar`、统一 `ChatShell`、Session Header、
  Conversation/Activity renderer 与 Conductor/Card 两类 Composer。Conductor 固定首 Tab；Worker 只在 materialize
  后出现；无 `+`；隐藏/排序/选中只在 Renderer view state。Task 总入口永远发送给 Conductor；Card Composer
  永远显示目标与“全文同步给 Conductor”，busy 时只显示 interrupt-then-send。
- `agent-loop-runtime-controller.ts`：Tab selection 只更新 view state；发送/Attention/interrupt/Handoff 分别调用
  5A/5B 的 typed command。不得因 selectedLogicalSessionId 偷偷改变 Task Composer target。
- Provider activity normalizer/read projection：只接收已有证据支持的 tool/change/stream/diagnostic 事实；没有
  证据时显示 unavailable，不创建 SessionMessage、RelayBlock 或 Conductor routing selection。
- 活动事实固定使用 `activity_observed(schemaVersion=1)`：类别仅
  `assistant_progress | tool | change | web`，阶段仅 `started | progress | completed | failed`，内容有界并经
  Adapter 脱敏；live delta 采用 append，completed/reconcile snapshot 采用 replace。Codex/OpenCode focused
  harness 必须对齐这一语义，并分别证明唯一 final/terminal；不得把 reasoning、raw args/result、cwd 或 native id
  带进 Renderer。
- Conversation 的执行树参考 Claudian 的紧凑 header + 左侧细轨道语义，但完成判断来自 Runtime：运行中与
  awaiting-final 强制展开；仅 `finalMessageId` 已存在且 Turn returned/completed 后自动收起，final Message 常驻；
  失败、取消、ambiguous 或缺 final 保持展开，用户手动展开仅写 Renderer view state。

**先写失败 harness：**

1. 选中 Worker Tab 后 Task Composer 仍发送给 Conductor；Card Composer 单独、明确发送给该 Worker；
2. 切换/隐藏/overflow Tab 不调用 Start/Stop/interrupt/Handoff，不改变 LogicalSession/Binding/Turn；
3. 未 materialize Card 只能预览，点击不能偷偷创建 Session；
4. provider_activity 没有 messageId/selection capability，不能被 Relay parser、Conductor gateway 或 sibling 读取；
5. running/tool/stream 活动默认展开；规范 final + terminal 后自动收起但 final 正文仍可见；手动展开可审计；
   failed、cancelled、ambiguous 与缺 final 不收起；
6. busy Card 草稿在 interrupt confirmed 前保持未发送，Browser/Desktop 都显示同一状态；
7. Attention、failure、unread final 的状态不被 selected 样式遮蔽，并有非颜色标识。

**完成条件：** focused component/controller tests、Runtime Bridge read-model contract、Browser harness 与 Electron
IPC harness 全部通过；同一 Task 在两个 Surface 上显示相同 Session/Message/Intervention/Binding 事实；不存在
Provider-specific Chat 页面、第二 Composer writer、选中即隐式直投或 raw activity 可路由路径。

**实施记录（2026-08-09）：** `activity_observed` 合同、Store/domain 投影、不可路由边界、Codex/OpenCode
live+recovery 映射，以及参考 Claudian 的紧凑执行 header / 左侧细轨道已接入。执行组在 running 时展开，仅在
canonical `finalMessageId` 与 returned/completed 同时存在时自动收起；Provider assistant snapshot 不再重复展示
canonical final，失败、歧义、缺 final 与 0-step terminal 仍保持可见。1,000 个 activity invalidation 的完整 read
由 1,000 次降为 1 次，flight 中 semantic invalidation 只追加一次尾刷新；同 dedup identity 的语义冲突、stale
binding revision 与跨 Turn correlation 均 fail closed。

最终代码已通过 `npm run verify`（Vitest 200 passed / 2 opt-in skipped、Desktop IPC 13 passed、production build）、
`npm run test:integration`（49 passed / 2 opt-in skipped）和双 Provider parity harness。锁定 Codex `0.146.0`
真实 shell/reconcile/restart smoke 通过，delivery 有 3 条 activity，恢复有 2 条 replace activity，final/terminal
各唯一；OpenCode `1.18.15` 隔离 `read` tool + SSE/history smoke 同样通过 tool/assistant 全阶段、唯一 final/terminal
与 recovery。正式 Browser 用隔离 Runtime DB 重新启动真实 Task，再发送 `pwd` follow-up：运行中组展开，完成后
自动收为 2 步，final 常驻为 `BROWSER_TOOL_STREAM_FINAL_OK`，展开只显示一条 assistant progress 与一条
Shell command，cwd 显示为 `[workspace]`；390px 无横向溢出、Vite/React overlay 不存在、console 0 warning/error。

本记录仍**不宣称 Phase 5C 完成**：OpenCode content/activity probe 不等于匹配 `1.18.13` pin 与 interrupt 的
managed-core 证据；真实多 Session、Electron 原生 Provider 视觉旅程和 Browser/Desktop 同事实对照仍须关闭。

## Phase 5D — Configuration Meta Agent And Task Setup

**目标：** 实现一个配置期 Meta Agent，在 Template Design 与 Task Setup 两个对象隔离的模式中提出可审阅
Draft patch；用户仍独立确认 apply、Publish、Workspace、Create 与 Start。

**设计门状态：已关闭。** `architecture.md` 的“Phase 5D v1 配置契约”已经冻结有序 typed Task inputs、确定性
`task_goal` compiler、Host-owned Meta Profile option、durable retention、proposal 原子确认、双栏完整 Task Setup
Surface、两种 Meta mode 隔离与 HTML ArtifactReference。实现只能落该 v1，不得再以 JSON blob、UI default、
Renderer Provider 字符串或 Provider prompt 发明另一套语义；本状态只表示可以开始实现，不表示 Phase 5D 已完成。

**输出与 owner：**

- Meta/Task Setup service 拥有 `MetaSession`、`TemplateDesignDraft`、`TaskSetupDraft` 与 patch proposal/application；
  Task/Run service 仍独占 Create/Start 和 Architecture Snapshot；
- Runtime contracts/store 增加有序 `short_text | long_text | choice` Task schema、只含 `title/goal/inputValues` 的可编辑
  Setup payload、versioned deterministic task-goal compiler，以及对象受限的 create/resume/message/proposePatch/
  applyPatch/rejectPatch/abandon command 与 migration；每条 Meta user message 还必须原子建立 durable `MetaTurn`，
  冻结 profile/mode/target revision/context/system/output schema 及 digest，并以 lease/reconcile 状态机恢复；
- Host/Bridge 提供只读 Meta Profile readiness options；Meta Session 只保存 Host 验证并冻结的 option snapshot，
  v1 无工具、无 cwd。unavailable/version mismatch 在创建或恢复前 fail closed，不 fallback；
  Meta Session 使用独立 `MetaAgentPort`，不使用 Task Run LogicalSession、Task-shaped Provider Binding/Fact、Conductor
  Gateway、MessageForward 或 Workspace filesystem；首次 pending lease 才能 submit，恢复/accepted/ambiguous 先
  reconcile，unknown 固定进入 typed ambiguous 而非重发；
- Template Studio 和 Task Setup 复用 Phase 5C Chat shell，但没有 Task Session Tabs。入口点击才 create/resume；
  浮窗/左侧停靠是 view state，Template 停靠替换 Library 左栏；Task Setup 实现为主表单 + Meta 区的完整双栏
  Surface，而不是小型 Create dialog；
- Draft/MetaSession 只由 explicit abandon、Publish 或 Create 收束；关闭、停靠、页面切换和断线无副作用；
- Meta patch 必须展示 ordered typed field diff、校验、理由与未解决项；整份 apply 使用 Draft revision fence 并
  原子提交，整份 reject 不改 Draft；v1 不做逐 operation 部分接受或隐式 rebase；
  publish/create/start 必须是不同的认证用户 command。

### 5D.1 DeepSearch golden journey

`DeepSearch` 只是验收 fixture 名称，不是新的 Template 类型、固定 DAG 或 Provider-specific 分支。Conductor 的每次
目标选择仍必须产生显式 MessageForward/Turn。Browser 与 Desktop 必须用同一隔离 Runtime 数据依次通过：

| Checkpoint | 用户旅程 | 必须成立 |
| --- | --- | --- |
| `DS-01` | 用户创建 v2 DeepSearch Draft，含 Conductor、Researcher、Reviewer、HTML Publisher，并配置 `topic: short_text`、`brief: long_text`、`depth: choice` 三个有序 Task input | Draft/schema 校验通过；三类字段及 choice option 顺序在 Version 中稳定；尚无 Task/Run。 |
| `DS-02` | 用户在 Template Design 打开 Meta，选择 Host-ready Codex Meta option，请它调整 Card prompt 及 Card 的默认 Provider/model Profile | Meta 只返回一个 ordered proposal；用户整份 Apply 后 Draft revision 恰增一次，再以独立 Publish command 形成 immutable Version；Meta 不能自行 Publish。 |
| `DS-03` | 用户进入完整 Task Setup，选择该 exact Version；另一个隔离 Meta Session 建议 title/goal/inputValues patch，用户 Apply | Setup Meta 看不到 Template Meta history；关闭/恢复 Surface 后 Draft 与 session 不丢失；Task 尚未创建。 |
| `DS-04` | 用户授权 workspace，再独立 Create | Snapshot 绑定 exact Version；versioned compiler 按 schema 顺序产生可重放的 task-goal content/digest；同输入重试字节一致且不重复 Task。Create 不是 Start。 |
| `DS-05` | 用户以 Codex baseline 显式 Start；Conductor 根据 goal 调用 Researcher | fresh Run、Task Goal Message/Conductor Inbox 与 Codex Binding 均可关联；Researcher assignment/receipt/final/terminal 完整回 Conductor。 |
| `DS-06` | Research 进行中，用户从 Task 总入口告诉 Conductor：“最终以 `reports/stock-research.html` 交付” | target 固定为 Conductor；Tab 选择不改投 Card；消息进入 durable Inbox，并在 Conductor safely idle 时形成新 Turn。 |
| `DS-07` | Conductor 明确选择 Researcher 的完整 final 给 Reviewer，再选择用户 HTML 要求与 Reviewer final 给 HTML Publisher | 每一步都有 ordered selection、Forward、rendered Message、Inbox/Input/Turn；没有 hidden workflow、shared-read、HTML 路由解析或 Provider-to-Provider 调用。 |
| `DS-08` | HTML Publisher 写入相对路径文件并在 canonical final 中说明路径；Conductor 给出用户可见 final | Artifact service 验证 workspace 边界、普通 `.html` 文件、digest 与来源 Turn/final 后才创建 ArtifactReference；tool/activity 不能替代 final 或路由。 |
| `DS-09` | 用户预览 Artifact 后显式 Achieve；若仍有 active Run，再独立 Stop | Achieve 记录所选 Artifact ID 但不由 Agent/file/terminal 自动触发，也不自动 Stop；Stop/terminal/reconcile 保留独立证据。 |

### 5D.2 Checkpoint ledger 与 Provider gate

每次 golden journey 都必须产生一份可审计 ledger；它引用 Runtime 内的 evidence records，不另建产品真相。每行至少
记录以下内容，缺任一项的 checkpoint 不得标为通过：

| Checkpoint 范围 | 唯一 writer / durable identity | command 与 fence | 外部效果与恢复 | 断言证据 |
| --- | --- | --- | --- | --- |
| `DS-01`–`DS-03` | Template/Meta/Task Setup service；Draft、Version、MetaSession、proposal ID/revision/digest | commandId、expectedDraftRevision、idempotencyKey；Apply/Reject/Publish 分离 | Meta Provider option snapshot、version/fingerprint；close/resume 与 stale proposal 路径 | typed schema、原子 patch、mode isolation、无 Task/Run/Forward/workspace effect |
| `DS-04` | Task service；Task、Snapshot、Task Goal Message ID/digest | Workspace/Create commandId、expectedRevision、idempotencyKey、compiler version | Create ambiguity/retry 与 Store restart | exact Version、确定性 content/digest、零重复 Task、Create != Start |
| `DS-05`–`DS-07` | Task/Message/Turn owners；Run、Binding、Forward、Inbox、Input、Turn、Invocation IDs | Start/invoke/relay command/revision/idempotency 与 ordered selection digest | Provider pin/fingerprint、native effect、receipt、reconcile/restart | 唯一 receipt/final/terminal、完整回 Conductor、零 sibling/shared-read、用户消息固定 target |
| `DS-08`–`DS-09` | Message/Artifact/Task owners；finalMessageId、Artifact ID/digest、achievement ID | Artifact verify、Achieve、Stop 各自 command/fence | 文件验证、Stop interrupt/terminal/reconcile | 相对路径与 provenance、Conductor final、Achieve 独立、active Run 不被静默结束 |

Provider gate 固定为：

1. **Codex positive baseline：** 使用 `architecture.md` 证据矩阵中的精确 `0.146.0` pin/fingerprint、
   `permissionMode: deny` 与空 tool allowlist。Meta Profile 必须同样来自 Host-ready option 且无工具/cwd。任何 pin、
   fingerprint、model policy 变化都使旧证据失效。golden journey 必须补齐真实多 Session、Host restart/reconcile，
   并在 Browser 与 Electron IPC 上取得同事实证据，不能只复用单 Conductor smoke。
2. **OpenCode unavailable negative：** 当前 managed pin/capability 不满足时，Meta options 与 Task Profile picker 都显示
   typed unavailable 原因；create/resume Meta Session 或 materialize Worker 在 owner 层拒绝，不创建 native effect，
   不返回 generic 400，不改用 Codex/Claude，也不阻止已就绪的 Codex Conductor Start。`1.18.15` content/activity
   probe 不能冒充 managed-core/interrupt 证据。

**实施记录（2026-08-09，readiness negative）：** Meta option 与 Task Profile 都已改为 Host-owned 异步
probe/cache + 同步安全投影；probe 前为 unavailable/pending，Task Profile 以 immutable Version ID 与 Profile ID
关联，Runtime invalidation 会刷新 Meta/Task Setup Surface 且不覆盖未保存表单。Start/Restart 只 gate 将被物化的
Conductor Profile，Worker 在 Invocation 前单独重验，因此 unavailable OpenCode Worker 不再阻止 ready Codex
Conductor；选择该 Worker 时在 Session/Binding/outbox/native effect 之前失败。新增真实 opt-in
`tests/integration/provider-readiness-negative.test.ts`：隔离 OpenCode `1.18.15` 对 declared `1.18.13` 得到
`provider_version_mismatch`，只访问 `/global/health` 与 `/doc`，native Session effect 为零。该记录不代表 OpenCode
managed lifecycle、Phase 5B Handoff 或完整真实 Browser/Electron DeepSearch 已通过。

**实施记录（2026-08-09，readiness/Bridge 收口）：** readiness registry 改为 canonical Profile identity、60 秒
freshness、15 秒 probe timeout、同 Profile single-flight 与逐 Profile invalidation；同步异常和原生 reason 都被压成
typed safe code。Host 先处理 durable outbox/recovery，挂起的 readiness 不再阻塞调度或其他 Provider 的状态发布。
stale Start/Restart/Meta send 在 probe 前拒绝；Restart/Resume readiness failure 对 Task/Run/Binding/outbox 保持原子；
accepted/ambiguous Meta Turn 在 Provider 暂未 compose 时保留 durable 状态，恢复后只 reconcile、不 resend。
Task read model 从 immutable Architecture Snapshot 投影 exact Conductor readiness，AgentLoop 在 checking、版本不匹配、
能力缺失或 unavailable 时预禁用 Start/Restart，owner command 仍做最终 force gate。Task Setup 的 readiness refresh
采用 latest-wins；clean Draft 接收新 revision，dirty Draft 保留旧 revision fence，外部更新不会被旧表单静默覆盖。
Runtime Bridge、Browser 与 Desktop 现在统一使用脱敏 error code envelope，并对 user owner/workspace 的 read、command
和 subscription 做 scope gate；published Template Library 仍共享，Template identity 级 archive/import/export 仍是
single-owner Host 边界。最终自动门禁为 Vitest `329 passed / 3 opt-in skipped`、Desktop `15/15`、E2E `10/10`、
integration `57 passed / 3 opt-in skipped`、contracts `15/15`、typecheck/build 通过；真实 OpenCode
`1.18.15` 对 frozen `1.18.13` 的 negative probe 另行 `1/1` 通过且 native Session effect 为零。

截至 `2026-08-09` 的 Codex `0.146.0` Meta 原生探针已证明 dedicated Host profile 可关闭 shell/unified-exec、Web、
Apps、environment、capability roots、dynamic tools 与 native children，并能用 `outputSchema` 返回严格 JSON；但同一
live `turn/completed(status=completed)` 在立即 `thread/read` 与 App Server 重启后被标成 `interrupted`。因此 live
canonical final 可作为正向内容证据，冷恢复必须 fail closed 为 `ambiguous`，不得把该版本写成已通过完整 lifecycle
reconcile parity。只有 Host-owned exact binary/schema/no-tool attestation factory、Browser/Electron journey 与这一残余
门禁都取得证据后，Phase 5D 才能标为完成。

**先写失败 harness：** 重复/未知 Task field 与 choice option 被拒绝；task-goal compiler 对换行、field order 与重试
确定；Renderer 任意 Provider/model 字符串被拒绝；两个 Meta 模式互不读取 Draft/消息；Meta 不能读取 Task
transcript/cwd/credential；关闭或停靠不丢 Draft、不启动 Provider；patch 未确认不改 Draft；部分无效或 stale patch
整份失败；Meta final 不创建 Task/Run/MessageForward/Achieve；Publish/Create/Start 各需独立用户动作；HTML 路径
越界或 final 未说明时不建立 verified ArtifactReference；Browser/Desktop 行为一致。

**完成条件：** contracts、store migration、service isolation、fake Meta Provider、Template Studio/Task Setup
component/controller、Bridge、Browser 与 Electron harness 全部通过；`DS-01`–`DS-09` ledger 完整，Codex positive
baseline 与 OpenCode unavailable negative 同时通过；任一越权操作都由 owner 层拒绝，不能只靠按钮隐藏。每项证据
仍须覆盖 domain → application/store → fake Provider → real Provider → Runtime Bridge → Desktop + Browser，截图、
页面可打开或单 Provider 单 Session happy path 不能替代。未通过真实 capability gate 的 Meta Profile 明确 unavailable。

## Phase 6 — 已批准的硬切换与清理（仅在 Phase 5A / 5B / 5C / 5D 通过后执行）

**前置条件：** 新的 MessageForward / HumanIntervention / SessionTurn Runtime、统一 Provider 对话承接面、
Managed Chat/Session Tabs、配置期 Meta/Task Setup、原 AgentLoop 交互契约、Browser/Desktop 旅程和相应
Provider evidence 已通过。本 Phase 不是“目录已移动”就完成，更不能在新 Surface 不合格时宣布旧交互已经被替代。

**已确认边界：** 用户已批准直接切换，不要运行期 compatibility façade、第二套 UI、旧 lifecycle writer 或
Provider-specific fallback。切换不迁移或删除既有 Runtime 数据、用户 cwd、Provider 原生会话或凭据；历史源码
只能通过 VCS 作为交互证据，不能重新注册为可选 Runtime。

**执行：** 新 owner 通过上述 gates 后一次切换 composition；随后删除被统一 Runtime 接管的旧 lifecycle、PTY/Orca、
observer/gateway、superseded Adapter、测试、mockup 和入口。若早期已删除某些旧目录，也不恢复其 Runtime；仅从
VCS 核对原 AgentLoop 的交互契约，并在新的 `apps/*` / `packages/*` owner 中实现。

**验收：** 静态检查没有生产 import 指向正式源码树之外的 Runtime/Session Store、PTY/Orca、
Provider-specific gateway 或通用 `provider === "opencode"` 分支；保留 UI 的 interaction adapter 只调用
typed Runtime bridge。真实 Provider 的 Desktop/Web E2E 仍随 Provider evidence matrix 逐项关闭，不能被删除操作、
离线单测、页面截图或启动成功替代。

## Phase 7 — 后续 Workflow

只有硬切换后才引入 WorkflowRun/WorkflowNodeRun。它们经 Scheduler 请求受 scope 约束的 Conductor
`invoke_agent`，并沿同一 MessageForward / SessionTurn 链运行；不直写 Provider，也不自动把 native child
变成工作台 Session。

## 每个实现任务必须记录

```text
Phase / 用户动作 / 唯一 writer
commandId + expectedRevision + idempotency key
external effect / Provider version + protocol fingerprint
reconciliation path / evidence reference
verification command + result / residual risk
```
