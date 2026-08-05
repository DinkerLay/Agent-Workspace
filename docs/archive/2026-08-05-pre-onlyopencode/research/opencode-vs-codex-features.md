# OpenCode vs Claude Code — 视角A：功能特性和产品能力对比

> Dispatch ID: 1C9C54  
> 搜索日期: 2026-07-26  
> 信息来源: 官方文档直接抓取（opencode.ai/docs, docs.anthropic.com）

---

## 1. 总览对比

| 维度 | OpenCode | Claude Code (Codex) |
|------|----------|-------------------|
| **许可证** | 开源 (MIT) | 专有 (Proprietary) |
| **GitHub Stars** | 160K+ | N/A |
| **安装方式** | npm/brew/curl/pacman/choco/scoop/docker | curl/brew/winget/apt/dnf/apk |
| **语言** | TypeScript (Node.js) | 闭源 (Native binary) |
| **初始模型** | 无预设（用户选择 provider） | 仅 Claude (Anthropic) |
| **定价模式** | 免费 + 自有 API 费用 | Claude Pro/Max 订阅或 Console API 按量 |

---

## 2. 功能维度详细对比

### 2.1 终端/CLI 能力

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **交互式 TUI** | 全功能 TUI（主题、快捷键、vim 模式） | 全功能 TUI + Fullscreen 渲染 |
| **非交互式 CLI** | `opencode run "query"` | `claude -p "query"` |
| **管道输入** | 支持 | `cat file \| claude -p "query"` |
| **继续会话** | `-c` / `--continue` | `-c` / `--continue` |
| **指定会话恢复** | `--session` | `-r "<session>"` |
| **多文件编辑** | `edit`(精确替换) / `write` / `apply_patch` | Edit / Write / 类似 |
| **撤销/重做** | `/undo` / `/redo` | 基于检查点 `/rewind` |
| **非交互运行** | `opencode run` | `claude -p` |
| **后台进程** | 实验性 | 完整支持 (`claude --bg`) |

### 2.2 Agent / 自主编程能力

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **内置 agents** | Build(默认), Plan, General, Explore, Scout | 无默认 primary（自动选择模式） |
| **Plan 模式** | Tab 切换 Plan/Build | Shift+Tab 切换 permission modes |
| **自定义 subagents** | 支持（Markdown 或 JSON 配置） | 支持（.claude/agents/ 目录） |
| **Agent 团队** | 基础 subagent 调用 | Dynamic Workflows、Agent Teams、多 agent 编排 |
| **Subagent 隔离** | 子会话 | git worktree 隔离 |
| **嵌套 subagent** | 支持 | 支持（需显式启用） |
| **Agent SDK** | 有（基础） | 有（更成熟，含编排、工具权限控制） |
| **Memory / 持久记忆** | 不支持 | Auto Memory（跨会话学习） |

### 2.3 多模型/Provider 支持

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **支持的 LLM 数量** | 75+ 个 provider | 仅 Claude（Anthropic/Amazon Bedrock/GCP Vertex） |
| **本地模型** | Ollama, llama.cpp, LM Studio, Atomic Chat | 无 |
| **订阅复用** | ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo | 无 |
| **OpenAI 兼容 API** | 完整支持 | 无 |
| **自有 gateway** | Cloudflare, Helicone, OpenRouter 等 | Claude Apps Gateway |

### 2.4 MCP / 工具连接

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **MCP 本地 stdio** | 支持 | 支持 |
| **MCP 远程 HTTP** | 支持 (含 OAuth) | 支持 (含 OAuth, 更成熟) |
| **MCP OAuth** | 支持（自动检测 + 手动配置） | 支持（自动 + CLI login + callback port 固定） |
| **Channels** | 无 | 有（Telegram, Discord, webhooks 等） |
| **claude.ai 连接器** | 无 | 有（Sentry, Jira, Slack, Notion 等） |
| **动态 headers** | 无 | 支持 `headersHelper` |
| **MCP 自动重连** | 无明确说明 | 支持（指数退避） |

### 2.5 LSP / 代码智能

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **内置 LSP 服务器** | 30+ 个（TypeScript, Rust, Go, Python 等） | 无相关信息 |
| **LSP 诊断反馈** | 支持（agent 可根据诊断自动修正） | 无 |
| **自定义 LSP** | 支持 | 无 |
| **代码补全/跳转** | goToDefinition, findReferences, hover 等 | 通过 IDE 扩展实现 |

### 2.6 多模态

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **图片输入** | 支持（拖拽到终端） | 支持 |
| **PDF 读取** | 无 | 支持（文件读取） |
| **Chrome 浏览器集成** | 无 | 有（Claude in Chrome） |
| **音频/视频** | 无 | 无 |

### 2.7 IDE 集成

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **VS Code** | 扩展（自动安装） | 扩展（内联 diff、@引用、计划审查） |
| **Cursor** | 支持 | 支持 |
| **JetBrains** | 无 | 有（IntelliJ IDEA, PyCharm, WebStorm） |
| **快速启动** | Cmd+Esc | VS Code 命令面板 |
| **选择上下文** | 自动共享选中内容 | 自动共享 |

### 2.8 会话管理

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **多会话并行** | 支持（TUI 中切换） | 支持（Desktop 侧栏、agent view） |
| **会话分享** | `/share` 创建可分享链接 | 无公开分享链接 |
| **导出/导入** | JSON export/import | 有限 |
| **会话统计** | `opencode stats`（token/成本/模型用量） | 无 |
| **会话标题生成** | 自动（内置 title agent） | 自动 |

### 2.9 工具使用

| 工具 | OpenCode | Claude Code |
|------|----------|------------|
| **bash** | 支持（可配置权限） | 支持（可配置权限） |
| **edit (精确替换)** | 支持 | 支持 |
| **write** | 支持 | 支持 |
| **read** | 支持（分段） | 支持 |
| **grep** | 支持（正则） | 支持 |
| **glob** | 支持 | 支持 |
| **apply_patch** | 支持 | 无对应 |
| **webfetch** | 支持 | 支持 |
| **websearch** | 实验性（Exa） | 无独有（通过 web fetch 间接实现） |
| **question (询问用户)** | 支持（含选项和自定义输入） | 支持 |
| **todowrite** | 支持 | 支持 |
| **skill** | 支持（SKILL.md） | 支持（SKILL.md） |
| **lsp** | 实验性 | 无 |
| **自定义工具** | 支持（config 定义） | 通过 MCP 实现 |

### 2.10 调度与 CI/CD

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **GitHub Actions** | 支持（`opencode github install`） | 支持（更多 CI/CD 深度） |
| **GitLab CI/CD** | 支持 | 支持 |
| **定时任务 (Routines)** | 无 | 支持（Anthropic 托管基础设施） |
| **本地定时任务** | 无 | 支持（Desktop scheduled tasks） |
| **循环执行** | 无 | `/loop` 命令 |

### 2.11 企业功能

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **SSO** | 支持 | 支持（Gateway） |
| **Policies** | 支持 | 支持（Managed-only settings） |
| **MDM 部署** | 无 | 支持（plist/registry/JSON 文件） |
| **Server-managed settings** | 无 | 支持 |
| **数据隐私/本地部署** | 支持（代码不留存） | 支持（通过 Gateway/Bedrock/GCP） |
| **审计日志** | 无 | 有 |

### 2.12 远程与移动

| 项目 | OpenCode | Claude Code |
|------|----------|------------|
| **Web 界面** | `opencode web` | claude.ai/code |
| **iOS/Android 应用** | 无 | 有 |
| **Remote Control** | 终端 attach 到远程 server | `claude remote-control` + 手机通知/推送 |
| **Dispatch** | 无 | 从手机发起任务到桌面 |
| **Teleport** | 无 | web → 终端 会话迁移 |
| **Slack 集成** | 无 | @Claude 路由 bug 到 PR |

---

## 3. 关键差距清单

### OpenCode 有但 Claude Code 没有

| 功能 | 重要性 |
|------|--------|
| **75+ LLM Provider 支持** | ⭐⭐⭐⭐⭐ |
| **本地模型运行（Ollama/llama.cpp 等）** | ⭐⭐⭐⭐⭐ |
| **开源 (MIT)** | ⭐⭐⭐⭐ |
| **LSP 集成（30+ 语言服务器）** | ⭐⭐⭐⭐ |
| **会话分享链接** | ⭐⭐⭐ |
| **令牌/成本统计** | ⭐⭐⭐ |
| **自定义主题** | ⭐⭐ |
| **自定义快捷键** | ⭐⭐ |
| **ACP 协议支持** | ⭐⭐ |
| **GitHub Copilot / ChatGPT Plus 订阅复用** | ⭐⭐⭐⭐ |
| **Session export/import JSON** | ⭐⭐ |
| **Undo/redo 多级操作** | ⭐⭐⭐ |

### Claude Code 有但 OpenCode 没有

| 功能 | 重要性 |
|------|--------|
| **Scheduled Routines (托管基础设施)** | ⭐⭐⭐⭐⭐ |
| **Remote Control / 移动端控制** | ⭐⭐⭐⭐⭐ |
| **Auto Memory（跨会话记忆）** | ⭐⭐⭐⭐ |
| **Chrome 浏览器集成** | ⭐⭐⭐⭐ |
| **Channels（Telegram/Discord/webhook 推送）** | ⭐⭐⭐⭐ |
| **Slack 集成 (@Claude → PR)** | ⭐⭐⭐⭐ |
| **JetBrains IDE 插件** | ⭐⭐⭐⭐ |
| **iOS/Android 应用** | ⭐⭐⭐⭐ |
| **Agent Teams / Dynamic Workflows (编排)** | ⭐⭐⭐⭐ |
| **Managed settings 企业部署** | ⭐⭐⭐⭐ |
| **MCP OAuth 高级功能 (callback port / headersHelper)** | ⭐⭐⭐ |
| **MDM 部署（plist/registry）** | ⭐⭐⭐ |
| **GitHub Code Review (自动每 PR 审查)** | ⭐⭐⭐ |
| **Desktop scheduled tasks** | ⭐⭐⭐ |
| **Cowork 会话 (实时协作)** | ⭐⭐⭐ |
| **Extended thinking / ultrathink** | ⭐⭐⭐ |
| **Subagent 隔离 (git worktree)** | ⭐⭐⭐ |
| **Auto mode (权限分类器)** | ⭐⭐⭐ |
| **Server-managed gateway** | ⭐⭐⭐ |

---

## 4. 关键发现总结

1. **核心定位差异**: OpenCode 定位为**开源多模型编码 agent**，强调 provider 自由度和本地模型支持；Claude Code 定位为 **Anthropic 生态的专有编码 agent**，深度绑定 Claude 模型能力。

2. **OpenCode 核心优势**在于模型选择自由（75+ provider、本地模型、Copilot/ChatGPT 订阅复用）和代码智能（LSP 集成）。对想降低 API 成本、需要本地运行、或想在不同模型间切换的开发者非常有吸引力。

3. **Claude Code 核心优势**在于产品成熟度和企业级基础设施：Routines（托管定时任务）、Remote Control（跨设备会话迁移）、Auto Memory（跨会话学习）、Chrome 集成、Agent Teams/Dynamic Workflows（高级 agent 编排）、Channels（外部事件推送）、Slack 集成、MDM 企业部署。在工程深度和生态广度上明显领先。

4. **差距最大的领域**: 移动端支持（Claude Code 有 iOS/Android 应用，OpenCode 无）、调度任务（Routines 在 Anthropic 托管运行）、企业级管理（managed settings → MDM → server-managed）、agent 编排（dynamic workflows vs 基础 subagent）、外部事件集成（Channels/Slack vs 无）。

5. **OpenCode 的独特优势无法被 Claude Code 复制**: 开源、多 provider、本地模型、LSP 集成、订阅复用。这些构成了对 Claude Code 的竞争护城河。

6. **Claude Code 的领先领域短期内 OpenCode 难以赶上**: Routines、Remote Control、Auto Memory、Chrome 集成、Agent Teams、Channels 等功能深度绑定 Anthropic 平台能力和工程资源。

---

## 5. 信息来源

| 来源 | URL | 内容 |
|------|-----|------|
| OpenCode Docs (Intro) | https://opencode.ai/docs/ | 产品概览、安装、初始化 |
| OpenCode Docs (Tools) | https://opencode.ai/docs/tools/ | 内置工具列表（bash、edit、write、lsp 等） |
| OpenCode Docs (CLI) | https://opencode.ai/docs/cli/ | CLI 命令参考 |
| OpenCode Docs (Agents) | https://opencode.ai/docs/agents/ | Agent 系统、subagent 配置 |
| OpenCode Docs (IDE) | https://opencode.ai/docs/ide/ | VS Code/Cursor 集成 |
| OpenCode Docs (LSP) | https://opencode.ai/docs/lsp/ | LSP 服务器配置 |
| OpenCode Docs (MCP) | https://opencode.ai/docs/mcp-servers/ | MCP 服务器集成 |
| OpenCode Docs (Skills) | https://opencode.ai/docs/skills/ | Agent Skills (SKILL.md) |
| OpenCode Docs (Web) | https://opencode.ai/docs/web/ | Web 界面 |
| OpenCode Docs (Providers) | https://opencode.ai/docs/providers/ | 75+ LLM providers |
| OpenCode Docs (GitHub) | https://opencode.ai/docs/github/ | GitHub Actions 集成 |
| Claude Code Docs (Overview) | https://docs.anthropic.com/en/docs/claude-code/overview | 产品概览、安装 |
| Claude Code Docs (CLI Ref) | https://docs.anthropic.com/en/docs/claude-code/cli-reference | CLI 命令和标志 |
| Claude Code Docs (Subagents) | https://docs.anthropic.com/en/docs/claude-code/sub-agents | Subagent 系统 |
| Claude Code Docs (Skills) | https://docs.anthropic.com/en/docs/claude-code/skills | Skills (SKILL.md) |
| Claude Code Docs (MCP) | https://docs.anthropic.com/en/docs/claude-code/mcp | MCP 集成（详细） |
| Claude Code Docs (Settings) | https://docs.anthropic.com/en/docs/claude-code/settings | 配置范围、企业设置 |

---

## 6. 后续分析建议

- **视角B**: 性能基准对比（SWE-bench、代码生成质量、工具调用成功率）
- **视角C**: 架构和扩展性分析（plugin 系统、SDK、ACP、API 设计）
- **视角D**: 社区和生态系统（contributor 活跃度、第三方集成、市场认可度）
- **视角E**: 企业合规与安全（数据隐私、审计、部署模型、合规认证）
