# OpenCode Server / Web UI 真实浏览器 E2E Harness v1

日期：2026-08-05  
状态：Active；`onlyopencode` 的浏览器验收计划  
关联计划：`opencode-server-webui-migration-v1.plan.md`

## 已执行结果（R3，2026-08-05）

R3“本地软件诊断与修复”已用一个隔离 Workbench 页面完成真实浏览器验收，完整结果在：

```text
/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/
20260805-r3-local-software-diagnosis-01/result.md
```

- 已验证：Meta Agent 保存 Template Version、明确 Desktop `project/` cwd、官方 WebUI 的原生授权、真实失败复现与修复、独立复核、Publisher artifact、Achieve 后同 Task/Run/Conductor Session 续接、回收、放回、放回后同一会话续接、受管 artifact 的彻底删除，以及用户文件边界。
- 已验证：续接两次都没有创建新的 Run 或 Conductor/Publisher Provider Session；永久删除后 Task/Run/事件/Host binding/受管 artifact/用户消息/命令记录均已清理，只保留最小幂等 tombstone。
- 本次发现并修复：重新打开官方 Worker 页面时，Runtime 曾将未处理的原生授权错误投影为 `ready`；现在保留 `permission_required`，并有 OpenCode Server Runtime 回归测试。
- 未在 R3 声称完成：B11 的 Stop → Restart 新 Run 语义、B14 布局持久化、R1/R2 的全部业务场景。后续必须在独立 Electron user-data profile 中继续，不能复用 R3 的状态库。

## 已执行结果（R4 补充回归，2026-08-05）

R4 使用独立 Electron user-data profile 和独立桌面项目，完整结果在：

```text
/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/
20260805-r4-stop-restart-layout-01/result.md
```

- 已验证：Meta Agent 真实创建并保存 `Local Release Readiness Review · v1`；Task 明确选择该案例的 `project/`；Conductor、独立复核与 Publisher 在官方内嵌 OpenCode WebUI 中产生真实结果和 artifact。
- 已验证 B11：第一次 Stop 结束旧 Run；重新启动为同一 Task 创建新 Run、新 scoped Conductor logical Session 和新的 Provider Session；第二次 Stop 同样先记录取消事实，再释放 Host。
- 已验证 B14：Task 列表分隔条可拖动或用左右方向键微调；浏览器实测将当前 Run 的列表宽度从 `258` 持久化到 `282`，没有创建 Provider Session。
- 已验证 B10 的状态语义：Achieve 后点击“拉回继续”恢复同一 Task、同一 Run、同一 Conductor Provider Session；只重新连接 Host page lease，不创建替代 Session。
- 已验证官方 Composer 续聊路径：clipboard-backed automation 会失焦，但聚焦后的原生逐键输入加 `Enter` 已在官方 iframe 中发送真实只读业务问题。Provider 回答可见，Runtime 保存了同一 input id 的 attempting/continued/observed 事实；没有 `403`、新标签、替代 Session 或手工 HTTP 请求。该实测覆盖 Gateway 的 B06 关键路径，并证明 delivery-ready 后可由真实输入恢复下一决策；R1 的特定研究纠正与 HTML 二次交付仍不能因此跳过。

## 目标

建立一套不依赖 mock WebUI、手工 Cookie `fetch` 或 PTY 页面替代的验收标准，验证当前产品从 **Meta Agent 创建/修订 Template** 到 **Task 的官方 OpenCode Conductor 对话、派发、纠正、停止、重跑和交付** 的真实用户路径。

这份计划本身不是新的 Runtime，也不改变状态 owner。它定义实现顺序、真实浏览器操作、每项必须观察到的事实和测试产物位置；实现任何相关功能后，必须跑完对应场景。

## 真实测试环境和产物目录

文档、计划和代码都留在仓库。每次实际浏览器测试产生的项目文件、截图、状态快照和交付物只放在桌面：

```text
/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/
  <yyyyMMdd-HHmmss>-<case-id>/
    project/                 # 本次 Task 明确选择的项目根目录 / cwd
    evidence/
      browser/
      console/
      network/
      state/
    artifacts/
    result.md
```

规则：

- 每个案例都新建独立 `<case-id>/project`，不得复用现有用户研究目录。
- 不得把测试 Task、测试产物或 `.agent-workspace` 元数据放进 `/Users/dingyujie/CODES/Agent-WorkSpace`。
- 清理仅针对已经验证的单个 `<case-id>`；不得删除 `tempreport` 或仓库根目录。
- 浏览器操作针对当前产品和真实 OpenCode Host。不能通过 Runtime API、DOM 注入、假输入框或手工构造请求伪造“发送成功”。

### 浏览器标签纪律

- 一个 E2E 案例只保留一个隔离的 Agent Workspace Workbench 标签；官方 OpenCode Session 只在这个 Task 页面的内嵌 WebUI 中切换。
- 不得为每个 Provider Session、重绑 Host 或页面 lease 打开单独的 OpenCode 浏览器标签。Provider 诊断使用 Runtime 的只读事实、受控测试或 Workbench 内嵌页面，不把调试页当作产品验收界面。
- 代码或隔离 Electron 重启后，最多对该隔离 Workbench 做一次明确、可说明的 reload；不得通过反复刷新来等待状态变化。状态等待应观察 Task/Run 事实或当前页面的语义变化。
- 每轮结束清理本轮创建的测试标签，只保留一个可交接的 Workbench 标签；不得关闭用户原有浏览器标签。

## 测试前必须具备的产品入口

### A. Task 的项目文件夹选择和新建

Task 创建页必须把项目文件夹作为明确输入，而不是静默使用当前 Agent Workspace 仓库。

1. 用户可以选择已有可写目录，页面显示绝对路径与校验结果。
2. 用户可以点击 **新建文件夹**：输入父目录、文件夹名和最终路径预览。
3. 创建由 Task/Run service 的受控命令完成；Renderer 只能提交意图，不能直接写文件系统。
4. 空名称、路径穿越、不可写目录、已存在且未确认的目录都会阻止 Task 创建。
5. 浏览器 E2E 的默认父目录是 `/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/<case-id>`，最终 `cwd` 是其 `project/`。

验证：Task Architecture、Conductor Session、Worker Session 与 Publisher artifact 全部以同一个 `project/` 为根。

### B. 只给 Task、没有合适 Template 时的引导

Task 向导不能默默套用默认模板，也不能用一个未保存 Draft 启动 Task。用户只提供问题时，必须有三个明确入口：

| 选择 | 行为 | 禁止行为 |
| --- | --- | --- |
| 使用已有模板 | 选择不可变 Template Version 并预览 Charter/Cards | 后续模板编辑影响本 Task |
| 没有合适模板 | 保留 Task 标题、目标和项目目录，进入 Template Meta Agent Draft | 自动保存模板或自动启动 Task |
| 手工定义模板 | 建立显式 Draft，保存 Version 后回到原 Task 向导 | 用临时配置创建 Task |

保存 Meta Agent Draft 后，用户回到 Task 向导，原目标和目录仍在，新增 Version 被选中；仍需用户明确点击“创建 Task”。

### C. Card 的两类上下文必须分开

每张 Agent Card 至少有两种互不混淆的配置：

| 内容 | 注入对象与时机 | 用途 |
| --- | --- | --- |
| Dispatch profile / 给 Conductor 的派发档案 | Conductor 启动和每次决策读取的 Template/Task Architecture 上下文 | 让 Conductor 知道何时适合派发该能力卡 |
| Worker system prompt | Card 首次在该 Task Run 被物化为 Provider Session 时，作为该 Worker 的 Session 上下文 | 约束该 Worker 如何执行其接到的具体 assignment |

它们不能在 Inspector 中共用一个“描述”字段。Meta Agent 的 `@card-id` 目标修改应明确显示修改的是哪一种内容；选中的 Card 之外不得被隐式改写。

### D. Conductor 不能代替一个已声明的交付 Card

截图中的“Conductor 自己创建 HTML”是一个产品错误：Template 中已经有 Publisher Card，Conductor 却绕过该 Card 直接写最终交付物。Runtime 不应固定派发路径，但当 Conductor 选择并声明“由 Publisher 负责最终交付”时，产品必须能够验证下列事实：

1. 最终 artifact 关联的 `dispatch.agentId` 是 `publisher`，并有对应 Provider receipt/result。
2. Conductor 可以整理、选择结果和要求修订，但不应把被分配给 Publisher 的最终文件伪装为自己的交付。
3. 如果 Conductor 选择不使用 Publisher，它必须在对话和 Timeline 中给出具体理由；该情况在测试中应视为需要人工审核，而不是默默通过。

测试中每个最终 artifact 都要记录 `artifact path → Run → Dispatch → Card → Provider Session` 的链路；没有这条链路即为失败。

## 生命周期验收边界

生命周期定义只以
[`task-template-runtime-model.md`](../spec/task-template-runtime-model.md#states-and-completion)
为准。本 Harness 不再复制状态规则；B10 验证已 Achieve Task 的原会话接续，
B12/B13 验证回收、放回与彻底删除。R3 已实际覆盖 B12/B13；其他案例不得因
R3 通过而跳过与自身项目目录、受管 artifact 和状态库隔离相关的验证。

## 浏览器验收矩阵

所有场景都使用真实浏览器。每项成功都必须记录页面截图、浏览器 console error/warn、Task/Run/Session/Dispatch/Wakeup 事实快照和 `result.md`。

### 本 Harness 的真实业务场景库

本计划不用“回复一个令牌”作为产品验收，也不能只用一个 DeepSearch 模板。每个场景的 Template 都必须由 Meta Agent 通过一次真实对话新建、保存为独立 Version；具体卡片数量和派发顺序由 Conductor 根据结果决定，不由 Runtime 固定编排。

| 场景 | Meta Agent 创建的真实 Template | 真实 Task 与产物 | 主要交互/状态覆盖 |
| --- | --- | --- | --- |
| R1 产业链研究 | `产业链 DeepSearch 研究与投资判断`：产业链/需求、供给/竞争、上市公司/风险、独立复核、证据报告交付 | 中国储能产业链的 Markdown 研究与中文 HTML briefing | 完整多 Agent 研究、证据纠正、delivery-ready 续聊、Publisher artifact owner |
| R2 政策与市场准入 | `政策合规与市场准入评估`：法规原文研究、市场准入分析、反方风险复核、决策备忘录交付 | 面向中国储能项目的政策/合规决策备忘录 | `@` 定向改 Card、版本回退、不同 Card 配置；完成并 Achieve 后在原 Conductor 会话中“拉回继续” |
| R3 本地软件诊断 | `本地软件诊断与修复`：复现/测试、代码诊断、实施、独立代码复核、变更说明交付 | 桌面受控 fixture 项目的可复现缺陷修复、测试结果和变更说明 | Stop/restart、Provider Session 重建；完成并 Achieve 后的回收站、放回、彻底删除、受管产物与用户文件边界 |

R3 的 fixture 也只能创建在案例 `project/` 内。它应包含一个真实、可复现的失败测试和一份用户保留文件 `user-kept-note.md`；后者用于证明彻底删除 Task 不会误删用户未托管的项目文件。

R2 专门验证 Achieve 后的原会话接续；R3 专门验证回收、放回和彻底清理。永久删除
只会在该案例所有需要保留历史的验证结束后执行。

下面 R1 是首个执行案例的完整内容；R2/R3 不能因为 R1 通过而跳过。

**Template brief**：创建“产业链 DeepSearch 研究与投资判断” Loop Template。它应提供互补的产业链/需求、供给/竞争、上市公司/风险研究能力，以及独立复核和基于证据的报告交付能力。每张 Card 同时有给 Conductor 的派发档案和自身 Worker System Prompt。

**Task 目标**：在新建的 `project/` 中，围绕中国电化学储能产业链（电池、PCS、系统集成、运营）完成截至执行日期的可复核投资研究。报告须区分事实、推断和未知项，记录来源与发布日期，讨论基准/乐观/悲观情景、催化剂、风险、可证伪条件和不确定性；这不是投资建议。最终交付为：

```text
project/artifacts/china-energy-storage-investment-study.md
project/artifacts/china-energy-storage-investment-briefing.html
```

**真实中途纠正**：在已有研究回流后，用户要求“把范围明确收窄为中国市场；补足系统集成商、储能运营和海外需求变化的风险；撤回没有可追溯来源的估值或收益判断；保留不确定性而不是补编结论”。Conductor 必须基于已返回的材料自行决定是否重派发、派给谁、是否送 Reviewer。

**真实交付后续聊**：在 Conductor 声明 Markdown 报告可交付后，用户要求“把当前已核实材料整理成可直接打开的中文 HTML briefing，突出产业链流向、情景比较、主要风险和来源边界；由你决定是否需要 Publisher 或 Reviewer 继续工作”。这同时验证同一 Conductor Session 的 `delivery_ready → running` 续聊与实际二次交付。

| ID | 优先级 | 浏览器操作 | 通过条件 |
| --- | --- | --- | --- |
| B00 | P0 | 在 Task 向导中选择或新建本案例 `project/` | Task 不使用仓库路径；创建失败时不能创建 Task；Task Architecture 保存同一 cwd。 |
| B01 | P0 | 只填写 Task 目标、不选模板 | 出现已有模板 / Meta Agent / 手工定义三个入口；Meta Agent 返回后目标和目录仍保留。 |
| B02 | P0 | 打开 Template Meta Agent，但先不发消息 | 官方 WebUI 不自动写入 user/assistant 首轮；没有 Task、Run、Dispatch 或 artifact。 |
| B03 | P1 | 在 Meta Agent 对话中发送 `@Searcher-0 @Searcher-1` 的修改 | 仅所选 Cards 改变；派发档案和 Worker system prompt 分别可见；Patch 未自动保存 Version。 |
| B04 | P1 | 保存 Draft；从旧 Version 再创建 Draft 并保存 | 保存为不可变 `vN+1`；旧 `vN` 不变；所谓“回退”产生新 Draft / `vN+2`，不改写历史。 |
| B05 | P0 | 用已保存 Version 和新的 `project/` 创建并 Start Task | Task Architecture 固定 Template Version；Conductor 是默认、唯一主官方 WebUI；未派发 Card 不伪装为已启动 Session。 |
| B06 | P0 | 在嵌入的官方 Conductor iframe 补充真实研究要求：“同时比较电池、PCS、系统集成和运营；优先截至当前日期的一手资料；先自行判断需要哪些研究能力再开始。” | 无 `403`、无 JSON 解析错误、无“发送提示失败”；官方页面出现这条用户要求及 Conductor 的实际决策；相同 Task/Run/Conductor Provider Session 保持。 |
| B07 | P0 | Markdown 报告进入 `delivery_ready` 后，在同一官方 Conductor 页面发送“整理成可打开的中文 HTML briefing，保留情景、风险和来源边界；由你决定是否继续派发 Publisher 或 Reviewer”。 | `delivery_ready → running`；同一 Run 和 Provider Session；Conductor 作出实际下一步决定并在需要时派发；不创建新 Task/Run。 |
| B08 | P1 | 在已有研究回流后，发送“收窄为中国市场；补足系统集成商、储能运营和海外需求变化的风险；撤回无来源的估值或收益判断”。 | Worker 卡仅在实际 Provider binding 后可打开；Conductor 接收 exact provider result；是否重派发由 Conductor 决定，且结果能反映纠正要求。 |
| B09 | P1 | 运行 R1 直至 Markdown 与 HTML 交付；检查每个 artifact 的创建链路。 | 每一步有 Card、Dispatch、Provider receipt/result 和 wakeup；两个 artifact 都由 Publisher Dispatch 交付；报告含来源、事实/推断和不确定性。Conductor 自己写交付物视为失败。 |
| B10 | P1 | 在 R2 中完成后点 Achieve，再点“拉回继续”，在原官方 Conductor 会话对同一决策备忘录提出真实补充问题。 | Achieved Task 的历史和交付物先保持可读；用户明确确认且原 Provider Session 可恢复后，Task/Run 回到进行中；Task ID、Run ID、逻辑 Session 与 Conductor Provider Session ID 均不变，补充要求可继续完成。 |
| B11 | P1 | 在 R3 的活动任务上停止，再重新 Start。 | 所有活跃 Session 有取消事实；新 Start 建立新 Run / 新 Conductor Provider Session；旧页面 lease 不能继续派发。 |
| B12 | P2 | 将已 Achieve 的 R3 Task 移入回收站、确认内容仍在、放回；验证“拉回继续”仍接续原会话。另行选择“基于历史新建 Task”。 | 删除后 Task 从常规列表消失但在回收站可见；Task/历史/受管 artifact 与原 Conductor Session 绑定都可恢复。“拉回继续”保持原 Task/Run/Session；只有“基于历史新建 Task”才创建新的 Task/Run/Conductor Session，即使它选择同一个项目目录。 |
| B13 | P2 | 将放回后的 R3 再次移入回收站，执行“彻底删除”，明确选择删除登记的受管 artifact；检查实际清理结果。 | 常规列表、回收站、旧深链和旧 presentation lease 都不可再读取；Task、Run、Session bindings、Task Runtime 目录与登记的受管 artifact 均清理；`user-kept-note.md` 仍在，证明没有越权清理整个项目目录。 |
| B14 | P2 | 调整 Task 三栏宽度、刷新、切换 Task 再回来。 | 布局在边界内保存；Conductor 中心区域自适应且始终为主区；没有因布局操作创建新 Provider Session。 |

## B06 / B07 当前红色用例：官方 WebUI 续聊

当前截图中的失败必须成为首个红色浏览器回归：

```text
POST /session/<providerSessionId>/prompt_async → 403 Forbidden
```

已确认的实际请求格式：OpenCode 1.18.13 官方 WebUI 在 POST 时将目录放在 `x-opencode-directory` header，而不是 URL 的 `?directory=` query。Presentation Gateway 仅检查 query 会在 Runtime 处理续聊之前拒绝该请求。

修复验收要求：

1. Gateway 只接受已绑定 presentation lease 且 `providerSessionId` 完全匹配的 Conductor 请求。
2. 目录可以来自 query 或 `x-opencode-directory`；二者同时存在时必须一致；缺失、解码失败或与注册 cwd 不一致都拒绝。
3. 请求通过后，Gateway 先调用 Task/Run service 的 continuation preflight，持久化准确 input id 和 wakeup，再代理到 Provider。
4. Worker/其他 Session 的请求不触发 Conductor 生命周期回调。
5. 单元/组合测试只用于定位；B06、B07 必须在真实 iframe 中各跑绿一次才算完成。

## 执行顺序

1. 实现 B00、B01；先让每个测试都进入独立桌面项目目录。
2. 建立 B06 的真实官方 Composer Send 红色用例，修复 header 目录验证，跑绿 B06。
3. 跑绿 B07，验证 delivery-ready 的同 Run 连续对话。
4. 跑 B02–B04，验证 Meta Agent 连续修订、@ 选择和版本不可变性。
5. 跑完 R1、R2、R3，而不是复用一个 Template：验证真实多 Agent 研究、纠正、结果回流、交付、Achieve 拉回和本地修复。
6. 实施并验收 B10–B14 的停止、重跑、回收站、彻底清理与布局行为。

## 每次案例的结果记录

每次在桌面案例目录创建 `result.md`，最少包含：

```markdown
# <case-id>

- 产品构建 / OpenCode 版本：
- Template Draft / Version：
- Task cwd：/Users/dingyujie/Desktop/tempreport/agent-workspace-e2e/<case-id>/project
- Task id / Run id / Conductor Provider Session id：

## 浏览器步骤、预期、实际

| 步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- |

## 证据

- 浏览器及官方 WebUI 截图：
- console/network：
- Runtime 状态快照：
- artifact 路径：

## 风险或失败复现
```

## 完成标准

不以“页面能打开”、HTML mock、单测、手工 API 请求或模型的一句 `done` 宣称通过。R1、R2、R3 都必须各自通过 Meta Agent 新建真实 Template、保存 Version、创建桌面项目 Task 和可复核交付；至少 B00–B10 需要真实证据，B11–B14 是删除与布局功能落地后的回归门槛。
