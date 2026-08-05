# OpenCode vs GitHub Codex 整体差距结构化搜索报告

> **Dispatch ID**: F9DB29
> **生成日期**: 2026-07-26
> **搜索目标**: OpenCode (https://opencode.ai) 与 GitHub Codex (GitHub Copilot / OpenAI Codex) 的整体差距

---

## 搜索视角 1：产品定位和核心能力对比

### 信息来源

- https://opencode.ai — OpenCode 首页
- https://opencode.ai/docs — OpenCode 文档
- https://github.com/features/copilot — GitHub Copilot 功能主页
- https://github.com/features/copilot/agents — GitHub Copilot Agents 页面
- https://github.com/features/copilot/ai-code-editor — Copilot in VS Code
- https://github.com/features/ai/github-app — GitHub Copilot 桌面 App

### 关键发现

#### 产品定位对比

| 维度 | OpenCode | GitHub Copilot (含 Codex) |
|------|----------|---------------------------|
| **定位** | "The open source AI coding agent" — 开源的 AI 编码代理 | "Command your craft" / "Your AI pair programmer" — 端到端 AI 开发者平台 |
| **哲学** | 开源、模型自由、隐私优先、终端优先 | 闭源 SaaS、GitHub 生态深度集成、企业级 |
| **目标用户** | 开发者个体、开源社区、隐私敏感组织、CLI 重度用户 | 全谱开发者 — 从个人到大型企业 |
| **核心卖点** | 无厂商锁定、75+ 模型提供商、零数据存储、完全可定制 | IDE 原生补全、GitHub 工作流集成、IP 赔偿、企业治理 |
| **商业模式** | 开源免费 + Zen (PAYG) + Go ($10/m) + Enterprise (按席位) | Free ($0) → Pro ($10/m) → Pro+ ($39/m) → Max ($100/m) → Business ($19/m) → Enterprise ($39/m) |

#### 核心能力对比

| 能力 | OpenCode | GitHub Copilot / Codex |
|------|----------|------------------------|
| **代码补全** | 无内联补全，通过对话驱动 | 业界领先的内联代码补全 + Next Edit Suggestions |
| **Agent 模式** | 内置 Build/Plan 双 agent，可自定义 agent | Copilot Agent Mode (IDE 内) + Cloud Agent (GitHub 后台) |
| **第三方 Agent** | 通过 subagent 系统支持自定义第三方 agent | 原生支持 Claude by Anthropic 和 OpenAI Codex 作为第三方 agent |
| **多模型支持** | 75+ 提供商，本地模型，Zen 精选验证模型 | 有限模型选择（GPT、Claude、Gemini 等），Auto 模型选择 |
| **多会话** | 原生并行多 agent 会话 | 支持多会话，IDE 内 + 桌面 App |
| **MCP 支持** | 完整 MCP 服务器管理 | MCP Registry + IDE 内集成，企业 MCP allowlist |
| **LSP 集成** | 自动加载 LSP 供 LLM 理解代码 | 无显式 LSP，依赖编辑器上下文 |
| **AGENTS.md** | 原生支持，开源规范 | VS Code AGENTS.md 支持，可被 Copilot/Codex/Claude 读取 |
| **非交互模式** | `opencode run` 脚本化调用 | Copilot CLI (`gh copilot`) |
| **桌面 App** | 桌面 App (Beta) — macOS/Windows/Linux | GitHub Copilot App — 从 Issue 到 Merge 的完整桌面体验 |
| **IDE 扩展** | VS Code 扩展 | VS Code、VS、JetBrains、Xcode、Neovim、Eclipse、Zed 等 |
| **代码审查** | 无原生 Code Review | AI Code Review 集成于 PR 流程 |
| **共享能力** | `/share` 生成可分享会话链接 | Copilot Chat 协作有限 |

#### Codex 在 GitHub Copilot 中的定位

根据 GitHub 官方页面，OpenAI Codex 是 Copilot Pro/Pro+/Max/Business/Enterprise 用户可选的**第三方 Agent** 之一，与 Claude by Anthropic 并列：
> "Copilot Pro+ and Copilot Enterprise users get access to Claude by Anthropic and OpenAI Codex in VS Code and GitHub."
> "Pick from Copilot, third-party agents like Claude and Codex, or custom agents to get the work done right."

### 原始片段

**OpenCode 首页**:
> "OpenCode is an open source agent that helps you write code in your terminal, IDE, or desktop."
> "LSP enabled — Automatically loads the right LSPs for the LLM"
> "Multi-session — Start multiple agents in parallel on the same project"
> "Any model — 75+ LLM providers through Models.dev, including local models"
> "Built for privacy first — OpenCode does not store any of your code or context data"

**GitHub Copilot 首页**:
> "Your AI accelerator for every workflow, from the editor to the enterprise."
> "Choose from leading LLMs optimized for speed, accuracy, or cost."
> "Use GitHub Copilot, your own custom agents, or the third-party agents you already rely on."
> "Copilot works where you do—in GitHub, your IDE, the CLI, project tools, chat apps, and custom MCP servers."

**GitHub Copilot Agents 页面**:
> "AI agents that do more than write code. Assign work, choose the right model, and steer agents from anywhere."
> "Copilot and third-party agents like Claude by Anthropic and OpenAI Codex handle the execution while you stay focused on what to build next."
> "Kick off a task and move on. Copilot works asynchronously — so by the time you check back in, there's a plan to review, code to look at, or a PR ready to merge."

**Pricing page about Codex**:
> "Access to 3rd party agents (Claude Code and Codex)" — Pro plan ($10/m)
> "More agents, no extra accounts. Access a growing roster of agents with your Copilot subscription."

---

## 搜索视角 2：OpenCode 的当前功能和路线图

### 信息来源

- https://opencode.ai/docs — 全部文档目录
- https://opencode.ai/docs/agents — Agent 系统
- https://opencode.ai/docs/go — Go 订阅
- https://github.com/anomalyco/opencode — GitHub 仓库
- https://opencode.ai/enterprise — Enterprise 页

### 关键发现

#### 当前功能全景

OpenCode 的产品体系分为 5 层：

| 层级 | 产品 | 定价 | 核心能力 |
|------|------|------|----------|
| **开源核心** | OpenCode CLI/TUI | $0 | 所有基础功能、75+ 提供商连接、Agent 系统、MCP、LSP、多会话 |
| **付费模型** | Zen | PAYG ($20 起充) | 精选 benchmarked 模型、零加价仅手续费、自动续充 |
| **订阅模型** | Go | $5 首月 / $10 月 | 开源模型可靠访问（DeepSeek V4、Qwen3.7、GLM-5.2 等 16 个模型） |
| **桌面 App** | Desktop (Beta) | 免费 | 独立桌面应用，macOS/Windows/Linux |
| **企业版** | Enterprise | 按席位 | SSO、中央配置、内部 AI 网关、自托管支持 |

#### Agent 系统架构

OpenCode 拥有成熟的 Agent 系统，支持两种 agent 类型：

- **Primary agents**: Build（默认，所有工具可用）、Plan（只读，分析用）— 通过 Tab 切换
- **Subagents**: General（通用）、Explore（只读搜索）、Scout（外部文档研究）— 通过 @ 调用
- 隐藏 system agents: Compaction（上下文压缩）、Title（标题生成）、Summary（会话摘要）
- 支持用户通过 JSON config 或 Markdown 文件自定义 agent

每个 agent 可配置：温度、最大步骤、模型、系统提示词、权限（ask/allow/deny）、颜色、工具集。

#### 企业功能

- 中央配置分发（通过版本控制或内部网络）
- SSO 集成
- 内部 AI 网关（可禁用外部提供商）
- Policies 策略管理
- 审计日志（Pro+ 级）
- 自托管部署
- 零数据存储策略

#### 关键差距与路线图信号

根据 Enterprise 页面和文档推断的路线图方向：
- 自托管分享页面 — "路线图中，可根据需要协助自托管分享页面"
- 桌面 App — Beta 阶段，持续完善
- Go 订阅 — 新推出，模型列表持续更新
- Zen 模型精选 — 持续扩展

#### 版本与社区数据

| 指标 | 数据 |
|------|------|
| GitHub Stars | ~190K |
| Forks | ~24K |
| Contributors | 900+ |
| Commits | 15,162 |
| 月活开发者 | 7.5M |
| 许可证 | MIT |
| 语言 | TypeScript (Node.js) |
| 最近更新 | Jul 24, 2026（文档） |

### 原始片段

**Agent 系统配置示例**:
```json
{
  "agent": {
    "plan": {
      "mode": "primary",
      "model": "anthropic/claude-haiku-4-20250514",
      "permission": {
        "edit": "deny",
        "bash": "deny"
      }
    }
  }
}
```

**Go 订阅说明**:
> "OpenCode Go is a low cost subscription — $5 for your first month, then $10/month — that gives you reliable access to popular open coding models."
> "We created OpenCode Go to: 1. Make AI coding accessible to more people with a low cost subscription. 2. Provide reliable access to the best open coding models. 3. Curate models that are tested and benchmarked for coding agent use. 4. Have no lock-in by allowing you to use any other provider with OpenCode as well."

**Enterprise 页**:
> "OpenCode does not store your code or context data. All processing happens locally or through direct API calls to your AI provider."
> "You own all code produced by OpenCode. There are no licensing restrictions or ownership claims."
> "Through the central config, OpenCode can integrate with your organization's SSO provider for authentication."
> "OpenCode can also be configured to use only your internal AI gateway."

---

## 搜索视角 3：社区反馈与采用情况

### 信息来源

- https://github.com/anomalyco/opencode — GitHub 仓库（Issues 3.7K, PRs 1.1K）
- https://opencode.ai — 首页社区数据
- https://github.com/features/copilot — Copilot 采用数据
- https://opencode.ai/docs/ecosystem — 生态系统文档

### 关键发现

#### 采用规模对比

| 指标 | OpenCode | GitHub Copilot |
|------|----------|----------------|
| **GitHub Stars** | ~190K | N/A (闭源) |
| **社区贡献者** | 900+ | N/A (闭源) |
| **总提交** | 15,162 | N/A |
| **月活开发者** | 7.5M | "数百万个个人用户和数万企业客户" |
| **Issues** | 3.7K | 不公开 |
| **Pull Requests** | 1.1K | 不公开 |
| **Forks** | 24K | N/A |
| **整体地位** | 最受欢迎的开源 AI 编码代理 | 世界最广泛采用的 AI 开发者工具 |

#### 社区活跃度分析

OpenCode 社区非常活跃：
- 高频提交：15K+ commits，dev 分支持续开发
- 高参与度：3.7K Issues 和 1.1K PRs 表明用户积极参与
- 翻译支持：21 种语言的 README 翻译
- Discord 社区：官方 Discord 频道（opencode.ai/discord）
- 多平台安装支持：npm/bun/pip/brew/choco/scoop/pacman/nix/docker

#### 生态系统的增长

OpenCode 正在构建开发生态系统：
- **SDK**：用于构建基于 OpenCode 的工具
- **Server**：服务端部署支持
- **Plugins**：插件系统（`opencode plugin <module>`）
- **Ecosystem**：第三方工具和集成目录
- **Agent Skills**：可复用的 agent 技能包
- **AGENTS.md 规范**：逐渐成为跨工具标准

vs GitHub Copilot 的生态系统优势：
- GitHub Marketplace 成熟
- MCP Registry 官方支持
- 第三方 Agent 集成（Claude、Codex）
- Copilot Spaces 知识管理
- 企业级集成（Azure、Jira、Slack、Teams、Linear）

#### 用户认知差异

根据定价和市场定位推断：
- OpenCode 用户画像：CLI 重度开发者、开源爱好者、隐私关注者、成本敏感用户、自托管需求用户
- GitHub Copilot 用户画像：全栈到企业开发者、IDE 优先用户、GitHub 生态深度用户、企业合规需求用户

#### 社区反馈主要关注点（基于 Issues 分析推测）

OpenCode：
- 功能请求新模型/提供商支持
- 桌面 App 体验完善
- 企业功能改进
- 文档本地化

GitHub Copilot：
- 定价和用量限制
- 数据隐私（Free/Pro 数据用于训练）
- 模型质量一致性
- 第三方 Agent 集成体验

### 原始片段

**OpenCode 首页**:
> "With over 160,000 GitHub stars, 900 contributors, and over 13,000 commits, OpenCode is used and trusted by over 7.5M developers every month."

**GitHub Copilot 采用数据**:
> "GitHub Copilot is the world's most widely adopted AI developer tool and the competitive advantage developers ask for by name."
> "Developers who use GitHub Copilot report up to 75% higher satisfaction with their jobs than those who don't and are up to 55% more productive at writing code without sacrifice to quality."
> "Growing to millions of individual users and tens of thousands of business customers."

**OpenCode AGENTS.md 规范传播**:
> "AGENTS.md enables you to share project-specific instructions and keep all agents in sync with your team's coding practices." — 该规范已被 VS Code Copilot 和 Claude Code 等工具采纳

**OpenCode 生态系统**:
> "SDK, Server, Plugins, Ecosystem" — 四点开发生态支柱

---

## 综合差距总结

### OpenCode 核心优势

1. **开源 + MIT 许可** — 完全透明，可自托管，可二次开发
2. **模型自由** — 75+ 提供商，本地模型，无厂商锁定
3. **隐私优先** — 零数据存储，所有处理在本地
4. **Agent 系统灵活性** — 自定义 agent、subagent 协作、精细权限控制
5. **AGENTS.md 规范** — 已发展为跨工具标准
6. **低成本** — 免费可用，Go 订阅 $10/m 比 Copilot Pro ($10/m) 但模型选择更广
7. **终端 TUI 成熟** — CLI 重度用户首选

### GitHub Copilot / Codex 核心优势

1. **IDE 原生补全** — 内联代码补全和 Next Edit Suggestion 业界领先
2. **GitHub 生态深度集成** — Issues、Actions、Code Review、PR、桌面 App
3. **企业成熟度** — IP 赔偿、审计日志、GDPR DPA、SLA、企业支持
4. **品牌信任** — Microsoft/GitHub 背书，企业采购流程成熟
5. **第三方 Agent 即用** — Codex、Claude 预集成，无需配置
6. **异步 Agent 工作流** — 后台运行，从 Issue 到 PR 的端到端管理
7. **Copilot Spaces** — 团队知识管理和共享

### OpenCode 需要追赶的方向

1. **内联代码补全** — 目前缺失，Copilot 的核心体验差距最大
2. **企业合规认证** — SOC2、ISO27001 等
3. **GitHub 工作流集成** — Code Review、Actions、Issues 深度集成
4. **异步后台 Agent** — Copilot 支持在 GitHub 后台运行 agent 并提交 PR
5. **品牌认知** — 企业客户中的知名度和信任度
6. **IDE 覆盖度** — Xcode、JetBrains 等 IDE 的本地集成深度
7. **MCP Registry** — 类似 GitHub MCP Registry 的生态目录

---

*报告结束 — Dispatch ID: F9DB29*
