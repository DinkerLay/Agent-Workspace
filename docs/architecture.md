# Agent Workspace Architecture

日期：2026-08-11
状态：**当前唯一架构真相**

本文件定义产品、领域模型、Provider Runtime、Web/Desktop Surface、代码目录、状态 writer、
验证和直接切换规则。除 [`implementation-plan.md`](implementation-plan.md) 外，没有其他
当前规范、当前计划或当前设计文档。

本文用下面的 ASCII 路径表达架构；文字与数据约束是唯一权威，不保留第二份图形化架构真相。

## 1. 产品是什么

Agent Workspace 是一个本地优先、有人监督、可恢复的多 Agent 工作台。它不是模型选择 UI、
OpenCode 壳、Cursor clone、终端复刻或重复 prompt 的聊天循环。

```text
Template Version
  -> Task Architecture Snapshot
  -> Task / TaskRun
  -> Task/User Message -> Conductor Inbox -> Conductor SessionTurn
  -> invoke_agent(agentCardId) 只 materialize Card Session 并返回 sessionId
  -> send_to_session(sessionId, payload) 创建显式 MessageForward（新内容与可选 Message / RelayBlock 引用）
  -> Session Agent Inbox -> InputSubmission -> SessionTurn
  -> Orchestration Runtime 发出 durable SessionRuntimeCommand
  -> 每个 LogicalSession 的 Session Runtime -> ACP Client -> ACP Agent
  -> Session Runtime 配对 ACP final candidate + prompt terminal，发出 SessionRuntimeEvent
  -> Session Agent 唯一完整 final Message / optional RelayBlocks -> Conductor Inbox
  -> 用户也可明确直达 Card；HumanIntervention 同时向 Conductor 透明同步完整内容与归因
  -> explicit user Achieve
```

Conductor 负责业务决策：是否派发、派给哪个 Card、何时复核、何时请求验收。每个 TaskRun 的
**Orchestration Runtime（OR）**负责协作身份、Message/Inbox/Input、用户优先、Task 生命周期与最终提交；每个
materialized LogicalSession 的 **Session Runtime（SR）**负责 Binding execution、ACP prompt correlation、交互、
取消、恢复、candidate/terminal pairing 与 settlement。Runtime Host 承载它们并管理本机 ACP Agent 进程，
但不是第三个业务 Runtime。OpenCode、Codex、Claude Code 只是 ACP Agent 背后的执行 runtime，不能决定 Task
生命周期或业务路线。

正式 Task/Session Provider wire 恰好只有 ACP：

```text
OR -> durable SessionRuntimeCommand -> SR -> ACP Client -> ACP Agent
ACP observation -> SR settlement -> SessionRuntimeEvent -> OR
```

OpenCode REST、Codex App Server、Claude stream-json 与 Provider-specific SDK 只能存在于独立 ACP Agent/wrapper
内部；Agent Workspace production graph 不直接调用它们，也不提供 direct fallback 或可选 selector。

当前产品模式是动态 **Agent Loop**。未来 Workflow 是 Scheduler 在同一 MessageForward / SessionTurn
kernel 上增加的显式模式；它不是隐藏 DAG，也不是 Session Runtime / ACP Client 的职责。

### 当前入口与交互不变量

当前默认产品入口是 `start.sh` / `pnpm start` / `npm start` → `apps/runtime-host` +
`apps/workbench` + `apps/desktop`。`pnpm start:web` 启动同一正式 Renderer 和认证 Host 的浏览器开发面。
根 `src/`、根 `desktop/`、根 Vite 和 OpenCode WebUI 已从工作树删除；不存在兼容入口、双 writer 或旧
PTY fallback。

任务三栏、Task Setup、Task-local Session Tabs、统一 Chat、Session Presentation、Timeline、已完成／
回收站与 Template Studio 是产品交互契约。配置期 Meta 也属于这个契约：它只在有明确 Draft scope 的
Template Studio / Task Setup 显示固定入口；调出面板与显式打开 Meta Session 是两个动作，浮窗、停靠、
关闭和页面切换只是 Renderer view state。正式 Renderer 保留这些交互，而不是把它们换成通用控制台；
它只通过 typed Runtime bridge 读取模型和提交用户意图。Task/Run 生命周期永远只有 Runtime writer。

统一 Chat 固定分成两层：`SessionMessage` 是可进入 Agent 对话、可被审计和转递的协作内容；Provider
tool/stream/change/diagnostic/Attention 只是经验证、只给人看的活动投影。活动投影不是
`SessionMessage`、不能成为 RelayBlock、不能被 Conductor 转递，也不能成为 sibling Agent 的上下文。

第一版 Provider 活动统一为可去重的 `activity_observed` 事实，并投影为独立的
`ProviderActivityReadModel`。ACP normalizer 只允许输出稳定的脱敏 activity id、`assistant_progress | tool | change |
web` 类别、`started | progress | completed | failed` 阶段、有界 title/detail/content、`append | replace`
更新方式和单调 sequence。Provider 通过正式 ACP thinking/reasoning channel 发出的文本以
`assistant_progress(contentKind="reasoning")` 有序投影，并在统一 Chat 的 Thinking block 中流式展示；Host 只对已知
credential、raw ACP/native id、absolute cwd 与 wire envelope 做精确移除或替换，不得摘要、改写或伪造 reasoning
正文。raw arguments/result、stdin、native metadata 与私有 transcript 仍不得进入展示 payload。live chunk 使用 append，
原生 completed/history snapshot 使用 replace，从而让重连恢复覆盖残缺流而不重复正文。

统一 Chat 的执行过程采用紧凑的可展开活动树：`running` / `awaiting_final` 始终展开；只有同一
`SessionTurn` 已有规范 `finalMessageId` 且 Turn 为 `returned` / `completed` 时才默认自动收起。收起后只让
final Message 保持正文主视觉，用户仍可手动展开审计；failed、interrupted、cancelled、ambiguous、terminal
先到或缺 final 的 Turn 必须保持展开。展开状态只属于 Renderer view state，不能回写 Runtime。
Thinking block 有独立的折叠规则：`running` / `awaiting_final` 时默认展开并流式显示 reasoning；任一 settled terminal
在 flush 最后 delta 后自动收起，用户可手动重开。即使 failed/cancelled Turn 的外层活动树必须保持展开，其内部
Thinking block 也仍按该规则自动收起；ambiguous 或尚未 settlement 时不得提前收起。

## 2. 不可混淆的领域对象

| 对象 | 作用 | 唯一 writer |
| --- | --- | --- |
| Meta Agent Session | 配置期的受限会话；分别绑定 Template Draft 或 Task Setup Draft，不属于 Task Run | Meta Session service |
| Template Design Draft | 可手动编辑、也可接受 Meta patch 的模板草稿 | Template service |
| Task Setup Draft | 选定不可变 Version 后、创建 Task 前的一次性输入草稿；不是 Task/Run | Task Setup service |
| Template Version | 不可变的 Conductor、Card、Execution Profile 与 Task Input Schema 定义 | Template service |
| Execution Profile | portable ACP Profile requirement：Provider family、ACP launch kind、model/config intent、工具/权限与 capability policy；不含本机 path/version/hash | Template/Task service |
| Task Architecture Snapshot | Task 创建时冻结的 Version、Workspace 授权、Profile 与 Card | Task/Run service |
| Task / TaskRun | 用户可见工作项与一次明确执行身份 | Task/Run service |
| CardSessionSlot | 一个 `(runId, agentCardId)` 的稳定位置、0..N 代历史与至多一个 current `sessionId` | Task/Run service |
| LogicalSession | Run 内的 Conductor，或某张 Card Slot 的一代 Runtime 会话身份 | Task/Run service |
| SessionExecutionRuntime | 一个 materialized LogicalSession 的执行 owner；持有 Binding execution、ACP delivery correlation、interaction fence、candidate/terminal pairing、reconcile 与 settlement | Session Runtime service |
| SessionExecutionAttempt | 一次 SR-owned ACP prompt/interaction/terminal 尝试；不同于 OR-owned 协作 `SessionTurn` | Session Runtime service |
| ProviderSessionBinding | LogicalSession 与一个 ACP Agent Session 的不透明绑定；durable 层只保存 Workspace opaque handle，不保存 raw ACP session id | Binding service，基于 SessionRuntimeEvent |
| LocalResolutionSeal | Host 对当前安装的 ACP launcher/wrapper/upstream、digest/trust、协商能力与 execution config 的私有观测封条 | Runtime Host resolution service |
| ACPQualification | `LocalResolutionSeal + model/config + live behavior probe + Host generation` 的 process-local opaque 资格 | Runtime Host qualification service |
| ConductorPlanningFence | Task 总入口用户输入使旧 Conductor Turn 失去继续提交协作动作资格的 durable 边界 | Task/Run service；Orchestration Coordinator 只校验/执行 |
| SessionMessage | 用户、Runtime 或 Agent 的唯一、完整、不可变协作正文；非 Conductor Agent 的 `agent_final` 完整回到 Conductor | Message service |
| RelayBlock | 同一条 final canonical content 中 0..N 个可选引用节点；不单独投递，也不授予路由权 | Message service |
| MessageForward | 一次 `send_to_session` 的内部审计：来源 Conductor Turn、单一目标、新内容 digest、有序引用快照与结果 Message ID；不重复保存正文 | Message service |
| SessionControlAudit | `interrupt_session` / `close_session` / human `session.request_interrupt` 的发起者、目标、请求、最终结果与受影响 pending IDs；控制命令不创建正文 | Orchestration Coordinator |
| HumanIntervention | 认证用户对明确 Card/Turn 的直接消息、Attention/Permission 回复或 scoped interrupt 意图及其归因 | Human Intervention service；Coordinator 只推进关联 Inbox/Control |
| SessionInboxItem | 指向已持久化目标 Message 的 durable Lane 项；可 pending、held、leased、handled 或 suppressed | Orchestration Coordinator |
| InputSubmission | 一次可靠、可幂等地把目标 Message 交给 Adapter 的投递意图 | Orchestration Coordinator |
| SessionTurn | 一次受管输入与 final/terminal 的 durable 关联；成功恰好一条 final，失败/取消/确认中断可为零，任何状态不得多于一条 | Orchestration Coordinator |
| Attention | Provider 请求用户处理的 durable 事实 | Orchestration Coordinator |
| WorkspaceFileObservation | Task-scoped、只给人看的相对路径/时间/digest/来源验证观察；不拥有文件、不是快照或稳定文件身份 | Workspace Tool/Observation service |
| SessionPresentation | native page、external handoff 或 Workspace surface 的短期 capability | Presentation Port |

```text
LogicalSession        = 工作台长期身份
SessionExecutionRuntime = 一个 LogicalSession 的 ACP 执行 owner
ProviderSessionBinding = Workspace opaque handle 指向 Host-private ACP continuation
SessionMessage        = 可见、不可变的协作内容真相
RelayBlock            = Agent 提供给 Conductor 的可选转递候选片段
MessageForward        = Conductor 的一次单目标 send 内容决定
SessionInboxItem      = “把已决定的目标 Message 安全投给哪个 Session”的 durable 队列项
HumanIntervention     = 用户直接介入明确 Card/Turn 的 durable 意图、冲突关系与内容谱系
InputSubmission       = 已决定向某个 Binding 发送的一次可靠输入
SessionTurn           = OR-owned Input、真实发起者/触发原因与 SR settlement 的可靠关联
SessionExecutionAttempt = SR-owned ACP prompt、interaction、candidate 与 terminal 关联
SessionControlAudit   = Conductor/human interrupt 与 close 的控制审计，不产生用户内容
SessionRuntimeEvent   = SR 提交给 OR 的脱敏 receipt/final/terminal/interaction/reconcile 事实
ProviderFact          = SR/ACP 集成层私有的已观察证据，不是编排内容或模型协议
TranscriptItem        = SessionMessage / Input / Fact 的 UI 投影，不是另一份 Runtime 真相
```

`agent_final` 只结束一个 SessionTurn，不关闭 Card Session；`close_session` 只退役一代 LogicalSession，
不删除历史或宣称 Provider 原生过程已终止。`Achieve` 是用户接受交付，不表示 Provider
已停止；`Resume` 只能恢复原 Binding，不能悄悄新建替身会话。

`Task.status` 只表达 Runtime lifecycle（queued/running/stopping/stopped/blocked）。用户的
`achievement` 是独立的、不可由 Agent 或 Provider 写入的记录，包含时间、用户选择接受的
可选的非拥有型文件状态锚点（也可以为空）和说明。Conductor 的“完成”、Workspace 文件/观察、证据、Provider
turn 完成都是 Workbench 可见的上下文，绝不是 Achieve 的前置 gate；用户可以在没有 Run、没有文件锚点、没有
任何 Conductor claim 的情况下 Achieve。Achieve 后不再允许创建新 Run，但一个已经活跃的 Run
不会被悄悄停止，仍需明确 Stop 并等待原生终止事实。正式 Surface 对每个未验收 Task 都必须保留无锚 Achieve，
包括 active Run 以及 queued/stopped 且无 active Run 的 Task；Publisher Preview 只会额外提供有锚选择，不能把
Preview、文件存在或 Run 存在变成验收 gate。刷新后必须由 typed achievement read model 显示对应有锚/无锚状态。

### Template Library、发布与分享

Template Library 是用户可见的产品能力，不是工作区中被 Runtime 静默监听的一组文件。用户可
新建、编辑 Draft、发布不可变 Version、复制、归档、导入、导出，并从明确选定的 Version 创建
Task。

```text
Template package (.agent-template.yaml / .agent-template.zip)
  -> explicit Import + schema/capability validation
  -> Template Draft / immutable Template Version in Runtime Store
  -> explicit selection when creating a Task
  -> immutable Task Architecture Snapshot
```

Runtime Store（SQLite）是 Template identity、Draft、Version、archive metadata 的唯一真相。
YAML 是受 schemaVersion 约束的交换格式，供 Git、备份和分享；它不是第二个活跃 writer，
Runtime 不监视目录，也不与文件双向同步。导出必须从一个已发布 Version 生成；导入必须先
预览和校验，再显式创建 Template 或新 Version。相同 `templateId + version` 的不同
`definitionHash` **或** `assetManifestHash` 必须拒绝，不能覆盖；定义和资产都相同的重试必须幂等。

模板包只包含可分享定义：metadata、Conductor/Card、Execution Profile、routing、deliverable、
prompt/asset manifest 与 schema version。无资产时以 `.agent-template.yaml` 交换；含资产时以
`.agent-template.zip` 交换，入口仍是 `manifest.yaml`。它绝不包含 cwd、credentials、原生
Provider identity、Task/Run/transcript 或 Runtime 数据库。

v2 `deliverable.artifactPath` 是历史 schema 名称，只表示非拥有型、workspace-relative expected output path hint；
它不创建 Artifact identity/service、不给 Conductor 路由权，也不允许 Task lifecycle 删除文件。字段改名必须走新的
package schema version，不能原地改变已发布 Version 的字节语义。

Template Studio 的 Draft 编辑器必须允许用户为每张 Card 选择 Host 投影的 portable ACP Profile revision，并编辑
model/config intent、permission mode 与 capability policy。新 ACP schema 不允许保存本机 launcher path、artifact/
upstream version、binary hash、raw protocol fingerprint、credential ref 或 Host-private resolution ID；Renderer 也不
提供自由输入这些字段的控件。schema v2 的 `providerVersion` / `protocolFingerprint` 只按其历史字节语义读取，不能
原地改写或静默升级为 ACP Profile。迁移必须创建新的 Draft/schema version，并由用户显式发布。

Template/Profile requirement 只声明 Provider family（例如 `opencode` / `codex` / `claude-code`）、ACP launch kind
（`native_acp` / `codex_acp` / `claude_agent_acp`）、协议 major requirement、所需 capability/extension、model/config
intent 与 permission policy。Host 是否能实际 Start 由当前安装的 `LocalResolutionSeal` 与 live `ACPQualification`
判断；UI 选择、Catalog metadata、旧 evidence 或版本字符串都不能绕过该门槛。

一个 Card 的 `executionProfileId` 是 V1 使用的冻结 Profile，不是 Renderer 可以自行写入 Provider 名称的权限。
Task Session Header 可显示该 Profile 的 Provider、模型、版本、permission/tool policy 与 Host readiness；未就绪
或未证实能力时保持可见但不可执行，并给出原因，不回退到其他 Provider。运行中 Profile 选择与 Handoff 属于当前
计划之外的 deferred backlog；其控件在实现前必须诚实 unavailable，不能使 V1 invoke/send 依赖多 Profile 切换。

Task 创建后不再读取模板文件或可变 Template Draft；它只读取自己的 Architecture Snapshot。
因此发布后续 Template Version、归档 identity 或导入其他模板，都不得改变历史 Task。

### Template package v2 当前实现、v3 ACP target 与 Card scope

当前 Runtime 只接受 `schemaVersion: 2` 的模板包；这是迁移事实，不是 ACP target。Phase 1 必须新增
`schemaVersion: 3`，以 portable ACP Profile revision取代品牌单例和legacy version/fingerprint字段。已发布v2 Version
bytes永不原地改写：旧Version只读兼容；用户只有在Draft中显式迁移、通过v3 schema与capability校验并再次发布，才会
得到v3 Version。在Phase 1代码和round-trip tests完成前，文档中的v3只是目标合同，Runtime不得伪称已可导入或运行。

```text
Conductor LogicalSession
  = own identity { agentCardId, kind, title, role? }
  + own systemPrompt
  + worker dispatchRegistry (title / description only)
  - no Worker systemPrompt

Worker LogicalSession
  = own identity { agentCardId, kind, title, role? }
  + own systemPrompt
  + current assignment
  - no dispatchProfile, Conductor prompt, or sibling prompt
```

`dispatchProfile` 是给 Conductor 选择 Card 的目录，不是 Worker 的稳定 prompt。Conductor 首次需要某张
Card 时只调用 `invoke_agent({ agentCardId })` 建立一代 Runtime 会话并取得 `sessionId`；这一步不携带
instruction、正文、引用、验收标准、产物请求或 priority，也不创建 Message / Inbox / Turn。首条与后续
任务内容一律通过 `send_to_session({ sessionId, payload })` 发送，payload 只含可选新 `content` 与有序
`messageRefs`。Agent 若产出文件，只能在 canonical final 中向人类说明；文件或 Files & Changes 观察不能成为 Gateway
的隐式输入。`capabilityRefs`、Provider、Model、Effort 与 tool policy 都是 Host 侧执行配置，不渲染成自然语言
身份或指令。Runtime 只在一个 LogicalSession 尚无持久 Provider receipt 时，把上述冻结身份/指令前置到首次
真实 prompt；Host 重启、reconcile 或后续 Turn 不得重复注入。Task Architecture snapshot 是静态
Card/Profile scope 的唯一来源；后续 Template Draft 编辑不会
回写已有 Task。

`capabilityRefs` 是 Host 使用的 Card 作用域声明，可以保留在内部 bootstrap record 中，但不得渲染进模型
上下文；真正可执行的 Provider 工具/权限仍由 `ExecutionProfile.capabilityPolicy` 与 Host 注入能力决定。
Card scope 与 Provider tool policy 的强制交集尚未完成，因此不得把声明误写成已完成的权限隔离。

### Meta Agent 与 Task Setup

产品只有一个用户可识别的 Meta Agent，但它只在配置期工作，并以两个对象隔离的模式出现：

```text
Template Design -> Meta Session 只绑定一个 Template Draft
Task Setup      -> Meta Session 只绑定一个 Task Setup Draft + 已选 immutable Template Version
Task Run        -> 不显示 Meta Agent；只运行 Conductor 与 Card LogicalSession
```

Meta Agent 可以读取当前 Draft、对应 schema 与校验结果，提出可见 patch；用户可应用、拒绝或继续手动
编辑。它不能发布 Version、授权 Workspace、创建/Start Task、读取运行中 Task transcript、持有 Provider
凭据/文件系统权限、创建 MessageForward、Stop/Restart Task 或 Achieve。Template Design 与 Task Setup
不会共享一份无界上下文；两者只通过用户确认后的 Version、Task 参数和冻结 Architecture Snapshot 与
Task Run 衔接，不传递 Meta transcript、权限或未确认草稿。

Meta Agent、Conductor 与 Card Session Agent 使用同一个 Renderer `Agent Chat Shell`：统一 transcript、
message card、composer、Enter/Shift+Enter 和 interaction slot。统一的是交互结构，不是领域对象；Meta message/
proposal 仍属于 Draft scope，Task Message/Turn/Interaction 仍由各自 Runtime owner 投影，二者不得互相翻译、
路由或共享 transcript。

Meta Chat 直接作为 Draft Workspace 的可输入界面；建立会话不再要求独立的“打开 Session”按钮：

1. Template Library 的 `用 Meta Agent 新建` 是一个显式用户动作：Runtime 先从标准 Deepsearch v3 Version
   复制定义并创建一个新的持久化 Template Draft identity，随后直接进入带 Meta 唤醒入口的 Draft Workspace。
   Renderer 不保留“本地未保存 Draft”中间态，也不让 Meta 操作无 identity 的临时对象。该动作只创建 Draft，
   不创建 MetaSession/MetaTurn；已消费/abandon 的 Draft 与 Task Run 不显示可用入口。
2. 点击入口只调出对象受限面板并读取 Draft、历史 Meta 消息、proposal 与 Host-owned profile options；它不
   创建 Provider 进程、MetaSession 或 MetaTurn。若该 scope 已有 active MetaSession，面板直接显示同一会话并
   对 pending Turn 做正常 reconcile；这只是恢复 view，不是另一次建会话。
3. 没有 active MetaSession 时，Composer 仍直接可用，并在底部把 Host-issued options 投影为联动的
   Provider / Model / Effort 选择；它们只选择一个 opaque `metaProfileOptionId`，不能提交任意品牌、模型或配置。
   用户首次发送是显式的会话建立动作：Renderer 先以同一已选 option 创建唯一 active MetaSession，收到 typed
   result 后立即为该 Session 提交用户消息与 MetaTurn。中途失败可以留下一个空的 durable Session，但不得丢失、
   重放或改投用户消息。无 option、当前 installation/capability probe 不合格或 Provider 未配置时，Composer 明确
   unavailable；不得伪造默认 Profile、会话或 assistant 消息。
4. Template Version 与 Draft 使用同一 Workspace 骨架。Draft 只额外显示一个默认收起的 Meta 唤醒入口；展开后
   Meta Chat 是可收起、可调宽的左侧栏，右侧 Inspector 同样可收起、可调宽。应用主导航也可收起为图标栏。
   这些布局状态只属于 Renderer view state，不创建、abandon 或改变 MetaSession，也不产生另一套“AI 修订页”。
   Version 只读视图不显示 Meta；Task Setup 仍可按自己的响应式布局放置相同 Chat Shell。
5. 关闭、隐藏、浮窗/停靠切换、切页、断线不会 abandon Draft、MetaSession 或 pending proposal；再次调出恢复
   同一对象范围。Publish/Create 消费各自 Draft 与 MetaSession；显式 abandon 才放弃它们。

Meta 面板按顺序显示完整 user/assistant 消息；proposal 是与消息相邻但独立的可审阅变更项，不能取代对话。
Template Design 与 Task Setup 都复用 ChatShell，但没有 Task Session Tabs。Task Run 永不显示 Meta 入口。

#### Phase 5D v1 配置契约

`TaskInputSchema` 是 Template Version 中有序的 Task 级字段数组；v1 不暴露 Card-specific 参数，也不接受
任意 JSON 字段。每个字段有稳定 `fieldId`、`label`、`kind: short_text | long_text | choice`、`required` 与可选
`description`；`choice` 还必须有至少一个有序 `{ optionId, label }`，其值保存稳定 `optionId`，文本字段保存字符串。
未知 field/option、重复 ID 或缺失 required value 在 Create 前失败。

`TaskSetupDraft` 的可编辑 payload 固定为 `title`、`goal` 与按 `fieldId` 保存的 `inputValues`，并关联一个已选
immutable Template Version；它不是 Task。title/goal 必填，title 与 `short_text` 必须是单行。Create 以 v1 纯函数
编译 `task_goal`：所有文本先把 CRLF/CR 规范为 LF 并去除首尾空白，再按 Schema 顺序使用下面的 UTF-8 正文；
缺失的 optional field 不渲染，choice value 渲染为 `<option label> [<optionId>]`，正文以一个 LF 结束。

```text
Task title: <title>
Task goal:
<goal>
Task inputs:
```

其后每个已提供字段按顺序追加 `[<fieldId>] <label>\n<rendered value>`，字段块之间恰有一个空行；没有字段时
追加 `(none)`。完整正文恰以一个 LF 结束。

编译不读取时间、Meta transcript、Renderer 状态或 Provider，compiler version 与 content digest 随 Task Goal
Message 保存；同一 Version、title、goal 与 inputValues 必须得到字节一致的正文。Create 失败不得创建 Task、
Snapshot、Message 或 Binding。

`task.create` typed command 只携带 owner、Workspace、Task Setup Draft 与 observed revision，不接受 Renderer
提供的 `taskId`。Task/Run owner 在 command replay 与 revision fence 通过后的同一事务中分配 opaque Task identity，
冻结 Architecture Snapshot、消费 Task Setup Draft，并把新 ID 作为 typed result 返回；模糊 transport 重试复用
原 `commandId` 时返回第一次提交的同一结果，而不是生成第二个 Task。

Meta Session 创建时，用户只能从 Host 的只读 typed readiness options 中选择 `metaProfileOptionId`；Provider、
model 与 effort 控件只是这些 option 的安全分组视图，不是自由输入。Host 在 owner
层复核 availability，并把该 option 的 portable ACP Profile revision、Provider family、model 与 capability policy
冻结进 `MetaSession`。Renderer 不能提交任意 Provider/model、launcher、版本或 resolution 字符串；resume 重新解析
当前安装，并要求同一 Profile/model 的 ACP negotiation 与 live behavior 仍合格，失配时明确 unavailable，绝不
fallback。
Meta Profile 没有通用工具、cwd、Workspace filesystem 或 Task transcript capability。Template Design 模式仅获得
一个 Host 注入、`MetaTurn`-scoped 的 `template_draft` MCP：它按稳定 `agentCardId` / `executionProfileId` 与 Draft
revision 读取目标，并构造 typed create/read/update/delete/reorder、唯一子串 Prompt edit 及 Host-issued Profile revision
选择操作。工具调用不写 Draft；最终只形成 Pending Proposal，仍须用户显式 Apply。Task Setup 模式保持零工具。

每条用户 Meta message 与一个 configuration-owned `MetaTurn` 原子持久化。`MetaTurn` 冻结 Meta Profile、mode、
target revision、对象受限 context、system instructions、whole-final output schema 及各自 digest；它不创建 Task
`Binding`、`ProviderFact`、`SessionTurn`、Task 编排工作单或 `MessageForward`。Host 通过独立 `MetaAgentPort` 调度它，
`MetaAgentPort` 与 Task SR 复用同一个 ACP Client/launcher 机械层，但必须解析独立 Profile、启动独立 ACP Agent process、
使用独立 raw-ID map 与 no-workspace、proposal-only scoped-tool capability broker；不能把 Task SR 或 Task-shaped `ProviderPort` 伪装成
Meta Session。首次 lease 才可直接 submit；恢复后的 pending、已 accepted
或 ambiguous Turn 必须先 reconcile。无法证明 native absence/completion 时保留 typed `ambiguous`，绝不自动重发。

Meta Provider 只能返回与该 Turn 精确关联的一个 whole-final JSON。Runtime 拒绝 fenced/substring JSON、未知字段、
mode 不匹配 operation、未授权工具/文件/native child 活动与多 final；Template Design 仅允许同一 Turn lease 下已经
注册的 `template_draft` 工具。模型不能用整段 Prompt replacement 或自由 model 字符串绕过局部 edit/Profile revision
选择；随后用目标 Draft 的当前 revision 做 dry-run 校验。
assistant Meta message、可选 pending proposal、MetaSession revision 与 `MetaTurn.returned` 在同一事务提交。Provider
final 本身永远不会 Apply/Publish/Create/Start；目标已消费、abandon、revision 或冻结的 Profile/model/capability policy 已变化时，迟到结果只保留
失败/歧义审计，不修改目标。

Template Design Draft/MetaSession 持久到用户显式 `abandon` 或 Publish，Task Setup Draft/MetaSession 持久到
显式 `abandon` 或 Create；Publish/Create 只把它们标为已消费并保留审计，不由关闭、隐藏、停靠、切换页面或
断线触发。Template Design 与 Task Setup 使用不同 Draft、MetaSession、message history 和 revision lane，互不
读取；两者唯一桥梁是用户确认后选定的 immutable Template Version，不传 Meta transcript 或未应用 proposal。

一个 proposal 固定包含 target Draft、base revision、理由、校验/未解决项和有序 typed patch operations；操作
路径和值必须由目标 Draft schema 验证，不能是 opaque merge blob。用户只能整份 Apply 或 Reject：Apply 携带
`expectedDraftRevision`，按顺序原子执行全部操作并只递增一次 revision；任一操作或 revision 失败则零操作生效。
Reject 不改变 Draft。v1 不做逐 operation 部分接受、自动 rebase 或连续 proposal 的隐式应用。

Task Setup v1 是完整 Surface，不是小型 Create dialog：Version、Workspace、title、goal 与 input 主表单始终可见；
只有 Meta 区域初始显示 opener/collapsed rail。面板默认浮动，用户停靠后才与主表单组成可读双栏。
它复用 Chat shell 组件但没有 Task Session Tabs；浮窗/停靠/关闭仍只是 Renderer view state。

当 Task 要求最终 HTML 时，Agent 通过自己被授权的最小 Workspace tool 写入 project-relative `.html`，并可在
canonical final 中向人类说明相对路径。文件系统仍是唯一事实；Host 只生成 Files & Changes 观察，并在每次
Open/Preview 时重新校验 Workspace 边界、非 symlink、常规文件、大小/类型与当前 digest。观察记录不拥有文件、
不因 Final 声明自动建立来源，也不成为 Gateway 引用。用户可独立 Achieve，并可选保存
`{ workspaceRelativePath, observedDigest, label? }` 状态锚点；该锚点不是快照。文件存在、Agent/Conductor 声称
完成或 Provider terminal 均不能代替 Achieve，Achieve 也不自动 Stop。

### Built-in ACP Starters

隔离 Runtime Host 在启动时可以幂等安装不可变的 `OpenCode ACP Starter` 与 `Codex ACP Starter` portable Template
Version。它们只引用对应 ACP Profile requirement，不锁定 OpenCode/Codex/wrapper 版本、binary hash、launcher path、
schema fingerprint 或本机 resolution。真正 Start 时 Host 必须解析当前安装、完成 ACP `initialize` 协商，并针对
当前 artifact/upstream、model 与 role policy 运行所需 live qualification。用户可从 Starter 创建自己的 Draft 或新
Version，但 Host 不会把本机观测回写到 built-in Version。

正式 Template Studio 和 Task 创建面只显示 Host-ready Profile 对应的 Starter；仍必须由用户显式选择 Template
Version、授权 Workspace、创建 Task、再发出 Start。Starter 安装绝不能创建 Task、启动 Run、安装 wrapper 或写入
Achieve。

## 3. Conductor 主权的 Session-ID 编排 Runtime

### 3.1 一轮闭环与四个公开动作

Task Run 的协作闭环固定为：

```text
task_goal / Task 用户输入 / Worker final / Human Intervention / Runtime Notice
  -> Conductor Inbox
  -> Conductor SessionTurn
  -> invoke_agent(agentCardId) 仅在无 current Session 时建立会话身份
  -> send_to_session(sessionId, payload) 创建单目标内容投递
  -> Card Inbox -> InputSubmission -> SessionTurn -> Provider
  -> 唯一 canonical agent_final
  -> FinalForConductor -> Conductor Inbox
```

这不是 Provider-to-Provider 调用。Conductor 决定 what / who / why；Runtime 保证身份、顺序、可靠投递、
用户优先、恢复和审计；Provider 只负责自己的原生过程。

Conductor 可见的 Gateway 恰好只有四个动作：

```ts
invoke_agent({ agentCardId })
  -> { sessionId } | rejected(reason)

send_to_session({
  sessionId,
  payload: {
    content?: string,
    messageRefs?: MessageRef[]
  }
})
  -> accepted | rejected(reason)

interrupt_session({ sessionId })
  -> accepted | rejected(reason)

close_session({ sessionId })
  -> closed | rejected(reason)

type MessageRef =
  | { kind: "full_message"; sourceMessageId: string }
  | { kind: "relay_block"; sourceMessageId: string; relayBlockId: string }
```

固定语义：

| 动作 | Runtime 提交点 | 明确不做 |
| --- | --- | --- |
| `invoke_agent` | 校验 frozen Card、Run 与调用 scope；当 Slot 无 current 时创建新 generation / LogicalSession，并返回 Runtime 生成的 opaque `sessionId` | 不携带正文或引用；不创建 Binding、Message、Forward、Inbox、Input 或 Turn；不复用已有 current；不接受自造 ID |
| `send_to_session` | 原子校验 current Session、Run、Conductor Turn、用户优先与 refs；持久化一个 MessageForward、新的目标 `conductor_forward` Message 和 Inbox 后才返回 `accepted` | 不创建 Session；不按 Card 名猜目标；不隐式 interrupt；不返回内部 Forward/Message/Turn ID |
| `interrupt_session` | 只对该 Session 当前由同一 Conductor 发起且允许中断的 active Turn 写 durable control request；写入后返回 `accepted` | 不声称 Provider 已停；不关闭 Session；不产生正文；不覆盖 HumanIntervention 或 Attention/Permission |
| `close_session` | 仅在 current、无 active/ambiguous Turn、无 held human、无 active/unresolved HumanIntervention、无 unresolved Attention/Permission 且无需 reconcile 时，原子 suppress 尚未 handed 的普通 Conductor Inbox、记录 affected IDs、退役 generation，再返回 `closed` | 不自动 interrupt、不 suppress 人类/Attention 内容、不删除历史、不创建下一代、不释放/kill 原生过程 |

`sessionId` 是当前 Run 内的 Runtime 地址，不是 Provider native id，也不能跨 Run 使用。成功的 invoke 只返回它；
send 只返回 accepted；interrupt 的 accepted 只表示意图已记录，真实结果以后由 Notice 抵达；close 必须真的
完成才返回 closed。拒绝回执只给稳定、脱敏 reason，不暴露 revision、epoch、Turn、Forward、Binding 或 Provider
状态。

Conductor 不充当数据库客户端。`commandId`、`taskId`、`runId`、`expectedRevision`、调用 Turn、幂等键和
Planning Fence 由 Host 从**受管 Conductor tool-call context**取得或生成，并在 Runtime command boundary 保存。
这些字段仍是内部可靠性契约，但不进入模型工具参数或成功回执。

受管 tool call 的稳定内部 idempotency key 也冻结回执：同一 key 与字节一致 payload 的重放返回第一次提交的
`{ sessionId }`、`accepted`、`closed` 或 `rejected(reason)`，不重新创建 Slot/Forward/ControlAudit 或 Provider
effect；同一 key 配不同 payload 必须 fail closed。只有新的 key 才按当下 current/fence/用户优先状态重新判断。

### 3.2 Conductor-only 工具注入与安全边界

四个 Gateway 工具是 Runtime Host 注入 Conductor Binding 的**编排 capability**，不是普通 shell/web/MCP/
workspace tool：

- Host 只为一个 active Run 的 Conductor LogicalSession 建立 binding/Turn-scoped MCP server，并在该 ACP Session 的
  `mcpServers` setup 中注入；Worker、Meta、Renderer、其他 ACP Session 与外部 Provider 页面都拿不到。
- 每次 tool call 由 Host 绑定 `taskId + runId + conductorLogicalSessionId + conductorSessionTurnId`，生成稳定
  command/idempotency identity，并在执行前检查该 Turn 仍可提交协作动作。
- 普通 Execution Profile 的 `allowedTools: []` / `permissionMode: deny` 不会移除这四个 Runtime 内建工具；Profile
  必须另有 role-scoped `orchestrationCapabilities`，Conductor 固定为这四项，Worker/Meta 固定为空。它不授权
  shell、filesystem、网络或 Provider 原生控制。
- ACP Client 只承载 ACP Agent 发出的 MCP tool-call request/result；Runtime Host 才执行 Gateway。工具调用不能经
  Renderer、generic RuntimeClient、全局 MCP 配置、raw proxy 或 Provider SDK 直达 Store。
- 真实 Provider 若不能可靠产生、关联和恢复这些 tool calls，则只能运行单 Session，不得宣称支持自动多 Agent
  编排。

Publisher、Worker 与 Reviewer 都是普通 Provider Session。它们不注入 Agent Workspace 自定义 MCP 工具；文件、shell、
搜索等执行能力来自所选 ACP Agent 自身，并受 Provider 原生权限与 Task Workspace 边界约束。只有 Conductor 注入上述
四个编排工具。Host 的 `Files & Changes` 只在事后以 Task Workspace observation 投影文件变化；它不代理普通 Session
的文件工具，也不把文件变化转成 Artifact、Message 或 Achieve。Meta 仍不获得 Task Workspace、Provider原生工具或
Task工具；Template Design仅获得上述proposal-only `template_draft` MCP。

因此，“TypeScript 中存在一个 gateway wrapper”不构成产品能力。发布门必须观察到真实 Conductor Provider
发出四工具之一、Runtime durable 提交、tool result 回到同一 Turn，以及 Host restart 后不重复 side effect。

### 3.3 CardSessionSlot、generation、Directory 与串行 Lane

Card 是冻结角色，不是永久会话。每个 `(runId, agentCardId)` 有一个 `CardSessionSlot`，保存 0..N 代
LogicalSession，至多一代 current / routeable：

```ts
type CardSessionDirectoryItem = {
  agentCardId: string
  currentSessionId?: string
  state:
    | "no_session"
    | "available"
    | "busy"
    | "human_blocked"
    | "attention_blocked"
    | "reconciling"
    | "closed"
    | "faulted"
}
```

Directory 只供发现与重新规划。正常收到 A 的 Final 后，`sourceSessionId` 已经是继续 A 的地址，不需要先查
Directory。只有首次选择 Card、忘记地址、改选 Card，或 send/interrupt/close 被拒绝后才读取 Directory。
Directory 不暴露 Slot revision、Turn ID、Binding/native id、完整 transcript 或 Store 查询能力。

Directory 不是第五个 Gateway tool。Host 把这份最小、只读、受信快照作为 Conductor Turn context/resource
注入，并在相关 Inbox 状态或工具拒绝后刷新；模型不能提交查询条件、遍历 Store 或从中读取历史 transcript。

V1 每个 Session 固定一条 durable FIFO Lane：

1. 同一 `sessionId` 至多一个 active InputSubmission / SessionTurn；
2. 被 Runtime 接受的普通 Conductor send 按 durable 接受顺序推进，不并发交给 Provider；
3. HumanIntervention、Attention/Permission、reconcile 与 close gate 可以 hold、suppress 或拒绝普通 send；
4. held 的人类消息不是“排在普通消息后面”的 queue item，必须按 `3.6` 的用户优先规则处理；
5. Provider 即使支持并行，也不能改变这一编排语义；未来并发必须另立显式分支模型。

关闭后旧 generation 只读。重新开始必须是独立动作序列：

```text
interrupt_session(oldSessionId)? -> 等待真实结果
-> close_session(oldSessionId) -> closed
-> invoke_agent(agentCardId) -> newSessionId
-> send_to_session(newSessionId, payload)
```

每个箭头都重新检查用户事件与 Runtime 状态。旧 `sessionId` 的 send 必须以稳定、脱敏的
`orchestration_session_not_current` 拒绝；历史 Message 仍可按 messageId / relayBlockId 引用，但不会暗中投到
新 generation。发布证明必须让受管 Conductor tool-call context 在 close A1、invoke 得到不同的 A2 后实际执行一次
`send_to_session(A1, ...)`；测试直调 Gateway/Store 或只观察 Directory 的 G1 只读状态不能代证。

### 3.4 SessionMessage、引用与唯一 Final

任何会让 LogicalSession 的模型读取的受管协作正文，都必须先成为不可变 `SessionMessage`，再走：

```text
SessionMessage -> SessionInboxItem -> InputSubmission -> Provider user-role input
```

V1 的协作 kind 收敛为：

```ts
type SessionMessageKind =
  | "task_goal"
  | "user_input"
  | "conductor_forward"
  | "agent_final"
  | "runtime_notice"
```

`user` 是 Provider delivery role，不表示真实发起者。`initiator`、`trigger`、Forward/Human 关系与 affected Turn
都留在 Runtime provenance。

`send_to_session.payload` 必须满足非空 `content` 或至少一个 `messageRef`。新 content 与有序引用被展开成一条
**新的目标 Message 快照**：

- `full_message` 选择同一 Task/Run 内 Conductor 已有权读取的完整不可变 Message；
- `relay_block` 选择该 Message canonical content 中一个确定的 RelayBlock；
- Runtime 校验来源、scope、block 归属与 digest，再把所选快照渲染进目标 Message；
- 目标看不到未选择的正文、sibling Message、Provider transcript、ToolCall、文件正文或可回拉历史的 live handle。

一条 send 只能一个目标。所谓多目标发布只能由 Conductor 对每个明确 `sessionId` 各发一次独立 send；Runtime
没有 `publish_message`、MessageForwardBatch、共享 topic 或隐式 fan-out。

每个成功 SessionTurn 恰好产生一条 canonical `agent_final`；失败、取消或 confirmed interrupted 可为零，但任何
Turn 都不得超过一条。SR 只提交已和 prompt terminal 配对的标准 Final 草稿；Runtime 的单一 canonicalizer 解析严格 `relay` fenced
grammar，形成内容 AST：

```ts
type CanonicalContentNode =
  | { kind: "text"; text: string }
  | {
      kind: "relay"
      relayBlockId: string
      suggestedTargetAgentCardIds: readonly string[]
      suggestedAudience?: "one" | "publish"
      topic?: string
      format: "text/markdown" | "application/json"
      content: string
    }

type CanonicalContent = readonly CanonicalContentNode[]
```

有效 block 必须成对、含 `---`，ID 由 `sourceMessageId + ordinal + sourceRange + contentDigest + parserVersion`
确定性生成；无效 block 只作为 text。`to` / `audience` 只是可见提示，不自动路由。Runtime 保存同一份 canonical
content 并用一个 deterministic renderer 给 Provider/UI；不得让各 ACP Profile/wrapper 各自发明格式。

Conductor 对成功回信只读取三项：

```ts
type FinalForConductor = {
  messageId: string
  sourceSessionId: string
  content: CanonicalContent
}
```

完整 content 直接进入下一 Conductor input，RelayBlock ID 嵌在节点内。Task/Run、来源 Turn、Forward、
HumanIntervention、range/digest 与内部状态不进入模型。继续该 Agent 直接
`send_to_session({ sessionId: sourceSessionId, payload })`。

人类输入与 Runtime 说明是另外两种受信 envelope，不是 Final 的扩展字段：

```ts
type HumanInterventionForConductor = {
  messageId: string
  sessionId: string
  content: string
}

type SessionNoticeForConductor = {
  messageId: string
  sessionId: string
  content: string
}
```

Runtime 把 envelope 类型和由 sessionId 映射的 Card 显示名作为不可伪造标签编译给模型。Conductor 不获得
generic message/read-store API；它只在已经收到的 canonical content 中使用 messageId / relayBlockId。

### 3.5 Task 根输入、Planning Fence 与 Conductor Inbox 顺序

`task.start` 是控制命令。它创建 fresh Run、Conductor LogicalSession 和每张 Card 的
`CardSessionSlot(state = unmaterialized)`；然后只从 immutable Architecture Snapshot 与已验证 Task Setup
Snapshot 确定性编译一条 `task_goal` Message。Meta transcript、proposal、未应用 Draft、Renderer state 与
Provider transcript 不进入 Run。

Task 总入口后续文字先持久化为给 Conductor 的 `user_input`，并在同一接受边界建立
`ConductorPlanningFence`。若旧 Conductor Turn 仍运行：

- fence 后该旧 Turn 的新 invoke/send/interrupt/close 必须被拒绝；
- fence 前已经 durable 接受的 send 是审计事实，不假装撤回；
- Provider 可证明 targeted interrupt 时可受控请求；否则 UI 显示“新意图已生效，等待当前工作收束”；
- 用户内容只在安全时作为下一 Conductor Turn 输入，不能藏进 Provider 原生 queue。

Conductor Inbox 顺序是 durable 产品语义：

1. 新 Run 的 `task_goal` 是唯一首输入；
2. 之后 Task 用户输入、HumanIntervention 与 Attention/Permission 回复优先于普通 Worker Final；
3. 解释晚到 Final、中断或未投递人类内容的 Notice 必须紧邻并先于被解释内容；
4. 同优先级按 durable enqueue 顺序；
5. Stop/Fence 是控制门，不是可被队列越过的普通模型消息；
6. WakeConductor 只含待处理引用，可丢失、合并或重放；恢复真相只有 durable Inbox。

### 3.6 人类直接介入与 busy Card

用户可在 Card Composer 明确向 Card 发送内容；这不是 Conductor Forward，也不需要 Conductor批准。Runtime 从认证
主体写 `initiator = human`，其他 Card 零 Inbox，Conductor 收到完整透明内容。

空闲 Card 的接受事务固定先建立 Conductor envelope，再使 Card 输入可推进：

```text
HumanIntervention
  -> Card user_input + HumanInterventionForConductor 两条 SessionMessage
  -> Conductor Inbox
  -> Card Inbox（只有 mirror 已 enqueue 后才可 lease）
```

若 Card 尚未 materialize，Human Intervention 用例只能调用 Task/Run service 的 owner-scoped materialize 操作，
由后者在同一受控事务中为明确 frozen Card 建立 Runtime generation；Intervention service 与 Renderer 都不能直接
写 Slot，且所得 sessionId 仍由 Runtime 生成。

Card busy 时，用户点击的唯一语义是 **interrupt-then-send**，不是本地草稿等待，也不是普通队列：

1. 点击前文字只是 Renderer draft；点击后 Runtime 立即 durable 接受 `HumanIntervention`。
2. 同一事务创建两条完整 Message：Card `user_input` 的 Inbox 为 `held_by_human_intervention`、没有
   InputSubmission；Conductor mirror 立即 pending。必须先 enqueue mirror，之后才可能推动 Card。
3. 同 Lane 尚未 handed-to-adapter 的冲突 Conductor 输入改为 `suppressed(reason = human_intervention)`，并写一个
  影响下一步判断的 Notice；新的普通 send 在人类路径收束前拒绝。
4. Runtime 对旧 active Turn 发 scoped interrupt，并等待 Provider 事实。请求 accepted 不等于已中断。
5. 若旧 Turn 晚到真实 Final，先 enqueue 因果 Notice，再 enqueue 原 Final；Final provenance 不改，不能当作对
   新人类文字的回答。
6. 若确认 interrupted 且无 Final，Turn 记 interrupted，并给 Conductor 一条去重 Notice；不伪造 Final。
7. 若 interrupt 超时或结果不明，Session 进入 reconciling；Card Message 保持 held，不自动重发、不创建并行 Turn。
8. 在 release held Message 前再次检查 Run、Intervention、Lane 与 Stop fence。Task Stop 已接受时，Card held
   Message 与尚未送入 Conductor 模型的 mirror 都标 suppressed，Intervention 为
   `cancelled_by_task_stop`；旧 Run 只保留审计。
9. 只有旧 Turn 安全收束且门禁通过，Card Inbox 才进入 InputSubmission，并创建
   `SessionTurn(trigger = human_interrupt_then_send)`。它不创建 MessageForward；其成功 Final 正常回 Conductor。

用户在 InputSubmission 前显式放弃时，内容与审计保留、Card 不收到；Run 仍接受输入时给 Conductor Notice。
ACP Interaction/Permission 回复是现有 Turn 的 `interaction_continuation`，保留原 provenance。Renderer只能提交
Workspace opaque `interactionId + expectedInteractionRevision + choiceId`；Human Intervention owner从持久化的安全
choice解析label，并把该选择的完整安全label透明同步给Conductor。Renderer不得提交自由文本、label或raw ACP option
id；等待Interaction时普通Composer也不得把新文字混入同一Turn。

### 3.7 interrupt、close、Notice 与 Stop

Conductor interrupt 只能针对当前 Run、当前 Session、由它自己的 send 触发且 active 的 Turn；人类 Turn、
Attention continuation 或 active HumanIntervention 一律拒绝。Runtime 内部由 sessionId 定位 Turn，不让模型传
Turn/Binding/Provider ID。实际结果通过 `SessionNoticeForConductor`：

- confirmed interrupted、且无 Final；
- interrupt 无法确认、Session 进入 reconcile；
- 请求被用户优先路径 supersede；
- 晚到 Final 的因果说明。

认证用户的“仅中断当前 Card，不附新文字”是独立产品命令
`session.request_interrupt({ taskId, runId, sessionId, commandId, expectedRevision })`，不是第五个 Conductor
Gateway action。Runtime 校验用户、current Session、Run revision 与目标 active Turn，再由 application transaction
通过 owner-scoped capability 原子写入 `HumanIntervention(mode = scoped_interrupt)` 引用、
`SessionControlAudit` request 和 Provider outbox；不创建用户 Message。command accepted 只表示 durable intent，
之后必须由 SR settlement/reconcile 得到 confirmed、unknown 或 late-final 结果。Run 仍可接收时，给
Conductor 一条去重的因果 Notice；Stop/旧 Run 则只保留 control/intervention 审计，不生成可消费 Inbox。

`runtime_notice` 只在改变 Conductor 下一步决策时进入 Inbox，允许原因限于：人类内容未投递/被放弃、受控
interrupt 最终结果、Session 不可继续或需 reconcile、晚到 Final 因果。重试、心跳、stream、ToolCall、Provider
trace 与不要求重规划的错误只进 UI/审计。Notice 按状态转变去重，不成为日志流。

`close_session` 不隐含 interrupt。active/ambiguous Turn、held human Inbox、active/unresolved HumanIntervention、
unresolved Attention/Permission 或未清 Provider outcome 存在时拒绝。只有尚未 handed-to-adapter、由该 Conductor 普通 send 产生的 pending Inbox
可在同一个 close 事务中标记 `suppressed(reason = session_closed)`；`SessionControlAudit` 记录 affected Inbox/Forward，
完成 suppress 与退役后才返回 `closed`。关闭成功后 Slot current pointer 清空，旧 Session/Binding/Message/Turn 均
只读保留。后续 invoke 新代不继承 native transcript；Handoff 是后续用户确认、能力受限的恢复用例，不是
close/reopen 或 V1 编排前提。

Task Stop 属于用户生命周期命令。接受后立即进入 stopping，并 suppress 一切尚未 handed-to-adapter 的新编排输入，
包括 held Card Message 与未消费 mirror。Stop 后到达的 Final/Notice 仍以原 runId 保存为
`late_after_stop` 审计，不创建可消费 Inbox/Wake，也绝不进入 Restart 的新 Run。Adapter/terminal 只能提供对账
事实，不能宣称 Runtime 同步杀死了 Provider 原生过程。

### 3.8 Durable 关系与唯一 writer

```text
card_session_slots(run_id, agent_card_id, current_session_id?, generation)
  └─ logical_sessions(session_id, generation, lifecycle)
       └─ provider_session_bindings(...) 0..N lineage

session_id_provider_effect_outbox(task/run/session, optional turn/control/attention,
                                   effect intent, idempotency, lease, receipt/unknown)
  └─ correlated ProviderFact / reconcile projection

session_messages(message_id, canonical immutable content)
  └─ relay_blocks(relay_block_id, source_message_id, ordinal, range, digest)

message_forwards(forward_id, one send decision, target_session_id, new_content_digest, ordered_ref_snapshots, rendered_message_id)
  └─ rendered session_message(conductor_forward)
       └─ session_inbox_item
            └─ input_submission
                 └─ session_turn
                      └─ provider_facts (integration-private evidence)

human_interventions(...)
  ├─ card target message -> held/pending inbox -> input -> turn
  └─ conductor mirror message -> conductor inbox

conductor_planning_fences(...)
session_control_audits(conductor_interrupt | human_interrupt | close, request/result)
```

没有独立 Invocation、MessageForwardBatch、Wakeup、InvocationResult、Shared Relay 或 generic append-event。
一个 send 的新内容 digest、引用快照与结果 Message ID 由 MessageForward 记录；一个 Turn 的结果由 SessionTurn 记录；
Conductor interrupt、human scoped interrupt 与 close 由
SessionControlAudit 记录，三者不能互相代替。

| Owner | 写入 |
| --- | --- |
| Task/Run service | Task、Run、Architecture Snapshot、CardSessionSlot、LogicalSession、PlanningFence 与用户生命周期 |
| Binding service | ProviderSessionBinding lineage、Workspace opaque binding handle、status / recoverability；不保存 raw ACP session id |
| Runtime reliability/outbox capability | `session_id_provider_effect_outbox` intent、幂等键、lease、receipt/unknown 与 Task/Run/Session/Turn/Control/Attention correlation；不写 Binding 或 ProviderFact |
| Message service | SessionMessage、canonical content、RelayBlock、MessageForward 与确定性目标渲染 |
| Human Intervention service | HumanIntervention 与其引用的 Card/Conductor Message IDs；不写 Message 正文、Slot、Inbox 或 control result |
| Orchestration Coordinator | Inbox、held/suppress、Input、SessionTurn、SessionControlAudit、Workspace interaction/Attention、调度 intent 与 Notice 准入；不保存 raw ACP request/option id |
| Session Runtime service | SessionExecutionRuntime/Attempt、ACP delivery/interaction correlation、candidate/terminal pairing、reconcile 与 SessionRuntimeEvent settlement |
| ACP Client / normalizer | ACP wire observation 与 Host-private raw session/request/option/tool ID map；只向 SR 输出脱敏事实 |
| Workspace Tool/Observation service | scoped file-effect intent/result 与 human-only Files & Changes observation |
| Renderer | 仅 view state、unsaved draft、request progress 与 typed read-model cache |

跨 owner 外部 effect 前先写 durable intent + idempotency；不能原子提交时使用 outbox/reconcile。Read model 永远
无副作用。

### 3.9 端到端例：Researcher A 与 Reviewer B

```text
1. Conductor: invoke_agent({ agentCardId: A }) -> { sessionId: A1 }
   Runtime 只有 A Slot generation 1 / LogicalSession；没有正文、Binding 或 Turn。

2. Conductor: send_to_session({
     sessionId: A1,
     payload: { content: "研究目标与边界" }
   }) -> accepted
   Runtime durable 写 Forward -> conductor_forward -> A Inbox，再按 Lane 建 Binding/Input/Turn。

3. A 返回唯一 agent_final。
   Runtime canonicalize relay nodes，给 Conductor：
   { messageId: message_A, sourceSessionId: A1, content: <完整 canonical content> }

4. Conductor: invoke_agent({ agentCardId: B }) -> { sessionId: B1 }

5. Conductor: send_to_session({
     sessionId: B1,
     payload: {
       content: "复核这个风险点",
       messageRefs: [{
         kind: "relay_block",
         sourceMessageId: message_A,
         relayBlockId: relay_A_1
       }]
     }
   }) -> accepted

6. B 只读到新指令和 relay_A_1 快照。B 的唯一 final 再回 Conductor；B 不直连 A。

7. 若继续 A，Conductor 直接 send_to_session(A1, payload)；若要丢弃上下文，则先安全
   interrupt? -> close(A1) -> invoke(A) 得到 A2 -> send(A2)。
```

完整 Message 是 Conductor 的决策上下文；RelayBlock 是精确引用候选；MessageForward 是一次实际单目标 send 的
审计。它们分别回答“看见什么”“选择什么”“发了什么”，不会合并成 visibility 字段。
## 4. ACP-only Session Runtime 与事实模型

统一的是正式 wire 与生命周期合同，不是假装所有 Provider 内部实现相同。OpenCode、Codex、Claude Agent 仍可拥有
各自原生对话、tool loop、stream、session 与长过程，但 Agent Workspace production graph 只实现 ACP Client；
Provider-specific transport 和 SDK 只能封装在独立 ACP Agent/wrapper 内。

```text
portable ACP Profile requirement
  -> Host current-install discovery / trust
  -> LocalResolutionSeal
  -> ACP process launch
  -> initialize(protocolVersion = 1) + capability negotiation
  -> model/role-bound live ACPQualification
  -> SR ensure/load/resume/prompt/cancel/reconcile
```

`AcpTaskSessionRuntimeProvider` 是 application/OR 与 Host-native Binding 之间的唯一 Provider-neutral managed
lifecycle 边界。它只接受已持久化的 v3 effect/retirement intent ID；OR/application 不直接面对 ACP
connection，也不按 `providerFamily` 品牌选择 native adapter。SR 必须从
ACP update/response 中观察受管输入回执、可关联 final candidate、prompt terminal、interaction、cancel 与恢复证据，
再提交脱敏 `SessionRuntimeEvent`；否则不得推进 OR-owned Input/SessionTurn 或 Binding-service-owned Binding 状态。

### 4.0 ACP-first 原型差异决议

外部 ACP-first 产品原型是本节的设计输入，但仓库 authority 必须把其中的简写、后续用户决议与现有 single-writer
领域模型收敛成一个可执行含义。以下决议具有规范性；实现不得同时保留两种解释：

| 原型中的简写或分歧 | 本架构冻结的含义 | 原因 |
| --- | --- | --- |
| `ACPProfile` pin 精确 launcher / wrapper / upstream version 与 digest | portable Profile 只声明 protocol major、Agent kind、model/config intent、required capability 与 policy；Host 对**当前实际解析的安装**签发 exact `LocalResolutionSeal` | 不用仓库版本 allowlist 阻断升级，同时保留单次 Binding/process/release 的 artifact identity、TOCTOU 与 drift 证明 |
| “SR owns Binding / Turn / Attention” | Binding service 唯一写 durable Binding/current pointer；Orchestration Coordinator 写协作 `SessionTurn`；SR 写 `SessionExecutionRuntime/Attempt`及其 choice-only Interaction；Human Intervention service 写认证用户的 choice 回复及归因；ACP Client 只持有 raw request/option map并输出脱敏 observation | 把协作事实、用户归因、Provider execution attempt 和 raw ACP request map 分开；新 production 路径不再创建平行 Attention 事实 |
| Handoff 图中的“new SR / new Binding” | 一个 materialized LogicalSession 始终只有一个稳定 SR；Handoff 只创建 target Binding lineage 与新的 process lease | “每 LogicalSession 一个 SR”与恢复/因果 fence保持一致；若需要第二个 SR，那是新 LogicalSession/generation，不是 Handoff |
| ACP managed baseline 等于整个产品已可用 | generic baseline 只证明 session core；每个 portable Profile 还必须独立通过它声明的 role capability gate | 能聊天不等于能运行 Conductor 四工具、Publisher 写入或 Meta whole-final；缺少某项只让要求该项的 Profile unavailable |
| Compatibility Catalog 决定 runtime 可接受版本 | Catalog 只可做用户确认的安装、升级、回滚建议；runtime admission 只认本机当前 resolution + initialize + live qualification | 推荐供应链 artifact 与本机实际运行证明是两件事；Catalog 不能成为 supported-version allowlist |

V1 不实现跨 Binding 的 ACP process pooling。每个 active/reconciling Binding 在任一时刻至多绑定一个专属 Host-owned
ACP Agent process/connection generation；同一 process generation 不得同时服务两个 Task Binding 或 MetaSession。稳定
SR 的寿命长于 OS process：crash/restart 可在同一 SR、同一 Binding 下建立新 process generation，但必须重新
discovery/qualification，并以 load/resume/reconcile 证明连续性。future Handoff 期间，同一 SR 可暂时监督 source 与
target 两份相互隔离的 lease；source 仍是 current，直到 target receipt满足切换条件。MetaSession 始终使用独立
Profile/process/connection/raw-ID map。未来若引入受控 pooling，必须先证明 credential、cwd、MCP catalog、raw-ID map、
cancel、terminal 与 cleanup 在 Binding 间不可串权，且不得改变上述 durable owner、identity fence 或 release evidence
语义。

`available` 的准入单位是 `profileRevisionId × LocalResolutionSeal × model/config × role policy × Host generation`。
generic ACP session-core PASS 不得跨 Profile、Provider、model、role 或 process generation 复用。Conductor 必须另证恰好
四个 scoped orchestration tools；Publisher 必须另证路径受限的 file-effect capability；Worker 不继承 Conductor 权限；
Meta 必须另证无通用/Task/Workspace tools、no-cwd/no-Workspace、Template Design 的精确
`template_draft` Turn lease 与撤销，以及 strict whole-final；Task Setup 仍须另证零工具。

### 4.1 ACP Profile、当前安装解析与资格

Portable Profile requirement 固定：

```text
profileRevisionId
providerFamily = opencode | codex | claude-code
acpAgentKind = native_acp | codex_acp | claude_agent_acp
protocolMajor = 1
model/config intent
required capabilities/extensions
permission/capability policy
```

它不包含本机 path、version、hash、credential、raw session id 或 Host resolution id。Host-only discovery 解析当前
Provider 安装与 Agent Workspace 管理的 ACP runtime component：OpenCode 使用用户当前安装的 `opencode acp`；Codex 与
Claude Code 使用 Agent Workspace 管理的官方 ACP server package，用户只配置 Provider CLI/登录源。受管 ACP server 的
path 是 Host 内部实现细节，不是 Renderer 字段；解析结果也不因版本号未知而拒绝。Host 为实际将要运行的 artifact 及 wrapper 内 upstream 生成 `LocalResolutionSeal`，至少包含 canonical launcher
identity、observed artifact/upstream version、digest/signature/trust state、execution-config digest 与 observedAt。

启动后必须通过 ACP `initialize` 取得实际 protocol/agentInfo/capability/extension fingerprint，再用当前 model 对 Profile
所需的 create/load-or-resume、prompt receipt、final+terminal、cancel/reconcile、interaction 与 role-scoped MCP behavior
执行有界 live probe。只有本进程签发、同时绑定 resolution seal、model/config、probe digest 和 Host generation 的
opaque `ACPQualification` 可以授予能力。运行期任一 artifact、initialize observation 或 capability inventory 漂移都让
本 generation fail closed；下一次重新 discovery/qualification 可以接受任何新版本。

仓库、Template、Renderer 与 environment 不能提交“期望 version/hash”来授权；Compatibility Catalog 如存在，只用于
用户显式安装/信任提示，不是 runtime allowlist。ACP protocol major 与 required capability 是协议合同，不是 Provider
版本锁定。

### 4.2 私有 identity 与路径边界

raw ACP `sessionId`、permission request/option id、toolCall id、JSON-RPC id、absolute cwd、credential 和 wire payload
只能存在于 Host/ACP Client 私有边界。为跨Runtime Host重启恢复，只有raw ACP `sessionId`可进入Runtime data目录下
独立的0600 Host-private recovery map；它按Profile resolution、Binding与generation fence读取，不属于领域SQLite、
ProviderFact、evidence或Renderer。每个live generation只把本次checkout materialize进generation-local map；permission、
option、tool call与JSON-RPC映射始终只存活于该generation。Workspace domain/SQLite/ProviderFact/UI/evidence 使用
Workspace 生成的 opaque `bindingHandle`、`interactionId`、`choiceId` 与脱敏 digest：

旧 Host generation 是否已经死亡不能由新 Runtime Host 自己声明。Desktop supervisor 或 formal launcher持有唯一
recovery issuer：它为每个子 Host 分配新的opaque Host epoch，只有在等待到旧子进程真实`exit`之后，才能为同一
canonical Runtime data root、exact dead epoch与exact new epoch签发一次性恢复证明。子 Host只得到公开验证材料与该
scope-bound证明，不得到issuer/private signing key；它把有效证明转换成本进程opaque lease后才可回收旧generation
或stale writer lock。`SIGTERM -> SIGKILL`后仍未确认exit、proof被篡改/重放、root/epoch不一致或lease inode/权限漂移
都必须fail closed并保留旧槽位；正常关闭只删除自己持有的exact lease inode。进程内WeakMap-branded recovery test只能
证明机械合同，不能替代Desktop/launcher跨进程恢复证据。

```text
bindingHandle -> Host-private ACP sessionId
interactionId + choiceId + Binding/Attempt/revision fence
  -> Host-private ACP requestId + optionId
wire cwd -> per-Binding empty Host-private absolute directory (0700)
workspaceId -> Host authorization -> Attempt-scoped filesystem / MCP capability
```

未知、重复、跨 Binding/Attempt 或过期映射必须 fail closed。不得把 raw ACP ID 包装成 `nativeBindingRef` 后持久化，
也不得把绝对 Workspace path 冻结进 portable Template/Profile 或投影给 Renderer。

### 4.3 Task SR、Meta 与 ACP process 隔离

每个 materialized LogicalSession 有一个稳定 SR，Handoff 只会让同一 SR 建立新的 Binding lineage，不会创建第二个
协作 Runtime。一个 SR 同时最多一个 active delivery；同一 attempt 的 final candidate 与 `session/prompt` terminal
必须精确配对，SR 才能 settlement。`session/load` replay、`session/resume`、process crash 与 ambiguous response 都先
reconcile；无法证明 completion/absence 时保持 reconciling，不自动重发。

Task 与 Meta 只复用 ACP Client/launcher 机械层。ACP协议虽然要求`session/new`提供absolute cwd，但该字段不能成为
Provider读取Task Workspace或项目配置的旁路：所有Task/Meta Binding都使用各自空的0700 Host-private session cwd；
真实Workspace只经`workspaceId`授权后的Attempt-scoped filesystem/MCP capability进入。当前ACP Agent若把wire cwd标为
trusted、读取项目级配置或把cwd当工具权限来源，也只能看到该私有空目录。Host不得把Task Workspace root作为
`session/new|load|resume.cwd`，也不得在Agent不支持此隔离时回退；这与“Meta零cwd”口径一致——即零Task/Workspace cwd
authority，而非省略协议必需字段。[OpenAI官方配置参考](https://developers.openai.com/codex/config-reference)说明
untrusted project会跳过项目级`.codex/`配置；Host仍不依赖某个Agent的当前trust实现来授权。

机械层具体边界：

- 每个 Task Binding 的 ACP process generation接受frozen bootstrap、Host-private session cwd、当前Binding的scoped MCP
  servers与权限broker；不得服务另一个Binding；
- Meta ACP process 使用独立 Profile/resolution/process/raw-ID map、空的Host-private wire cwd、零 Workspace authority、
  零 Task transcript；Task Setup 零工具，Template Design 只挂载 proposal-only `template_draft` MCP，并只返回 strict
  whole-final configuration JSON；
- 一个 Profile/process/qualification 不能授权另一个，OpenCode PASS 不能授权 Codex，Task PASS 不能授权 Meta。

### 4.4 Provider-neutral records

| ACP production record | 作用 | 唯一 Writer |
| --- | --- | --- |
| `AcpSafeSessionBindingRecordV3` | LogicalSession 到 opaque `bindingHandle`、Profile revision、status 与 recoverability 的关联 | Binding service |
| `SessionExecutionRuntimeRecord` / `SessionExecutionAttemptRecord` | 稳定 SR、单次 prompt Attempt、receipt、choice-only Interaction、final candidate、terminal 与 settlement | Session Runtime |
| `SessionRuntimeProviderEffectIntentRecord` | 在 submit/reconcile/interrupt/interaction response 前持久化 exact Binding/Profile/Attempt/OR correlation 与幂等键 | Runtime reliability capability |
| `AcpV3BindingRetirementIntentRecord` | 在 close/Stop 引发的 per-Binding native retire/cleanup 前持久化可恢复意图 | Runtime reliability capability |
| Host-private Binding identity map | opaque `bindingHandle` 到 raw ACP session identity、resolution fingerprint 与 Host epoch 的恢复映射 | Runtime Host private vault |

raw ACP session/request/option/tool ID 只在 Host-private mapping。SR correlation、Binding 私有恢复字段与
reliability intent 都不进入 Agent 编排对象链、Conductor tool schema、Renderer read model 或模型正文；
application/Coordinator 只经 owner-scoped capability 和已验证的 safe event/settlement 推进状态。

```ts
interface AcpTaskSessionRuntimeProvider {
  executeProviderEffect(providerEffectIntentId): Promise<Settled | Reconciling | Rejected>;
  retireBinding(bindingRetirementIntentId): Promise<Released>;
  close(): Promise<void>;
}

interface AcpTaskSessionRuntimeNativeBinding {
  submit(scope): Promise<NativeOutcome>;
  reconcile(scope): Promise<NativeOutcome>;
  requestInterrupt(scope): Promise<NativeOutcome>;
  respondInteraction?(scope): Promise<NativeOutcome>;
  retire({ signal }): Promise<void>;
  close({ signal }): Promise<void>;
}
```

公开application/OR边界只提交已持久化的v3 provider-effect或Binding-retirement intent ID；它不接触native
Binding对象。Host在每次native effect前从不可变Task Architecture snapshot解析exact
`executionProfileId + profileRevisionId + providerFamily + role`，复核current Binding/revision/opaque
`bindingHandle`与Workspace grant，并在Host-private边界编译session configuration、私有wire cwd和scoped MCP。
Message/Input正文只来自其唯一owner的durable记录；Adapter不能拼入其他Card的prompt、改写正文、解释
RelayBlock，或自行执行业务路由。

Conductor只在exact active Attempt获得四个role-scoped Runtime工具；Publisher只获得允许的Workspace工具；
Worker、Reviewer和Task Setup Meta默认零工具，Template Design Meta仅获得proposal-only `template_draft`工具。
`invoke_agent`不产生动态assignment；第一条及后续`send_to_session`才创建
不可变`conductor_forward` Message与InputSubmission。portable Profile/Task snapshot从不保存launcher path、raw ACP
| ACP operation | SR / ACP Client mapping | 必须证明 |
| --- | --- | --- |
| ensure Binding | `initialize` 后 `session/new`，或对同一私有映射执行 `session/load` / `session/resume` | portable bootstrap、workspace scope、MCP servers、model/config 与 returned session 都属于同一 resolution/qualification |
| submit delivery | 对 exact active Binding 执行一个 `session/prompt` | one-active-prompt、Workspace `inputSubmissionId` 与 causal attempt fence；不能依赖 Provider 自造稳定 input ID |
| observe/reconcile | `session/update` + prompt response；恢复时 `session/load` replay 或 `session/resume` 后重新观察 | receipt、latest valid final candidate、terminal、interaction 去重与 crash ambiguity |
| interrupt | `session/cancel` notification | cancel intent 不等于 confirmed terminal；必须等待同 attempt 的 terminal/reconcile evidence |
| interaction response | `session/request_permission` 的 Client response | exact `interactionId + interactionRevision + choiceId` 经 SR 与 Human Intervention owner 二次校验后，才在 Host-private map 中解析私有 request/option ID；Renderer 不提交 free text 或 label |
| release | `session/close`（若当前 Agent协商支持）+ bounded process shutdown | 先撤 scoped capability，再确认 child/stream 终止；无法确认时 fail closed |

不同 ACP Agent 如何把 bootstrap 映射进其内部 runtime 是 wrapper 的责任，不是 Agent Workspace 的分支。每次 Host
启动都先发现当前 launcher/wrapper/upstream，再以实际 `initialize` observation 与行为 probe 授予能力；版本、品牌或
某个 method 名存在本身不授予能力。

scoped permission 只在 exact current Binding、`inputSubmissionId`、`sessionTurnId`、tool registration 与 opaque
delivery epoch 的交集内有效。ACP session setup 只注入本次 Profile 允许的 MCP servers；terminal 在向上游 yield 前
撤销该 exact epoch，旧 terminal 不能撤销或授权新 epoch，cancel intent 在发出前先撤权。release/close、correlation
ambiguity、ACP observation drift 或 ensure/reconcile 失败也必须 local-first 撤销，不能从旧 process、旧 model
qualification 或 serialized evidence 恢复 authority。

`SessionRuntimeProviderEffectIntentRecord` 只表示在外部 effect 前已持久化的意图；只有同 Attempt
且通过 Binding/Profile/revision fence 的 receipt、interaction、terminal 与 settlement 可以分别推进 SR 和 OR owner
状态。本地 transport 返回或已发出 cancel 都不是 terminal 事实。

Runtime 只让与当前 Binding 的 provider/revision 一致、且所有已提供的
`inputSubmissionId` / `sessionTurnId` 都解析到同一唯一 Turn 的事实推进状态；stale、future、
跨 Turn 或跨 Binding 相关性只保留为证据，不物化 Message、Activity、Interaction 或 terminal 结果。同一 durable
intent/event identity 的完全相同重放是幂等的；若 kind、相关性或语义 payload 冲突，SR/reliability Store 必须
fail closed，不能静默 first-wins。live/recovery 的观察来源不是语义 payload。

Provider 原生 tool/stream/terminal/transcript 可以在 Adapter 内产生事实或安全展示投影，但 raw payload 不进入
`SessionMessage`、RelayBlock、Conductor scoped message view 或 sibling 上下文。对人可见的 Provider 活动与
对 Agent 可读的协作消息必须是两条不同的 read-model 分支。

OpenCode、Codex 与后续 Claude ACP Profile 必须把 ACP `session/update` 映射到同一 `activity_observed` 语义，而不是
只做相似外观或让 UI 解释 Agent-specific extension。agent message chunk、tool call/update、plan 与 usage 分别产生
有界 progress/activity facts；reasoning/thought channel 产生上述有界、有序且去除 Host-private值的 reasoning
activity，并允许用户展开查看。stdin、完整参数、原始 tool result、raw ID、wire envelope 与私有 transcript 均不展示。
每个 Profile 还必须独立证明同一 prompt attempt 的 receipt、唯一有效 final candidate 与 prompt terminal；
中间 tool activity、旧 replay item 或更早 assistant message不能被当作最终 terminal。

受管 Agent 回信要求一个 Provider-neutral 的事实组合：同一 `sessionTurnId` / `inputSubmissionId` / SR attempt
必须有可关联的 latest valid `assistant_final(content)` candidate 与 `session/prompt` terminal。两者齐全后，SR
提交 settlement，Runtime application 在同一事务中编排 owner-scoped
capability：Message service 只写 `SessionMessage(kind: "agent_final")` 和 RelayBlock；Orchestration Coordinator
只关联 `SessionTurn.finalMessageId` 并为非 Conductor Agent 创建 target=Conductor 的 InboxItem。事务边界不是
第二 writer，任一 capability 都不得写其他 owner 的行。Adapter 不解析 RelayBlock，不生成 InboxItem，也不能用“最新
assistant message”猜测 final 内容。不能提供这种关联的 Profile 不得宣称支持自动 Session Agent 回信。

### Profile readiness 与 deferred Provider Handoff reference

Provider 选择不是 UI 内的 `if (provider)`，也不是对已有原生 Session 的字段覆盖。Host 对每个冻结
Execution Profile 提供一个无副作用、typed 的 Session Profile Options query（或等价的 Host 缓存
projection）；Renderer 只显示该投影，所有最终判断仍在 Runtime command handler 中复核。它至少要区分
`available`、`unavailable`、`capability_missing` 与 `checking`，并给出不含凭据的诊断和 required
capability。`version_mismatch` 只作为旧 schema-v2 projection 的兼容状态保留，不再表示当前版本 allowlist。
同步 `RuntimeReadModel` 不得为了填这个 UI 而临时启动 Provider 或调用原生
session；异步 `describeCapabilities` 的结果必须经 Host-owned query/cache 提供。

当前 Host 对 Meta Profile 与 Task Execution Profile 使用两套隔离但同样 fail-closed 的 readiness cache：未完成
真实 capability probe 时同步 read model 只显示 `probe_pending`，探测失败、Provider 未 compose、当前安装结构漂移与
缺少 required capability 都投影为受控 reason code，绝不转发原生 report。Task Profile readiness 以
`templateVersionId + executionProfileId` 关联 immutable Version；Task Setup 只能读取同一次 default/focused query
中可见 Version 的记录。Task 自己的 Conductor readiness 另以其 immutable Architecture Snapshot 投影；普通 read
只读缓存，不触发原生 probe。owner command 必须先通过 revision/status fence，再在产生 Binding/native effect 前
重新探测；缓存不能替代最终门禁。显式 readiness refresh 对每个 Profile 独立限时和发布 invalidation，一个挂起的
Provider 不能阻塞其他 Profile 或 durable outbox/recovery 调度；Host 启动、同步 read、打开 Chat 或切换页面都不得
暗中触发该探测。Workbench 的 Provider 设置页分两阶段：`provider.discover_installation(providerFamily)` 只由
Runtime Host 检查本机 PATH、用户明确选择的 Provider CLI 与登录源文件元数据（不启动 Provider、不读取凭据内容），
`provider.probe_models(providerFamily)` 才显式启动有边界、prompt-free 的临时 ACP Session 来读取 model catalog。
该目录探测不依赖已存在的 Template/Profile，也不发送模型消息；`session/new` 的 safe `configOptions` 被读取后必须先
确认 `session/close`、process 与 credential cleanup，再返回模型目录。Provider CLI/登录源路径是设备级 Host
设置，不属于 Template/Profile；只有该认证设置页可以显示 home-shortened path 并提交 `provider.configure_installation`，
其余 Runtime read model、Task、Template、日志和证据仍为零 absolute path/credential/raw ACP ID。环境变量部署配置优先且
在页面只读；本地设置写入 Runtime root 下0600 Host-private 文件。保存只切换 Host 的 future-provider generation：
后续 probe 与新建 Binding/Meta Session 立即使用新配置，已有 Binding/Session 保持冻结，不要求用户重启 Runtime Host。
设置页把最近一次成功 ACP probe 返回的安全模型目录持久化在 Host-private 设备设置中，并以一次原子
`provider.configure_chat_models` 命令保存“加入 Chat 的 modelId 有序列表 + 其中唯一的默认 modelId”。两者都只能引用该次
目录真实观察到的 modelId；至少选择一个模型。Renderer 不从 Template 固定值或品牌常量补模型。Meta Chat 的空白、未绑定
Composer 只展示这份用户启用列表，并按 Provider / Model / Effort 投影 Host-issued opaque `metaProfileOptionId`；首次发送冻结
选择，既有 Meta Session、Template Version、Architecture、Binding 与 Task Session 都不得被重定向。Host 可以为新选择增量
注册 Meta Profile，但必须保留旧注册以恢复既有 Session，且不得要求重启 Runtime Host。已被 Provider 接受的 Meta Turn 则只
reconcile，不能因后续 probe 抖动、模型被移出新 Chat 列表或暂时未 compose 而被终态化或重新提交。

借鉴 Claudian 的安全边界，但不复制它的 Obsidian Tab 模型：Claudian 只允许空白、未绑定 Tab 在首条输入前
选择 Provider；已绑定会话会拒绝跨 Provider 修改，并提示创建新 Conversation。它的可迁移价值是
latest-wins 选择 fence、目标初始化去重、失败回滚，以及“原生 continuation 归属于一家 Provider”的事实。
它不是跨 Provider 原地迁移的实现参考。

2026-08-11 对 Claudian `main@033eed1211482a66c71ab383e635914d4bc2c3cb`（2.1.3）的 CodeGraph
复核还冻结了更窄的参考边界：可以吸收 Provider 初始化 single-flight/generation fence、Tab 资源事务回滚、
模型目录的分页/TTL/stale-while-revalidate，以及 native thread/turn/request 的精确相关性；不能吸收静态
capability 表、Obsidian 同进程 Provider/Renderer 所有权或 `thread/start.dynamicTools`。后者来自 Claudian
手写 legacy request type，未由当前安装结构与 live behavior probe 证明，不能替代本 Runtime 的 binding-private
MCP inventory 与 model-bound opaque qualification。Workbench 已将该 generation 思路落成单调 refresh epoch，
并在每次 authenticated subscription 建立/重连时以 transport-only `subscription_resynced` 触发 full read；
该 hint 不是领域事实。Host 现在必须从 bounded ACP `session/new`/`session/load`/`session/resume` 返回的
`configOptions(category=model)` 构建 typed 模型目录；只投影 portable `modelId + label`，ACP config option id、
raw session id、path、credential 与 Provider 私有字段仍留在 Host 内。同步 read model 只读最近一次成功 probe 的
目录，不为了填下拉而启动 Provider；尚未取得真实目录时显示“未发现模型”，不得拿 Template 默认模型冒充列表。
目录条目只证明 ACP Agent 在该次会话中声明可选，不授予 capability，也不代表该 role/Profile 已通过行为资格验证。
Renderer 的模型选择必须落成新的 Host-issued portable Profile revision；真正创建 Binding 前仍按 exact
Provider/model/role/profile revision 重新 qualification。

下面的 Handoff 是 **deferred reference design**：它不属于当前 Session-ID V1 的可执行命令、read model 或
release gate，只为后续实现冻结不能破坏的安全边界。当前 V1 只按 frozen default Profile 在首条 send 时建立
Binding；需要隔离时使用 safe close → new generation，而不是假装 `session.handoff` 已存在。

Agent Workspace 的统一语义如下：

```text
未绑定 LogicalSession
  -> 用户选择 frozen Architecture 中的 target executionProfileId
  -> Runtime 复核 readiness
  -> 更新该 Session 的 pending/current profile；尚未创建 native Binding

已绑定 LogicalSession
  -> 用户明确发出 session.handoff
  -> durable SessionHandoff + target Binding + ensureBinding outbox
  -> target binding_observed 后才 stage 用户确认的 HandoffContext InputSubmission
  -> target input_received 后才成为该 LogicalSession 的 current binding
  -> source Binding 仅变为 superseded history，绝不把 native ref/state 交给 target
```

future `session.handoff` 必须是 Provider-neutral 的 Binding service 用例，不是 Codex/OpenCode/Claude Code 各一套
逻辑。它的 target 必须是该 Task Architecture 中存在的 `executionProfileId`；command 至少携带
`commandId`、Task `expectedRevision`、`runId`、`logicalSessionId`、source `bindingId + bindingRevision`、
target `executionProfileId`、用户选择的 typed `messageSelections` 与稳定 handoff idempotency key。Runtime 必须验证
source 是 current routing binding、没有 active InputSubmission / SessionTurn、没有未解决 Attention，且 target
Profile 通过 Host capability gate。future Handoff v1 不排队、不隐式 Stop；
不满足条件时明确拒绝并让用户先等待或 Stop。

Handoff 的 source 与 target 永远是两个 Binding：

- 禁止修改 source 的 `provider`、opaque `bindingHandle`、`executionProfileId`、ProviderFact 或 ACP/private history mapping；
- target `ensureBinding` 不接受 source native ref、opaque provider state、provider transcript path 或任意
  provider-specific resume token；
- `HandoffContext` 只能由用户在 UI 中可预览、显式选择的完整 SessionMessage 或允许的 RelayBlock 组成。
  它在创建 target Binding 前冻结，并作为 target 的首个普通 `InputSubmission` 留下 receipt/reconcile 链路；
  产物只能以用户选择后写入 Message 的文字说明出现，不能作为 Runtime 自动读取的上下文；
- target 绑定失败、capability 变化或 outbox ambiguous 时，source 仍是 current，不得丢失输入或静默切换；
- 只有 target 的 Handoff Context 得到 `input_received` ProviderFact 后，Binding service 才原子地切换
  LogicalSession 的 current-binding pointer，并把 source 标为 `superseded`（routing 状态，不表示原生
  进程已停止）。所有历史 Binding 继续可观察、可审计；Task Stop 仍覆盖每个未终态 Binding。

一个 LogicalSession 可以顺序拥有多个 Binding，因此“最新 `created_at`”不是 routing 规则。LogicalSession
必须区分 Card 的 `defaultExecutionProfileId`、用户已选择的 `selectedExecutionProfileId`、`currentBindingId`
与 session revision；Binding 保存 immutable `executionProfileId`、predecessor/segment lineage 和 routing
state；Handoff 保存其 durable transition 状态。Binding store 必须提供 `getCurrentBinding` 与
`listBindingsForLogicalSession`；Input、Turn、Attention、Presentation 和 Stop 只能依各自需要的明确
Binding 查询，不能靠 `ORDER BY created_at LIMIT 1` 猜测。Session bootstrap 只从 Card identity、prompt、
scope 和 Task Architecture 编译，不能再假设 LogicalSession 当前 Profile 永远等于 Card default；实际
Provider Profile 由每个 Binding 的 immutable `executionProfileId` 决定。

future Handoff v1 中，已绑定 Session 的**模型变更也走同一 handoff**，以保证三家 Provider 的产品语义一致。未来若要
优化为原生 in-place reconfigure，必须先在 `ProviderPort` 添加一个通用、能力门控的 operation，并分别证明
该 Provider 对同一 Binding 的模型修改、恢复、receipt、取消和 late event fence 都安全；Runtime 不能以
`provider === ...` 分支偷用某一家私有 API。该优化不属于当前切换路径的前置条件。

启动 Task 时也不能因为 Template 同时列出三个可选 Profile 就要求三个 Provider 全部可用。Host 只 gate
当前 Conductor 默认/已选 Profile；Card 在被 materialize 或用户切换时再 gate 其 selected target。这样
不可用 Profile 被诚实展示为 unavailable，而不会阻止一个可用 Codex、OpenCode 或 Claude Code Session
启动。

ProviderFact 的去重优先使用跨重连稳定的 provider event identity；若 cursor 仅在一个 source
instance 有效，则用 `sourceInstanceId + cursor`；否则用 payload fingerprint + durable
reconciliation watermark。connection epoch 仅供审计，不能作为 dedup 主键。

每个 ACP Profile 在进入 Template readiness 前，Host 必须解析当前安装并验证该 Profile **实际要求**的能力。
`LocalResolutionSeal` 至少包含 Provider family、ACP Agent kind、当前 artifact/upstream observation、canonical
launcher digest/trust 与 execution-config digest；启动后的 observation 至少包含实际 ACP protocol major、agentInfo 与
capability/extension fingerprint。它们只是 evidence 与同一 process/generation/cell 内的 drift seal，不是版本
allowlist。配置、Template、旧 attestation、Catalog entry 或对象形状相同的伪造值都不能授权能力。

能力门分层为：ACP session core 必须实际观察 initialize/new/load-or-resume/prompt receipt/final+terminal/cancel/
reconcile；managed Task core再要求本产品所需的 correlation/interrupt/recovery；Conductor 四工具与 Publisher write
还必须让所选 model 对 Host-private exact MCP inventory 完成 valid/rejection behavior probe。role-scoped qualification
同时绑定 resolution、initialize observation、model/config 与 Host generation，是 process-local opaque object；重启、
model变化或 observation drift 后 capability classes 归零，必须重新 probe。

发布给 Workbench 的 Template Profile 必须要求完整 managed core：

```text
create_binding, resume_binding, input_correlation,
provider_receipt, reconcile, interrupt
```

因此没有已证实 target-correlated interrupt terminal 的 Provider 不是“可运行但 Stop 降级”，而是
**不能被选入受管 Template**。attention reply、native child、presentation 只有各自完成真实协议
验证后才可被 Profile 要求。缺能力就是 `unavailable`，不 fallback，也不能因为某个通用 transport
route 存在就自动宣称该能力。

### Superseded direct-Provider evidence

此前 direct OpenCode REST、Codex App Server、Claude stream 与 companion diagnostics 不再保留在当前架构正文，也不再是
readiness/release输入；需要审计时从 VCS 恢复。它们不能证明 ACP Agent/wrapper、ACP correlation、cancel/reconcile
或两个 Provider 已接通。新的 ACP evidence 必须从当前源码重新生成。

**自动协作消息门：** OpenCode ACP 与 Codex ACP 必须分别以真实 Task Profile 通过当前安装的 managed lifecycle 和所需
role qualification；任一方都不能作为另一方的 companion 或替代证据。独立 Meta ACP qualification 也不能替代 Task
qualification。任何新 Binding/Host generation 都重新 discovery/initialize/qualify；artifact/version/capability 变化
只使旧 qualification 失效，不意味着新版本天然被拒绝或继承旧能力。

| ACP Agent kind | Host launch / isolation strategy |
| --- | --- |
| `native_acp`（OpenCode） | 解析当前安装的 `opencode` 并启动 `opencode acp`；每个 Task/Meta 使用独立 Host-owned process、私有 env/credential/cwd 与 raw-ID map。 |
| `codex_acp` | 解析当前受信 `codex-acp` wrapper 及其当前 Codex upstream；Host 只说 ACP，App Server 细节留在 wrapper 内。 |
| `claude_agent_acp` | 解析当前受信 `claude-agent-acp` wrapper 及其 current upstream；未安装/未资格验证时 typed unavailable，不回退 stream-json。 |

## 5. 正式 AgentLoop Surface、Web、Desktop 与 Runtime Host

正式 Runtime-backed AgentLoop Renderer 拓扑：

```text
AgentLoop Renderer（保持 AgentLoop 交互；由 Runtime 驱动）
        -> RuntimeClient
        -> Desktop: preload IPC / Browser: authenticated HTTP(S) + WS(S)
        -> apps/runtime-host (唯一可信执行面)
        -> Orchestration Runtime × TaskRun
        -> Session Runtime × LogicalSession
        -> ACP Client -> ACP Agent process

apps/workbench = formal AgentLoop Renderer
apps/desktop = Electron shell + native capability container
```

- **AgentLoop Renderer** 同时可作为 Electron Renderer 和浏览器 Web App 运行；它只展示
  read model、持有 view state，并提交 typed commands，但必须保留任务三栏、Task Setup、Task-local
  Session Tabs、统一 Chat、Template Studio、Timeline、回收站与 Presentation 的交互语义。
- **`apps/workbench`** 是正式 Renderer 的归属；其中只保留 AgentLoop UI，不能出现可选 generic
  Workbench、Provider 页面 iframe 或 Provider-specific lifecycle 分支。
- **Desktop** 只提供窗口、菜单、native dialog、受控 WebView、打包和本机 Host 启动；它不
  持久化 Task/Run/Provider 状态。
- **Runtime Host** 唯一拥有 SQLite、workspaceId→cwd 授权、Provider 凭据、ACP resolution/qualification/process、领域
  service 和事实投影。

### 统一 Chat 与 Task-local Session Tabs

Task Run 中央区域使用一个 Provider-neutral Chat shell：Header 显示 LogicalSession、Profile/Binding 与可用性；
Conversation 显示真实 `SessionMessage`；Provider activity/Attention/Files & Changes 作为人类可见
项目；Composer 始终显示真实目标并只提交 typed intent。Provider 品牌只是 Profile/Binding 的解释信息，
不会选择另一套聊天页或 Composer。

Task-local Session Tab 的固定规则：

- 一个 Tab 只对应当前 Run 内一张 Card 的 current LogicalSession generation，不是 Provider native session/thread；
- Conductor 固定第一个、不可关闭；Worker 在 `invoke_agent` 成功或 human-direct 首次 materialize 后才出现。只有
  invoke、尚未 send 时显示“已建立，等待首条指令”，此时允许没有 Binding/Input/Turn；
- 旧 generation 从 Timeline/历史入口以相同阅读壳打开，Header 显示 `G<n> · 已关闭 · 只读`，没有 Composer；
  新 generation 的 Message 绝不拼入旧 Tab；
- 未 materialize Card 只在 Directory；点击 Directory 或预览不会偷偷 invoke、绑定或投递；
- 点击 Tab 只切换中央 `ChatSessionPresentation` 与 Card Composer 的显式目标，不暂停、取消、启动或删除 Session；
- 没有“+ 新会话”；隐藏/重排/选中属于 Renderer view state，不能写 Runtime lifecycle；
- Attention > failure > unread final > running > pending > idle 的状态优先级不能被选中样式遮蔽，且不能只靠颜色表达。

Task 总入口的 Conductor Composer 与 Card Composer 是两个目标明确的入口，不能因当前 Tab 变化而把 Task 普通
输入暗中改投 Card。`ChatSessionPresentation` 是副作用为零的 read model，不是新领域 writer；至少分开
`collaboration_message` 与 `provider_activity/attention/workspace_file_or_change`，并脱敏 native ID、cwd、
凭据和 raw Provider payload。

Template Studio 与 Task Setup 复用同一 Chat shell 的消息、Composer、Attention 与 Provider 状态组件，但不显示
Task Session Tabs，也不共享 Meta Session 或权限。两处都从固定 opener 显式调出面板；已有 active Meta Session
直接显示，只有尚无会话才从面板显式打开。Task Setup 初始不得因存在 controller 就自动锁定为 docked。Meta 的内容只有在用户确认
patch 后才改变 Draft。

目标 Browser 永远连接已认证的 Runtime Host；没有本地文件系统、PTY、Provider DB、token 或任意
shell 能力。目标 Desktop Renderer 也不会取得这些能力：preload 只暴露 RuntimeClient IPC facade。

### Presentation

| 描述符 | Desktop | Web | Runtime 真相 |
| --- | --- | --- | --- |
| `workspace_transcript_and_composer` | 支持 | 支持 | typed input 是唯一可靠入口 |
| `native_embedded` | 仅受控 WebView | 默认降为 handoff/transcript | native page 不是 writer |
| `external_handoff` | 系统浏览器/客户端 | 新窗口/跳转 | 直输仅 external activity |
| `unavailable` | 显示原因/恢复动作 | 相同 | 不发生 fallback |

无法禁用或路由原生 composer 的页面只能是 unmanaged/external，不能伪装为受管 Task 输入。
每个 `inputSubmissionId` 只能产生一条 Provider receipt 链路。

## 6. 目标目录与职责

```text
apps/
  workbench/       # 正式 Web/Electron Renderer；保留 AgentLoop interaction
  desktop/         # Electron main/preload/packaging/native presentation
  runtime-host/    # composition, transport, auth, observability

packages/
  runtime-contracts/   # JSON schemas, IDs, commands, read models, protocol versions
  runtime-client/      # Renderer-safe IPC/HTTP/WS RuntimeClient
  runtime-domain/      # pure state machines/invariants/value objects
  runtime-application/ # OR Task/Run/Slot/Binding/Message/Forward/Intervention/Inbox/Input/Turn/Control + SR owner use cases
  runtime-store/       # SQLite repositories, migrations, projections, retention/delete intent
  provider-port/       # OR↔SR managed lifecycle、capabilities、presentation 的 semantic port
  provider-acp/        # 唯一 production ACP Client/normalizer/interaction map/ProviderPort implementation
  conductor-tools/     # Conductor-only 四工具 schema/server 与 scoped Host adapter；无 generic read/user lifecycle capability
  workbench-ui/        # AgentLoop/Meta Chat components, Session Tabs, pure view models, Renderer-only state
  test-kit/            # fake Provider, fixtures, clock, contract helpers

tests/
  contracts/         # package-level ProviderPort / fake-provider contract command scope
  integration/       # explicit protocol and native Provider probes
  e2e/               # deterministic Bridge contract journey
  journeys/          # Browser/Electron actual-operation journeys, native attestors and fresh release verifier
```

依赖只能向内：

```text
target workbench / target desktop / runtime-host
  -> runtime-client / runtime-application / provider-acp (Host only)
  -> runtime-domain + runtime-contracts + provider-port
```

`provider-acp` 只由 Runtime Host 注册；Workbench、Desktop Renderer、Conductor tools 不得 import ACP SDK、Agent
wrapper、Store 或 credentials。OpenCode REST、Codex App Server 与 Claude stream direct packages/bridges 是 atomic
cutover 后物理删除的迁移目标，不得保留 compatibility facade、production selector 或 fallback。Provider-specific
SDK 依赖只允许位于外部 ACP Agent/wrapper artifact 内。

## 7. 状态 writer 与安全边界

| Owner | 写入 |
| --- | --- |
| Template/Meta/Task Setup service | Template identity/Draft/Version、Meta Session、Task Setup Draft；不写 Task Run |
| Task/Run service | Task、Run、Architecture Snapshot、CardSessionSlot、LogicalSession、PlanningFence、用户生命周期命令 |
| Binding service | binding generation、current-binding routing、Binding lineage，以及由 SessionRuntimeEvent 验证的 opaque binding handle / status / recoverability |
| Runtime reliability/outbox capability | `session_id_provider_effect_outbox` 的 effect intent、幂等键、lease、receipt/unknown 与 Task/Run/Session/Turn/Control/Attention correlation；不写 Binding 或 ProviderFact |
| Message service | SessionMessage、RelayBlock、MessageForward、目标渲染 Message 与完整 final 的确定性提取 |
| Human Intervention service | HumanIntervention、认证 human 归因、对 Card/Conductor Message IDs 的引用与 scoped interrupt 意图；Message 正文仍由 Message service 写 |
| Orchestration Runtime / Coordinator | SessionInboxItem、held/suppress、InputSubmission、协作 SessionTurn、SessionControlAudit、Workspace Interaction/Attention、Notice 准入、取消与调度 intent |
| Session Runtime service | SessionExecutionRuntime/Attempt、ACP delivery correlation、interaction fence、candidate/terminal pairing、reconcile 与 settlement |
| ACP Client / normalizer | Host-private ACP connection/raw-ID map 与 ACP wire observation；不写 OR 的 Message/Inbox/Turn/Task 状态 |
| Workspace Tool/Observation service | scoped file-effect intent/result 与 Task-scoped Files & Changes 来源验证；不拥有、锁定或随 Task 删除文件 |
| Presentation Port | lease / descriptor |
| Renderer | 仅 view state 与 typed read-model cache |

Runtime application transaction 只编排上表 owner-scoped capability，不是额外 writer。`invoke_agent` 由
Task/Run capability 写 Slot/Session；`send_to_session` 由 Message capability 写正文/Forward、Coordinator
capability 写 Inbox；interrupt 由 Coordinator capability 写 control/lane；close 在同一事务中由 Coordinator
capability 写 control/lane suppression、Task/Run capability 退役 LogicalSession 并清除 Slot current pointer，全部
提交后才返回 `closed`。即使一个数据库事务跨多个 owner，每个 capability 也只能修改自己的行，
不接受 raw multi-writer Store。

`WakeConductor` 不在 writer 表中：它是由 pending Conductor Inbox 派生的内部信号，没有独立 durable record。
跨 owner 的外部 effect 前先写 durable intent + idempotency key。Read model 纯投影，不启动
ACP Agent、不修状态、不发送输入、不确认取消。Runtime Bridge 不提供 generic append-event、
raw Provider proxy、filesystem proxy 或 PTY proxy。

Host 负责 Provider credential、ACP launcher resolution/qualification、origin allowlist、短期 scope token、workspace/task-scoped
subscription、presentation lease 和日志脱敏。ACP Agent 子进程只取得明确 cwd/env/MCP allowlist。
Runtime Bridge 只返回固定、脱敏的 error code envelope；未知错误统一为 `runtime_command_failed`，Browser 与
Desktop 不接收或展示内部 `Error.message`。普通 user scope 必须带 user identity，并按 owner/workspace 过滤
Draft、Task Setup、Meta、Task command/read/subscription；跨 Task invalidation 不携带对方的 task/run/command ID。
Published Template/Version/readiness 是共享 Library。Template identity 级 archive/import/export 目前仍属于
single-owner Host 边界，不能通过某个 Draft 反推一个不存在的 Template owner。

## 8. 生命周期、保留、删除与直接切换规则

```text
Meta conversation -> visible Draft patch -> explicit user apply/reject; never publish/create/start automatically
Task Setup Draft -> explicit user create -> immutable Task Architecture Snapshot; Create is not Start
Start queued, unachieved Task -> fresh Run + Conductor Session + Task Goal Message + Conductor InboxItem；首个 delivery 时 materialize SR/Binding
Task-level user input -> immutable Message + Conductor InboxItem -> Conductor SessionTurn when safely idle
Explicit Card user input -> HumanIntervention + Card Message/Inbox/Turn + complete Conductor mirror; no sibling broadcast
Busy Card user input -> durable mirror first + held Card Message -> scoped interrupt/reconcile -> release or suppress held input
Human-only scoped interrupt -> session.request_interrupt intent/control (no Message) -> Provider fact/reconcile -> Conductor Notice when Run accepts
Conductor invoke -> Card Slot new generation + sessionId only; no Message/Binding/Turn
Conductor send -> one MessageForward + conductor_forward Message + Inbox; first/next content use the same path
Conductor interrupt -> SessionControlAudit request -> Provider fact/reconcile -> Notice; accepted != interrupted
Conductor close -> only when safe -> old generation readonly; later invoke creates a new sessionId
Session Agent final -> immutable complete final Message + optional RelayBlocks -> Conductor InboxItem
Achieve -> user records independent acceptance; active Run remains observable
Resume -> only after original SR/Binding ACP continuation recoverability verified
Stop -> record user intent, suppress new orchestration delivery, request qualified ACP cancel, await/reconcile terminal facts
Restart -> explicit task.restart after prior Run terminal + every Binding released/unrecoverable -> fresh Run; old Run is historical
Archive -> user moves an Achieved, quiescent Task to recycle bin; Task/Run/Binding/observation/achievement records remain
Restore -> restores that same Task identity, achievement and historical Run records
Permanent delete -> SQLite intent/fence -> FK-safe product graph delete + tombstone; Workspace files are never deleted
```

目标 Runtime 必须实现 `task.start`（queued Task 创建 fresh Run）、`task.resume`（仅恢复仍为 active
的原 Run）、`task.stop` 与 `task.restart`。Restart 只接受当前 active 的旧 Run 已经 terminal，且该
Run 的所有 Binding 都已 `released` 或 `unrecoverable`；它创建新的 Run、Conductor Session 和 Binding，
不复用旧原生会话。已 Achieve 的 Task 不可 Restart。UI 不得把 Start/Resume 伪装为 Restart，也不得
暗中创建替代原生会话。

Task Stop 不等于“Runtime 已控制并同步杀死所有 ACP Agent/Provider 内部过程”：它先禁止新的编排投递，再按各 Profile
已证实能力让 SR 对受影响 Binding 请求 cancel/release，并以 SessionRuntimeEvent/reconcile 证明结果。晚到 final/notice
留在原 Run，绝不能投进 Restart 后的新 Run；具体 suppress/审计状态必须由当前 Run ID 和 durable fence 决定。

`Achieve`、Archive 与 permanent delete 是三个不同的用户动作。Achieve 可在没有文件状态锚点或 Run 的
情况下发生，且不会停止 active Run。Archive 只允许已 Achieve 且所有 retained Binding 已终态的 Task；
Restore 不克隆 Task/Run；permanent delete 只允许回收站内的 Task。删除只处理产品记录、观察和审计保留，绝不
删除 Workspace 文件；若未来提供文件删除，必须是独立 Workspace 权限/用户命令并重新校验 canonical path、
symlink、scope 与 digest，不能挂在 Task 删除、Archive、Preview 或 Achieve 上。

完成切换后的统一 Runtime 只持有自己的 canonical lifecycle state，且不双写。正式
`workbench-ui/agent-loop` 是唯一的 interaction-preserving adapter：它把 AgentLoop UI 的用户意图映射为
typed Runtime commands，并把 Runtime read model 映射回展示结构；它不是 generic event bridge、raw PTY proxy
或 Provider UI iframe，也不能自行改变 Task/Run 生命周期。正式构建只组合 `apps/workbench`、`apps/desktop`、
`apps/runtime-host` 与 `packages/*`，不存在第二套 UI、兼容 writer 或其他生命周期入口。Candidate-named app、
source、config 与 launch 路径已经物理删除，并由 static cutover gate 禁止恢复，即使作为 focused fixture 也不例外；
release launcher 只能解析默认 production Vite/build/Electron/Host entry。用户 cwd、未受管文件、Provider 原生会话
和凭据绝不因本次切换删除。

当前 fresh SQLite schema 为 v21；其中 ACP v3 Binding/current pointer、SessionExecutionRuntime/Attempt、provider-effect
intent、schema-v3 LogicalSession/Profile revision，以及 Meta/Template v3 writer 均使用独立的安全字段，领域表不保存 raw
ACP identity或绝对路径。升级已有数据库时，Runtime 可以从 `sqlite_master` 发现明确 allowlist 内的旧协议
表名并把名称写入 `runtime_meta.superseded_protocol_tables`，但不得读取、迁移、改写或删除这些旧表/行；未知的
用户／私有表也必须保持原定义与内容。fresh schema 不创建 Invocation/Batch/Artifact routing 表。物理 drop 或旧行
转换仍是另一个需要明确授权和副本验证的任务，不属于启动、Task 删除或本次 cutover。

ACP cutover 必须是一次 production graph 切换：先阻止新 direct Binding、等待 active direct Binding 安全终态或显式
Stop/reconcile，再切换 composition。历史 direct Binding/ProviderFact 只读保留，不能通过改 `provider` 字段、复用 raw
native id 或伪造 `LocalResolutionSeal` 变成 ACP Binding；切换后新 Binding 一律 ACP-only。旧 direct adapter/bridge/
configuration/import/static registration 必须物理删除，不保留 fallback、selector、compatibility facade 或 test-only
production route。无法获得当前 ACP wrapper/capability 的 Profile 显示 typed unavailable / `BLOCKED_CAPABILITY`。

### 已冻结与仍延期的边界

Session FIFO Lane、Conductor Inbox 优先级、Notice 准入、Planning Fence、busy HumanIntervention、Stop 后晚到结果、
四工具回执和 close/reopen generation 已由本文件冻结，不再是实现可自行选择的设计门。

当前延期且不得阻塞 V1 Loop、Meta 或真实 journey 的只有：

- user-confirmed SessionHandoff 与跨 Provider context continuity；
- Provider native child adoption 与 Presentation；
- Workflow/Scheduler；
- 新的同 Session 并发分支模型。

Provider activity 仅保留已通过脱敏/去重证据的 human-only 投影；任何未验证活动都不得伪造或升级为协作消息。

## 9. 验证、真实操作 Harness、Subagent 与 Workflow

### 9.0 ACP cutover 证据重置

本节中可复用的是 UI checkpoint、owner lineage、issuer 分离、artifact/source seal 与“证据层不可互相代证”的规则。
此前围绕 OpenCode REST Task、shared-loopback Meta、Codex App Server companion、`privateServer` 或固定 26-cell matrix 的
字段与 PASS 记录已被 ACP-only 目标 supersede，不得继续产生 release 0。`implementation-plan.md` 的 ACP migration
matrix 是当前唯一可执行计划；旧脚本在 ACP matrix 完成前必须 fail closed / `BLOCKED_CAPABILITY`。

新的 required native evidence 至少包含：

1. 当前安装 OpenCode 的 `opencode acp` Profile：真实 initialize、Binding、prompt receipt、final+terminal、load/resume、
   cancel/reconcile 以及其声明的 Conductor/Publisher能力；
2. 当前安装 `codex-acp` wrapper 与其当前 Codex upstream：独立完成同一 managed ACP baseline；不能用 direct App Server
   或 companion report 代证；
3. 独立 ACP Meta Profile/process：无通用/Task/Workspace tools、no-cwd/no-Workspace、Template Draft scoped MCP
   lease/revoke、strict whole-final 与 crash reconcile；
4. Browser、Electron、cross-surface 与 Host restart 中，OR/SR/Binding/Message/Input/Turn lineage 和 actual
   `LocalResolutionSeal` / `ACPQualification` 一致；
5. release verifier 明确拒绝 raw ACP ID、direct transport production import、version allowlist、跨 Profile qualification
   复用与 silent fallback。

OpenCode ACP PASS、Codex ACP PASS 与 Meta ACP PASS 是三个独立 required cells/issuer lanes；任何一个缺失都不能声称
“两个 Provider 已接通”或 final release。cell 数由新 matrix 冻结，不继承旧 26 这个数字。

### 9.1 证据层不可互相替代

发布目标需要下面五类证据；`surface` 与 `evidenceClass` 必须分开记录，不能把 FakeProvider 事件标成
“provider evidence”：

| evidenceClass | 证明什么 | 不能证明什么 |
| --- | --- | --- |
| `deterministic_fake` | domain/store/application/outbox 的状态、竞态、幂等与 crash recovery | 真实 UI、Provider protocol、native tool call |
| `browser_rendered` | 正式 Browser Renderer 中实际可见控件、用户点击/输入、authenticated HTTP/WS loopback bridge 与 DOM 状态 | Electron IPC、真实 Provider |
| `electron_ipc` | 实际 Electron 窗口、preload IPC、同一 Renderer 与 native shell lifecycle | Browser transport、真实 Provider |
| `qualified_acp_provider` | 同 cell 当前 ACP resolution + initialize observation + model-bound live qualification 下的 Binding、receipt、final+terminal、MCP tool call、cancel/reconcile | 独立 Meta、另一个 ACP Profile、wrapper 内 direct transport |
| `qualified_acp_meta` | 独立 Meta ACP resolution/process 下的 no-generic-tool/no-authority policy、Template Draft scoped MCP、whole-final schema、proposal 与恢复 | Task Run 编排或另一个 Profile 的资格 |

Release-required assertion 不能以 optional、skipped、`NOT_EXERCISED` 或截图代替。每条证据至少记录：测试/操作
命令、schema version、surface、evidenceClass、`bundleCellId`、`scenarioId`、observed artifact/upstream version、
`LocalResolutionSeal`/capability fingerprint、Workspace opaque identity、durable
Message/Slot/Input/Turn/Control identity、reconcile 路径、断言结果与残余风险。

required cell 的唯一成功值是 `PASS`；`NOT_APPLICABLE` 只允许预先声明为 optional 的 cell。每次 release verifier
生成新的 `releaseRunId` 与 nonce，并绑定当前 source/build/schema/providerPolicy/policy digest；
`providerPolicyDigest` 签封 discovery/qualification policy，不是 Provider 版本 allowlist。verifier 在开始前为
required matrix 冻结不可变的 `bundleCellId` / `scenarioId`；J-08 互斥结果、J-10 crash point 和其他明确分支
可在同一 releaseRunId/nonce 下使用各自干净的 runtimeInstanceId 与 Draft/Task/Run lineage。但每个 cell 内
UI/Host/Provider issuer、runtimeInstanceId 和 durable lineage 必须同链，一个 cell 的 PASS 不得替代另一个。
旧 bundle、不同 nonce、未预声明 cell 或任意跨 cell 拼接均拒绝。新的 OpenCode ACP Task、Codex ACP Task 与 ACP
Meta required cells 各自冻结 current `LocalResolutionSeal`、initialize/capability fingerprint、model/config 与
`ACPQualification`，并在 actual Binding/process generation 回调中重新验证；preflight/qualification-only child 不能
单独生成 Provider attestation。Host restart 必须关闭旧 SR/ACP connection/qualification，generation 2 重新
discovery、initialize、qualify 并恢复同一 Workspace opaque Binding lineage；旧 generation observation不能代证。

`buildDigest` 不是 Vite config source 的摘要。Verifier 在冻结 matrix 前只运行一次 production Vite build，并按
路径、字节长度与内容对 `dist/workbench/**` 中每个 regular/non-symlink 文件，以及
`apps/desktop/main.cjs`、`apps/desktop/preload.cjs`、`apps/runtime-host/src/index.ts`、
`tests/journeys/support/controlled-unified-host-service-cli.ts` 与
`tests/journeys/support/native-unified-host-service-cli.ts` 生成 canonical bytes。后两者是 release-only
evidence wrapper child entry，只组合正式 unified Host 并增加 harness-owned 观测/control 端点，不是第二套或
可选 Runtime。Launcher manifest 必须携带同一 digest；cell 一律 `--skip-build`，worker 在 actual operation
前后重算，parent 还在每个 cell
边界前后重算 source/build/schema/providerPolicy/policy 五类 digest。缺文件、symlink 或任一 drift 都使 fresh bundle 失败，
不能通过 cell 内重建改写 release identity。Cell runner/worker 的 SHA 属于 source/policy seal，不冒充
`buildDigest` 产物。

Matrix 中的 `lineage` exact 只含 `runtimeInstanceId`，它是 cell 的 Runtime anchor，不是动态领域 ID
分配器。不得预造 Draft/Task/Run/Meta/Session/Binding/Message/Input/Turn。Bridge、controlled 与 native 的
每个 required cell 都必须读取 Host canonical observed-lineage projector；projector 只从认证 owner 的
实际持久化 repositories（包括所有历史 Run）与已关联 Provider facts 重新发现 identity，不接受
matrix allocator、launcher manifest 或 Renderer payload 作为投影输入。Seal 的 exact arrays 是
`TemplateDraft` / `TaskSetupDraft` / `Task` / `Run` / `MetaSession` / `MetaTurn` / `CardSessionSlot` /
`LogicalSession` / `Binding` / `Message` / `MessageForward` / `HumanIntervention` / `InputSubmission` /
`SessionTurn` / `SessionControlAudit` identities，加 `runtimeInstanceId`、schema version 与 canonical JSON SHA-256。

Worker 与 parent 都要重算 seal digest，校验 exact schema/prefix/cardinality、cell Runtime anchor、全局唯一性，
并将 Host operation 与 native Meta/Provider document 中每个 typed identity reference 限定为 seal member。缺失、
额外/fallback identity、未知引用、重复 ID 或 digest 不一致都 fail closed。同 cell 每个 required issuer 的
ledger/stream 与 runner 签名必须携带同一 digest；parent 另外拒绝任一 actual ID 或 seal digest
跨 cell 复用。Bridge fake 也是 mandatory seal，不得以 deterministic fixture 豁免。

证据由互不越权的 issuer 产生：UI driver 只记录真实可见动作/DOM/窗口结果；Runtime Host 只记录 durable IDs、
tool dispatch 与 filesystem observation；Provider attestor 只记录当前 observation/qualification 下的 native
receipt/final/control；release
verifier 只校验，不能补写事实。scenario manifest 不得自行声明 evidenceClass/surface。class-specific runner 独占
Playwright `Page/BrowserContext/ElectronApplication/window` raw handles；scenario 只得到窄 locator-action DSL
（click/fill/select/press/visible assertion），拿不到 `evaluate`、request/network、preload facade、RuntimeClient、Bridge
credential、Host object、Gateway、Repository 或 test-kit。每个 user commandId 必须关联 runner action trace 与 Renderer
event-handler 产生的 uiIntentId；没有可见动作因果链的 Host command 不能计作 UI checkpoint。

| Required bundle | surface × evidenceClass × checkpoint | 同链要求 |
| --- | --- | --- |
| Bridge fake | `deterministic_fake`；J-04..J-10 及全部 race/crash 分支 | 每个预声明 scenario 一个隔离 Runtime fixture；不声称 UI/native |
| Browser controlled | `browser_rendered + deterministic_fake`；J-01..J-11，J-08/J-10 使用独立 scenario fixtures | 每个 scenario 的 UI action 与 Host facts 共享 runtimeInstanceId 和 durable IDs |
| Electron controlled | `electron_ipc + deterministic_fake`；J-01..J-11，J-08/J-10 使用独立 scenario fixtures | 必须启动真实 window/preload；mock IPC 不接受 |
| Cross-surface controlled | `browser_rendered + electron_ipc`；J-12 | 同一个 Host、Draft/MetaSession/Task/Run lineage |
| OpenCode ACP native | `browser_rendered + electron_ipc + qualified_acp_provider`；J-04..J-11 与 J-12 | 同 releaseRunId/Host/OR/SR/Binding/Input/Turn lineage；actual `opencode acp` resolution/qualification；无 REST fallback |
| Codex ACP native | `browser_rendered + electron_ipc + qualified_acp_provider`；独立 managed Task baseline，role claim按实际 required matrix | 当前 `codex-acp` wrapper/upstream 的独立 resolution/qualification；不能由 OpenCode或direct App Server代证 |
| ACP Meta native | J-02/J-03 的 `qualified_acp_meta` | 独立 Profile/process/raw-ID map；无通用/Task/Workspace tools、no-cwd/no-Workspace、Template Draft scoped MCP；不能借 Task qualification |

class-specific runner 固定自己的 issuer、surface 与 evidenceClass；RuntimeClient-only、page/electron
`evaluate`/`request`/`fetch`/preload 直调、FakeProvider 伪 native、headless probe 伪 Browser/Electron、required N/A 和
未预声明/跨 cell 代证都是 release verifier 的必测 negative cases。

当前 `tests/e2e/deepsearch-runtime-bridge.contract.test.ts` 是 Session-ID deterministic Bridge contract：它使用
Fake/controlled Provider 与 Meta 来证明 domain/application/Bridge 语义，并让 controlled Conductor/Publisher 穿过
正式 scoped tool host。它仍不是 Browser/Electron 实际操作或 native Provider 证据，不能替代 `tests/journeys`
中的 class-specific runner。

### 9.2 “实际操作”的最低定义

Browser/Electron full journey 必须由可重复的 UI driver 操作正式产品 Surface：

- 启动隔离 Runtime Host；Browser 由 release-only 只读 static/proxy server 服务已冻结并纳入
  `buildDigest` 的 `dist/workbench`，不启动 Vite dev server；Desktop 还必须实际启动 Electron window/preload；
- 按可访问名称点击、输入、选择、停靠、关闭、重开、Publish、Create、Start、Preview、Achieve 与 Stop；
- 被测用户动作不得由测试直接调用 `RuntimeClient.command`、Repository、Gateway 或写文件来替代；
- controlled Provider 可以用于确定性 UI journey，但 Conductor 动作也必须作为 Provider tool call 穿过正式
  Conductor-only tool server，不能由测试进程代替 Conductor 调 Gateway；
- native journey 不得注入 ProviderFact、伪造 terminal/final，或由脚本替 Agent 写交付文件；
- 每个 Surface 使用干净 DB/workspace 各跑一次，再跑 Browser 创建 → Electron 恢复同一 Draft/Task 的 continuity；
- DOM/窗口断言与 Runtime read-only evidence ledger 同时通过；截图和 console 只是辅助证据；
- 临时目录只删除 harness 自建的精确路径，不调用 Provider 原生 delete/archive。

`verify:release` 仍是未来唯一 aggregate claim，但在 ACP production cutover、dual-Provider native matrix 与新的
attestor schema 完成前必须 fail closed，不能运行旧 direct-provider native cell 得到 release 0。新的固定顺序是：

```text
zero-side-effect current ACP artifact/credential/workspace input validation
-> OpenCode ACP / Codex ACP / Meta ACP independent discovery + initialize + bounded qualification + cleanup proof
-> typecheck / full unit / Desktop / integration / e2e / cutover / journey-static local gates
-> one production build + source/build/schema/policy seals
-> fresh ACP matrix: controlled UI + OpenCode ACP + Codex ACP + ACP Meta + restart/cross-surface
-> independent issuer/lineage/raw-ID-redaction/direct-import-negative verification
```

Local gate child 只接收窄系统运行变量白名单，不继承 Provider credential/path/private resolution；只有受信 native
launcher 能读取明确的 Host capability。零 side-effect 输入检查未通过时退出 `2`，任何已启动 child 的失败必须先
证明 bounded shutdown 与 credential/temp cleanup。任一断言失败退出 `1`，只有同一次 fresh bundle 全部 required
cells PASS 才退出 `0`。当前 direct-provider `verify:release` 不满足此合同；迁移、脚本重建与真实命令以
`implementation-plan.md` 的当前 phase 为准。

### 9.3 Full journey checkpoints

Browser、Electron、OpenCode ACP native、Codex ACP native 与独立 ACP Meta journey 使用同一 UI checkpoint语义；
各 Provider 的 capability 只要求其 Profile 在 matrix 中声明的角色，不能跨 cell 借权：

| Checkpoint | 实际操作 | 必须证明 |
| --- | --- | --- |
| `J-01 Launch` | 从正式命令启动隔离 Host + Browser/Electron | 一个 Runtime writer；正式 AgentLoop Surface；无 fallback/overlay/console error |
| `J-02 Template Meta` | UI 新建并保存 Draft；点固定 Meta opener；观察零 session；选 Host-issued Provider/Model/Effort；首次发送自动 create+send；审阅/Apply；浮窗↔dock；关闭/重开；显式 Publish | 调出零 effect；首次发送建立 session+turn；同 Draft session 恢复；patch 原子；Meta 不能 Publish；无 tools/cwd/Task effect |
| `J-03 Task Setup Meta` | 选 exact Version/Workspace；从初始 opener 调出独立 Meta；选 Host option 后首次发送自动 create+send；Apply；关闭重开；显式 Create | 与 Template Meta 历史隔离；Create != Start；Task Run 页面无 Meta 入口 |
| `J-04 Start` | UI 显式 Start | fresh Run、Slots unmaterialized、唯一 task_goal、Conductor Binding/receipt |
| `J-05 Invoke A` | 真实/controlled Conductor tool call `invoke_agent(A)` | 只返回 A1 sessionId；A Slot G1/current；Tab 显示等待首条指令；零 Message/Binding/Input/Turn |
| `J-06 Send A / Final` | Conductor tool call `send_to_session(A1, payload)`；A 返回 | 单目标 Forward；首条与续聊相同；唯一 final；Conductor 只收到三字段 envelope 与嵌入 block IDs |
| `J-07 Review` | Conductor invoke B，再 send 新内容 + A block ref | B 只见被选快照；无 publish/shared-read/Provider直连；B final 回 Conductor |
| `J-08 Human priority` | UI 对 idle Card 发送；再在 busy Card 点击“中断后发送” | mirror 先 enqueue、Card held、冲突 send suppressed、零 sibling；confirmed/unknown/late-final 三分支和 Notice 顺序 |
| `J-09 Session control` | 等 J-08 的 held 文字已投递为 human Turn，UI 点“仅中断”且不附文字，线性 path 等待真实 confirmed Notice；该 Notice 驱动的 Conductor planning Turn 调 `send_to_session(A1, payload)` 后结束；UI 等 Card 显示 busy，用户从 Task-level Conductor composer 发出“中断并重开 A”意图；新 PlanningFence/新 Conductor Turn 从 Directory 看到 A1 busy 后调 `interrupt_session(A1)` 并结束；下一 confirmed Notice 驱动受管 Conductor Turn 依次安全 `close_session(A1)`、`invoke_agent(A)` 得到 A2，再真实调用一次 `send_to_session(A1, payload)` 并保留拒绝，然后才继续 Publisher | 不增加 wait/read 第五工具；human scoped interrupt 不是 Gateway action；send accepted 不代表 target Turn 已建立；两条 interrupt 都是 accepted != completed；control 无用户正文；Host ledger 唯一且有序证明 `J-05 invoke(A1) < J-09 close(A1) < invoke(A2) < rejected send(A1)`、A2 != A1、精确 `orchestration_session_not_current` 和 observed-lineage membership；UI 同时显示旧 G1 只读、A2/G2 current |
| `J-10 Recovery` | 在 pending Lane、tool result、provider accepted、human interrupting、final-before-inbox 各 crash point 重启 Host | 不重复 Session/Forward/Input/final/Notice；ambiguous 不重发；Directory/current 正确 |
| `J-11 Delivery/acceptance` | Publisher 通过 Provider 原生文件工具写入 Task Workspace 并在 final 说明；Host 观察、UI Preview；Browser main 在 Preview 后选择无锚 Achieve，Electron main、cross-surface 与 native 选择有锚 Achieve，各自等待对应 persisted marker；active Run 再独立 Stop；另以正式 lifecycle surface 证明 queued/stopped 且无 active Run 也可无锚 Achieve | Preview 不能强制锚点；测试不代写文件或注入 Publisher 专用 MCP；无 Artifact 注册；文件/Agent claim 不触发 Achieve；Achieve 不 Stop、不允许后续 Start/Restart；Task 删除不删文件；Stop 后 late result 只审计 |
| `J-12 Cross-surface` | 独立 continuity scenario 在 Browser 完成 J-01..J-06，Electron 以同一 Host/用户恢复并完成 J-07..J-11 | Draft/Meta/Task/Run identity 连续；Renderer view state 不冒充 Runtime state |

J-01→J-11 是每个 Surface 的线性 golden path，其中 J-08 选择 confirmed interrupt，J-10 选择一次
受控 Host restart；J-12 是在 Stop 前从同一流程分出的独立 cross-surface continuity scenario。J-08 的
confirmed/unknown/late-final 与 J-10 的每个 crash point 另成 scenario matrix：每个分支在 verifier
预声明的独立 cell 中使用干净 fixture 并保留相同 UI 操作语义，不能在一条线性 run 中伪称同时发生互斥结果。
required bundle 表决定哪些 Surface 必须重演这些分支。

Meta opener 在两处都必须实测：Template Studio 只有 persisted Draft 才出现；Task Setup 的主表单始终可见，
只有 Meta 区域初始显示 opener/collapsed rail，默认浮窗，dock 后才形成双栏；Task Run 中查询不到入口。
dirty local editor 不进入 Meta context，Apply 前
必须保存或放弃本地修改。

### 9.4 Provider Profile 的真实可达性门

Full journey 至少需要四类互不借权的 role/profile evidence：

| Role | 允许能力 | 禁止 |
| --- | --- | --- |
| Meta | 独立 MetaAgentPort、strict whole-final JSON；Template Design 仅 proposal-only `template_draft` MCP | 通用/Task/Workspace tools、cwd、Workspace、Task transcript、用户登录态 fallback |
| Conductor | 四个 scoped Runtime Gateway tools | shell/web/filesystem、generic RuntimeClient、Task lifecycle、Achieve、Provider native control |
| Worker/Reviewer | Template 冻结的最小工作能力 | Runtime Gateway、sibling transcript |
| Publisher | 明确 Workspace scope 内最小 write + canonical final | 任意路径、Runtime Store、自动 Achieve |

每个 role/profile 的 native evidence 都必须来自它自己的 ACP resolution、process、Binding、prompt attempt 与
qualification，且在 Host restart 后重新取得。OpenCode ACP 与 Codex ACP 均须证明 managed Task baseline；一个只能
做 companion、零 Binding/Delivery 的报告不满足“已接通”。Conductor/Publisher能力按 Profile 独立 live probe；
缺 Publisher capability 时 J-11 是 `BLOCKED_CAPABILITY`，不能由脚本 `writeFile` 补成 PASS。

Native launcher 在任何 qualification root/build/Host/UI/model effect 前只做零副作用输入检查：当前 ACP launcher/
wrapper command ref、credential source、workspace authorization、model/config、Host supervisor source 与私有 data root。
它随后为每个 required Profile 分别启动 qualification-only ACP Agent，取得 `LocalResolutionSeal`、实际 initialize
observation、capability fingerprint 与 behavior probe，证明 bounded close/credential cleanup 后才进入 local gates。
不得把 raw command path、credential、ACP session/request/tool ID 或 absolute cwd 写入 evidence。

Task attestor 至少证明：actual SR/Binding generation、prompt receipt、latest final candidate + terminal pairing、
cancel/reconcile、restart 后 load/resume 与 scoped MCP call；Meta attestor至少证明独立 process、无通用/Task/Workspace
工具、无cwd/Workspace、Template Draft scoped MCP的Turn lease与撤销、strict whole-final、permission拒绝与 cold reconcile。
所有 issuer 引用 Workspace opaque IDs 和同一 observed-lineage
seal；任何 raw ACP ID、跨 Profile qualification、direct transport effect 或 fallback 都使 cell fail closed。

### 9.5 Subagent 与 Workflow

ACP Agent 报告的 native child 默认只是 ProviderFact/tool activity；只有 Workspace opaque child handle、父 Binding、
所属 SR attempt/SessionTurn 与显式 user adoption command 都存在时，才可成为工作台对象。raw native id 不持久化。

Workflow 将来由 `WorkflowRun / WorkflowNodeRun` Scheduler 管理。Scheduler 只能请求 Conductor 在自己的
受管 Turn 中执行同一四工具协议；不能直接写 Provider、替 Conductor选择内容、复用旧 Session ID 或绕过
MessageForward/Inbox/Turn。

每个实现任务必须在计划/任务记录中写明：

```text
Phase / goal / inputs / dependencies / user action
unique writer / output files or observable behavior
internal commandId + revision/fence + idempotency
external effect / current LocalResolutionSeal + ACP initialize observation + model-bound qualification
reconcile path / failing harness written first
exact verification command + evidence class/result / residual risk
```
