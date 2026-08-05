# Agent Workspace 文档入口

状态：onlyopencode 当前入口
更新日期：2026-08-05

主目录只保留当前产品契约与当前执行计划。研究、旧 mock、Orca/PTY 方案、旧
Browser Runtime 方案和已替代计划均已移入 `archive/`，不能作为实现依据。

## 从这里开始

1. 读 [`superworks/spec/spec_readme.md`](superworks/spec/spec_readme.md)。
2. 涉及 Template、Task、Run、Session 或生命周期，读
   [`superworks/spec/task-template-runtime-model.md`](superworks/spec/task-template-runtime-model.md)。
3. 涉及产品流程与页面，读
   [`superworks/spec/product-interaction-map.md`](superworks/spec/product-interaction-map.md)。
4. 只从 [`superworks/plans/README.md`](superworks/plans/README.md) 选择当前计划。

## 当前产品一句话

Agent Workspace 只实现 Agent Loop：Template 保存为不可变 Version，Task 快照该
Version；一个项目目录由共享 OpenCode Server 承载 Provider Sessions；官方 OpenCode
Web UI 是 Conductor 与 Worker 的唯一对话界面；Conductor 决定派发，Runtime 只记录
事实与受控命令。

## 当前事实 owner

| 事实 | Owner |
| --- | --- |
| Template、Task Architecture、Task、Run、生命周期命令 | Task/Template/Run service |
| Dispatch、输入回执、wakeup、取消回执 | Dispatch Coordinator |
| OpenCode Session/message/turn/result/attention | OpenCode Server 与 Provider Adapter 投影 |
| 官方页面 presentation lease | OpenCode presentation gateway |
| 选中项、弹窗、布局和输入草稿 | Renderer |

Renderer 只能提交 typed intent、读取 typed read model；它没有 Provider、文件系统或
生命周期写入权。Task 真实产物与测试项目只存在用户选择的项目目录中，不写入 `docs/`。

## 目录

- `superworks/spec/`：当前权威规范。
- `superworks/plans/`：当前可执行计划。
- `archive/` 与各子目录的 `archive/`：历史证据，不是产品依据。
