import { Bell, Inbox, Play, ServerCog, Workflow, type LucideIcon } from "lucide-react";
import { StatusPill } from "../components/common";
import type { LoopScheduleEvent, Task } from "../types";

type LoopStage = {
  label: string;
  state: string;
  detail: string;
  icon: LucideIcon;
};

export function LoopConsole({
  tasks,
  loopScheduleEvents,
  loopStages,
  onAdvance,
  onStartAgent,
}: {
  tasks: Task[];
  loopScheduleEvents: LoopScheduleEvent[];
  loopStages: LoopStage[];
  onAdvance: (taskId: string) => void;
  onStartAgent: (taskId: string) => void;
}) {
  const recentScheduleEvents = [...loopScheduleEvents].reverse().slice(0, 4);

  return (
    <section className="loop-layout">
      <div className="panel loop-main">
        <div className="section-title">
          <Workflow size={18} />
          <span>三层 Loop 调度控制台</span>
        </div>
        <div className="loop-timeline">
          {loopStages.map((stage, index) => {
            const Icon = stage.icon;
            return (
              <div className="loop-stage" key={stage.label}>
                <div className="stage-icon">
                  <Icon size={22} />
                </div>
                <div>
                  <span className="eyebrow">Loop {index + 1}</span>
                  <h3>{stage.label}</h3>
                  <p>{stage.detail}</p>
                  <StatusPill status={stage.state} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <aside className="panel rules-panel">
        <div className="section-title">
          <ServerCog size={18} />
          <span>Scheduler rules</span>
        </div>
        <RuleRow label="Watcher trigger" value="docs product-intent files changed" />
        <RuleRow label="Planner output" value="self-consistent plan file" />
        <RuleRow label="Executor input" value="one plan step per task" />
        <RuleRow label="Retry policy" value="max 2 before user decision" />
        <RuleRow label="Done gate" value="review + verification + context" />
        <div className="decision-callout">
          <Bell size={18} />
          <span>需要你判断：自动 commit 还是生成 pending commit proposal。</span>
        </div>
        <div className="loop-schedule-audit">
          <div className="section-title compact">
            <Workflow size={16} />
            <span>Loop schedule audit</span>
          </div>
          {recentScheduleEvents.length ? (
            recentScheduleEvents.map((event) => (
              <article className="loop-schedule-event" key={event.id}>
                <div>
                  <strong>{event.summary}</strong>
                  <StatusPill status={event.decision} />
                </div>
                <small>{event.createdAt}</small>
                <code>{event.evidencePath}</code>
              </article>
            ))
          ) : (
            <span className="loop-schedule-empty">No loop schedule event recorded yet</span>
          )}
        </div>
      </aside>
      <aside className="panel queue-panel">
        <div className="section-title">
          <Inbox size={18} />
          <span>Loop queue</span>
        </div>
        {tasks.map((task) => (
          <div className="queue-row" data-task-id={task.id} key={task.id}>
            <span>{task.title}</span>
            <StatusPill status={task.status} />
            <button
              aria-label={`Start Agent for ${task.title}`}
              className="small-action"
              type="button"
              onClick={() => onStartAgent(task.id)}
            >
              <Play size={14} />
              Start Agent
            </button>
            <button
              aria-label={`Advance ${task.title}`}
              className="small-action"
              type="button"
              onClick={() => onAdvance(task.id)}
            >
              Advance
            </button>
          </div>
        ))}
      </aside>
    </section>
  );
}

function RuleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rule-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
