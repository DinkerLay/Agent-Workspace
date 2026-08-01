# 当前执行计划

状态：当前计划索引
更新日期：2026-08-02

只把本目录下表格列出的文件视为当前执行计划。`archive/` 保存完成、被替代的
计划和审计证据；`deprecated/` 保存已明确废弃的方案。二者都不能覆盖当前 spec。

| 计划 | 状态 | 当前范围 |
| --- | --- | --- |
| [`state-management-foundation-v1.plan.md`](state-management-foundation-v1.plan.md) | Active；生产 owner seam 已落地，物理 Store 拆分与 Dispatch command ledger 待完成 | Template/Task/Run 状态 owner、命令、持久化与 read model 收口 |
| [`agent-loop-continuity-regression-remediation-v1.plan.md`](agent-loop-continuity-regression-remediation-v1.plan.md) | Active；部分人工验收剩余 | Task continuation、权限恢复、Terminal 交互回归 |
| [`browser-runtime-bridge-local-dev-v1.plan.md`](browser-runtime-bridge-local-dev-v1.plan.md) | Active；首个本地切片已实现 | Browser renderer 到受保护本地 Runtime bridge |

新增计划必须包含目标、输入、owner、输出、依赖、验证命令和完成条件；完成后移入
`archive/completed/`，被替代后移入 `archive/superseded/`。
