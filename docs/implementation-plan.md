# Agent Workspace ACP-first Provider Cutover Plan

日期：2026-08-11

状态：**当前唯一可执行计划；production ACP-only cutover 已完成，Phase 8 fresh release 尚未完成**

架构来源：[`architecture.md`](architecture.md)

## 1. 目标、现状与完成口径

目标 production graph：

```text
Workbench
  -> RuntimeClient / authenticated Runtime Bridge
  -> Orchestration Runtime（OR，per TaskRun）
  -> durable SessionRuntimeCommand
  -> Session Runtime（SR，per materialized LogicalSession）
  -> ACP Client
  -> ACP Agent
  -> current installed Provider runtime

ACP observation
  -> SR correlation / settlement
  -> SessionRuntimeEvent
  -> OR-owned Message / Inbox / SessionTurn / lifecycle
```

当前已完成基线：Session-ID domain/store/application、Slot/generation、ACP-safe Binding/SR/reliability、
Message/Inbox/Input/SessionTurn、Conductor 四工具、PlanningFence、Human priority、Stop/Restart/close、Meta
Draft/Turn、Files & Changes、Achieve、统一 Host/Bridge/Workbench/Desktop，以及 production ACP Client/
launcher/current-install qualification/private identity/recovery composition。Production import graph 已只走 ACP；
direct OpenCode REST、Codex App Server、Claude stream transports、direct Meta adapters 与三个 direct Provider package
已物理删除，superseded writer 与 migration 已封印。

当前确定缺口只属于 Phase 8 live release：parent 三 lane zero-effect input seal、4+4+1 bounded
production qualification、隔离local gates、单次build、exact 28-cell runner/verifier已接入唯一
`run-release.ts` aggregate；本机尚缺 trusted `codex-acp` wrapper 与三个 exact live envelope，且
OpenCode/Codex/Meta 尚未启动真实 Provider/model，因而尚无 fresh 28-cell bundle PASS。无输入时aggregate在A门以
`acp_release_parent_envelope_missing`零副作用退出2。

### 完成定义

只有同时满足以下条件才可声明 ACP cutover completed：

1. production import graph 中 Task/Meta Provider wire 只有 `provider-acp`；无 direct adapter、selector 或 fallback。
2. OR 与 SR owner 边界有 durable command/event、crash/replay 和 single-writer tests；协作 `SessionTurn` 仍由 OR 写，
   ACP `SessionExecutionAttempt` 由 SR 写。
3. raw ACP session/request/option/tool/JSON-RPC ID 与 absolute cwd 只在 Host-private map；domain/store/UI/evidence 零 raw ID。
4. portable Profile 不含本机 path/version/hash；Host 每个 Binding/generation解析当前安装并签发
   `LocalResolutionSeal` + process-local `ACPQualification`。没有版本 allowlist。
5. OpenCode ACP 与 Codex ACP 都以真实 Task Profile 独立通过 initialize、Binding、prompt receipt、final+terminal、
   resume/reconcile、cancel 及各自宣称的 role capability；一个不能替另一个出证。
6. Meta 使用独立 ACP Profile/process/raw-ID map；Task Setup证明零工具，Template Design只证明proposal-only
   `template_draft` scoped MCP、no-cwd/no-Workspace、strict whole-final 与恢复。
7. Browser、Electron、cross-surface、restart 与 fresh release matrix 同 bundle PASS；旧 direct evidence 不可代证。

退出码保持：`0 = fresh ACP bundle all required PASS`、`1 = assertion/safety failure`、
`2 = BLOCKED_CAPABILITY`。缺 wrapper、credential、当前安装或 required capability 时绝不回退 direct transport。

## 2. 冻结的 owner 与数据边界

| Owner | 唯一写入 / 责任 | 明确禁止 |
| --- | --- | --- |
| OR / existing owner-scoped services | Task/Run/Slot/LogicalSession、Message/Forward、Inbox/Input、协作 SessionTurn、Control、Human、Notice、canonical final | ACP wire/raw ID、Provider process、直接改 Binding pointer |
| Binding service | Binding lineage、current binding、Workspace opaque `bindingHandle`、status/recoverability | raw ACP session id、修改历史 Binding、按时间猜 current |
| SR | SessionExecutionRuntime/Attempt、delivery correlation、interaction fence、candidate/terminal pairing、reconcile/settlement | Message/Inbox/Task lifecycle、sibling routing、Achieve |
| ACP Client | initialize/session lifecycle/prompt/cancel/reverse RPC、wire normalization、generation-local raw-ID map | Store/domain writer、业务路由、把 raw payload/ID 投影给 UI |
| Host | current-install discovery/trust、LocalResolutionSeal、qualification、process/credential/workspace/MCP/fs/terminal broker | Task/Message业务结论、Template写本机值、用配置version授权 |
| Meta service | Draft/MetaSession/MetaTurn/message/proposal/apply | Task Binding、Gateway、cwd/Workspace、Publish/Create/Start/Achieve |
| Renderer | view state、unsaved draft、request progress、typed read-model cache | Provider/ACP connection、Store、credential、lifecycle truth |

### Profile 与版本合同

新 portable Profile schema（必须 schema bump，不原地改 v2）只保存：

```text
profileRevisionId
providerFamily = opencode | codex | claude-code
acpAgentKind = native_acp | codex_acp | claude_agent_acp
protocolMajor = 1
model/config intent
required capabilities/extensions
permission/capability policy
```

Host-private：

```text
LocalResolutionSeal
  = canonical launcher identity
  + observed artifact/upstream version
  + digest/signature/trust
  + initialize capability/extension fingerprint
  + execution-config digest + observedAt

ACPQualification
  = LocalResolutionSeal + model/config + live probe digest + Host generation
```

旧 seal 在 artifact/initialize/model/capability drift 后失效；重新 discovery/qualification 后任何新版本都可以重新
available。Template、Catalog、UI、environment 与仓库都不能提供 supported-version allowlist。

## 3. 执行原则

- 先写 fail-first contract，再实现；每个 phase 的 GREEN 不能由后续 phase 补写。
- 新代码先与现有 direct production graph隔离；只有 Phase 7 一次切 composition。
- 旧 active direct Binding 不转换为 ACP。切换前 drain/Stop/reconcile；历史只读保留，新 Binding 才 ACP-only。
- 不建 compatibility facade，不给用户 Provider transport selector，不在失败时 fallback。
- 当前 `verify:release` 只运行已注册的ACP parent+exact 28 matrix；A/B缺capability时必须fail closed，不能接受旧
  native-full cell或跳过真实qualification。
- 每次外部 effect 仍先写 durable intent/idempotency；accepted 不等于 receipt/final/cancelled。
- Handoff 继续 deferred；未来是同一稳定 SR 建新 Binding lineage，不为同一 LogicalSession 创建第二个 SR。

## Phase 0 — Authority 与错误 release 阻断

**Status：** completed（2026-08-11）。ACP matrix 注册前的 release guard 已先于任何 preflight、local gate、build、
evidence 目录或 Provider effect fail closed；环境不能绕过。旧 direct matrix 保留为迁移输入，但不可再产生 release `0`。

**Goal：** 让 docs 只描述 ACP-only target，并阻止旧 direct native evidence 产生 release 0。

**Outputs：**

- `docs/README.md`、`docs/architecture.md`、本文件；
- root `README.md` / `AGENTS.md`与受authority约束的`apps/runtime-host/PROVIDER_CONFIGURATION.md`、
  `tests/integration/README.md`、`tests/journeys/README.md`同步原型差异决议、代码迁移账本和迁移状态；
- direct production imports、raw-ID持久化、brand-singleton registry、旧 native matrix 的 RED/static inventory；
- release preflight 的临时 fail-closed guard，直到新的 ACP matrix 注册完成。

**Verification：**

```bash
git diff --check -- README.md AGENTS.md docs/README.md docs/architecture.md docs/implementation-plan.md \
  apps/runtime-host/PROVIDER_CONFIGURATION.md tests/integration/README.md tests/journeys/README.md
# relative links、Markdown fences、重复 heading、当前/目标/PASS 矛盾、Provider version allowlist、direct 正向措辞人工+脚本检查
```

**Completion：** 三份authority及五份派生guidance检查全绿；旧release不能误报PASS。尚未修改production Provider path。

**Recorded verification：** focused release entry/preparation contracts `12/12 PASS`；`npm run typecheck` PASS；实际
`npm run verify:release` 以 `BLOCKED_CAPABILITY / acp_release_matrix_not_registered` 退出 `2`，且未创建配置的
evidence root。

## Phase 1 — ACP contracts、Profile schema 与 OR↔SR seam

**Status：** completed（2026-08-12）。Profile v3、SR records/state machine、隔离的 `provider-acp` core，及
durable OR command → managed fake ACP → SR settlement → canonical `recordAgentFinal` seam 已完成。未接 production
composition；raw ACP identities 与absolute workspace path仍未进入durable/public边界。

**Goal：** 在 fake ACP Agent 下先冻结协议与唯一 writer，不启动本机 Provider。

**Planned outputs：**

- 新 `provider-acp` package：ACP Client connection abstraction、normalizer、private identity store、fake Agent kit；
- runtime contracts：ACP Profile schema、新 `SessionExecutionRuntime` / `SessionExecutionAttempt` /
  `SessionRuntimeCommand` / `SessionRuntimeEvent`；
- runtime application：每 LogicalSession stable SR owner、OR command/outbox → SR settlement；
- vNext Binding contract只接受Workspace opaque handle；历史direct field的物理迁移与只读投影在Phase 6完成，新ACP
  contract从第一天就不能写raw native ref；
- vNext Interaction contract使用Workspace `interactionId/choiceId`，raw ACP request/option ID只在private store；
- vNext Task snapshot contract只保存`workspaceId`/grant digest；Host只把它解析成Attempt-scoped filesystem/MCP
  capability，ACP wire cwd使用每Binding空的0700 Host-private目录。现有SQLite迁移仍在Phase 6。

**Fail-first contracts：**

- initialize protocol major/capabilities协商失败；
- one active prompt；receipt/final candidate/terminal乱序、重复、跨 attempt；
- final无 terminal、terminal无 final、cancel accepted但未终态；
- crash before/after prompt、load replay、resume无 replay、ambiguous不重发；
- raw ACP ID/path/credential进入 durable record/read model/evidence即失败；
- OR 与 SR 不能写对方 owner rows。

**Verification：** focused contract/domain/application tests + `npm run typecheck` + `npm run test:vitest`。

**Completion：** fake Agent 可以从 OR command走到 SR settlement和 canonical final；无 production composition变化。

**Recorded verification：** `provider-acp` 6 files / `55/55 PASS`；contracts 18 files / `104/104 PASS`；
runtime-domain + runtime-application + cross-layer integration 21 files / `103/103 PASS`；冻结快照
`npm run typecheck` PASS。独立退出审计在补齐 runtime `disposition` closed-enum 后确认 P0/P1/P2 均为零；非法
`create | load | resume` 之外的值在任何 ACP Session effect 前拒绝。

## Phase 2 — Host ACP launcher、discovery 与 qualification

**Status：** completed（2026-08-12）。Provider-neutral current-install resolution、process-local qualification、
per-Binding Agent process、reverse-RPC broker 与 opt-in composition 已完成；尚未切 production，也未把任何 injected
probe 冒充为 OpenCode/Codex native evidence。

**Goal：** 实现 Provider-neutral、当前安装驱动的 ACP process boundary。

**Planned outputs：**

- Host ACP launcher/supervisor：stdio NDJSON、bounded output/backpressure、abort、TERM→KILL、confirmed exit、credential cleanup；
- `LocalProfileResolution` registry，key 为 portable Profile revision + Host resolution，不是 Provider brand；
- current-install descriptor contract与resolution registry；OpenCode/Codex的实际descriptor和native proof分别在
  Phase 3/4落地，`claude-agent-acp`在未安装/未资格验证时保持typed unavailable；
- initialize observation、capability/extension fingerprint、model-bound behavior probe与 process-local qualification；
- Host-private raw-ID map、workspace resolver、MCP/fs/terminal reverse-RPC broker；
- readiness single-flight/TTL/timeout keyed by Profile resolution；UI只收安全 observation。

**Fail-first contracts：**

- A版本通过 → 运行期 artifact/initialize drift到B使旧seal失效 → 重新 discovery/qualification 后B可用；
- unknown version不因版本号拒绝；伪造/serialized qualification、cross-process/profile/model复用均失败；
- ambient env、credential、absolute path、raw ID不泄漏；child termination/cleanup未确认则 unavailable；
- reverse RPC越 workspace/terminal/MCP lease或过期 interaction fence失败。

**Verification：** injected process/connection tests、current-install opt-in probes、typecheck/full unit。

**Completion：** Host 可以对任一 ACP launch descriptor给出 available/unavailable安全报告；尚不切默认入口。

**Recorded verification：** 5 个相邻 Host test files `35/35 PASS`；`npm run typecheck` PASS。独立退出审计确认：
credential acquisition/open/close cleanup 使用 owned cancellation，未确认即 poison；Terminal create 后立即进入可重试
cleanup registry；空 behavior 只能得到 structural unavailable，不能签发 Host-ready qualification。未启动 live Provider。

## Phase 3 — OpenCode ACP vertical slice

**Status：** implementation complete / actual-operation pending（2026-08-12）。Official ACP SDK stdio bridge、current-install OpenCode descriptor、
role-scoped deny-first policy、owned private credential/XDG lease、Attempt-scoped MCP、Binding-stable private cwd、
provider-neutral SR consumer、Unified production composition与external fresh-epoch Host recovery已通过controlled tests；
current-install actual-operation 仍归 Phase 8 fresh cell，尚未执行，因此不宣称native PASS。

**Goal：** 以当前安装 `opencode acp` 跑通第一个真实 Task SR，不使用 REST fallback。

**Required behavior：**

- initialize/new、same Binding prompt receipt、latest final + terminal；
- Host restart 后 load/resume/reconcile，不重复 prompt/final；
- cancel intent + confirmed/unknown/late-final分支；
- Conductor四工具经 ACP session `mcpServers`和 exact Turn lease；
- Publisher以 Provider 原生文件工具写 Task Workspace；Publisher/Worker/Reviewer均无 Agent Workspace scoped tool；
- raw IDs/cwd/credential零投影，process/credential清理可证。

**Evidence：** focused + native headless +正式 Host controlled Binding；不能用 direct OpenCode Server test代证。

**Completion：** OpenCode ACP Profile可作为真实 Task Profile；不代表 Codex/Meta完成。

## Phase 4 — Codex ACP vertical slice

**Status：** implementation complete / actual-operation blocked（2026-08-12）。Current `codex-acp` wrapper + current Codex upstream + exact Node runtime 的
composite resolution/drift seal、owned private `CODEX_HOME` credential lease、official ACP Binding、role-exact MCP与
provider-neutral SR consumer与production Unified composition已通过controlled tests；本机尚缺trusted
`codex-acp` wrapper，native current-model cell 尚未执行，因此不得宣称 Codex ACP 已通电。

**Goal：** 解析当前 trusted `codex-acp` wrapper及当前 Codex upstream，经同一 SR/ACP contract 跑通真实 Task Profile。

**Required behavior：** 与 Phase 3 相同的 managed baseline；role capability只按实际Profile要求出证。Agent Workspace不得
直接调用 Codex App Server；wrapper内部实现和版本只作为当前 resolution observation。Codex ACP child与
`session/new|load|resume`只接收Host-private 0700 cwd；Task Workspace只能经Attempt-scoped capability进入，项目级
`.codex`配置不得影响Host policy或scoped MCP route。

**Fail-first contracts：** wrapper缺失/不受信、upstream drift、initialize缺能力、resume/cancel不相关、direct App Server
fallback、OpenCode qualification复用均明确失败。

**Completion：** Codex ACP 与 OpenCode ACP 分别可用；两者都拥有实际 Binding/Delivery evidence，不再有 companion完成口径。

## Phase 5 — ACP Meta、Profile Setup 与 WebUI

**Status：** implementation complete / release-native evidence pending（2026-08-13）。portable Meta Profile v3、Task/Meta共用的安全ACP readiness、
`metaSessionId`-scoped Port、独立Meta ACP process/owner、Host lifecycle adapter、Template v3 built-ins与typed UI均已通过
controlled tests，并已接入Unified Host/Browser。标准 Deepsearch built-in、首次新建即持久化 Draft、Meta/Conductor/
Session 共用 Agent Chat Shell 已落地；真实 Browser 已完成 Codex Meta open/send/reply/proposal/apply。独立release-native
Meta evidence 仍归Phase 8 fresh cell，尚未执行。2026-08-14起Template Design已切到proposal-only `template_draft`
scoped MCP与局部Prompt edit/Profile revision选择合同；controlled ACP HTTP discovery/call/revoke已通过，真实Browser/Provider
交互证据仍须在本Phase focused journey补齐。

**Goal：** 把 Meta和配置/运行UI改为Host-observed ACP Profile，而非品牌自由输入/direct port。

**Planned behavior：**

- Meta复用ACP Client/launcher，使用独立 Profile/process/raw-ID map；无通用/Task/Workspace工具、cwd/workspace/task transcript；
  Template Design只注入Turn-scoped `template_draft` proposal MCP，Task Setup保持零工具；
- opener/open/send/apply/publish/create边界不变；whole-final与cold reconcile由ACP证据证明；
- Template Studio选择Host提供的 portable Profile revision；不编辑/展示本机 version/path/hash；
- Task Setup/Session Header显示actual Provider family、ACP Agent kind、artifact/upstream version和capability摘要，仅作观察；
- unavailable Profile可见但不可Start；command handler强制重新probe；无fallback；
- 产品 Library 只安装一个可用的 Deepsearch v3 Template；全部 Session Profile 默认 Codex `gpt-5.6-luna`，
  Provider-specific starters仅保留为合约fixture，不进入产品索引；
- Meta、Conductor 与 Session Agent 共用 Renderer Chat Shell，但消息/proposal/interaction继续走各自typed owner边界。
- 统一 Chat 把正式 ACP thinking/reasoning channel 投影为可展开的 Thinking block：运行中流式展示原始 reasoning
  文本（只精确移除Host-private值），任一 settled terminal 前flush，settled后自动收起；不得只显示无内容的“思考中”，
  也不得把reasoning变成`SessionMessage`、MetaMessage或Provider final。
- Template Design Meta patch支持新增、更新、删除和重排Session Agent Card：Provider只提交proposal-local引用并复用已有
  Execution Profile，Runtime在持久化Proposal前分配Workspace opaque `agentCardId`；小型Prompt变更必须按稳定target和
  唯一oldText形成局部edit，Provider/model/effort只选择Host-issued Profile revision；新Card默认零`capabilityRefs`，
  用户Apply后才由Template owner原子校验并更新Draft，既有Version/Task Architecture不回写。
- Provider / Model 选择读取 Host 从真实 ACP session config 投影的安全模型目录，不再把 built-in Template 的固定
  model 当作 Provider catalog；目录项与 role qualification 分开展示，选择模型生成新的 portable Profile revision，
  raw ACP config id 不进入 Runtime contract 或 Renderer。

**Verification：** Meta owner/adapter/Host/UI focused tests，Browser rendered opener/open/send/apply，独立 native Meta probe。

**Phase 5E — ACP model catalog（2026-08-13，in progress）：**

- **目标文件：** `packages/provider-acp/src/{types,session-configuration,managed-client}.ts`、
  `packages/runtime-contracts/src/{acp-profile-readiness,provider-settings}.ts`、`apps/runtime-host/src/{acp-provider-composition,
  acp-task-profile-runtime,acp-meta-provider-composition,session-id-acp-production-composition,
  session-id-unified-runtime-host}.ts`、`packages/workbench-ui/src/agent-loop/{AgentLoopMetaPanel,
  AgentLoopTemplateStudio,AgentLoopProviderSettings,agent-loop-template-studio-controller}.ts*`及相邻测试。
- **首个 RED：** fake ACP `session/new` 返回多个分组 model options，但 Runtime 只投影 Template 固定 model；
  raw config option id/额外字段不得泄漏；catalog-only model 不得被标成已 qualification。
- **退出条件：** Template 与 Meta Chat 的 Provider / Model 两级选择只显示最近一次 Host probe 观察到的真实目录；
  左侧设置页按 OpenCode/Codex/Claude Code 分开完成“Host扫描 Provider CLI/登录源 → Agent Workspace 解析受管 ACP runtime →
  保存并切换 future-provider generation → 显式读取模型 → 从真实目录勾选加入 Chat 的模型并指定默认值”，不再使用编号步骤或把
  未配置状态渲染成整卡禁用灰屏；最近一次成功目录与用户启用列表由本地0600设备设置持久化，Meta Chat 只显示启用模型，
  Provider / Model / Effort 组合由 Host 增量注册为 opaque Meta Profile option；部署环境配置只读，
  设置页不展示或要求用户选择 Codex/Claude ACP server 路径，也不要求用户重启 Runtime Host；已有 Binding/Session 保持冻结，
  只通过显式 `provider.probe_models` 创建 prompt-free 临时 ACP Session 刷新模型，且不依赖既有 Template/Profile；
  Host 启动、普通 read 和打开 Chat 均为零探测；无目录时明确为空；临时 Session/process/credential cleanup 未确认则失败；
  选择与 role readiness 分离；focused contracts、Host、UI、
  typecheck 与 Browser 交互验证通过。

## Phase 6 — Persistence migration 与 direct Binding drain

**Status：** completed（2026-08-12）。SQLite v21 的ACP-safe Binding/SR/Attempt/effect-intent与schema-v3
LogicalSession/Profile tuple、显式v2→v3 Template Draft migration、Meta v3 strict writer、0600 Host-private raw-session vault、
Host epoch lease与Desktop supervisor confirmed-dead恢复合同已通过focused tests。Production Host已注入这些
owner/resolver；direct drain seal 是assembly首个有状态动作；所有superseded repository writer已封印，
upgrade 对retained direct rows仅读schema metadata而不读/迁/改/删raw rows。

**Goal：** 新schema只写ACP安全对象，并为atomic cutover准备现有数据。

**Outputs：**

- schema bump：Profile revision、SR/attempt、opaque binding handle、private-map不可持久化声明、Workspace-safe interaction；
- v2 Profile/old direct Binding只读投影；显式Draft迁移到新schema，不改已发布Version bytes；
- direct active Binding inventory、drain/Stop/reconcile gate；未知/ambiguous阻止cutover；
- raw ID/path migration禁止项与fresh schema tests。

**Completion：** 没有active direct Binding；历史仍可读；新写路径只接受ACP schema。

## Phase 7 — Atomic production cutover

**Status：** completed（2026-08-12）。唯一production Host/Meta/Task composition已原子切到ACP-only；
direct transports/packages/config parsers 已物理删除；static cutover gate 对当前production/release graph为零问题。

**Goal：** 一次切换默认Host/Meta/Task composition，随后物理删除direct路径。

**Required changes：**

1. production `index.ts` 只加载ACP Profile registry/resolver/ports；
2. Task与Meta分别创建独立ACP process/qualification；
3. production-entry/cutover import graph要求`provider-acp`可达并拒绝OpenCode REST/Codex App Server/Claude stream；
4. 删除direct composition/bridges/packages/config/parser/tests，VCS保留历史；
5. 不保留兼容export、selector、fallback、candidate route或test-only production入口；
6. formal launcher、Desktop supervisor、Browser都启动同一ACP-only Host。

**Verification：** typecheck、full Vitest、Desktop、integration、e2e、formal launcher、cutover static gate、production build。

**Completion：** production graph ACP-only；若任一Profile capability缺失则typed unavailable/exit2，而不是direct fallback。

## Phase 8 — Actual-operation matrix 与 fresh release

**Status：** in progress（2026-08-12）。旧25/26-cell evidence全部 superseded；exact 28-cell matrix、
ACP Task/Meta launcher、external restart supervisor、cleanup-fenced semantic facts与UI/Runtime companion correlation已冻结。
Parent zero-effect A seal、4+4+1 production qualification B（成功预算exact 14 credential / 14 process / 13 prompt）、
隔离local gates、production locator、单次build、五类digest、matrix runner/verifier已接入真实aggregate。尚未完成的是三个
exact live envelope/current capability与唯一fresh 28-cell actual-operation PASS。

**Required cells/lanes：**

- deterministic OR/SR fake crash/race matrix；
- Browser controlled、Electron controlled、cross-surface J-01..J-12；
- OpenCode ACP Task native：managed lifecycle + required Conductor/Publisher + restart；
- Codex ACP Task native：独立 managed lifecycle + matrix声明的role能力；
- 独立ACP Meta native；
- negative：raw ID泄漏、version allowlist、cross-profile qualification、direct import/fallback、stale interaction、
  final/terminal ambiguity、child cleanup未确认。

Matrix已冻结为exact 28 required cells：24个isolated controlled（3 surfaces × main/J-08两分支/J-10五crash）、
1个cross-surface、2个独立ACP Task与1个独立ACP Meta。每个native lane记录current resolution/initialize/model/
qualification但不记录
credential/path/raw ACP ID；同一required cell保持Browser/Electron/Host/OR/SR/Binding/Input/Turn lineage。

**Aggregate order：**

```text
zero-side-effect ACP inputs
-> independent OpenCode/Codex/Meta discovery + bounded qualification + cleanup proof
-> local gates
-> one production build + source/build/schema/policy seals
-> fresh matrix
-> issuer/lineage/checksum/redaction/direct-import negatives
```

只有同一次fresh bundle全部required PASS时`verify:release`退出0。任何单独probe、fake test、旧direct result或截图都不能
代证；缺capability退出2，assertion失败退出1。

## 4. 逐 Phase 代码迁移账本

本节把 Phase 目标落实到当前 checkout 的代码入口。它是施工范围，不是“可能相关文件”清单：开始一个实现任务前，
必须先把该行的 exact files/symbols、RED test 与验证命令写入任务记录；若实际需要越出这里列出的 owner 或入口，先更新
本计划并说明依赖方向，不能边写代码边默默扩大范围。新文件名是目标 ownership 的默认落点；只有首个 fail-first
contract证明现有 owner 不适合时才允许调整。现有 direct 文件在 Phase 7 前只做隔离、inventory和阻断，不改造成第二条
ACP fallback。

### Ledger Phase 0 — Authority 与 release guard

- **当前入口：** `docs/{README,architecture,implementation-plan}.md`、`tests/journeys/{run-release,release-preparation,
  release-verifier,release-production-entry.test}.ts`、`scripts/verify-session-id-cutover.{mjs,test.mjs}`。
- **修改目标：** authority只描述ACP target；在新matrix注册前，aggregate明确拒绝旧direct native matrix并返回
  `BLOCKED_CAPABILITY`，且不得创建evidence root、build或Provider child。
- **首个RED：** 旧matrix或旧native cell仍可使`verify:release`退出0；production cutover scan没有把direct import列为
  forbidden。
- **退出条件：** 文档检查全绿；release guard测试证明旧证据不能签发新claim。Phase 0不创建`provider-acp`或修改
  production composition。

### Ledger Phase 1 — Contracts、Profile v3 与 SR seam

- **新包：** `packages/provider-acp/{package.json,src/index.ts}`，以及相邻的 connection、normalizer、
  private-identity map、fake ACP Agent模块和`.test.ts`。public export只暴露Provider-neutral command/observation与安全
  qualification observation；raw ACP IDs不得从package public API流出。
- **现有 contracts/domain 入口：** `packages/runtime-contracts/src/{templates,records,session-id-orchestration}.ts`、
  `packages/provider-port/src/index.ts`、`packages/runtime-domain/src/session-id-orchestration.ts`。新增
  `session-execution-runtime.ts` contract/domain文件，区分OR-owned `SessionTurn`与SR-owned
  `SessionExecutionRuntime/Attempt`。Template package从v2显式升为v3；v2只读兼容，不能原地改变已发布bytes。
- **现有 application入口：** `packages/runtime-application/src/{provider,persistent-session-id-orchestration-application,
  session-id-task-runtime,session-id-attention-owner}.ts`。新增相邻SR owner/use-case文件；Binding写入仍只能经Binding
  service capability，SR不得直接写OR rows。
- **Store边界：** Phase 1只冻结SR repository capability与fake/in-memory contract；
  `packages/runtime-store/src/{sqlite,session-id-repositories}.ts`中的物理schema、legacy字段和历史迁移只做inventory，统一在
  Phase 6修改。不得为了让fake Agent变绿提前改生产SQLite。
- **注册文件：** root `package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`只增加`provider-acp`
  workspace/alias/build/test可达性，不引入Provider-specific SDK或锁定Provider版本。
- **首个RED：** fake Agent下的initialize major/capability失败、one-active-prompt、final/terminal乱序、crash/replay、
  cross-attempt permission、raw ID/cwd进入Store/read model，以及OR/SR越权写入。测试落在新包及上述owner相邻
  `.test.ts`，不能只写一个跨层happy-path。
- **退出条件：** fake Agent可从durable OR command走到SR settlement和唯一canonical final；Template v3、opaque
  `bindingHandle`与Workspace `interactionId/choiceId`已由contract与fake repository round-trip证明；production入口未
  切换，SQLite尚未迁移。

### Ledger Phase 2 — Host ACP process、resolution 与 qualification

- **新Host落点：** `apps/runtime-host/src/acp-agent-process.ts`、`acp-profile-resolution.ts`、
  `acp-qualification.ts`、`acp-reverse-rpc-broker.ts`、`acp-provider-composition.ts`及相邻测试。实现复用
  `workspace-directory-resolver.ts`、`acp-binding-private-storage.ts`和`provider-scoped-mcp-bridge.ts`的安全机械层；
  后者只承载Conductor编排工具，普通Session不经Host自定义workspace工具。
- **composition边界：** `apps/runtime-host/src/provider-composition.ts`与`index.ts`在本Phase仍是旧默认入口；新
  `acp-provider-composition.ts`只由focused/opt-in harness调用，不能被旧parser当fallback。
- **process粒度：** 每个active/reconciling Binding最多一个专属process/connection generation；禁止跨Binding pooling。
  同一SR的crash recovery建立新generation并重新resolution/qualification；future Handoff的source/target lease隔离。
- **首个RED：** current artifact A运行中漂移到B、伪造或serialized qualification、cross-profile/model/generation复用、
  child忽略TERM、credential cleanup不确认、raw path/ID泄漏、reverse RPC越workspace/MCP/terminal/interaction lease。
- **退出条件：** injected child/connection tests全绿；Host可对任意portable Profile输出安全
  available/unavailable报告；current-install opt-in只作本机证据，default production仍未切换。

### Ledger Phase 3 — OpenCode ACP Task slice

- **实现入口：** 新`apps/runtime-host/src/acp-opencode-resolution.ts`及测试，只负责解析当前受信`opencode`并启动
  `opencode acp` descriptor；通用session/prompt/normalization仍在`provider-acp`，不得在Host新增OpenCode REST
  lifecycle分支。
- **实际证据：** 正式Unified Host controlled Binding harness与Phase 8 provider-neutral native cell；已删除的旧
  provider-specific smoke、`packages/provider-opencode/**`、OpenCode Server/Meta smoke与private-server diagnostic不构成ACP PASS。
- **首个RED：** 未安装/untrusted command、initialize缺能力、resume/cancel不相关、REST effect、raw ID/cwd泄漏、
  Conductor四工具或Publisher路径拒绝不在exact Binding/Turn lease。
- **退出条件：** 当前安装OpenCode ACP真实Task Profile完成managed core、restart/reconcile以及它声明的role能力；
  cleanup confirmed。不得因此更新Codex或Meta状态。

### Ledger Phase 4 — Codex ACP Task slice

- **实现入口：** 新`apps/runtime-host/src/acp-codex-resolution.ts`及测试，解析当前受信`codex-acp`与其当前Codex
  upstream；Agent Workspace只启动wrapper并说ACP，不import/call App Server。
- **实际证据：** 正式Unified Host controlled Binding harness、Codex ACP wrapper边界探针与Phase 8
  provider-neutral native cell；已删除的provider-specific smoke、`packages/provider-codex/**`、
  `codex-app-server-bridge*`或companion qualification不能代证。
- **首个RED：** wrapper/upstream drift、initialize缺能力、resume/cancel错误相关、App Server direct effect、复用
  OpenCode qualification、零真实Binding/Delivery。
- **退出条件：** Codex ACP以独立resolution/process/Binding完成它声明的managed/role matrix；与OpenCode分别记账。

### Ledger Phase 5 — ACP Meta、Profile Setup 与 Renderer

- **contracts/application入口：** `packages/runtime-contracts/src/{templates,read-models}.ts`、
  `packages/runtime-application/src/{built-in-templates,meta-agent,meta-profile,session-id-meta-agent-owner,
  session-id-configuration-task-lifecycle}.ts`。
- **Host入口：** 新`apps/runtime-host/src/acp-meta-provider-composition.ts`及测试；现有
  `meta-profile-composition.ts`只保留portable option/readiness语义，`meta-provider-composition.ts`的direct ports到
  Phase 7删除。Task/Meta不得共用Profile resolution、process、connection、raw-ID map或qualification。
- **Renderer入口：** `packages/workbench-ui/src/agent-loop/{AgentLoopChatUI,AgentLoopTemplateStudio,AgentLoopTaskSetupSurface,
  AgentLoopSessionIdTaskSurface,AgentLoopSessionPresentation,AgentLoopMetaPanel}.tsx`及controllers/tests。UI选择`profileRevisionId`并只显示Host
  observation，不编辑path/version/hash或按Provider品牌决定能力。
- **首个RED：** config available但live probe unavailable、Meta获得未注册tool/cwd/Workspace/Task transcript、
  小改动仍可整段替换Prompt、Template MCP在Turn外仍可调用、Task
  qualification复用、whole-final不唯一、cold reconcile重发、Renderer从品牌/版本猜availability。
- **退出条件：** Template v3/Profile options、Meta opener/open/send/apply及Task Setup/Session Header均使用同一Host
  typed readiness；Template Draft CRUD仅创建Pending Proposal且Turn后撤销；独立native ACP Meta通过no-authority、
  scoped Template Draft tool、whole-final与recovery。

### Ledger Phase 6 — Persistence migration 与 direct Binding drain

- **Store入口：** `packages/runtime-store/src/{sqlite,session-id-repositories,repositories}.ts`及相邻测试；
  `packages/runtime-contracts/src/{records,templates}.ts`；`packages/runtime-application/src/
  persistent-session-id-orchestration-application.ts`。
- **Host私有恢复入口：** 新`apps/runtime-host/src/acp-private-binding-map.ts`及相邻测试，以Runtime data目录下
  regular/non-symlink/0600、原子替换的Host-only文件保存`bindingHandle -> raw ACP sessionId`恢复映射。该文件不是领域
  Store、Template、ProviderFact或release evidence；只允许exact Profile resolution/Binding/process generation fence读取，
  release/retire后删除，损坏、权限漂移、重复raw ID或cross-Profile checkout均fail closed。
- **Host epoch authority：** `apps/runtime-host/src/acp-host-epoch-lease.ts`只接受active opaque lease；同进程controlled
  harness可由launcher保留issuer并只下放factory，正式Desktop子进程则由`apps/desktop/runtime-host-supervisor.cjs`
  保留signer/confirmed-exit authority并传入scope-bound签名证明。Runtime Host不得获得issuer或自行声称前代死亡；
  TERM/KILL后exit未确认、stale lease并非该supervisor刚确认的dead epoch、proof/root/new epoch漂移都必须在启动新Host
  或Provider effect前阻断。
- **Host-private composition owner：** `apps/runtime-host/src/acp-runtime-host-private-authority.ts`从上述已签名launch
  environment取得唯一epoch lease，并只向Task/Meta分别下放namespace-separated durable vault resolver；它不序列化
  Runtime root、epoch或raw ID，close failure必须sticky。Phase 7 production入口只消费该owner，不可自行重建lease/map。
- **迁移目标：** 新写入只接受Template v3 Profile revision、SR runtime/attempt、Workspace opaque
  `bindingHandle`与safe interaction；raw ACP map永不进入SQLite。v2 Profile、旧`nativeBindingRef`和direct Binding仅
  只读投影，不能被ACP writer更新或自动翻译。
- **首个RED：** fresh schema仍接受raw native ref/path；Host重启后无法以opaque handle恢复或把raw map写进SQLite/
  evidence；private map权限、symlink、重复identity或Profile fence漂移未拒绝；migration改写已发布Version bytes；
  unknown/private table被删除；active/ambiguous direct Binding未drain仍允许cutover。
- **退出条件：** fresh及upgrade store tests全绿，旧历史可读且新写路径拒绝旧字段；跨进程supervisor→Host测试证明
  fresh epoch、confirmed-dead recovery、篡改/重放与unconfirmed-exit拒绝；inventory证明active direct Binding为零，
  否则Phase 7 blocked。

### Ledger Phase 7 — Atomic production cutover 与direct物理删除

- **唯一切换入口：** `apps/runtime-host/src/index.ts`与`production-session-id-entry.test.ts`改为只加载ACP Profile
  registry/resolver、`acp-provider-composition`和独立ACP Meta composition；`package.json`的`test:integration`改为
  `provider-acp`与ACP integration lanes。
- **删除集合：** existing `apps/runtime-host/src/provider-composition.{ts,test.ts}`与
  `meta-provider-composition.{ts,test.ts}`中的direct parser/ports，`codex-app-server-bridge*`、
  `codex-meta-app-server-bridge*`、`claude-code-stream-bridge*`、Provider-specific scoped
  qualification/private-server files，以及`packages/provider-{opencode,codex,claude-code}/**`。可复用的process/MCP/
  cleanup逻辑必须先迁入Provider-neutral ACP owner并证明无direct import；原文件随后物理删除，不保留re-export。
- **static gate：** `scripts/verify-session-id-cutover.{mjs,test.mjs}`和production-entry tests禁止direct package、wire、
  config kind、selector、fallback及candidate/test-only production route再次可达；同时要求production import graph实际可达
  `packages/provider-acp/src/index.ts`、`acp-provider-composition.ts`、`acp-meta-provider-composition.ts`与
  `acp-task-session-runtime-provider.ts`、`acp-runtime-host-private-authority.ts`，仅仅把这些文件留在仓库中不算cutover。
- **首个RED：** default Host仍能解析direct config、ACP unavailable时落回native wire、formal launcher与Browser/
  Desktop启动不同composition、删除后存在hidden import。
- **退出条件：** typecheck、full Vitest、Desktop、integration、e2e、formal launcher、cutover gate和一次production
  build全绿；缺ACP capability只产生typed unavailable/exit2。

### Ledger Phase 8 — ACP actual-operation 与 release

- **release入口：** `tests/journeys/{run-release,release-preparation,release-verifier,release-cell-runner,
  release-cell-worker,acp-release-attestation,full-journey.scenario}.ts`、
  `tests/journeys/support/{acp-release-cell-launcher,native-unified-host-service}*`、
  `scripts/{production-release-inputs,production-release-artifact,release-cell-executor}.mjs`。
- **重建而非改名：** 重新定义OpenCode ACP Task、Codex ACP Task、独立ACP Meta issuer/cell/seal；旧direct
  OpenCode/Codex companion/private-server字段、固定25/26 cell计数与PASS不能保留为compatibility alias。
- **首个RED：** current resolution/initialize/qualification缺失仍可签名、raw ACP ID/path进入evidence、跨Profile
  qualification复用、direct import/effect未被拒绝、child cleanup未确认、旧matrix仍能exit0。
- **退出条件：** `npm run verify:release`按Phase 8 order生成唯一fresh bundle；所有required cells PASS才exit0，
  capability缺失exit2，assertion/safety失败exit1。`tests/journeys/README.md`随最终matrix同步并纳入版本控制。

## 5. 当前执行清单

1. **Phase 0完成：** authority与旧release fail-closed guard已冻结；该临时guard现已由ACP-only A/B+exact 28
   production aggregate替代，缺capability仍不能退出0。
2. **Phase 1完成：** fake ACP Client、Profile v3、opaque Binding、SR command/settlement及OR→SR→canonical final合同已通过。
3. **Phase 2完成：** Host resolution/process/qualification/reverse-RPC公共机制已通过injected tests，
   并已由Phase 7的唯一production composition消费。
4. **Phase 3–5实现完成，Claude production slice已接入：** OpenCode/Codex/Claude Code/Meta现消费同一个production
   SR/ACP owner；Claude current-install、隔离settings、exact role MCP tools与permission-mode compiler已有focused合同，
   但Claude actual-operation release cell尚未签PASS。V3 Meta owner与typed UI保持统一；
   controlled/native-mechanical gates已绿，但actual-operation PASS只能由Phase 8 fresh cells签发。
5. **Phase 6完成：** SQLite v21、private vault、supervisor recovery、Meta/Template v3 writer、显式Draft migration、
   direct drain/writer seal与metadata-only upgrade已冻结。
6. **Phase 7完成：** production `index.ts`只达ACP composition，direct packages/bridges/config已物理删除，
   cutover gate零问题；full regression 由Phase 8 parent local gates在fresh build前重跑。
7. **Phase 8进行中：** exact 28 matrix、launcher/worker/attestation、parent A/B、cleanup-before-attestation、
   exact companion correlation与唯一production aggregate已冻结；下一步只准备三lane exact live inputs并执行一个fresh
   bundle，不拼旧PASS、不复用direct evidence。

## 6. Deferred backlog

- user-confirmed Session Handoff与跨Provider context continuity；
- Compatibility Catalog、installer/update/rollback UI与manual-path UX；
- dynamic model/mode/config catalog；
- ACP optional extensions、native child adoption与Presentation；
- Claude ACP positive Task actual-operation/release journey（production接线已完成，仍需fresh live cell签PASS）；
- Workflow/Scheduler与同Session显式并发分支。

Deferred项不得增加第五个Conductor tool、恢复Invocation/relay/publish/Artifact owner、让Handoff阻塞ACP cutover，或把
未验证能力silent fallback到另一Provider/direct transport。

## 7. 计划维护规则

- Architecture只写冻结产品/Runtime真相；本文件记录Phase、可执行输入/输出、真实验证与剩余动作。
- 只有实际测试/live evidence可以更新PASS；代码存在、initialize声明、controlled journey或旧evidence都不能提升状态。
- 每个实现任务记录goal、owner、files/behavior、command/revision/idempotency、external effect、reconcile、fail-first test、
  exact verification与residual risk。
- Provider version/hash/capability observation只能属于`LocalResolutionSeal`/evidence和drift fence，不能成为allowlist。
- 不自动commit/PR；提交前检查unrelated edits、secret、generated noise、direct production引用和用户数据误删。
