import {
  ArchiveRestore,
  BellRing,
  Blocks,
  Bot,
  Brain,
  ClipboardList,
  FileDiff,
  FileSearch,
  FolderOpen,
  Globe2,
  History,
  Library,
  MonitorPlay,
  Network,
  Search,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { View } from "../types";

export type ShellEntry = {
  title: string;
  detail: string;
  view: View;
  cta: string;
  icon: LucideIcon;
};

export const navItems: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "backlog", label: "任务主页", icon: ClipboardList },
  { id: "workbench", label: "IDE 工作台", icon: SquareTerminal },
  { id: "delivery", label: "交付门禁", icon: FileDiff },
  { id: "more", label: "更多", icon: Blocks },
];

export const deliveryEntries: ShellEntry[] = [
  {
    title: "Review",
    detail: "检查 diff、验证命令、redaction 和人工批准。",
    view: "review",
    cta: "打开 Review",
    icon: FileDiff,
  },
  {
    title: "Runs",
    detail: "查看单个 Agent Run 的 transcript、policy、evidence 和 PR handoff。",
    view: "runs",
    cta: "打开 Runs",
    icon: History,
  },
  {
    title: "Audit Trail",
    detail: "查看 workspace 级别的任务、Loop、Review、MCP、Browser、Restore 证据链。",
    view: "audit",
    cta: "打开 Audit Trail",
    icon: History,
  },
];

export const moreGroups: Array<{
  title: string;
  detail: string;
  entries: ShellEntry[];
}> = [
  {
    title: "项目和资源",
    detail: "项目上下文、Agent profile、Prompt Library 和 Skills Library。",
    entries: [
      {
        title: "项目驾驶舱",
        detail: "项目、Agent、任务、run 和 command context。",
        view: "projects",
        cta: "打开项目驾驶舱",
        icon: FolderOpen,
      },
      {
        title: "资源库",
        detail: "Prompt templates、技能绑定和 scratchpad 保存记录。",
        view: "libraries",
        cta: "打开资源库",
        icon: Library,
      },
    ],
  },
  {
    title: "自动化",
    detail: "Loop 调度、docs product-intent watcher、MCP 和 project browser 证据。",
    entries: [
      {
        title: "Loop 控制台",
        detail: "调度规则、队列和 task/run 启动边界。",
        view: "loops",
        cta: "打开 Loop 控制台",
        icon: Workflow,
      },
      {
        title: "Plan Watcher",
        detail: "监听 durable product intent 并创建 planner task。",
        view: "watcher",
        cta: "打开 Plan Watcher",
        icon: FileSearch,
      },
      {
        title: "MCP Gateway",
        detail: "任务域内的工具权限、confirmation 和证据边界。",
        view: "mcp",
        cta: "打开 MCP Gateway",
        icon: Network,
      },
      {
        title: "Browser Automation",
        detail: "localhost 验证工具和任务级 browser evidence。",
        view: "browser",
        cta: "打开 Browser Automation",
        icon: Globe2,
      },
    ],
  },
  {
    title: "高级工作台",
    detail: "多 Agent handoff、dev command、通知路由和 session restore。",
    entries: [
      {
        title: "Agent Teams",
        detail: "多 Agent workflow 和 max-cycle guard。",
        view: "teams",
        cta: "打开 Agent Teams",
        icon: Network,
      },
      {
        title: "Dev Terminals",
        detail: "项目命令 session，独立于 AgentRun。",
        view: "terminals",
        cta: "打开 Dev Terminals",
        icon: MonitorPlay,
      },
      {
        title: "Notifications",
        detail: "waiting、blocked、done 状态路由。",
        view: "notifications",
        cta: "打开 Notifications",
        icon: BellRing,
      },
      {
        title: "Restore Session",
        detail: "恢复 workspace shell、process 和 context pointers。",
        view: "restore",
        cta: "打开 Restore Session",
        icon: ArchiveRestore,
      },
    ],
  },
  {
    title: "产品地图",
    detail: "解释页面、能力、运行时边界和 runtime readiness 路径。",
    entries: [
      {
        title: "产品地图",
        detail: "完整能力地图和 service contract。",
        view: "capabilities",
        cta: "打开产品地图",
        icon: Blocks,
      },
    ],
  },
];

export const loopStages = [
  {
    label: "Research / Spec 监听",
    state: "watching",
    detail: "监听 docs/research/、docs/superworks/spec/，记录 durable product intent",
    icon: Search,
  },
  {
    label: "Planner 规划",
    state: "running",
    detail: "把事实和 spec 转为可验证 plan steps",
    icon: Brain,
  },
  {
    label: "Executor 队列",
    state: "queued",
    detail: "从 plan step 创建 task/run，启动真实 CLI agent",
    icon: Bot,
  },
  {
    label: "Review 门禁",
    state: "blocked until verified",
    detail: "diff、test、transcript、commit context 才能进入 Done",
    icon: ShieldCheck,
  },
];
