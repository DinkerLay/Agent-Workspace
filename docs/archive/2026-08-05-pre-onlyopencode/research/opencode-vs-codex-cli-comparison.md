# opencode vs Codex CLI (codex) — 结构化对比报告

> 搜索日期: 2026-07-26 | 任务 ID: E5020D
> 范围: opencode (anomalyco/opencode) vs OpenAI Codex CLI (openai/codex) vs Claude Code (anthropics/claude-code)

---

## 1. 项目元数据速览

| 维度 | opencode | Codex CLI | Claude Code |
|------|----------|-----------|-------------|
| **开发商** | Anomaly (社区驱动) | OpenAI | Anthropic |
| **GitHub Stars** | ~190K | ~101K | ~139K |
| **许可证** | MIT | Apache 2.0 | 专有 (闭源) |
| **实现语言** | TypeScript (Bun) | Rust + TypeScript | TypeScript (Node) |
| **提交次数** | 15,000+ | 8,600+ | 713 |
| **开放贡献** | 是 (900+ 贡献者) | 是 | 仅插件 |
| **核心模型** | 任意模型 (75+ 供应商) | OpenAI 模型 (GPT/o 系列) | Claude 模型 |
| **安装方式** | curl/npm/brew/pacman | curl/npm/brew | curl/brew/winget |

数据来源:
- https://github.com/anomalyco/opencode
- https://github.com/openai/codex
- https://github.com/anthropics/claude-code

---

## 2. 功能差距分析

### 2.1 opencode 有、其他工具没有的功能

| 功能 | 描述 |
|------|------|
| **多模型支持** | 75+ LLM 供应商，包括本地模型 (通过 Models.dev) |
| **LSP 集成** | 自动加载正确 LSP 供 LLM 使用 |
| **桌面应用** | 原生桌面应用 (macOS/Windows/Linux Beta) |
| **多会话并行** | 可同时启动多个 agent 工作在同一项目 |
| **会话分享链接** | 分享任何会话的链接供他人参考 |
| **Plan/Build 双模式** | 内置只读分析 agent (plan) 和全权限开发 agent (build) |
| **GitHub Copilot** | 使用 Copilot 订阅 |
| **ChatGPT Plus/Pro** | 使用 OpenAI 订阅 |
| **隐私优先** | 不存储任何代码或上下文数据 |
| **Zed 编辑器支持** | 内置 .zed 配置支持 |
| **AGENTS.md 系统** | 每个项目的 agent 指令文件 |
| **上下文压缩** | 自动会话压缩 (虽被批评实现不佳) |

### 2.2 Codex CLI 有、其他工具没有的功能

| 功能 | 描述 |
|------|------|
| **Rust 核心** | codex-rs 用 Rust 编写，性能更好 (用户反馈 CLI 体验更流畅) |
| **ChatGPT 计划集成** | 直接使用 ChatGPT Plus/Pro/Business/Edu 订阅，$20/月即可 |
| **OpenAI 深度优化** | 针对 GPT/o 系列模型深度调优 |
| **Bazel 构建系统** | 大型 monorepo 友好的构建 |
| **IDE 集成优先** | VS Code / Cursor / Windsurf 原生集成 |
| **轻量 CLI** | 被描述为"轻量级 coding agent" |
| **App 体验** | 桌面 app + web 端 (chatgpt.com/codex) |

### 2.3 Claude Code 有、其他工具没有的功能

| 功能 | 描述 |
|------|------|
| **Claude 深度集成** | Opus / Sonnet 模型最优提示及工具链 |
| **GitHub @claude** | 在 GitHub 上 tag @claude 即可触发 |
| **插件系统** | 官方插件扩展 (plugins 目录) |
| **企业级隐私承诺** | 有限数据保留、数据不用于训练 |
| **Discord 社区** | Claude Developers Discord |

---

## 3. 社区评价与情感分析

### 3.1 Hacker News 讨论

从 HN Algolia API 检索到 40+ 条相关讨论，关键发现:

**支持 opencode 的观点:**
- "Claude Opus 在 OpenCode 上的表现比在 Claude Code 本身上更好" — log101 (2026-06-11)
  - 来源: https://artificialanalysis.ai/agents/coding-agents
- 生态工具将 opencode 和 Codex/Claude Code 视为可互换的后端 (agent-of-empires, devday, opencontext, codey 等项目)
- 开源、多模型、无供应商锁定的优势被反复提及

**支持 Codex CLI 的观点:**
- "Codex CLI definitely much more pleasant to use than Claude Code" — toraway (2026-02-11)
- Codex 在 $20/月的 ChatGPT Plus 计划上提供了比 Claude Pro 更慷慨的使用额度 — toraway (2026-02-17)
- 用户 earth2mars 报告 Opus 写的代码"在 codex, opencode, pi 上都不 work，切换到 Codex 后一切正常" (2026-06-22)

**中立/比较的观点:**
- "Many people will stop that discussion at the claude code vs. codex vs. opencode level" — Hfuffzehn (2026-05-19)，指出 harness 质量才是真正的难点
- "are there any reasons a pragmatic and informed developer would use OpenCode vs Claude/Codex as a harness today? I'm not seeing anything competitive in terms of cost/quality/trust" — jacobgold (2026-07-20)
- tekacs 对比了 opencode 的 Plan vs Build 模式和 Codex 的方法 (2026-03-13)

### 3.2 关键批评

**针对 opencode:**
- 安全漏洞: CVE-2026-22812 — HTTP 服务器默认暴露，任意 RCE
- "clown-car turboslop with a security posture of 'let me bend over for you daddy'" — wren.wtf (2026-07)
- Bash 命令过滤可被轻易绕过 (通过 base64, Python subprocess, heredoc 等)
- 提示缓存未命中设计糟糕 (每次 SSE turn 重新 glob 文件系统、重新读取 AGENTS.md)
- 上下文修剪破坏工作流 (40K 固定阈值，中断即丢失上下文)
- TUI 消耗 ~1GB RAM 渲染文本
- OpenCode Go 被称为"complete scam" — zackify (2026-03-21)
- 文档"内容贫乏、不连贯，显然是为 AI 而非人类写的" — wren.wtf
- 安全报告被 stale bot 自动关闭

**针对 Codex CLI:**
- 仅限 OpenAI 模型，供应商锁定
- 5K+ 开放 issues (部分可能为用户请求/功能建议)
- 与 opencode 相比功能更少 (无 LSP 集成、无多会话并行等)

**针对 Claude Code:**
- 闭源、仅限 Claude 模型
- 5K+ 开放 issues
- 被批评在非 Claude 场景下无用
- 上下文窗口管理不如 opencode 灵活

### 3.3 基准测试

来自 Artificial Analysis 的 Coding Agent Index (截至 2026-07):

- 当使用 **相同的底层模型** (Claude Opus 4.7) 时，opencode、Claude Code 和 Cursor CLI 之间的 harness 性能存在显著差异
- opencode 在与 Claude Opus 组合时表现优于 Claude Code 本身
- 基准测试涵盖: DeepSWE (113 任务)、Terminal-Bench v2 (84 任务)、SWE-Atlas-QnA (124 任务)
- Token 消耗、成本和执行时间因 harness 而异

来源: https://artificialanalysis.ai/agents/coding-agents

---

## 4. 性能与用户体验对比

| 维度 | opencode | Codex CLI | Claude Code |
|------|----------|-----------|-------------|
| **CLI 体验** | 功能丰富但 TUI 被批评 (RAM 消耗大、输入 bug) | "More pleasant to use" (用户反馈) | 可靠但功能有限 |
| **上下文管理** | 修剪/压缩机制 (被批评实现不佳) | 未披露具体机制 | 标准上下文管理 |
| **提示缓存效率** | 差 — 每轮回合重新读取文件 | 较好 (Rust 核心更高效) | 未知 |
| **多会话** | 原生支持并行 | 不支持 | 有限 |
| **安全性** | 严重问题 (CVE, RCE, 命令过滤易绕过) | 未知 (Apache 2.0，可审查) | Anthropic 管理，闭源 |
| **启动速度** | 较慢 (Bun/TypeScript) | 较快 (Rust) | 中等 (Node) |

---

## 5. 场景推荐

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| **多模型灵活使用** | opencode | 75+ 供应商，包括本地模型 |
| **预算有限 ($20/月)** | Codex CLI | ChatGPT Plus 即可使用全部功能 |
| **Claude 生态深度绑定** | Claude Code 或 opencode | opencode 可调用 Claude 且有些基准更好 |
| **企业隐私 / 数据主权** | opencode | 不存储数据，支持本地模型，开源 |
| **轻量快速 CLI** | Codex CLI | Rust 实现，更流畅的终端体验 |
| **需要并行 agent 工作** | opencode | 唯一原生支持多会话并行的工具 |
| **安全敏感场景** | Codex CLI 或 Claude Code | opencode 有严重安全漏洞历史 |
| **IDE 深度集成** | Codex CLI | VS Code / Cursor / Windsurf 原生支持 |
| **大型 monorepo** | Codex CLI | Bazel 构建系统原生支持 |

---

## 6. 生态互操作

值得注意的趋势: 社区正在构建工具将三个 agent 视为可互换的后端:

- **agent-of-empires** (njbrake): opencode & Claude Code 会话管理器
- **sk** (803/skills-supply): 跨 agent 技能管理
- **parley** (pi-victor): AI 代码审查 TUI，支持 codex/claude/opencode
- **opencontext** (adityak74): BYO Coding Agent (Codex/Claude/OpenCode)
- **codey** (joway): CLI wrapper 统一三个工具
- **maccha** (KarelTestSpecial): 跨 agent 大脑
- **NCA** (grigio): Rust 实现，声称是 opencode/claudecode 的 10 倍轻量替代品

这表明 **harness 正在商品化**，选择哪家越来越多取决于价格和信任，而非功能差异。

---

## 7. 关键结论

1. **opencode 是功能最丰富的开源选择** — 多模型、多会话、LSP、桌面应用，但安全记录是其最大软肋
2. **Codex CLI 是用户体验最优的轻量选择** — Rust 实现、ChatGPT 计划集成、IDE 原生支持，但仅限 OpenAI
3. **Claude Code 是 Claude 生态首选** — 与 Anthropic 深度绑定，但被基准测试证明在某些场景下不如 opencode + Claude 的组合
4. **安全性是 opencode 的最大风险** — CVE-2026-22812、可绕过的命令过滤、安全报告被自动关闭等问题构成严重隐忧
5. **没有"最好"的工具** — 选择取决于模型偏好、预算、安全需求和所需功能
6. **生态正在融合** — 社区工具将三者视为可互换后端，harness 差异在缩小

---

## 8. 数据来源

| 来源 | URL |
|------|-----|
| opencode 官网 | https://opencode.ai |
| opencode GitHub | https://github.com/anomalyco/opencode |
| Codex CLI GitHub | https://github.com/openai/codex |
| Claude Code GitHub | https://github.com/anthropics/claude-code |
| Artificial Analysis 基准 | https://artificialanalysis.ai/agents/coding-agents |
| HN: opencode 批评 | https://wren.wtf/shower-thoughts/stop-using-opencode/ |
| HN Algolia 搜索 | https://hn.algolia.com (多查询) |
| sk 技能管理 | https://github.com/803/skills-supply |
| NCA 轻量替代 | https://grigio.org/nca-10x-lighter-alternative-to-opencode-claudecode-written-in-rust/ |

---

*报告编制: opencode Agent | 2026-07-26 | 任务 E5020D*
