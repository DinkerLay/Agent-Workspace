import { ClipboardList, FileSearch, GitBranch, RadioTower } from "lucide-react";
import { StatusPill } from "../components/common";
import type { Task, WatchEvent, WatchSource } from "../types";

export function PlanWatcher({
  sources,
  events,
  tasks,
  onCreatePlannerTask,
}: {
  sources: WatchSource[];
  events: WatchEvent[];
  tasks: Task[];
  onCreatePlannerTask: (eventId: string) => void;
}) {
  const taskIds = new Set(tasks.map((task) => task.id));

  return (
    <section className="watcher-layout">
      <div className="panel watcher-main">
        <div className="section-title">
          <FileSearch size={18} />
          <span>Research / Spec / Plan Watcher</span>
        </div>
        <p>
          Durable product intent changes are observed here first. The shell creates planner tasks; agent
          reasoning starts only after a task/run is explicitly launched.
        </p>

        <div className="watch-source-grid">
          {sources.map((source) => (
            <article className="watch-source-card" key={source.id}>
              <div className="watch-source-head">
                <GitBranch size={16} />
                <strong>{source.label}</strong>
                <StatusPill status={source.status} />
              </div>
              <p>{source.purpose}</p>
              <div className="watch-source-meta">
                <span>{source.root}</span>
                <span>{source.eventCount} event</span>
              </div>
            </article>
          ))}
        </div>
      </div>

      <aside className="panel watcher-events">
        <div className="section-title">
          <RadioTower size={18} />
          <span>Watch events</span>
        </div>
        <code>.agent-workspace/watch/events.jsonl</code>
        <div className="watch-event-list">
          {events.map((event) => (
            <article className="watch-event-card" key={event.id}>
              <div className="watch-event-head">
                <strong>{event.summary}</strong>
                <StatusPill status={event.status} />
              </div>
              <code>{event.path}</code>
              <p>{event.impact}</p>
              <div className="watch-source-meta">
                <span>{event.changeType}</span>
                <span>{event.detectedAt}</span>
              </div>
              {event.plannerTaskId ? (
                <div className="watch-task-link">
                  <ClipboardList size={14} />
                  <span>{event.plannerTaskId}</span>
                  <StatusPill status={taskIds.has(event.plannerTaskId) ? "task-linked" : "missing-task"} />
                </div>
              ) : (
                <button
                  aria-label={`Create planner task for ${event.id}`}
                  className="small-action"
                  type="button"
                  onClick={() => onCreatePlannerTask(event.id)}
                >
                  <ClipboardList size={14} />
                  Create planner task
                </button>
              )}
            </article>
          ))}
        </div>
      </aside>
    </section>
  );
}
