import { ClipboardList, SquareTerminal, type LucideIcon } from "lucide-react";
import type { View } from "../types";

/**
 * Only live product surfaces belong in normal navigation. Template creation,
 * workflow execution, review automation, and other planned capabilities stay
 * out of the desktop shell until they have durable state and a runnable path.
 */
export const navItems: Array<{ id: Extract<View, "backlog" | "workbench">; label: string; icon: LucideIcon }> = [
  { id: "backlog", label: "任务主页", icon: ClipboardList },
  { id: "workbench", label: "IDE 工作台", icon: SquareTerminal },
];
