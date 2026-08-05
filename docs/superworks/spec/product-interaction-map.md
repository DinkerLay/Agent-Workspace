# Product Interaction Map: onlyopencode

日期：2026-08-05
状态：当前页面与操作边界

| 页面 | 用户做什么 | 不做什么 |
| --- | --- | --- |
| Templates | 新建、选择、连续修改 Draft、保存 Version、回退为新 Draft | 直接启动 Task 或隐式保存 |
| Task 创建 | 输入目标、选择/新建项目目录、选择已保存 Template Version | 默用仓库目录或未保存 Draft |
| Tasks | 查看状态/Timeline、Start、Achieve、拉回继续、回收/放回 | 伪造 Provider 对话或决定派发路线 |
| Task Session | 在单一中心画布打开官方 Conductor 或已物化 Worker Session | 自定义终端、多 Group 或预启动 Card |
| Artifact | 打开已验证、可追溯的项目内交付物 | 把不存在路径显示为交付 |

## Templates

Meta Agent 入口属于 Templates 左侧栏；打开的是同一个 Draft 的官方 OpenCode Web UI。
页面初始不自动发消息，用户先描述修改。输入 `@card-id` 或多个 `@card-id` 选择修改范围；
Meta Agent 返回 Patch，不自动保存。Card 点击只打开 Inspector，不遮挡 Meta Agent。

Inspector 分开显示 Dispatch profile 与 Worker system prompt。模型是可选列表；MCP/Skills
使用项目已有 Provider 配置，不在 Card 内伪造新的 Provider Agent。

## Tasks 与官方会话

Task 创建时项目目录是显式必填项；“新建文件夹”由受控服务完成。没有合适 Template 时，
页面保留 Task 目标和目录，并提供已有 Version、Meta Agent Draft、手工 Draft 三个入口。

Task 页面中央永远优先显示 Conductor 官方会话；左右 Task 列表与 Session 目录可调整宽度。
Session 目录显示 Conductor 和 Task Architecture 的 Card，未派发 Card 不能打开官方页面。
点击已物化 Worker 时，用其官方页面替换中心画布；不同时保留隐藏页面。

Achieve 后显示历史交付与 `拉回继续`。拉回成功后回到同一官方 Conductor 会话；失败说明
原因并提供“基于历史新建 Task”。删除先进入回收站；彻底删除必须二次确认和显示将清理的
受管 artifact。
