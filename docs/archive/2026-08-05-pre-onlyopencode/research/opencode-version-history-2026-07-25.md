# 结构化搜索报告：opencode 版本历史、重大功能发布与技术演进

**Dispatch ID:** C1D0BD
**Date:** 2026-07-25
**Research Perspective:** Version history, major feature releases, technical evolution, key product changes over time

---

## 1. 研究视角 (Research Perspective)

从以下维度追踪 opencode 的演进：
- **版本历史**：完整发布序列、发布节奏、语义版本模式
- **重大功能发布**：里程碑式产品能力（Desktop UI、SDK、MCP、Session Snapshots 等）
- **技术演进**：架构变化（v1/v2 Desktop Layout）、提供商集成（OpenAI、Anthropic、GitHub Copilot 等）、协议支持（MCP、OAuth、SSE）
- **项目健康度**：stars、contributors、月活开发者、社区贡献趋势

---

## 2. 信息来源 (Information Sources)

| Source | URL | Coverage |
|--------|-----|----------|
| opencode.ai 官网 | https://opencode.ai | 项目概览、产品定位 |
| opencode.ai 变更日志 | https://opencode.ai/changelog | v1.17.11 (Jun 25)–v1.18.5 (Jul 24) 详细发布说明 |
| opencode.ai 文档 | https://opencode.ai/docs | 功能文档、配置说明 |
| opencode.ai 数据 | https://opencode.ai/data | 模型使用量、市场占有率、成本数据 |
| GitHub Releases | https://github.com/anomalyco/opencode/releases | 全部 85 页发布记录，~320+ 版本标签 |
| GitHub 仓库 | https://github.com/anomalyco/opencode | 项目元数据、star 数、fork 数 |
| 工作区已有研究 | `docs/research/`, `docs/superworks/` | 补充上下文和交叉验证 |

**未搜索的第三方来源：** X/Twitter、Discord、第三方博客、科技媒体。

---

## 3. 关键发现 (Key Findings)

### 3.1 项目全景

- **项目名称**：OpenCode（由 Anysphere/Anomaly 开发）
- **仓库地址**：`github.com/anomalyco/opencode`
- **GitHub Stars**：~189,600（仓库 UI）/ ~160,000（官网）
- **Forks**：~24,000
- **Contributors**：~900+
- **月活开发者**：~7.5M
- **总提交数**：~15,162（dev 分支）
- **许可证**：MIT
- **npm 包名**：`opencode-ai`
- **官网**：https://opencode.ai

### 3.2 版本发布统计

| 版本范围 | 发布数量 | 说明 |
|----------|---------|------|
| vscode-v0.0.1–v0.0.13 | 13 | 早期 VS Code 扩展 |
| v1.0.32–v1.0.224 | ~193 | 首次大规模发布系列 |
| v1.1.1–v1.1.65 | ~65 | 1.1 系列 |
| v1.2.0–v1.2.27 | 28 | 1.2 系列 |
| v1.3.0–v1.3.17 | 18 | 1.3 系列 |
| v1.4.0–v1.4.14 | ~14 | 1.4 系列 |
| v1.14.17–v1.14.51 | ~35 | 早期稳定系列 |
| v1.15.0–v1.15.13 | ~13 | 1.15 系列 |
| v1.16.0–v1.16.2 | ~3 | 1.16 系列 |
| v1.17.0–v1.17.20 | ~20+ | 1.17 系列（当前活跃 minor） |
| v1.18.0–v1.18.5 | 6 | 最新系列（Jul 2026） |
| **总计** | **~320+** | 完整标签序列 |

### 3.3 近期发布节奏（v1.17.11–v1.18.5）

| 版本 | 日期 | 间隔 | 关键功能 |
|------|------|------|---------|
| v1.18.5 | Jul 24 | 2d | Claude 自适应思考优化；当前 Server 终端传输；Desktop 当前服务器支持 |
| v1.18.4 | Jul 20 | 4d | Kimi 自适应思考；v2 提示输入重写；审查面板改进 |
| v1.18.3 | Jul 16 | 1d | Up Arrow 子代理选择器快捷键；WSL 启动修复；命令面板会话搜索 |
| v1.18.2 | Jul 15 | 1d | `subagent_depth` 限制；Meta 推理深度改进；Mod+N 新建标签 |
| v1.18.1 | Jul 14 | 1h | 设置页间距修复 |
| v1.18.0 | Jul 14 | — | **Desktop v2 迁移完成**；新旧布局切换；Home 冷加载优化 |
| v1.17.20 | Jul 13 | 0d | 移除过时的 Codex 兼容；Azure AI GPT-5.6 支持 |
| v1.17.19 | Jul 13 | 4d | OpenAI pro 推理模式；Luna Responses Lite OAuth；Codex 上下文限制 |
| v1.17.18 | Jul 9 | 0d | Copilot 零批处理崩溃修复；Meta Muse Spark 系统提示 |
| v1.17.17 | Jul 9 | 0d | Meta 推理处理；v2 免费模型选择器 |
| v1.17.16 | Jul 9 | 2d | Grok 推理努力变体；xAI 提示缓存；内联文件浏览器标签 |
| v1.17.15 | Jul 7 | 1d | Z.ai 上下文窗口溢出分类；v2 命令面板刷新；macOS Sequoia 修复 |
| v1.17.14 | Jul 6 | 5d | **Code Mode MCP 适配器**；v2 审查面板大修 |
| v1.17.13 | Jul 1 | 1d | 可搜索 v2 模型选择器；WSL 设置优化 |
| v1.17.12 | Jun 30 | 5d | Claude Sonnet 5 自适应思考；MCP OAuth 重连；SDK 实时事件订阅 |
| v1.17.11 | Jun 25 | — | **Session Snapshots & Revert**；可拖拽标签；Chrome 风格标签切换 |

**节奏：** 约每 2 天一个版本，高峰期（Jul 9）一天发布 3 个版本。

### 3.4 重大功能里程碑（按时间线）

#### 2026 年 6 月
- **Session Snapshots & Revert (v1.17.11)**：允许将会话回滚到早期消息，包括文件更改
- **Claude Sonnet 5 Adaptive Thinking (v1.17.12)**：自适应思考集成
- **SDK Live Event Subscription (v1.17.12)**：实时事件流、会话访问、分页持久历史
- **Yolo Mode (v1.17.12)**：TUI 自动批准权限
- **Code Mode MCP Adapter (v1.17.14)**：受限编排脚本的 MCP 适配器
- **Searchable v2 Model Picker (v1.17.13)**：Composer 内模型选择和管理

#### 2026 年 7 月
- **Desktop v2 布局迁移完成 (v1.18.0)**：新布局、首次启动引导、新旧切换设置
- **subagent_depth 配置 (v1.18.2)**：默认阻止子代理嵌套
- **Home Command Palette 会话搜索 (v1.18.3)**：直接搜索和打开历史会话
- **Kimi Adaptive Thinking (v1.18.4)**：Anthropic 兼容提供商上的 Kimi 自适应思考
- **当前服务器支持 (v1.18.5)**：终端传输、审查数据、会话操作、事件流
- **MCP OAuth Reconnection (v1.17.12)**：OAuth 后自动重连 MCP 服务器
- **Draggable Tabs (v1.17.11)**：Desktop 标签可拖拽

### 3.5 技术演进主线

#### 模型提供商生态
- **初期**：OpenAI、Anthropic（Claude）
- **扩展**：GitHub Copilot、Azure AI、xAI/Grok、Meta、Mistral、DeepSeek、Z.ai、Cerebras、OpenRouter、Kimi、MiniMax
- **自由模型**：通过 opencode.dev Zen 提供免费模型；v1.17.17 加入 v2 免费模型选择器
- **推理模型**：OpenAI pro reasoning (v1.17.19)、Claude Sonnet 5 adaptive thinking (v1.17.12)、Meta reasoning depth (v1.18.2)、Grok reasoning effort (v1.17.16)

#### 交互界面演进
- **TUI（终端）**：初始界面、yolo mode、ServerAuth headers、spinner 注册修复
- **Desktop v1**：基础 desktop 应用
- **Desktop v2（当前）**：
  - 新布局、标签化界面（可拖拽、预览、快捷键）
  - 重写审查面板（v2 review panel）
  - 重写提示输入组件（v2 prompt input）
  - 模型选择器 UI（v2 model picker）
  - 命令面板升级（v2 command palette）
  - 集成终端主题同步
  - WSL 服务器发现和设置 UI

#### 协议与集成
- **MCP**（Model Context Protocol）：完整 MCP 工具支持、OAuth 认证、分页工具目录、远程技能缓存、skill 资源路径持久化
- **SDK**：实时事件订阅、会话运行时操作（中断、事件流、消息查找）、分页历史、权限请求 API
- **Server Protocol**：legacy vs current 服务器双协议支持（v1.18.5）
- **ACP**：Anthropic Context Protocol 支持
- **LSP**：自动加载 LSP

#### 底层架构关键词
- Plugin 系统
- 代理系统（build/plan agent + general subagent）
- 技能系统（Agent Skills）
- 权限系统（permissions + policies）
- 自定义工具（Custom Tools）
- 外部 TUI 连接（external served TUI）
- Nix/Flake 支持
- Docker 部署

### 3.6 社区与数据指标

- **Daily Active Users (Go)**：80K–168K（基于 opencode.ai/data 2026 年 6–7 月数据）
- **日 Token 消耗**：~1.4T–3.4T（同上区间）
- **Top Model**：DeepSeek V4 Flash（79.8% 市场份额，11T tokens）
- **缓存命中率**：平均 96%（最高 deepseek-v4-pro 97%）
- **前 3 模型提供商**：DeepSeek (79.8%) > Moonshot (4.9%) > Xiaomi (4.7%)
- **顶级用户国家**：中国 (18%) > 美国 (12%) > 巴西 (5%)
- **热门社区贡献者**：arvsrn、usrnk1、StarpTech、remixz、chouqin、jerome-benoit、ProdigyRahul、BB-84C、dleopold

---

## 4. 原始信息片段 (Raw Information Fragments)

### 4.1 来自 landing page 的关键指标
> "With over 160,000 GitHub stars, 900 contributors, and over 13,000 commits, OpenCode is used and trusted by over 7.5M developers every month."
> "OpenCode is an open source AI coding agent. It's available as a terminal-based interface, desktop app, or IDE extension."
> "Free models included or connect any model from any provider, including Claude, GPT, Gemini and more."

### 4.2 来自 changelog 的发布序列（完整，v1.17.11–v1.18.5）
- v1.18.5 (Jul 24): Claude adaptive thinking fix; Mistral reasoning/caching; MiniMax M3 fix; current server terminal transport
- v1.18.4 (Jul 20): Kimi adaptive thinking on Anthropic-compatible; Azure Cognitive Services endpoint restore; v2 prompt input rewrite
- v1.18.3 (Jul 16): Up Arrow subagent picker shortcut; WSL startup fix; command palette session search
- v1.18.2 (Jul 15): `subagent_depth` config; Meta reasoning depth; Mod+N tab shortcut
- v1.18.1 (Jul 14): Settings spacing fix
- v1.18.0 (Jul 14): Desktop v2 migration completed; layout toggle; cold-load perf
- v1.17.20 (Jul 13): Codex workaround removal; Azure AI GPT-5.6
- v1.17.19 (Jul 13): OpenAI pro reasoning; xAI Responses store=false default; Luna Responses Lite OAuth
- v1.17.18 (Jul 9): Copilot zero batch crash fix; Meta Muse Spark system prompt
- v1.17.17 (Jul 9): Meta reasoning; v2 free-model selector; revert dock restyled
- v1.17.16 (Jul 9): Grok reasoning effort; xAI prompt cache/PDF; inline file tabs; composer add menu
- v1.17.15 (Jul 7): Z.ai overflow classification; v2 command palette refresh; macOS Sequoia fix
- v1.17.14 (Jul 6): Code mode MCP adapter; v2 review panel overhaul; tab reopen; recently closed projects
- v1.17.13 (Jul 1): v2 model picker; WSL setup; tab hover preview
- v1.17.12 (Jun 30): Claude Sonnet 5 adaptive thinking; MCP OAuth reconnect; SDK live events; yolo mode
- v1.17.11 (Jun 25): Session snapshots & revert; draggable tabs; Chrome-style tab cycles

### 4.3 来自 GitHub repo 的项目元数据
> "The open source AI coding agent."
> 189,600 stars, 24,000 forks
> Main branch: dev
> 15,162 commits
> Built-in agents: build (full-access), plan (read-only), general (subagent)
> License: MIT
> Install via: curl, npm, brew, scoop, choco, pacman, nix, docker, mise

### 4.4 来自 GitHub releases 的早期版本结构
- Pre-v1.0: vscode-v0.0.1–v0.0.13（VS Code extension era）
- v1.0.x: v1.0.32–v1.0.224（193 releases）
- v1.1.x–v1.4.x: 持续迭代
- v1.14.x–v1.16.x: 稳定期
- v1.17.x–v1.18.x: 当前活跃开发线

### 4.5 来自 data page 的使用统计
> DeepSeek V4 Flash 占 79.8% token 市场份额
> 每日活跃用户 80K–168K
> 日均 token 消耗 1.4T–3.4T
> 缓存命中率平均 96%
> 平均会话成本 $0.0852（deepseek-v4-flash）

---

## 5. 研究限制与后续跟进 (Limitations & Follow-up)

### 已知限制
- 未搜索第三方来源（X/Twitter、Discord、社区博客、科技媒体）
- 早期版本（v1.14 之前）没有详细的 changelog 条目，仅有标签
- 无法访问内部路线图或未公开的功能规划
- 产品名称可能与其他类似工具混淆（opencode.ai 目前是该产品唯一官方域名）

### 建议后续
1. 爬取 GitHub release notes 第 3–85 页获取早期版本的详细功能描述
2. 搜索 opencode.ai 上的博客文章（`/blog` 返回 404）或 YouTube 频道
3. 监控 Discord/社区论坛获取未记录的实验性功能
4. 对比 Claude Code、Codex 等竞品的发布时间线与功能集
