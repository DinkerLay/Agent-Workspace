# Agent Workspace Architecture

日期：2026-08-09
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
  -> Conductor 的显式 MessageForward（完整 Message 或选定 RelayBlock）
  -> Session Agent Inbox -> InputSubmission -> SessionTurn
  -> unified ProviderPort / ProviderFact
  -> Session Agent 完整 final Message / optional RelayBlocks -> Conductor Inbox
  -> 用户也可明确直达 Card；HumanIntervention 同时向 Conductor 透明同步完整内容与归因
  -> explicit user Achieve
```

Conductor 负责业务决策：是否派发、派给哪个 Card、何时复核、何时请求验收。Runtime 负责
可靠性：身份、输入、回执、取消、恢复、权限、证据和投影。OpenCode、Codex、Claude Code
只是执行 Provider，不能决定 Task 生命周期或业务路线。

当前产品模式是动态 **Agent Loop**。未来 Workflow 是 Scheduler 在同一 MessageForward / SessionTurn
kernel 上增加的显式模式；它不是隐藏 DAG，也不是 Provider Adapter 的职责。

### 当前入口与交互不变量

当前默认产品入口是 `start.sh` / `pnpm start` / `npm start` → `apps/runtime-host` +
`apps/workbench` + `apps/desktop`。`pnpm start:web` 启动同一正式 Renderer 和认证 Host 的浏览器开发面。
根 `src/`、根 `desktop/`、根 Vite 和 OpenCode WebUI 已从工作树删除；不存在兼容入口、双 writer 或旧
PTY fallback。

任务三栏、Task Setup、Task-local Session Tabs、统一 Chat、Session Presentation、Timeline、已完成／
回收站与 Template Studio 是产品交互契约。正式 Renderer 保留这些交互，而不是把它们换成通用控制台；
它只通过 typed Runtime bridge 读取模型和提交用户意图。Task/Run 生命周期永远只有 Runtime writer。

统一 Chat 固定分成两层：`SessionMessage` 是可进入 Agent 对话、可被审计和转递的协作内容；Provider
tool/stream/change/diagnostic/Attention/Handoff 只是经验证、只给人看的活动投影。活动投影不是
`SessionMessage`、不能成为 RelayBlock、不能被 Conductor 转递，也不能成为 sibling Agent 的上下文。

第一版 Provider 活动统一为可去重的 `activity_observed` 事实，并投影为独立的
`ProviderActivityReadModel`。Adapter 只允许输出稳定的脱敏 activity id、`assistant_progress | tool | change |
web` 类别、`started | progress | completed | failed` 阶段、有界 title/detail/content、`append | replace`
更新方式和单调 sequence；raw arguments/result、native id、cwd、credential 与 reasoning 不得进入该事实的
展示 payload。live chunk 使用 append，原生 completed/history snapshot 使用 replace，从而让重连恢复覆盖
残缺流而不重复正文。

统一 Chat 的执行过程采用紧凑的可展开活动树：`running` / `awaiting_final` 始终展开；只有同一
`SessionTurn` 已有规范 `finalMessageId` 且 Turn 为 `returned` / `completed` 时才默认自动收起。收起后只让
final Message 保持正文主视觉，用户仍可手动展开审计；failed、interrupted、cancelled、ambiguous、terminal
先到或缺 final 的 Turn 必须保持展开。展开状态只属于 Renderer view state，不能回写 Runtime。

## 2. 不可混淆的领域对象

| 对象 | 作用 | 唯一 writer |
| --- | --- | --- |
| Meta Agent Session | 配置期的受限会话；分别绑定 Template Draft 或 Task Setup Draft，不属于 Task Run | Meta Session service |
| Template Design Draft | 可手动编辑、也可接受 Meta patch 的模板草稿 | Template service |
| Task Setup Draft | 选定不可变 Version 后、创建 Task 前的一次性输入草稿；不是 Task/Run | Task Setup service |
| Template Version | 不可变的 Conductor、Card、Execution Profile 定义 | Template store |
| Execution Profile | Provider、模型、工具/权限、版本、capability policy 的冻结快照 | Template/Task service |
| Task Architecture Snapshot | Task 创建时冻结的 Version、cwd、Profile 与 Card | Task service |
| Task / TaskRun | 用户可见工作项与一次明确执行身份 | Task/Run service |
| LogicalSession | Run 内的 Conductor 或按需 materialize 的 Card | Task/Run service |
| ProviderSessionBinding | 执行主体与原生 Session/Thread/SDK continuation 的不透明绑定 | Binding service，基于 ProviderFact |
| SessionHandoff | 用户把一个已绑定 LogicalSession 续接到另一 Profile/Provider 的 durable 意图与谱系 | Binding service；首条上下文 Input 由 Turn/Invocation Coordinator 写入 |
| SessionMessage | 用户、Runtime 或 Agent 的不可变正文；每个非 Conductor Session Agent 的 `agent_final` 完整回到 Conductor | Message service（由 Turn Coordinator 组合） |
| RelayBlock | 同一条 SessionMessage 中可选、可多段提取的“希望被转递”片段；原文绝不被改写，也不授予路由权 | Message service |
| MessageForward | Conductor 对完整 Message / RelayBlock 的明确选择、目标与谱系审计；它生成目标实际可见的 Message | Message service（受 Conductor gateway command 驱动） |
| HumanIntervention | 认证用户对明确 Card/Turn 的直接消息、Attention/Permission 回复或 scoped interrupt 意图及其归因 | Human Intervention service / Turn Coordinator |
| SessionInboxItem | 指向一个已渲染目标 Message 的、可恢复的目标 Session 投递意图；不是共享消息订阅 | Turn/Invocation Coordinator |
| InputSubmission | 一次可靠、可幂等的输入投递意图 | Turn/Invocation Coordinator |
| SessionTurn | 一次受管输入、Provider 事实与完整 final 的 durable 关联；非 Conductor Agent turn 的回信目标固定为 Conductor | Turn/Invocation Coordinator |
| Invocation | `invoke_agent` 的 Card 派发任务元数据；不是完整 final 回到 Conductor 的前提，也不是长期 Session | Turn/Invocation Coordinator |
| ProviderFact | Adapter 已观察到、可去重的原生事实 | Provider Adapter |
| Attention | Provider 请求用户处理的 durable 事实 | Turn/Invocation Coordinator |
| AsyncOperation | Provider 原生 turn/job，可能脱离 UI/连接继续 | Binding/Turn service，基于 ProviderFact |
| ArtifactReference | 已验证项目内产物与来源链 | Artifact service |
| SessionPresentation | native page、external handoff 或 Workspace surface 的短期 capability | Presentation Port |

```text
LogicalSession        = 工作台长期身份
ProviderSessionBinding = 原生 continuation
SessionHandoff        = 两个 Binding 之间的显式、可审计续接；不是原生 Session 迁移
SessionMessage        = 可见、不可变的协作内容真相
RelayBlock            = Agent 提供给 Conductor 的可选转递候选片段
MessageForward        = Conductor 的一次内容选择与目标决定
SessionInboxItem      = “把已决定的目标 Message 安全投给哪个 Session”的 durable 队列项
HumanIntervention     = 用户直接介入明确 Card/Turn 的 durable 意图、冲突关系与内容谱系
InputSubmission       = 已决定向某个 Binding 发送的一次可靠输入
SessionTurn           = Input、真实发起者/触发原因与 Provider final / terminal 事实的可靠关联
Invocation            = 一次 Card 调用的业务元数据，不拥有所有回信
ProviderFact          = Provider 已发生、可证明的事实
TranscriptItem        = SessionMessage / Input / Fact 的 UI 投影，不是另一份 Runtime 真相
```

`return` 结束 Invocation，不关闭 Card Session；`Achieve` 是用户接受交付，不表示 Provider
已停止；`Resume` 只能恢复原 Binding，不能悄悄新建替身会话。

`Task.status` 只表达 Runtime lifecycle（queued/running/stopping/stopped/blocked）。用户的
`achievement` 是独立的、不可由 Agent 或 Provider 写入的记录，包含时间、用户选择接受的
Artifact（可以为空）和可选说明。Conductor 的“完成”、Artifact、证据、Provider turn 完成都是
Workbench 可见的上下文，绝不是 Achieve 的前置 gate；用户可以在没有 Run、没有 Artifact、没有
任何 Conductor claim 的情况下 Achieve。Achieve 后不再允许创建新 Run，但一个已经活跃的 Run
不会被悄悄停止，仍需明确 Stop 并等待原生终止事实。

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

Template Studio 的 Draft 编辑器必须允许用户手动编辑每张 Card 关联的 Execution Profile：Provider
（`codex` / `opencode` / `claude-code`）、模型、Provider version、permission mode、protocol
fingerprint 与 capability policy。该表单只是 v2 Draft JSON 的受控编辑面；发布后冻结为 Version，创建
Task 后再冻结为 Architecture Snapshot。Provider 是否能真正 Start 仍由 Host 的 pin/capability evidence
判断，UI 选择不会绕过该门槛。

一个 Card 的 `executionProfileId` 是它的**默认** Profile，不是 Renderer 可以自行写入 Provider 名称的
权限。Task Session 的 Provider/Model 菜单只列出该 Task 已冻结 Architecture Snapshot 中的
`executionProfiles`；选择项始终展示 Provider、模型、版本、permission/tool policy 与 Host readiness。
这样用户可以在 Template Studio 手动配置多家 Provider、在运行中的 Session 选择其中一个，同时不会让
浏览器或 Desktop Renderer 获得自由 Provider/凭据入口。未就绪或未证实能力的 Profile 保持可见但不可
执行，并给出原因；不会回退到 OpenCode、Codex 或 Claude Code 的任一默认实现。

Task 创建后不再读取模板文件或可变 Template Draft；它只读取自己的 Architecture Snapshot。
因此发布后续 Template Version、归档 identity 或导入其他模板，都不得改变历史 Task。

### Template package v2 与 Card scope

Runtime 只接受 `schemaVersion: 2` 的模板包；不符合 v2 的包不能导入或运行。用户如需保留其
语义，必须在 Draft 中重建，并通过当前 schema 与 capability 校验后再显式发布。

```text
Conductor LogicalSession
  = own systemPrompt + own capabilityRefs
  + worker dispatchRegistry (title / description only)
  - no Worker systemPrompt

Worker LogicalSession
  = own systemPrompt + own capabilityRefs
  + required dispatchProfile { title, description }
  - no Conductor or sibling prompt/capability
```

`dispatchProfile` 是给 Conductor 选择 Card 的目录，不是 Worker 的稳定 prompt。每次
`invoke_agent` 才携带本次 `instruction`、明确选择的完整 Message / RelayBlock、`acceptanceCriteria`、
可选的产物请求与 priority。产物请求只要求 Agent 在其 final Message 中说明产物；它不会授权 Runtime
解析或自动传递文件内容。Task Architecture snapshot 是这两种静态/动态信息的唯一来源；后续 Template
Draft 编辑不会回写已有 Task。

`capabilityRefs` 当前是 Card 作用域声明，并会进入 session bootstrap；真正可执行的 Provider 工具/权限
仍由 `ExecutionProfile.capabilityPolicy` 决定。Card scope 与 Provider tool policy 的强制交集尚未完成，
因此不得把声明误写成已完成的权限隔离。

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

Meta 入口固定在 Template Studio 与 Task Setup，点击才创建或恢复对应 Draft 的会话；默认浮窗，并可停靠
在左侧。Template Studio 停靠时替换 Library 左栏；Task Setup 停靠时扩展为可读的双栏工作区；Task Run
不显示 Meta 入口。固定的是入口，不是常驻 Provider 进程。

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

Meta Session 创建时，用户只能从 Host 的只读 typed readiness options 中选择 `metaProfileOptionId`；Host 在 owner
层复核 availability，并把该 option 的 Provider、model、version/fingerprint 与 capability policy 冻结进
`MetaSession`。Renderer 不能提交任意 Provider/model 字符串；resume 仍复核冻结 pin，失配时明确 unavailable，
绝不 fallback。v1 Meta Profile 没有工具、cwd、Workspace filesystem 或 Task transcript capability；Draft/schema
由 Meta service 以对象受限上下文提供，不是 Provider 文件权限。

每条用户 Meta message 与一个 configuration-owned `MetaTurn` 原子持久化。`MetaTurn` 冻结 Meta Profile、mode、
target revision、对象受限 context、system instructions、whole-final output schema 及各自 digest；它不创建 Task
`Binding`、`ProviderFact`、`SessionTurn`、`Invocation` 或 `MessageForward`。Host 通过独立 `MetaAgentPort` 调度它，
不能把 Task-shaped `ProviderPort` 伪装成 Meta Session。首次 lease 才可直接 submit；恢复后的 pending、已 accepted
或 ambiguous Turn 必须先 reconcile。无法证明 native absence/completion 时保留 typed `ambiguous`，绝不自动重发。

Meta Provider 只能返回与该 Turn 精确关联的一个 whole-final JSON。Runtime 拒绝 fenced/substring JSON、未知字段、
mode 不匹配 operation、工具/文件/native child 活动与多 final；随后用目标 Draft 的当前 revision 做 dry-run 校验。
assistant Meta message、可选 pending proposal、MetaSession revision 与 `MetaTurn.returned` 在同一事务提交。Provider
final 本身永远不会 Apply/Publish/Create/Start；目标已消费、abandon、revision 或冻结 pin 已变化时，迟到结果只保留
失败/歧义审计，不修改目标。

Template Design Draft/MetaSession 持久到用户显式 `abandon` 或 Publish，Task Setup Draft/MetaSession 持久到
显式 `abandon` 或 Create；Publish/Create 只把它们标为已消费并保留审计，不由关闭、隐藏、停靠、切换页面或
断线触发。Template Design 与 Task Setup 使用不同 Draft、MetaSession、message history 和 revision lane，互不
读取；两者唯一桥梁是用户确认后选定的 immutable Template Version，不传 Meta transcript 或未应用 proposal。

一个 proposal 固定包含 target Draft、base revision、理由、校验/未解决项和有序 typed patch operations；操作
路径和值必须由目标 Draft schema 验证，不能是 opaque merge blob。用户只能整份 Apply 或 Reject：Apply 携带
`expectedDraftRevision`，按顺序原子执行全部操作并只递增一次 revision；任一操作或 revision 失败则零操作生效。
Reject 不改变 Draft。v1 不做逐 operation 部分接受、自动 rebase 或连续 proposal 的隐式应用。

Task Setup v1 是完整 Surface：主表单与对象隔离的 Meta 区组成可读双栏，不是小型 Create dialog；它复用 Chat
shell 组件但没有 Task Session Tabs。浮窗/停靠/关闭仍只是 Renderer view state。

当 Task 要求最终 HTML 时，v1 交付物是授权 workspace 内的 project-relative `.html` 文件及经 Artifact service
验证的 `ArtifactReference`，不是聊天中的任意 HTML 路由指令。产出 Agent 必须在 canonical final 中说明相对
路径；Artifact service 再验证 workspace 边界、文件与 digest，并关联来源 Turn/final。用户可在 Conductor final
后独立选择 ArtifactReference 执行 Achieve；文件存在、Agent/Conductor 声称完成或 Provider terminal 均不能
代替 Achieve，Achieve 也不自动 Stop。

### Built-in Codex Starter

隔离 Runtime Host 在启动时幂等安装一个不可变的 `Codex Starter` Template Version。它使用当前已验证的
Codex App Server `0.146.0` / `sha256:28161abf152e09a7a4c47427e9098a2407b048f5d16c099a4ec9cb282fbf8448`
execution profile；用户可从它创建自己的 Draft 或新 Version，但 Host 不会改写该 built-in Version。

正式 Template Studio 和 Task 创建面已暴露这一 Starter；仍必须由用户显式选择 Template Version、授权
Workspace、创建 Task、再发出 Start。Starter 安装绝不能创建 Task、启动 Run 或写入 Achieve。

## 3. Conductor 主权的消息、收件箱、调用与回信

### 不可绕过的消息主权

本产品不是让多个 Provider Session 互相看见彼此的 transcript，也不是让 Agent 自助读取一个共享总线。
**对 Agent ↔ Agent 协作，Conductor 是唯一的跨 Session 完整读者与转递决策者。** 用户仍是最高优先级
操作者，可以经认证的 typed command 明确向 Conductor 或某张 Card 发送内容、回复 Attention/Permission，
或请求明确 Card/Turn 的 scoped interrupt；这些人类动作不需要 Conductor 批准。目标 Session Agent 只能读取
自己收到的输入，不能读取 sibling 的原始消息。当前版本固定以下规则：

1. 每个**非 Conductor** Session Agent 的完整 final Message 都必须完整进入 Conductor；这是 Runtime 的
   事实链，不是 Agent 自称“完成”的约定。Conductor 自己面向用户的 final 留在其会话投影中，不会再把自己
   投递给自己。
2. 其他 Session Agent 默认看不到任何 sibling 的完整 Message、RelayBlock、ProviderFact、原生 transcript、
   Artifact 正文或共享日志。
3. Agent 可以在自己的完整 final 中声明零到多个“希望被转递”的 RelayBlock；这只是建议的可选内容，
   **不是路由权限、目标授权或自动广播命令**。
4. 只有 Conductor 明确提交 `full_message` 或 `relay_block` 选择，并明确指定目标 Session 后，Runtime 才会
   生成那个目标可见的新 Message 并投递。Conductor 可以不转、转给不同 Card、或转发完整原文。
5. `Achieve` 仍然只有用户命令；Conductor、Session Agent、final、RelayBlock、文件存在或 Provider terminal
   都不能触发它。
6. 用户向 Card 的直接内容不是 Conductor Forward：Runtime 必须记录 `HumanIntervention`，分别建立 Card
   的目标 Message 和 Conductor 的完整透明说明；其他 Card 不获得任何 Message/Inbox。Conductor 不能撤回、
   覆盖或把这次人类 Turn 结算成自己的 Invocation。

| 问题 | 固定答案 |
| --- | --- |
| A 的完整 final 谁能看？ | Conductor（以及有 Task 审计权限的用户 UI）完整可见；其他 Session Agent 默认不可见。 |
| A 在 final 中写了 RelayBlock 后发生什么？ | Runtime 只保存候选内容和 hint；不会投递、不会广播、不会让 B 获得读取权。 |
| B 何时能看到 A 的内容？ | 仅当 Conductor 在自己的 turn 中提交 `MessageForward`，并选择 A 的完整 Message 或某个 RelayBlock。 |
| Conductor 能否改写 A 的建议目标？ | 可以。`to` / `audience` 是建议，不是约束。 |
| 公共内容如何出现？ | Conductor 调用 `publish_message`，为每个目标建立独立的 Forward/Inbox/Turn。 |
| 用户能否直接向 Card 说话？ | 可以，但必须显式显示目标；Runtime 记录 human 来源并把完整内容透明同步给 Conductor，不广播 sibling。 |

Conductor 对同一 Task/Run 的完整 SessionMessage 有 owner-scoped 可见性，并且非 Conductor Agent 的 final
会被 Runtime 主动投到它的 Inbox；它不需要猜测产物、轮询 `read_result()` 或从共享空间拉取内容。

因此，统一的 provider-neutral 主链是：

```text
SessionMessage（完整原文）
  -> Conductor Inbox
  -> Conductor 的显式 ForwardSelection
  -> MessageForward（只保存选择与谱系，不复制内容）
  -> 为目标生成的 SessionMessage
  -> SessionInboxItem
  -> InputSubmission
  -> SessionTurn
  -> unified ProviderPort
  -> ProviderFact（assistant_final + terminal）
  -> 下一条完整 SessionMessage
  -> Conductor Inbox
```

`ProviderPort` 在这个图中已经是统一调用接口：Runtime 不会根据 OpenCode/Codex/Claude Code 写不同的
消息路由分支；Adapter 只把各自协议变成事实。ProviderFact 永远不是另一个 Agent 的上下文。

### 内容、选择、转递与回信是六个核心对象，publish 另有一个批次对象

```ts
type SessionMessage = {
  messageId: string
  taskId: string
  runId: string
  sourceLogicalSessionId?: string
  sourceSessionTurnId?: string
  sourceHumanInterventionId?: string
  kind: "task_goal" | "user_input" | "agent_assignment" | "agent_final" | "relay_forward" | "publish_forward" | "runtime_notice"
  content: string                 // 完整、不可变的协作正文
  contentDigest: string
  createdAt: string
}

type RelayBlock = {
  relayBlockId: string
  sourceMessageId: string
  ordinal: number
  topic?: string
  suggestedTargetAgentCardIds: readonly string[] // 来源 Agent 的建议，不是权限
  suggestedAudience?: "one" | "publish"       // 同样只是建议
  format: "text/markdown" | "application/json"
  content: string
  contentDigest: string
  parserVersion: number
  sourceRange: { start: number; end: number }
}

type MessageForward = {
  forwardId: string
  taskId: string
  runId: string
  commandId: string
  idempotencyKey: string
  expectedTaskRevision: number
  publishBatchId?: string
  targetIdempotencyKey: string
  decidedByLogicalSessionId: string // 当前版本必须是 Conductor
  decidedBySessionTurnId: string
  targetLogicalSessionId: string
  mode: "invoke" | "relay" | "publish"
  selections: readonly (
    | { kind: "full_message"; sourceMessageId: string }
    | { kind: "relay_block"; sourceMessageId: string; relayBlockId: string }
  )[]
  renderedMessageId: string         // 目标实际会看到的 Message
  createdAt: string
}

type MessageForwardBatch = {
  publishBatchId: string
  taskId: string
  runId: string
  commandId: string
  idempotencyKey: string
  expectedTaskRevision: number
  fanoutKey: string
  decidedByLogicalSessionId: string
  decidedBySessionTurnId: string
  targetLogicalSessionIds: readonly string[] // canonical ordered, immutable snapshot
  selectionDigest: string
  state: "staged" | "materializing" | "settled" | "suppressed"
}

type HumanIntervention = {
  humanInterventionId: string
  taskId: string
  runId: string
  commandId: string
  idempotencyKey: string
  expectedTaskRevision: number
  targetLogicalSessionId: string
  affectedSessionTurnId?: string
  affectedInvocationId?: string
  mode: "direct" | "interrupt_then_send" | "attention_response" | "scoped_interrupt"
  cardMessageId?: string
  conductorMirrorMessageId?: string
  state: "requested" | "interrupting" | "awaiting_turn_close" | "ready_to_send" | "sent" | "failed" | "abandoned"
}

type SessionInboxItem = {
  inboxItemId: string
  taskId: string
  runId: string
  targetLogicalSessionId: string
  renderedMessageId: string
  forwardId?: string
  replyToLogicalSessionId?: string  // 非 Conductor target 必须是 Conductor
  state: "pending" | "leased" | "delivery_staged" | "delivered" | "ambiguous" | "suppressed"
  deliveryInputSubmissionId?: string
  revision: number
}

type InputSubmission = {
  inputSubmissionId: string
  taskId: string
  runId: string
  targetLogicalSessionId: string
  sourceInboxItemId: string
  contentMessageId: string
  contentDigest: string
  deliveryRole: "user"            // Provider 协议角色；不等于 initiator=human
  sequence: number
  idempotencyKey: string
  state: "staged" | "provider_received" | "ambiguous" | "settled" | "suppressed"
}

type SessionTurn = {
  sessionTurnId: string
  inputSubmissionId: string
  targetLogicalSessionId: string
  kind: "conductor" | "session_agent"
  initiator: "human" | "conductor" | "runtime" | "session_agent"
  trigger: "task_goal" | "human_direct" | "session_agent_return" | "conductor_invocation" | "conductor_relay" | "conductor_publish" | "human_interrupt_then_send" | "attention_continuation" | "runtime_recovery"
  replyToLogicalSessionId?: string  // session_agent 必须是 Conductor；conductor 无自投递
  invocationId?: string             // invoke_agent 才有；普通 relay 也有 SessionTurn
  humanInterventionId?: string
  affectedSessionTurnId?: string
  finalMessageId?: string
  status: "staged" | "running" | "awaiting_final" | "interrupt_requested" | "interrupted" | "returned" | "completed" | "failed" | "cancelled" | "ambiguous"
}
```

这些对象刻意不合并：Message 是内容真相；RelayBlock 是来源 Agent 建议转递的片段；Forward 是 Conductor 的
选择审计；HumanIntervention 是认证用户直接介入的控制与谱系；Inbox 是可靠投递意图；Input 是幂等传输
意图；Turn 是每一次受管 Provider 输入、真实发起者/触发原因和其完整回信。
`Invocation` 仍是 Card 派发的任务元数据，但**不再是“是否把 Agent final 回给 Conductor”的前提**；这使
`relay_message`、游戏回合与 human-direct Card Turn 都能拥有同样可靠的完整回信路径。

`kind: "agent_final"` 必须同时有 `sourceLogicalSessionId` 和 `sourceSessionTurnId`，且 source turn 的身份必须
与其 Binding/LogicalSession 一致。若 source 不是该 Run 的 Conductor，Turn Coordinator 必须恰好创建一条
target=Conductor 的 InboxItem；若 source 是 Conductor，只完成其用户可见的 turn，严禁创建 self Inbox。
同一 Turn 的重复或乱序 ProviderFact 只能生成一条 final Message 与一条对应 InboxItem。

### Durable Store 关系：内容、路由、传输与产物分开

```text
session_messages(message_id, full immutable content)
  └─ relay_blocks(relay_block_id, source_message_id, ordinal, hint, content)

message_forwards(forward_id, Conductor decision, target, mode, rendered_message_id)
  └─ message_forward_selections(forward_id, ordinal, full_message | relay_block source)
       └─ rendered session_messages(message_id, target-visible content)
            └─ session_inbox_items(inbox_id, target, rendered_message_id, forward_id?)
                 └─ input_submissions(input_id, inbox_id, delivery status)
                      └─ session_turns(turn_id, input_id, return target, final_message_id?)
                           └─ provider_facts(fact_id, correlation, assistant_final / terminal)

message_forward_batches(publish_batch_id, immutable target snapshot, selection digest)
  └─ message_forwards(publish_batch_id, target_idempotency_key) * one per target

human_interventions(intervention_id, authenticated human intent, target/affected turn, state)
  ├─ card target session_message -> inbox -> input -> turn
  └─ conductor mirror session_message -> inbox -> input -> turn

artifacts(artifact_id, verified project reference) -- independent provenance only
```

`ArtifactReference` 不能成为 MessageForward 的 selection，也不会被 Relay parser 读取。Agent 如要交付文件，必须在
完整 final Message 中说明它；Conductor 可以转发那段 Message，但 Runtime 不解析文件正文来代替消息传递。

`InputSubmission.content` 永远来自一个已持久化的目标 Message，且带 `sourceInboxItemId`、digest、顺序号与
idempotency key。所有会让某个 LogicalSession 模型读取的协作内容都必须走
`SessionMessage -> SessionInboxItem -> InputSubmission`，并以该 Message 的完整正文作为 Provider 的
`user`-role 输入；`user` 是 Provider 协议角色，不表示真实发起者是人类。它不是文件路径、Provider
transcript、Artifact 内容、只含 ID 的 pull 提示或 `contextRef` 的临时解析结果。一次
Provider 输入只有收到 native message/turn id 或可审计原生历史证据后才是 `provider_received`；`accepted`、idle、
“最新 assistant message”都不是回执。`ambiguous` 绝不自动重发。

默认一个 Binding 同时只有一个受管 turn。`input_received` 不表示空闲；只有关联 turn 的 terminal 事实后才允许
下一个 InboxItem。并行由多个 Card Session/Turn 实现，而不是同一原生 Session 并发写入。

### 回传与“唤醒”是一次受管投递，不是另一个总线

以 A 的一次回信为例，Runtime 的行为固定为：

```text
A 的 ProviderFact assistant_final + terminal
  -> Message service 写 A 的完整 agent_final 与 0..N RelayBlock
  -> Turn Coordinator 写入一个 target=Conductor 的 SessionInboxItem
  -> Host 可发出只含 Inbox/Message/Turn 引用的 WakeConductor 内部调度信号
  -> Conductor Binding 空闲且无 Attention/Handoff/Stop 时，stage 一个 InputSubmission
  -> Provider receipt 确认后，Conductor 的下一次 SessionTurn 收到 A 的完整正文
  -> Conductor 自己决定：不转 / full_message 转给 B / relay_block 转给 B / publish 给多个目标
```

`WakeConductor` 只是 Host/Runner 的内部调度提示，可以重复、丢失或合并；它不携带协作正文，也不是 durable
领域真相。系统没有独立的 `Wakeup` 记录、没有 `read_result()` 拉取，恢复时只扫描 durable InboxItem。真正
送入 Conductor Provider 的 InputSubmission 必须包含同一条 `agent_final` 的完整正文和来源 envelope，不能只给
`messageId`。若 Conductor 忙、停止、等待 Attention 或正在 Handoff，InboxItem 保持 pending，直到可安全投递
或被明确 suppress。A 的完整 final 已经 durable，因此不会丢失，也不会被直接写进 B 的 Provider。

### 完整 final 与“希望被转递”的 RelayBlock

唯一性的作用域是一个 `SessionTurn`，不是整个 `LogicalSession`：每个成功完成的非 Conductor Turn 恰好产生
一条 canonical `agent_final`，完整原文先持久化，再由确定性 parser 提取 0..N 个 RelayBlock。无 block 的 final
仍然必须完整送达 Conductor。失败、取消或中断且没有真实 final 的 Turn 不伪造 Agent 回信；只有异常确实影响
后续编排、需要 Conductor 阅读时，Runtime 才创建独立 `runtime_notice`，否则只保留状态、审计和用户诊断。
Provider finish、文件存在或 Agent 写下“完成了”都不能替代同一 SessionTurn 的
`assistant_final(content)` 与 terminal 事实组合，也永远不能触发 Achieve。

来自 `human_direct` / `human_interrupt_then_send` 的 Card Turn 不创建或结算 Conductor Invocation；其真实 final
仍完整回到 Conductor，并通过 Turn envelope 的 `initiator`、`trigger`、`humanInterventionId`、
`affectedSessionTurnId` 与可选 `invocationId` 区分派发回报和人类介入结果。Final 正文不混入这些控制字段。

领域使用 `relay`，而不用 `transport`，避免与 Provider 底层 transport 混淆；`<transport>` 与名为
`transport` 的 fenced block 都不是兼容别名。唯一语法如下；多个 block 可以按原文顺序并列、不能嵌套：

````text
```relay
topic: game.board
to: agent_card_reviewer
audience: publish
format: application/json
---
{"turn": 4, "board": "..."}
```

```relay
topic: risk-summary
---
只希望被转给 Reviewer 的风险摘要。
```
````

`to` 和 `audience` 都只是来源 Agent 的转递建议：`to` 指向它认为合适的 Card，`audience: publish` 表示它希望
多人看到。Runtime 不会自动发送，也不会因为这些字段存在而限制 Conductor 改选目标或拒绝转发。不存在
`private/shared/direct` 的 Agent 可见性开关：完整 Message 和所有 RelayBlock 对 Conductor 可见，对其他 Agent
一律默认不可见，直到 Conductor 做出一个可审计的 Forward。无效字段、嵌套、超限、缺少分隔线或不可解析的
fenced block 都只是原始 Message 文本，零路由副作用。

### Conductor 的三种显式转递

Conductor 不轮询 `read_result()`。Runtime 在任一 Agent turn 完成后自动把完整 final 排入 Conductor Inbox；当
Conductor 当前 Binding 安全空闲时，普通 InputSubmission 把全文送入其 Provider。Conductor 看见后只能通过
受限 Runtime gateway 做出下列内容选择：

```ts
invoke_agent({
  targetAgentCardId,
  instruction,
  selections: [
    { kind: "full_message", sourceMessageId },
    { kind: "relay_block", sourceMessageId, relayBlockId },
  ],
  acceptanceCriteria,
})

relay_message({
  targetLogicalSessionId,
  selections: [
    { kind: "full_message", sourceMessageId },
    { kind: "relay_block", sourceMessageId, relayBlockId },
  ],
})

publish_message({
  targetLogicalSessionIds,
  selections: [
    { kind: "full_message", sourceMessageId },
    { kind: "relay_block", sourceMessageId, relayBlockId },
  ],
})
```

三种命令都带同一 durable fence：`commandId`、`taskId`、`runId`、`expectedTaskRevision`、
`decidedBySessionTurnId` 与 `idempotencyKey`；`publish_message` 另带稳定 `fanoutKey`。Runtime 验证 decision turn
属于该 Task/Run 的当前 Conductor、每个来源和目标也属于同一 Task/Run，再创建 Forward。相同 key 的模糊传输重试
对 invoke/relay 只返回既有 Forward/Inbox/Turn；对 publish 恢复同一个 batch。Conductor 若有意再次转发，必须
提交新的 commandId/key。这样“重复点击”不会产生第二个 Provider input，“再次要求 B 审查”又仍然是一个明确的新决定。

`publish_message` 先写一个 `MessageForwardBatch`：其中冻结 canonical ordered target IDs、全部 selections 的
digest、decision turn 和 fanoutKey；随后为每个 target 用 `publishBatchId + targetLogicalSessionId` 派生稳定的
target idempotency key，分别创建 Forward/Inbox/Turn。Host 在 A/B/C 中途重启时只补齐缺失目标，绝不重发已存在
的 A/B，也不接受同一 batch key 携带不同目标集或 selection 的重试；要改变目标必须创建新的 publish command。

`invoke_agent` 创建一个 Child Invocation、一个 MessageForward、一个目标 `agent_assignment` Message、Inbox 与
SessionTurn；适合让 B 执行一项任务。`relay_message` 不创建 Invocation，但同样创建 Forward、目标
`relay_forward` Message、Inbox 与 SessionTurn；适合游戏、模拟和已存在 Session 的普通消息。二者都允许一次
选择多个完整 Message 和/或多个 RelayBlock；Forward 的有序 selection join 保存全部来源，不能用单个
`originMessageId` 静默丢失谱系。

`invoke_agent` 的 `instruction`、`acceptanceCriteria`、有序 selections 与各内容 digest 必须一同写入不可变的
`agent_assignment` rendered Message，形成带 digest 的 assignment envelope。目标 InputSubmission 只能从这条
Message 取正文；Invocation 只引用它，不能在运行时再拼接 instruction 或从 Conductor transcript 猜测上下文。

`publish_message` 是 Conductor 明确作出的 fan-out：Runtime 为每个目标创建独立的 Forward、目标 Message、
Inbox 和 Turn；没有任何 Agent 能通过读取数据库、订阅 topic 或 `read_shared_relays` 获得同样效果。

选择 `full_message` 时，目标得到来源完整原文（包含它内部所有 RelayBlock）；选择 `relay_block` 时，目标只得到
所选块的内容、来源、topic 和 format，绝不得到来源 Message 的其他文字。Runtime 不调用源 Provider 去调用目标
Provider；所有路径仍经目标 Inbox -> InputSubmission -> ProviderPort。

所谓“公共内容空间”若需要，必须实现为 Conductor 的显式 `publish_message` Forward：Conductor 选择内容与一组
目标 Session，Runtime 为每个目标创建独立的 Forward/Inbox/Turn。它不是任意 Agent 可调用的
`read_shared_relays` 数据库或自动广播总线；没有 Conductor publish，就不存在其他 Agent 可见的公共内容。

Conductor 的 scoped message view 至少返回 `messageId`、来源 LogicalSession/Card、完整正文、按 ordinal 排列的
`relayBlockId/topic/format/contentDigest`、以及既有 Forward audit；只限当前 Task/Run，不带 ProviderFact payload、
native id、cwd、credential 或 Artifact 正文。它给 Conductor “选择什么”所需的稳定 ID，但不成为其他 Agent 的
pull API。

当前只有一个 Task Run 的 Conductor 持有跨 Session 转递 gateway。Meta Agent 是配置期的 Draft 助手，
不是 Task Run `LogicalSession`，不会取得 routing scope、读取 Task transcript 或创建 MessageForward。

### 人类直接介入与 Turn 归因

Task 总入口的普通文字固定默认目标为 Conductor；切换 Session Tab 不得隐式改变这个目标。Card Chat 可以
提供另一个明确写出“发送给 Card X”的 Composer。Renderer 只提交 typed intent；Runtime Bridge 依据认证主体
写 `initiator=human`，UI、Provider 与 Conductor 都不能伪造或覆盖来源。

```text
human -> Card X
  -> HumanIntervention
  -> Card X 的完整 user_input SessionMessage -> Card Inbox/Input/Turn
  -> Conductor 的完整透明说明 SessionMessage -> Conductor Inbox/Input/Turn
  -/-> 其他 Card（无 Message、无 Inbox、无共享读取）
```

透明说明必须包含原始用户全文、目标 Card、时间与 Intervention/Turn 归因；它不是摘要，不是
`MessageForward`，也不授权 Conductor 撤回或改写用户内容。第一版不提供对 Conductor 完全不可见的私聊路径。

当 Card 已有 active Turn 时，用户直接消息固定为 `interrupt_then_send`，不建立用户消息队列：

1. 文字先保留为 Renderer 本地草稿，尚未成为 Card 的已发送 Message；
2. Runtime 先 durable 写 `HumanIntervention` 与 scoped interrupt intent，关联明确 Binding/Turn 和可选 Invocation；
3. 只有旧 Turn 已以真实 final 或 confirmed interrupted 安全收束后，才创建新的 Card/Conductor Message 与
   `SessionTurn(trigger=human_interrupt_then_send)`；
4. 旧 Turn 在竞态中产出的真实 final 仍按原始归因保存和回传；若 confirmed interrupted 且无 final，不伪造
   final，并在影响既有 Conductor 派发时创建 `runtime_notice`；
5. interrupt 失败或状态不明时，草稿保持未发送，Runtime 不自动重试输入，UI 必须让用户等待、重试或放弃。

Attention/Permission 回复是对既有 Turn 的 `attention_continuation`，保留原 Invocation 关系，不变成一个新的
人类任务。用户对明确 Card/Turn 的 Attention、Permission、scoped interrupt 与 Task Stop 优先于相冲突的
Conductor 请求。Conductor 只能请求取消自己在同一 Task/Run 中创建、仍明确关联的 Invocation/Turn，并在
Runtime/Provider 事实确认后重新派发；它不能 kill Provider、Stop/Restart Task、批准权限或覆盖用户输入。

### 端到端实例：研究 Agent A 把一个风险点交给 Reviewer B

```text
1. A 的完整 final（只先对 Conductor 可见）

   “供应链研究结论……内部的完整推理与两个风险点……
    [relay block #1: 适合投资 Reviewer 的市场风险摘要]
    [relay block #2: 适合数据 Reviewer 的价格假设 JSON]”

2. Runtime 持久化 message_A 的完整正文和 relay_A_1 / relay_A_2，
   然后写 target=Conductor 的 inbox_A_return。

3. Conductor 的下一次 InputSubmission 收到 message_A 全文。它可：
   - 什么也不转；
   - 选 full_message(message_A) 给 B；或
   - 选 relay_block(relay_A_1) 给 B；也可无视 A 建议，转给 C。

4. 若选 relay_A_1：写 forward_17(mode=invoke, decision=Conductor turn,
   source=relay_A_1, target=B)，生成 rendered_message_17，随后 B 的 Inbox/Input/Turn。

5. B 的 Provider input 只含 rendered_message_17 的风险摘要和必要来源元数据，
   不含 message_A 的其余文字、其他 block、A 的原生 Session 或 ProviderFact。

6. B 完成后，其完整 final 又写为 message_B，并自动进入 Conductor Inbox；
   B 不能把它直接写回 A。Conductor 若要 A 继续处理，再创建另一条 Forward。
```

因此，完整消息是 Conductor 的决策上下文，RelayBlock 是 Agent 提供的精确转递候选，MessageForward 是唯一
跨 Agent 传播事实。它们分别解决“看见什么”“希望传什么”“实际传了什么”，不能合并成一个 visibility 字段。

### 场景验算：这条架构能否覆盖产品目标

| 场景 | Runtime 实际路径 | 必须成立的结果 |
| --- | --- | --- |
| A 没有 RelayBlock 的研究回信 | A SessionTurn -> 完整 `agent_final` -> Conductor Inbox | Conductor 仍收到 A 全文；没有 B 被唤醒；用户尚未 Achieve。 |
| Conductor 把 A 的完整研究交给 B 复核 | Conductor 选 `full_message` -> Forward -> B assignment Turn | B 获得 A 的完整原文；B 的完整 final 仍回 Conductor，不依赖 B 是否再调用工具。 |
| Conductor 只传 A 的风险块给 B | Conductor 选一个 `relay_block` -> Forward -> B Turn | B 只看到块正文和元数据，看不到 A 的其余/私有原文。 |
| 游戏回合 A -> B -> A | A final -> Conductor；Conductor `relay_message` 选棋盘块给 B；B final -> Conductor；Conductor 再选 B 的块给 A | 没有 Provider-to-Provider 直连；每一步都有完整回信、Forward 和 Turn 审计。 |
| 公共棋盘更新 | Conductor `publish_message` 同一个选中块给 A、B、C | 三个目标各有独立 Inbox/receipt；没有 Agent 自助读取或隐式广播。 |
| 用户直接纠正 A | HumanIntervention -> A 完整 user_input + Conductor 完整透明说明 | A 获得真实用户指令；Conductor 看见全文与 human 归因；B/C 无 Inbox；A final 不结算 Conductor Invocation。 |
| 用户在 A 运行中发消息 | local draft -> scoped interrupt -> old Turn 收束 -> new human Turn | 没有排队或并发写入；晚到 old final 保持原归因；interrupt unknown 时新文字仍未发送。 |
| final/terminal 到达顺序相反或 Host 重启 | 同一 SessionTurn 汇合已持久化 `assistant_final` 与 terminal fact | 只生成一次完整 final 与一次 Conductor Inbox；ambiguous 输入不自动重发。 |
| Agent 说“完成”或写出文件 | 只有普通 final 文本/Artifact fact | 仅作为 Conductor 上下文；绝不改变 Task 到 Achieved。 |

### Task 启动、失败、Handoff 与取消

`task.start` 必须创建 Task Goal Message 与 Root Conductor InboxItem；不能只启动一个空 native Binding，
再要求用户手工向 Composer 补发第一条工作请求。

Provider 无法可靠关联 `assistant_final(content, inputSubmissionId)` 与对应 terminal fact 时，该 Profile 不能作为
受管自动 Session Agent 使用。若任一 Agent turn 失败、取消或完成却缺失 final 内容，Runtime 不伪造 Agent final；
只有该异常会改变 Conductor 后续协作判断时，才创建带可读原因的 `runtime_notice` 并投递，其他事实仅进入
用户可见诊断、状态和审计投影。

`SessionHandoff` 不改变 Message/Inbox/Turn 路由：pending InboxItem 始终指向 LogicalSession，待 target Binding
收到 Handoff Input 并成为 current 后才可继续普通投递。Handoff 上下文只能由用户显式选择的完整
SessionMessage 或 RelayBlock 形成一个新的 Forward；绝不复制 source Provider 的 native transcript、thread id、
路径、token 或 opaque state。

### Attention 与取消

Attention 回复必须匹配：

```text
attentionId + bindingId + bindingRevision + native request id + active InputSubmission / SessionTurn
```

取消必须经过：

```text
abort_requested intent
  -> interrupt_requested effect/fact
  -> reconciled native terminal / process exit / explicit abort confirmation
  -> abort_confirmed or cancellation_unknown
```

“已发 interrupt”不等于“Session 已停止”；Provider Adapter 不能直接改 Task 状态。

用户或 Conductor 的 scoped interrupt 都必须携带明确 Task/Run/LogicalSession/Binding revision/SessionTurn，
并受 `commandId + expectedTaskRevision + idempotencyKey` fence 约束。用户是认证控制主体；Conductor 额外受限为
只能取消自己创建的 Invocation/Turn。两者都不能把请求已接受推断成原生执行已终止。

## 4. Provider Port 与事实模型

统一的是控制面，不是伪造同一个 Provider 协议。Provider 自己拥有原生对话、tool loop、stream、native
session 与内部 long-running 过程；Agent 编排 kernel 不解释或复制这些内部过程。Runtime 仍必须通过
Adapter-owned `ProviderFact` 观察受管输入回执、可关联 final、terminal、Attention、interrupt 与恢复证据，
否则无法安全推进 Input/Turn/Binding 状态。`ProviderFact` 是集成与生命周期证据，不是 Agent 协作内容。

```ts
interface ProviderPort {
  describeCapabilities(profile): Promise<ProviderCapabilities>;
  ensureHost?(request): Promise<ProviderEffect>;
  ensureBinding(request): Promise<ProviderEffect>;
  submitDelivery(request): Promise<ProviderEffect>;
  observeBinding(request): AsyncIterable<ProviderFact>;
  reconcileBinding(request): Promise<ProviderFact[]>;
  requestInterrupt(request): Promise<ProviderEffect>;
  respondAttention?(request): Promise<ProviderEffect>;
  openPresentation?(request): Promise<SessionPresentation>;
  releaseBinding(request): Promise<void>;
}
```

每个 Binding request 都带有由不可变 Task Architecture snapshot 与 LogicalSession 编译出的
`ProviderSessionBootstrap`：

```text
Task Architecture Snapshot
  -> compileProviderSessionBootstrap(LogicalSession)
  -> ProviderPortBindingRequest.bootstrap
  -> Provider adapter native instruction field
```

Conductor bootstrap 包含自己的稳定 instructions、自己的 capability refs，以及仅含 Worker
`title`/`description` 的 dispatch registry；绝不包含任何 Worker system prompt。Worker bootstrap 只包含
自己的稳定 instructions 和 capability refs。`invoke_agent` 的动态 assignment 是一条不可变
`SessionMessage`，它可选择完整 Message 或 RelayBlock 后形成对应的 InputSubmission；Adapter 不能拼入
其他 Card 的 prompt、改写正文，或解释 RelayBlock。

| Provider | 当前静态 bootstrap 映射 | 约束 |
| --- | --- | --- |
| Codex App Server | create 时写入 `thread/start.developerInstructions` | resume 依赖原生 Thread continuation。 |
| Claude Code | 每个 Binding CLI 以 `--append-system-prompt` 启动 | 原生 stream/journal 仍是事实来源。 |
| OpenCode | Runtime 受管 `prompt_async` 投递中写入 `system` | 不复用原生 Web Composer 作为可靠输入入口。 |

这些是本仓库的 transport/字段映射契约，不等于 Provider 已在真实生命周期中正确执行 prompt 的证据；每个
锁定版本还必须完成对应的 native create/resume/receipt/recovery probe。

`ProviderEffect` 只表示本地 transport 接受请求；只有可持久化、可去重的 ProviderFact 推进
Binding、Input、SessionTurn、Invocation 或 Attention。

Runtime 只让与当前 Binding 的 provider/revision 一致、且所有已提供的
`inputSubmissionId` / `sessionTurnId` / `invocationId` 都解析到同一唯一 Turn 的事实推进状态；stale、future、
跨 Turn 或跨 Binding 相关性只保留为证据，不物化 Message、Activity、Attention 或 terminal 结果。同一 durable
dedup identity 的完全相同重放是幂等的；若 kind、相关性或语义 payload 冲突，ProviderPort/Store 必须以
`provider_fact_dedup_conflict` fail closed，不能静默 first-wins。live/recovery 的观察来源不是语义 payload。

Provider 原生 tool/stream/terminal/transcript 可以在 Adapter 内产生事实或安全展示投影，但 raw payload 不进入
`SessionMessage`、RelayBlock、Conductor scoped message view 或 sibling 上下文。对人可见的 Provider 活动与
对 Agent 可读的协作消息必须是两条不同的 read-model 分支。

Codex 与 OpenCode 必须映射到同一 `activity_observed` 语义，而不是只做相似外观。Codex 的
`agentMessage` delta、command/file/MCP/dynamic tool/web item 与完成快照分别产生 progress/activity facts；
OpenCode 的 SSE text/tool/patch parts 与 history parts 产生相同类别和阶段。reasoning、stdin、完整命令参数、
原始 tool result 与私有 transcript 均不展示。每家还必须独立证明同一 input 的 receipt、唯一 terminal 与
规范 `assistant_final`；中间 `tool-calls` finish 不能被当作最终 terminal。

受管 Agent 回信要求一个 Provider-neutral 的事实组合：同一 `sessionTurnId` / `inputSubmissionId` 必须有可关联的
`assistant_final(content)` 与 terminal turn fact。Message service 在两者齐全后才原子地写
`SessionMessage(kind: "agent_final")`、提取 RelayBlock、关联 `SessionTurn.finalMessageId`，并为非 Conductor
Agent 创建 target=Conductor 的 InboxItem；若该 Turn 来自 `invoke_agent`，再关联
`Invocation.finalMessageId`。Adapter 不解析 RelayBlock，不生成 InboxItem，也不能用“最新 assistant message”
猜测 final 内容。不能提供这种关联的 Profile 不得宣称支持自动 Session Agent 回信。

### Profile readiness、选择与 Provider Handoff

Provider 选择不是 UI 内的 `if (provider)`，也不是对已有原生 Session 的字段覆盖。Host 对每个冻结
Execution Profile 提供一个无副作用、typed 的 Session Profile Options query（或等价的 Host 缓存
projection）；Renderer 只显示该投影，所有最终判断仍在 Runtime command handler 中复核。它至少要区分
`available`、`unavailable`、`version_mismatch`、`capability_missing` 与 `checking`，并给出不含凭据的
诊断和 required capability。同步 `RuntimeReadModel` 不得为了填这个 UI 而临时启动 Provider 或调用原生
session；异步 `describeCapabilities` 的结果必须经 Host-owned query/cache 提供。

当前 Host 对 Meta Profile 与 Task Execution Profile 使用两套隔离但同样 fail-closed 的 readiness cache：未完成
真实 capability probe 时同步 read model 只显示 `probe_pending`，探测失败、Provider 未 compose、版本/协议不匹配与
缺少 required capability 都投影为受控 reason code，绝不转发原生 report。Task Profile readiness 以
`templateVersionId + executionProfileId` 关联 immutable Version；Task Setup 只能读取同一次 default/focused query
中可见 Version 的记录。Task 自己的 Conductor readiness 另以其 immutable Architecture Snapshot 投影；普通 read
只读缓存，不触发原生 probe。owner command 必须先通过 revision/status fence，再在产生 Binding/native effect 前
重新探测；缓存不能替代最终门禁。后台 refresh 对每个 Profile 独立限时和发布 invalidation，一个挂起的 Provider
不能阻塞其他 Profile 或 durable outbox/recovery 调度；已被 Provider 接受的 Meta Turn 则只 reconcile，不能因
后续 probe 抖动或暂时未 compose 而被终态化或重新提交。

借鉴 Claudian 的安全边界，但不复制它的 Obsidian Tab 模型：Claudian 只允许空白、未绑定 Tab 在首条输入前
选择 Provider；已绑定会话会拒绝跨 Provider 修改，并提示创建新 Conversation。它的可迁移价值是
latest-wins 选择 fence、目标初始化去重、失败回滚，以及“原生 continuation 归属于一家 Provider”的事实。
它不是跨 Provider 原地迁移的实现参考。

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

`session.handoff` 是 Provider-neutral 的 Binding service 用例，不是 Codex/OpenCode/Claude Code 各一套
逻辑。它的 target 必须是该 Task Architecture 中存在的 `executionProfileId`；command 至少携带
`commandId`、Task `expectedRevision`、`runId`、`logicalSessionId`、source `bindingId + bindingRevision`、
target `executionProfileId`、用户选择的 typed `messageSelections` 与稳定 handoff idempotency key。Runtime 必须验证
source 是 current routing binding、没有 active InputSubmission / SessionTurn（若有 Invocation，它只是该 Turn 的
附属元数据）、没有未解决 Attention，且 target Profile 通过 Host capability gate。v1 不排队、不隐式 Stop；
不满足条件时明确拒绝并让用户先等待或 Stop。

Handoff 的 source 与 target 永远是两个 Binding：

- 禁止修改 source 的 `provider`、`nativeBindingRef`、`executionProfileId`、ProviderFact 或 native history；
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
`listBindingsForLogicalSession`；Input、Invocation、Attention、Presentation 和 Stop 只能依各自需要的明确
Binding 查询，不能靠 `ORDER BY created_at LIMIT 1` 猜测。Session bootstrap 只从 Card identity、prompt、
scope 和 Task Architecture 编译，不能再假设 LogicalSession 当前 Profile 永远等于 Card default；实际
Provider Profile 由每个 Binding 的 immutable `executionProfileId` 决定。

v1 中，已绑定 Session 的**模型变更也走同一 handoff**，以保证三家 Provider 的产品语义一致。未来若要
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

每个 Provider 在进入 Template Profile 前必须通过版本/schema fingerprint 和该 Profile **实际要求**
的能力验证。发布给 Workbench 的 Template Profile 必须要求完整 managed core：

```text
create_binding, resume_binding, input_correlation,
provider_receipt, reconcile, interrupt
```

因此没有已证实 target-correlated interrupt terminal 的 Provider 不是“可运行但 Stop 降级”，而是
**不能被选入受管 Template**。attention reply、native child、presentation 只有各自完成真实协议
验证后才可被 Profile 要求。缺能力就是 `unavailable`，不 fallback，也不能因为某个通用 transport
route 存在就自动宣称该能力。

### 当前 Provider 证据矩阵（2026-08-09）

下表记录当前直接 Runtime cutover 已知的、版本固定的事实。原生 lifecycle smoke、Browser Task 旅程与
focused harness 是不同证据层；每一行只声明明确列出的范围，不把其中一层冒充完整
Task/Run/outbox/Bridge/Desktop/Web 端到端证明。

| Provider / pin | 已观察到的直接生命周期 | managed Template 状态 | 未证实能力 / 约束 |
| --- | --- | --- | --- |
| Codex App Server `0.146.0`, `sha256:28161abf152e09a7a4c47427e9098a2407b048f5d16c099a4ec9cb282fbf8448` | 已通过 create、原生 receipt、terminal、Host composition 重建后的 resume、target-correlated interrupt → native terminal smoke；另通过真实 shell tool 的 command/assistant live activity、唯一 final/terminal、`thread/read` replace snapshot 与 Host 重建恢复，以及隔离 Browser Task 的 goal/follow-up/idle Stop 旅程。 | **可作为当前唯一已验证的 managed-core Provider**，并可为受管 Session 产生可关联 `assistant_final` 与脱敏 `activity_observed`；Profile 仍须匹配该 pin，并使用 Codex 已验证的 `permissionMode: "deny"` / 空 tool allowlist。 | 真实多 Session Worker → Conductor → Worker 旅程、attention reply、native child、presentation 未验证。 |
| OpenCode Server managed pin `1.18.13`；content/activity probe `1.18.15`, `sha256:946e219f81ebf7f3bbe858d616388e8c50e5465d5a4b9b78f2d279e9adff0af9` | `1.18.15` 隔离原生 `read` tool + SSE/history probe 已证明 receipt、tool/assistant started→progress→completed、唯一 `assistant_final` / terminal 与 recovery replace snapshot；另已观察到 create、native resume。真实 abort 仍未证明能与本次 Stop target 稳定关联。 | content/activity Adapter 语义已与 Codex 对齐；但**本地 Host 仍拒绝 start/restart**：当前 managed pin 不匹配该 probe，且实际未广告 `interrupt` 核心能力。 | `interrupt`、attention reply、native child、presentation unavailable；本次 `1.18.15` content probe 不是 managed-core/Stop 证据。 |
| Claude Code stream `2.1.222` | Stream bridge、`system/init` capability 检查与帧映射已有实现，但本次 cutover 没有完整 native create/input/resume/targeted-interrupt/terminal smoke 记录。 | 可保存、导入和分享完整 portable Profile；但**本地 Host 拒绝 start/restart**，直到同等版本固定的完整 smoke 通过并记录。 | 所有 managed-core 声明仍须以真实 lifecycle evidence 复核；attention reply、native child、presentation 也未验证。 |

**自动协作消息门：** Codex `0.146.0` 仍是唯一同时通过当前 pin、managed-core lifecycle 与可关联正文的
Provider；它已把 live/recovery 的 `agentMessage`、activity、receipt、唯一 final/terminal 汇合，并跑通单
Conductor Browser Task，但还没有跑通真实多 Session Worker → Conductor → Worker 旅程。OpenCode
`1.18.15` 已证明正文/activity Adapter 语义，却没有匹配当前 managed pin，也没有 target-correlated
`interrupt`；Claude Code 的 final 字段已有映射但缺完整 managed lifecycle 原生证据。因此 Phase 5A 的
多 Agent 自动协作完成门仍未通过。

能力代码、transport route、fixture 通过和原生证据是不同层次：只有上表所列的版本固定原生证据
可以让本地 Host 接受该 Provider 的受管 Run。升级 CLI/Server、变更 fingerprint、或更换模型安全策略
后都必须重新跑对应 probe，不能沿用旧结果。

| Provider | 初始 Host 策略 |
| --- | --- |
| OpenCode | 专用 REST transport 创建带 binding metadata 的原生 Session；用 async prompt 与原生历史事实恢复，不共享 Task/Run/Binding identity。 |
| Codex | Binding 隔离的 persistent App Server JSON-RPC bridge；真实验证后才决定 pool。 |
| Claude Code | Binding 隔离的 persistent official CLI stream bridge；以原生 frame journal/reconcile 为事实，不把旧 CLI/transcript 当事实来源。 |

## 5. 正式 AgentLoop Surface、Web、Desktop 与 Runtime Host

正式 Runtime-backed AgentLoop Renderer 拓扑：

```text
AgentLoop Renderer（保持 AgentLoop 交互；由 Runtime 驱动）
        -> RuntimeClient
        -> Desktop: preload IPC / Browser: HTTPS + WSS
        -> apps/runtime-host (唯一可信执行面)
        -> ProviderPort -> OpenCode / Codex / Claude Code adapters

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
- **Runtime Host** 唯一拥有 SQLite、cwd 授权、Provider 凭据、Provider host/process、领域
  service 和事实投影。

### 统一 Chat 与 Task-local Session Tabs

Task Run 中央区域使用一个 Provider-neutral Chat shell：Header 显示 LogicalSession、Profile/Binding 与可用性；
Conversation 显示真实 `SessionMessage`；Provider activity/Attention/Handoff/Artifact 作为带稳定 ID 的人类可见
项目；Composer 始终显示真实目标并只提交 typed intent。Provider 品牌只是 Profile/Binding 的解释信息，
不会选择另一套聊天页或 Composer。

Task-local Session Tab 的固定规则：

- 一个 Tab 只对应当前 Run 内一个已 materialize 的 `LogicalSession`，不是 Provider native session/thread；
- Conductor 固定第一个、不可关闭；Worker 首次被派发并 materialize 后才出现；未 materialize Card 只在 Directory；
- 点击 Tab 只切换中央 `ChatSessionPresentation` 与 Card Composer 的显式目标，不暂停、取消、启动或删除 Session；
- 没有“+ 新会话”；隐藏/重排/选中属于 Renderer view state，不能写 Runtime lifecycle；
- Attention > failure > unread final > running > pending > idle 的状态优先级不能被选中样式遮蔽，且不能只靠颜色表达。

Task 总入口的 Conductor Composer 与 Card Composer 是两个目标明确的入口，不能因当前 Tab 变化而把 Task 普通
输入暗中改投 Card。`ChatSessionPresentation` 是副作用为零的 read model，不是新领域 writer；至少分开
`collaboration_message` 与 `provider_activity/attention/handoff/artifact_or_change`，并脱敏 native ID、cwd、
凭据和 raw Provider payload。

Template Studio 与 Task Setup 复用同一 Chat shell 的消息、Composer、Attention 与 Provider 状态组件，但不显示
Task Session Tabs，也不共享 Meta Session 或权限。Meta 的内容只有在用户确认 patch 后才改变 Draft。

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

## 6. 当前目录与职责

```text
apps/
  workbench/       # 正式 Web/Electron Renderer；保留 AgentLoop interaction
  desktop/         # Electron main/preload/packaging/native presentation
  runtime-host/    # composition, transport, auth, observability

packages/
  runtime-contracts/   # JSON schemas, IDs, commands, read models, protocol versions
  runtime-client/      # Renderer-safe IPC/HTTP/WS RuntimeClient
  runtime-domain/      # pure state machines/invariants/value objects
  runtime-application/ # Task/Run/Binding/Message/Forward/HumanIntervention/Inbox/Input/Turn/Invocation/Attention/Outbox use cases
  runtime-store/       # SQLite repositories, migrations, projections, retention/delete intent
  provider-port/       # ProviderPort, capabilities, presentation interface
  provider-opencode/   # OpenCode Server REST client/fact mapper/reconciler
  provider-codex/      # Codex App Server protocol/fact mapper/reconciler
  provider-claude-code/# Claude Code official stream protocol/mapper/reconciler
  conductor-tools/     # scoped invoke_agent/relay_message/publish_message MCP facade; no shared-read or user-acceptance capability
  workbench-ui/        # AgentLoop/Meta Chat components, Session Tabs, pure view models, Renderer-only state
  test-kit/            # fake Provider, fixtures, clock, contract helpers

tests/
  contracts/         # package-level ProviderPort / fake-provider contract command scope
  integration/       # explicit protocol and native Provider probes
  e2e/               # Runtime Bridge <-> RuntimeClient journey
```

依赖只能向内：

```text
target workbench / target desktop / runtime-host
  -> runtime-client / runtime-application / provider-* (Host only)
  -> runtime-domain + runtime-contracts + provider-port
```

Provider package 只由 Runtime Host 注册；Workbench、Desktop Renderer、Conductor tools 不得
import Provider SDK、Store 或 credentials。Adapter 间也不得互相 import。

## 7. 状态 writer 与安全边界

| Owner | 写入 |
| --- | --- |
| Template/Meta/Task Setup service | Template identity/Draft/Version、Meta Session、Task Setup Draft；不写 Task Run |
| Task/Run service | Task、Run、Architecture Snapshot、LogicalSession、用户生命周期命令 |
| Binding service | binding generation、current-binding routing、Binding lineage、SessionHandoff、AsyncOperation 关联 |
| Message service | SessionMessage、RelayBlock、MessageForward、目标渲染 Message 与完整 final 的确定性提取 |
| Human Intervention service / Turn Coordinator | HumanIntervention、认证 human 归因、Card/Conductor 两条消息谱系、scoped interrupt intent |
| Turn/Invocation Coordinator | SessionInboxItem、InputSubmission、SessionTurn、Invocation、Attention、取消与调度 intent |
| Provider Adapter | ProviderFact 和 host transport fact |
| Artifact service | ArtifactReference |
| Presentation Port | lease / descriptor |
| Renderer | 仅 view state 与 typed read-model cache |

`WakeConductor` 不在 writer 表中：它是由 pending Conductor Inbox 派生的内部信号，没有独立 durable record。
跨 owner 的外部 effect 前先写 durable intent + idempotency key。Read model 纯投影，不启动
Provider、不修状态、不发送输入、不确认取消。Runtime Bridge 不提供 generic append-event、
raw Provider proxy、filesystem proxy 或 PTY proxy。

Host 负责 provider credential、origin allowlist、短期 scope token、workspace/task-scoped
subscription、presentation lease 和日志脱敏。Provider 子进程只取得明确 cwd/env allowlist。
Runtime Bridge 只返回固定、脱敏的 error code envelope；未知错误统一为 `runtime_command_failed`，Browser 与
Desktop 不接收或展示内部 `Error.message`。普通 user scope 必须带 user identity，并按 owner/workspace 过滤
Draft、Task Setup、Meta、Task command/read/subscription；跨 Task invalidation 不携带对方的 task/run/command ID。
Published Template/Version/readiness 是共享 Library。Template identity 级 archive/import/export 目前仍属于
single-owner Host 边界，不能通过某个 Draft 反推一个不存在的 Template owner。

## 8. 生命周期、保留、删除与直接切换规则

```text
Meta conversation -> visible Draft patch -> explicit user apply/reject; never publish/create/start automatically
Task Setup Draft -> explicit user create -> immutable Task Architecture Snapshot; Create is not Start
Start queued, unachieved Task -> fresh Run + Conductor Session + Task Goal Message + Conductor InboxItem + Binding
Task-level user input -> immutable Message + Conductor InboxItem -> Conductor SessionTurn when safely idle
Explicit Card user input -> HumanIntervention + Card Message/Inbox/Turn + complete Conductor mirror; no sibling broadcast
Busy Card user input -> local draft + scoped interrupt -> confirmed old Turn close -> new human-intervention Turn; no queue
Conductor invoke/relay/publish -> MessageForward + rendered target Message + Inbox + SessionTurn; Card Session lazily materializes/reuses
Session Agent final -> immutable complete final Message + optional RelayBlocks -> Conductor InboxItem
Unbound profile selection -> selected frozen Profile; no native Binding is created
Bound profile/provider selection -> explicit SessionHandoff -> new Binding + user-confirmed context Input
Achieve -> user records independent acceptance; active Run remains observable
Resume -> only after original Binding recoverability verified
Stop -> record user intent, suppress new orchestration delivery, request supported Binding interrupts, await/reconcile terminal facts
Restart -> explicit task.restart after prior Run terminal + every Binding released/unrecoverable -> fresh Run; old Run is historical
Archive -> user moves an Achieved, quiescent Task to recycle bin; Task/Run/Binding/artifact identities remain
Restore -> restores that same Task identity, achievement and historical Run records
Permanent delete -> SQLite intent/fence -> Host verifies selected Artifact IDs -> file effect -> FK-safe graph delete + tombstone
```

目标 Runtime 必须实现 `task.start`（queued Task 创建 fresh Run）、`task.resume`（仅恢复仍为 active
的原 Run）、`task.stop` 与 `task.restart`。Restart 只接受当前 active 的旧 Run 已经 terminal，且该
Run 的所有 Binding 都已 `released` 或 `unrecoverable`；它创建新的 Run、Conductor Session 和 Binding，
不复用旧原生会话。已 Achieve 的 Task 不可 Restart。UI 不得把 Start/Resume 伪装为 Restart，也不得
暗中创建替代原生会话。

Task Stop 不等于“Runtime 已控制并同步杀死所有 Provider 内部过程”：它先禁止新的编排投递，再按各 Profile
已证实能力对受影响 Binding 请求 interrupt/release，并以 ProviderFact/reconcile 证明结果。晚到 final/notice
留在原 Run，绝不能投进 Restart 后的新 Run；具体 suppress/审计状态必须由当前 Run ID 和 durable fence 决定。

`Achieve`、Archive 与 permanent delete 是三个不同的用户动作。Achieve 可在没有 Artifact 或 Run 的
情况下发生，且不会停止 active Run。Archive 只允许已 Achieve 且所有 retained Binding 已终态的 Task；
Restore 不克隆 Task/Run；permanent delete 只允许回收站内的 Task。Renderer 先请求 path-free delete preview，
用户可勾选可删除 Artifact ID；Host 会重新校验 canonical workspace 边界、普通文件与 digest。未勾选、已变更、
缺失、过大或不支持的文件保留在项目中。不存在从 UI 传入路径的删除 API。

完成切换后的统一 Runtime 只持有自己的 canonical lifecycle state，且不双写。正式
`workbench-ui/agent-loop` 是唯一的 interaction-preserving adapter：它把 AgentLoop UI 的用户意图映射为
typed Runtime commands，并把 Runtime read model 映射回展示结构；它不是 generic event bridge、raw PTY proxy
或 Provider UI iframe，也不能自行改变 Task/Run 生命周期。正式构建只组合 `apps/workbench`、`apps/desktop`、
`apps/runtime-host` 与 `packages/*`，不存在第二套 UI、兼容 writer 或其他生命周期入口。用户 cwd、未受管文件、
Provider 原生会话和凭据绝不因本次切换删除。

### 实现前仍须关闭的设计门

Phase 5D 的 Task Input、Meta Profile、Draft/proposal retention 与 Task Setup Surface 已在上文冻结。以下其余项目
尚未形成产品决定；当前代码不得以局部便利先写成事实，计划必须先给出输入、选择、验证与完成条件：

- 每个 LogicalSession 输入 lane 是否永久串行或允许 capability-gated concurrency；在决定前 managed input 串行；
- 哪些异常必须创建 `runtime_notice`，哪些只进入用户诊断/审计；
- Stop 后晚到 final/notice 的 suppress 与可见性细则，但它们必须留在旧 Run 且不得进入新 Run；
- 第一版保存哪些 Provider activity/stream 投影；任何未验证活动都不得伪造或升级为协作消息；

## 9. Subagent、Workflow、证据与验收

Provider-native child 默认只是 ProviderFact/tool activity；只有稳定 native id、父 Binding、
归属 Invocation 和显式 adoption command 都存在时，才可成为工作台对象。

Workflow 将来以 `WorkflowRun` / `WorkflowNodeRun` 形式由 Scheduler 管理；每个节点仍通过受 scope 约束的
Conductor `invoke_agent` 创建 Invocation，并沿同一 MessageForward / SessionTurn 回信链运行。Scheduler
不能绕过 Conductor 把一个 Agent 的内容直接写给另一个 Agent。

发布目标需要六层验证：

```text
domain -> application/store -> fake-provider contract -> real Provider integration
-> Runtime Bridge -> Desktop + Browser E2E
```

必测故障：ambiguous input、重复/乱序 Provider event、Host restart、stale Attention、interrupt
unknown、interrupt 与 late final 竞态、HumanIntervention 重放/冲突、background child、Provider version
mismatch、presentation lease revoke、Desktop/Web 并发观察。截图、token 流或页面能打开不构成 Runtime 正确性。

Human/Card 路径必须有 harness 证明：明确目标、认证来源、Card 与 Conductor 两条 Message、零 sibling Inbox、
busy 时无 queue、interrupt unknown 不发送、晚到 final 保持原归因、人类 Turn 不创建/结算 Invocation。统一 Chat
必须有 Renderer/Bridge harness 证明 Session Tab 只改变 view state、Task 总入口仍指向 Conductor、Card Composer
目标可见、Provider activity 不可路由。Meta 必须有隔离 harness 证明两个模式只写各自 Draft，关闭/停靠不改
Runtime，且发布/Workspace/create/start 均需要独立用户命令。

每个通过 gate 的测试或真实 Provider probe 都必须留下可审计证据：测试名称/命令、Runtime
schema version、Provider version 与 protocol fingerprint、脱敏 native identity/trace、事实
reconcile 路径、断言、结果和残余风险。需要凭据的真实 probe 不能伪装为离线单元测试；没有
证据的 Provider capability 必须显示 `unavailable`。

当前仓库已有 ProviderPort/fake-provider contract、Runtime application/store、Runtime Bridge ↔
RuntimeClient E2E、显式 protocol probe、Codex direct smoke，以及正式 Browser 的
authorize-workspace → exact Template Version → create Task 真实 Bridge 验证。正式 Desktop 启动器、IPC
与语义 invalidation 有独立测试。带真实 Provider 的 Desktop/Browser 完整 Task journey，以及
RuntimeApplication/outbox → native Provider → restart/recovery 的端到端 probe，仍是发布 gate，不能由
当前 direct smoke 或页面截图代替。

当前还必须保持以下两类边界测试：`session-bootstrap.test.ts` 证明 Conductor 不泄露 Worker prompt、
Worker 不取得 Conductor/sibling scope；`contracts.test.ts` 拒绝 schema v1 与缺失 Worker dispatch profile
的 v2 包。Codex `developerInstructions`、OpenCode `prompt_async.system`、Claude Code
`--append-system-prompt` 都有各自 Adapter 映射测试。它们证明本仓库发送了正确字段，不替代固定版本的
真实 Provider lifecycle evidence。

Claudian 是外部语义参考，不是依赖或 fork。本地忽略的
`.references/claudian` 锁定上游 SHA 并拥有独立 CodeGraph；运行
`npm run reference:claudian:update` 后，按 SHA → diff + CodeGraph affected symbols → 能力审计
→ 选择性吸收一个语义 → 添加本项目 contract test 的顺序处理。镜像更新绝不自动改动产品代码。
