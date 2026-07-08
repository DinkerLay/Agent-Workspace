import { CheckCircle2, CircleDot } from "lucide-react";
import type { TaskStatus } from "../types";

export function StatusPill({ status, label = status }: { status: string; label?: string }) {
  return <span className={`status-pill status-${normalizeStatus(status)}`}>{label}</span>;
}

export function GateRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className={done ? "gate-row done" : "gate-row"}>
      {done ? <CheckCircle2 size={16} /> : <CircleDot size={16} />}
      <span>{label}</span>
    </div>
  );
}

export function RecordItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="record">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

export function laneTitle(status: TaskStatus) {
  const titles: Record<TaskStatus, string> = {
    todo: "TODO",
    queued: "Queued",
    running: "Running",
    "waiting-input": "Waiting Input",
    "pending-review": "Pending Review",
    "failed-verification": "Failed Verification",
    blocked: "Blocked",
    done: "Done",
  };
  return titles[status];
}

function normalizeStatus(status: string) {
  return status.toLowerCase().replace(/\s+/g, "-");
}
