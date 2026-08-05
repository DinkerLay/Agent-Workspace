# 结构化搜索报告：OpenCode 创立起源与早期历史

**Dispatch ID: 442F94**

> **重要说明**: 报告中提及的 OpenCode 是 Anomaly 公司（anomalyco）的产品，**不是** Cursor（Anysphere）的产品。两者是独立的 AI 编码工具。

---

## 一、研究视角 (Research Perspective)

本报告从以下维度追溯 OpenCode（开源 AI 编码代理）的创立与早期发展：
- **起源故事**: 项目如何诞生、从哪个项目/团队衍生
- **创始团队**: 核心创建者、组织归属
- **首次公开发布时间线**: 从首次代码提交到 HN 公开发布
- **早期演进**: 关键版本里程碑和功能演变

---

## 二、信息来源 (Information Sources)

| 来源 | URL | 内容 |
|------|-----|------|
| 官方网站 | opencode.ai | 产品定位、统计数据 |
| GitHub 仓库 | github.com/anomalyco/opencode | 代码提交历史、发布版本、PR |
| GitHub 组织 | github.com/anomalyco | 团队构成、关联项目 |
| 官方文档 | opencode.ai/docs | 安装指南、功能说明 |
| 更新日志 | opencode.ai/changelog | 版本发布记录 |
| X/Twitter | x.com/opencode | 官方社交媒体（2025年9月加入） |
| Hacker News | news.ycombinator.com | 社区讨论、公开发布 |
| 母公司网站 | anoma.ly | Anomaly 公司介绍 |
| 早期构建配置 | 仓库历史提交 | 早期导入路径、组织归属 |

---

## 三、关键发现 (Key Findings)

### 3.1 起源与创建故事

OpenCode 是由 **Anomaly**（原名 SST 团队，GitHub 组织 `anomalyco`）开发的**开源 AI 编码代理**。其核心特点是：

- 运行在**终端**中，同时提供桌面应用和 IDE 扩展
- 支持 75+ LLM 提供商（Claude、GPT、Gemini 等）
- **LSP 感知**，自动为 LLM 加载正确的语言服务
- 多会话并行管理
- 隐私优先设计（不存储用户代码）

从早期构建配置（`.goreleaser.yml`）的导入路径 `github.com/sst/opencode` 可以确认，该项目最初托管在 **SST 组织**下。SST（Serverless Stack）是一个全栈基础设施框架，由 Dax Raad 和 Adam 等人创建。OpenCode 是 SST/Anomaly 团队在 AI 编码代理领域的延伸产品。

### 3.2 创始团队

**公司**: Anomaly
- 网站: anoma.ly
- 口号: "For whatever you build."
- GitHub: github.com/anomalyco
- 创建时间: 约 2020 年（由 SST 团队演进而来）

**核心成员**（基于 GitHub 组织数据）:

| GitHub 账号 | 姓名/角色 | 贡献领域 |
|------------|----------|---------|
| `thdxr` | **Dax Raad** | 创始开发者，初始版本发布者 |
| `adamdotdevin` | **Adam** | 早期核心贡献者，早期 PR 作者 |
| `simonklee` | Simon Klee | 组织核心成员 |
| `Brendonovich` | Brendonovich | 桌面应用核心开发 |
| `Hona` | Hona | 核心成员 |
| `nexxeln` | nexxeln | 核心成员 |
| `arvsrn` | arvsrn | 桌面 UI 开发 |
| `fwang` | fwang | Zen 服务开发 |
| `kitlangton` | kitlangton | 核心功能贡献 |

### 3.3 首次公开发布时间线

| 日期 | 事件 | 详情 |
|------|------|------|
| **2025年初** | 项目启动 | 初始开发阶段 |
| **2025-05-02** | 首个 PR 合并 | PR #1: "feat: compact and other improvements" by adamdotdevin |
| **2025-05-14** | 首个发布 v0.0.45 | 功能包括：自动 LSP 发现/配置、自动压缩/总结、新日志页面、视觉改进 |
| **2025-05-15** | v0.0.48~v0.0.50 | 自动补全模块、VertexAI 支持、配置持久化 |
| **2025-05-17** | v0.0.51 | 0-255 颜色支持、非交互模式、工具对话框、图像粘贴 |
| **2025年9月** | X/Twitter 账号创建 | @opencode 账号加入 X 平台 |
| **~2025年末** | 组织迁移 | 从 sst/opencode 迁移到 anomalyco/opencode |
| **2026-03-20** | **HN 公开发布** | HN 帖子 "OpenCode – Open source AI coding agent" — **1274 points, 618 comments** |
| **2026-07-24** | 当前版本 v1.18.5 | 支持 Claude 自适应推理、桌面应用 V2、多会话标签页 |

### 3.4 早期发展故事

**从 SST 到 OpenCode**:
OpenCode 由 SST 团队（全栈基础设施工具 SST 的创建者）开发。团队在构建开发者工具方面的经验直接影响了 OpenCode 的设计理念。项目最初以 `github.com/sst/opencode` 为路径，后迁移至独立的 `anomalyco` 组织。

**早期版本特征**（v0.0.45，首个发布版本）：
- 自动 LSP 发现和配置
- 自动压缩/总结（无限会话）
- 日志页面
- 改进的可视化效果
- 大量修复和性能改进

**关键里程碑**：
- 从单一的 Go 终端工具演进为多会话 TUI
- 增加桌面应用（Electron 框架）
- 增加 Web 界面和 IDE 扩展
- 推出 **Zen**（精选模型市场）
- 推出 **Go**（订阅服务）  
- 支持 MCP（Model Context Protocol）服务器
- 达到 190K GitHub Stars、24K Forks

**当前规模**（截至 2026年7月）：
- **190,000+** GitHub Stars
- **24,000+** Forks
- **900+** 贡献者
- **15,162+** 提交
- **7.5M+** 月活跃开发者
- **85 页**发布历史

---

## 四、原始信息片段 (Raw Information Fragments)

### 来源：GitHub Releases (0.0.45)
> "auto LSP discovery/configuration, auto-compact/summarize for indefinite sessions, new logs page, improved visuals, a SHIT TON of fixes, performance stuff, stuff that was clearly just broken, lots of refactoring"

### 来源：早期构建配置 (47cbb65 commit)
goreleaser.yml 显示原始导入路径为 `github.com/sst/opencode`，AUR 维护者从 "kujtimiihoxha" 变更为 "dax" 和 "adam"，证实了组织所有权变更。

### 来源：opencode.ai 首页
- "With over 160,000 GitHub stars, 900 contributors, and over 13,000 commits, OpenCode is used and trusted by over 7.5M developers every month."
- 实际数据（截至 2026-07-25）: 190K stars, 900+ contributors, 15K+ commits

### 来源：HN (2026-03-20)
- "OpenCode – Open source AI coding agent" — 1274 points, 618 comments
- 这是项目首次大规模公开亮相

### 来源：X/Twitter (@opencode)
- 账号创建于 2025年9月
- 12.7K 关注者
- 440 条帖子

### 来源：GitHub 组织
- Anomaly 旗下还拥有 models.dev (6.1K stars)、SST (26.2K stars)、OpenTUI (12.7K stars) 等项目

---

## 五、名词澄清

| 实体 | 说明 |
|------|------|
| **OpenCode** | 本报告研究对象，Anomaly 公司的开源 AI 编码代理 |
| **Cursor** | Anysphere 公司产品，闭源 AI 编码编辑器 |
| **Anomaly** | OpenCode 母公司，GitHub 组织 anomalyco |
| **SST** | Serverless Stack，Anomaly 团队的另一个开源项目 |
| **OpenTUI** | Anomaly 开发的终端 UI 库，用于 OpenCode 的 TUI |

---

*报告生成时间: 2026-07-25*
*研究 Agent: opencode (self-research)*
