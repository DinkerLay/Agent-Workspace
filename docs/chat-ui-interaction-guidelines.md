# 统一 Agent Chat UI 交互与实现指导

日期：2026-08-14

状态：实施指导（非产品权威）

本文件回答一个具体问题：Agent Workspace 的 Meta Agent、Conductor 与 Session Agent 应该怎样共用一套真正流畅、可恢复、Provider-neutral 的 Chat UI。

产品、领域 owner、安全边界与状态 writer 仍以 [`architecture.md`](architecture.md) 为唯一真相；实施顺序仍以 [`implementation-plan.md`](implementation-plan.md) 为唯一可执行计划。本文件不能替代二者，也不能授权 Renderer 读取 raw ACP 流、直接控制 Provider 或创建第二套生命周期。

## 1. 结论

当前问题不是缺少几个按钮或 CSS，而是 Chat UI 尚未围绕一个统一的 **Turn presentation state machine** 组织。继续分别在 Meta、Conductor、Card 页面补“思考中”“工具列表”“停止按钮”，会形成三套行为不一致的适配器。

目标结构应当固定为：

```text
Provider-specific ACP Agent
  -> Host-private ACP normalization
  -> owner-scoped durable facts + safe Provider activity projection
  -> provider-neutral ChatTurnPresentation
  -> shared AgentChatShell
       -> Meta adapter
       -> Conductor adapter
       -> Card Session adapter
```

统一的是事件语义、Turn 状态、消息层级、活动卡片、Composer 行为与恢复规则；不统一领域对象和命令。MetaMessage 不能翻译成 SessionMessage，Meta cancel 不能冒充 Task Stop，Card interrupt 也不是 Conductor 第五个工具。

## 2. 研究范围与 Claudian 证据

对照对象是 `YishenTu/claudian`，固定到提交 [`bed1f05a9888fad096223722a73c24fa9f1e6094`](https://github.com/YishenTu/claudian/tree/bed1f05a9888fad096223722a73c24fa9f1e6094)。研究只用于理解交互和代码分层，没有复制其源码。

Claudian 的可迁移价值不在视觉，而在以下结构：

1. **先归一事件，再渲染 UI。** 它用 provider-neutral execution event 表达 text delta、thinking delta、tool started/output/completed 与 turn terminal，而不是让 Chat 组件识别 Claude、Codex、OpenCode。[事件合同](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/core/execution/ProviderExecutionEvent.ts#L96-L235)
2. **ACP 只是一个 normalizer 输入。** ACP message/thought/tool update 被映射为同一 execution event；tool update 只发增量，避免重复渲染历史输出。[ACP execution normalizer](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/providers/acp/AcpExecutionEventNormalizer.ts#L117-L208) · [ACP update normalizer](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/providers/acp/AcpSessionUpdateNormalizer.ts#L100-L206)
3. **排队是明确状态。** Chat state 独立保存 `queuedMessage`；忙碌时再次发送不会丢消息，也不会创建并发 Turn，而是先显示一个待发送项。[Chat state](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/state/types.ts#L27-L101) · [Input queue](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/controllers/InputController.ts#L341-L369)
4. **取消有真正的 execution owner。** `ChatExecutionCoordinator.cancel()` abort 当前请求、撤销当前 interaction，并调用 active run cancel；按钮不是单纯改 UI 状态。[Cancellation](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/execution/ChatExecutionCoordinator.ts#L440-L446)
5. **流式渲染有节流和 flush。** 高频 delta 先合并为最新 snapshot，再按 frame/最小间隔渲染；terminal 前显式 flush，避免每个 token 触发整棵 Markdown 重绘。[Streaming coordinator](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/controllers/StreamingRenderCoordinator.ts#L35-L179)
6. **Thinking 和 Tool 都是 Turn 内的可折叠块。** Thinking 运行时展示耗时，完成后收起；每个 tool 有稳定 header、摘要、状态和独立详情，而不是一整块重复文字。[Thinking renderer](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/rendering/ThinkingBlockRenderer.ts#L19-L98) · [Tool renderer](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/rendering/ToolCallRenderer.ts#L1041-L1151)
7. **设置中的模型目录与 Chat 里的快捷选择分开。** 设置页决定哪些已发现模型进入 Chat selector 及默认顺序；Chat 只展示可用子集。[Model picker](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/shared/settings/ProviderModelPicker.ts#L4-L91) · [Chat model selector](https://github.com/YishenTu/claudian/blob/bed1f05a9888fad096223722a73c24fa9f1e6094/src/features/chat/ui/InputToolbar.ts#L64-L132)

### 2.1 应吸收与不应照搬

| Claudian 做法 | Agent Workspace 决策 | 原因 |
| --- | --- | --- |
| Provider-neutral execution events | 吸收，但只接 Host 的 safe read model | Renderer 不得读 raw ACP |
| busy 时保留 queued message | 吸收为“未提交的本地排队意图” | 简单、不会伪造 durable Message/MetaTurn |
| 真正 cancel active execution | 吸收为 owner-specific typed interrupt/cancel | 不能用按钮假装已经取消 |
| Thinking 原文可展开 | 吸收；展示正式 ACP thinking/reasoning channel 的原始文本并在 Turn settled 后自动收起 | 用户需要观察 Agent 的真实推理过程 |
| Tool input/result 详情 | 只显示 owner 允许的结构化摘要、diff、校验和安全结果 | raw args/result、cwd、native ID 必须留在 Host |
| Tab 可以选择 Provider/model | 只允许空白、尚未绑定的会话选择；已创建 Session 显示冻结 Profile | ACP Binding/Profile 不能被 UI 原地改投 |
| Obsidian Tab/Conversation 模型 | 不照搬 | 本产品 Tab 对应 Task 内 current LogicalSession generation |

## 3. Chat UI 使用场景

只有一套 `AgentChatShell`，但存在四个 typed adapter：

| 场景 | 对话真相 | 可提交动作 | 特有内容 |
| --- | --- | --- | --- |
| Template Meta | MetaMessage + MetaTurn | create-on-first-send、send、proposal apply/reject、未来的 exact Meta interrupt | Pending Proposal、Template Draft tool activity |
| Task Setup Meta | MetaMessage + MetaTurn | create-on-first-send、send、proposal apply/reject | Task Setup proposal；零工具 |
| Task Conductor | SessionMessage + SessionTurn | Task-level user input、authenticated interrupt、Task Stop | planning status、Conductor Notices |
| Card Session | SessionMessage + SessionTurn | direct human input、authenticated interrupt | generation、held input、Final、Attention/Interaction |

Adapter 只做三件事：

1. 把 owner read model 投影成 `ChatTurnPresentation`；
2. 把共享 Composer intent 转换为 owner 的 typed command；
3. 提供这个 scope 真正支持的 secondary actions。

Adapter 不得复制消息组件、解析 ACP payload、拼接 tool result、推断 final、改写领域状态或伪造不支持的停止能力。

## 4. 统一 Turn 状态机

### 4.1 主状态

```text
idle
  -> submitting
  -> running
       -> awaiting_interaction
       -> awaiting_final
       -> stopping
  -> completed
  -> failed
  -> cancelled
  -> ambiguous
```

- `submitting`：用户 intent 已提交但 Runtime 尚未确认接受；Composer 不得清空到不可恢复状态。
- `running`：当前 Turn 已 durable 接受或 Provider receipt 已确认，允许流式 activity 更新。
- `awaiting_interaction`：需要用户选择；选择器占据 interaction slot，普通发送不可绕过它。
- `awaiting_final`：Provider terminal 或 candidate 只到一半；不能显示为完成。
- `stopping`：中断 intent 已提交但未确认；按钮显示“正在停止”，不能立即宣称“已停止”。
- `completed`：同 Turn canonical final 已提交且 terminal pairing 成立。
- `failed/cancelled/ambiguous`：保持活动树展开，显示可恢复信息和明确下一动作。

### 4.2 与 Turn 正交的 UI 状态

- `queuedDraft: null | { targetLease, content, attachments }`
- `autoFollow: true | false`
- `activityExpandedByUser: Set<activityId>`
- `turnTraceExpandedByUser: Set<turnId>`
- `composerDraft`
- `selection/provider-control-popover`（仅空白、未绑定 Session）

这些只是 Renderer view state。`queuedDraft` 尚未送出，因此不是 Message、MetaMessage、Input、Turn 或 outbox intent。实际发送时必须重新验证 target generation/revision；漂移时把文字退回 Composer，绝不静默改投。

## 5. 统一展示层级

每个用户 Turn 的视觉顺序固定为：

```text
User message
Assistant turn
  provider thinking/reasoning stream
  activity list
    tool card 1
    tool card 2
    change/web activity
  interaction slot (optional)
  final answer (when canonical)
  proposal/review item (Meta only, optional)
```

### 5.1 消息

- 用户自己的消息不重复显示“你”；气泡位置、颜色和方向已经表达身份。
- assistant 只在首次或多 Agent 混排时显示 agent 名称；连续同 speaker 可省略重复 header。
- Message 正文使用正常排版，不用 `pre` 承担所有文本；代码块和结构化数据由 Markdown renderer 处理。
- tool、thinking、notice、file change 都不是 Message，不能混进正文或被 Conductor 转发。

### 5.2 Thinking / progress

标准展示是一个独立可展开的 Thinking block。Provider 通过正式 ACP thinking/reasoning channel（例如
`agent_thought_chunk`）输出的文本按原顺序流式展示；这不是只显示 `思考中 · 12s` 的占位状态。

这里的“原始 reasoning”指 Provider reasoning channel 的文本正文，不是整份 raw ACP wire payload。Host 只允许精确
移除或替换已知 credential、raw ACP/native id、absolute cwd 与 wire envelope，不做摘要、润色、重写或语义过滤。
处理后的正文进入 human-only activity，仍不能成为 Message、RelayBlock、Meta proposal 或 Agent Final。

规则：

- 首次 submit 后立即出现本地 `正在发送…`，不等待 Provider 首 token；
- 收到 reasoning delta 后按 stable activity id 原位追加，不新增重复块；
- running / awaiting_final 默认展开，显示正文与持续时间；
- completed、failed 或 cancelled 等 settled terminal 到达前先 flush 最后 delta，随后 Thinking block 自动收起；
- ambiguous 或仍未 settlement 的 Turn 保持展开；用户始终可以手动重新展开；
- Provider 没有输出 reasoning channel 时才显示中性 `思考中 · 12s`，不编造正文。

### 5.3 Tool card

每个 tool activity 使用稳定 `activityId` 更新同一张卡片：

- header：图标、动作名、安全摘要、pending/running/completed/failed 状态；
- body：按 tool kind 渲染 owner-approved detail；
- running 默认展开；stored completed 默认收起；failed 保持展开；
- tool update 采用 append/replace 语义，不能把相同调用重复追加成多张卡；
- 一张 tool card 可以展开；不再用一个外层大框把整组工具锁死。

Template Draft MCP 的安全详情可显示：目标对象、操作类型、受影响字段、验证结果、局部 diff、Proposal 引用。不得显示 raw MCP id、绝对路径、原始参数、credential、ACP session/tool id 或未裁剪结果。

### 5.4 Final answer 与活动收口

- final answer 是独立 assistant Message，是 Turn 的主视觉，不是最后一条 tool activity。
- 只有 `completed + canonical finalMessageId` 时活动树自动收起为一行摘要，例如“6 个步骤 · 5 成功 · 1 已跳过 · 18s”。
- failed、cancelled、ambiguous、awaiting_final 都不能自动收起。
- 用户手动展开/收起只修改 view state。
- Meta Proposal 与 final answer 分开。Final 解释“做了什么”；Proposal 展示“将修改什么”并等待 Apply/Reject。

## 6. Composer、停止与排队

### 6.1 Composer 不是 busy 时整块禁用

Turn 运行中，输入框仍可编辑。主按钮按状态变化：

- idle：`发送`
- running 且输入为空：`停止`
- running 且输入非空：`加入队列`
- stopping：disabled `正在停止…`
- awaiting interaction：普通发送不可提交，优先完成 interaction

### 6.2 排队

第一版只支持每个 Chat target 一个本地 `queuedDraft`：

- 显示完整预览、目标 Agent、`立即发送（若 owner 支持 steer）`、`编辑`、`取消排队`；
- 不合并成不透明长字符串；后一次发送默认替换或由用户确认追加；
- 当前 Turn settlement 后才触发真正 typed send；
- target generation/revision 变化时不发送，恢复到 Composer 并提示原因；
- 刷新/关闭页面时可作为 unsaved draft 恢复，但绝不把它伪装成已接受的 durable Message。

若以后要求跨设备 durable queue，必须由对应 domain owner 增加明确记录和命令；不能把 Renderer localStorage 当业务真相。

### 6.3 停止

停止能力必须由 adapter 明确声明：

| 场景 | 正确动作 |
| --- | --- |
| Card Session | `session.request_interrupt`，绑定 exact current Session/Turn |
| Task Conductor | `session.request_interrupt` 绑定 exact Conductor LogicalSession/Turn；独立 Task Stop 仍是另一项产品动作 |
| Template/Task Setup Meta | 需要新增 owner-scoped MetaTurn interrupt/cancel command 后才显示停止；未实现前不能放假按钮 |

`accepted` 只表示 intent 已记录。真正 cancelled/unknown/late-final 必须由 Runtime reconciliation 更新展示。

## 7. Provider、Model、Effort 控件

设置页与 Chat Composer 分工如下：

1. 设置页发现本机 Provider、读取真实 ACP model catalog，并让用户维护“加入 Chat 的模型”有序列表及默认模型；
2. 空白、未绑定的 Meta Chat 或未来新 Session 可以从 Host-issued option 选择 Provider / Model / Effort；
3. 首次发送冻结 `metaProfileOptionId` 或 Execution Profile revision；
4. 已绑定 Session 只显示一个紧凑只读 chip，例如 `Codex · gpt-5.6-luna · high`；点击可查看详情或“新建会话使用其他配置”，不能原地改投；
5. 下拉控件默认折叠在 Composer 的运行配置 popover 中，避免长期占用正文区域。

模型列表必须来自最近一次已确认 cleanup 的 Host model catalog，不能来自 Template 固定值、品牌常量或 UI fallback。

## 8. 建议的 Renderer 合同

以下是实施目标，不是新的领域 writer：

```ts
type ChatTurnPresentation = Readonly<{
  turnId: string;
  target: ChatTargetPresentation;
  state:
    | "submitting"
    | "running"
    | "awaiting_interaction"
    | "awaiting_final"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"
    | "ambiguous";
  userMessage?: ChatMessagePresentation;
  finalMessage?: ChatMessagePresentation;
  activities: readonly ChatActivityPresentation[];
  interaction?: ChatInteractionPresentation;
  summary: Readonly<{
    durationMs?: number;
    completedActivities: number;
    failedActivities: number;
  }>;
}>;
```

`ChatActivityPresentation` 应落实 Architecture 已冻结的 `assistant_progress | tool | change | web`、phase、append/replace 与有界 detail/content。当前 [`packages/runtime-contracts/src/provider-activity.ts`](../packages/runtime-contracts/src/provider-activity.ts) 只有 progress/tool 的最小 union，且 tool 没有可展开的安全 detail；这是实现 tool card 前必须先补的 contract，而不是在 JSX 里猜内容。

## 9. 组件边界

建议把共享组件收敛为：

```text
AgentChatShell
├── ChatHeader
├── ChatTranscript
│   ├── ChatMessage
│   ├── ChatTurn
│   │   ├── ThinkingStatus
│   │   ├── ActivityTree
│   │   │   └── ToolActivityCard
│   │   ├── InteractionSlot
│   │   └── FinalMessage
│   └── JumpToLatest
└── ChatComposer
    ├── QueuedDraft
    ├── RuntimeProfileChip / ProfilePicker
    └── SendStopAction
```

当前 [`AgentLoopChatUI.tsx`](../packages/workbench-ui/src/agent-loop/AgentLoopChatUI.tsx) 应继续作为共享 primitive 的归属；Meta/Session surface 只组装 adapter 数据。不要再在 `AgentLoopMetaPanel` 内单独做一套 tool trace，也不要让 `AgentLoopSessionPresentation` 维护另一套折叠语义。

## 10. 流式与性能规则

- Provider activity invalidation 可以高频到达，但 Markdown/Tool detail 渲染合并到 animation frame，并设置约 100–150ms 的最大批次窗口；
- text/progress/tool output 按 stable id 原位更新；禁止每个 delta append 一个 React list item；
- terminal/final/cancel 前必须 flush 最后 snapshot；
- 用户向上滚动后停止 auto-follow，显示“回到底部”；只有用户回到底部或显式点击才恢复；
- 大 tool output 必须由 Host 先生成 bounded safe detail，Renderer 再分段/截断；
- 切换 Tab/页面时，旧 generation 的 render request 必须被 generation fence 丢弃。

## 11. 恢复与错误语义

- 刷新后从 durable Message/Turn/Interaction/ProviderActivity rebuild，不从 DOM 或 raw Provider transcript恢复；
- stable activity id + sequence 防止重放时重复 tool card；
- running Turn 重连后先显示“正在恢复状态”，再由 Runtime projection变为 running/awaiting_final/ambiguous；
- Provider unavailable 不删除已存在会话和历史；新 send 明确 blocked；
- final 已到但 terminal 未到显示 awaiting_final；terminal 已到但 final 缺失也显示 awaiting_final/failed，不得制造空 final；
- interrupt accepted 后 late final 必须按 Runtime canonical reconciliation 展示 Notice，不由 Renderer 决胜。

## 12. 可访问性与视觉密度

- tool/thinking header 使用原生 button 或 `role=button + tabindex + aria-expanded`；
- 状态不只靠颜色，必须有文字或图标的可访问标签；
- Chat 字号、行高与产品正文 token 一致，不创建独立的小字号控制台风格；
- 不给每组 activity 再套一个无语义大边框；层级由缩进、连接线、状态和留白表达；
- user/assistant/tool/notice 使用同一排版系统，code/diff 才使用 monospace；
- running 状态用 `aria-live=polite`，token delta 本身不逐字播报。

## 13. 分阶段实施顺序

### P0：先修语义，不先修样式

1. 扩展 safe `ProviderActivityReadModel`，补 phase、updateMode、bounded detail/content 与 stable sequence；
2. 增加 provider-neutral `ChatTurnPresentation` projector；
3. 让 Meta 与 Task Session adapter 共用 Turn/activity/final 折叠规则；
4. Tool card 按 activityId 原位更新并可独立展开；
5. 补 Composer local queue；Meta 停止按钮必须等真实 MetaTurn interrupt owner 后再展示。

### P1：流畅度

1. 引入 batched streaming render；
2. 补 submit 即时状态、thinking duration 与 reasoning channel 正文流；
3. settled terminal 前 flush，Thinking 自动收起；completed final 后活动树再按既有规则收起；
4. 自动跟随、回到底部、切换 generation fence。

### P2：配置与细节

1. 已绑定 Session 折叠 Provider/Model/Effort 为只读 chip；
2. 空白 Session 使用 Host-issued picker；
3. tool kind 专用安全详情（Template patch、web、change）；
4. keyboard、ARIA、响应式和可调宽布局统一。

## 14. 验收场景

| 场景 | 必须观察到 |
| --- | --- |
| Meta 首次发送 | 立即出现 user message + submitting；只创建一个 MetaSession/MetaTurn；首 safe delta 原位流式更新 |
| running 时再次发送 | 输入可编辑；出现一个未提交 queued draft；当前 Turn 未多建；settlement 后才真正 send |
| 停止 | exact typed interrupt/cancel intent；UI 先 stopping；confirmed/unknown/late-final 与 Runtime 一致 |
| 连续 tool updates | 同 activityId 只有一张 card；status/detail 原位更新；单卡可展开；无外层重复大框 |
| Thinking | reasoning正文按ACP顺序流式展示；settled前flush并自动收起；可手动重开；无reasoning时才显示中性占位 |
| Final | canonical final 独立显示；completed trace 自动收起；failed/ambiguous 不收起 |
| 刷新/重连 | Message、tool status、final/interaction 从 durable read model恢复；无重复 card/Message |
| 切换 Session | 旧 generation delta 不进入新 Tab；Composer 目标清楚；queued draft 不静默改投 |
| 模型选择 | 设置页启用列表决定 Chat options；已绑定 Session 配置冻结；无品牌硬编码 fallback |
| 三种 Chat | Meta、Conductor、Card 的消息样式、tool card、stream、scroll、composer 一致；命令与领域记录仍隔离 |

验证至少包括：

1. shared Chat component focused tests；
2. Meta/Session adapter contract tests；
3. Runtime Host 的 activity dedupe、terminal/final、interrupt/reconnect tests；
4. Browser 中实际发送、排队、停止、展开 tool、滚动与恢复；
5. 至少一条真实 ACP Provider journey，证明 delta/tool/final 从 ACP 到 UI 全链路，而不是 fake Renderer data。

## 15. 取舍记录

- Claudian 是产品与实现对照，不是 Agent Workspace 的架构权威。
- 吸收 Claudian 的可展开 Thinking 交互并展示 Provider reasoning channel 正文；不搬它的 Obsidian conversation/tab
  模型或 direct provider integration，也不把 raw ACP wire envelope 暴露给 Renderer。
- 不为 Meta、Conductor、Card 各写一套 ChatUI；只写 typed adapter。
- 不在 JSX 中解释 Provider 品牌或 raw ACP payload。
- 不把“停止”“排队”“最终回复”做成纯视觉状态；每个状态都必须能追到真实 owner、命令或明确的未提交 Renderer intent。
