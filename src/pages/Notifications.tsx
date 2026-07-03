import { ArrowRight, BellRing, CheckCircle2, RadioTower, Route } from "lucide-react";
import { StatusPill } from "../components/common";
import type { NotificationEvent, Task } from "../types";

export function Notifications({
  selectedTask,
  events,
  onRouteNotification,
  onAcknowledgeNotification,
  onOpenNotificationContext,
}: {
  selectedTask: Task;
  events: NotificationEvent[];
  onRouteNotification: () => void;
  onAcknowledgeNotification: (eventId: string) => void;
  onOpenNotificationContext: (eventId: string) => void;
}) {
  const pendingEvents = events.filter((event) => !event.acknowledged);
  const acknowledgedEvents = events.filter((event) => event.acknowledged);

  return (
    <section className="notifications-layout">
      <div className="panel notification-main">
        <div className="section-title">
          <BellRing size={18} />
          <span>Notification queue</span>
        </div>
        <div className="notification-signal">
          <div>
            <span className="eyebrow">Active task signal</span>
            <strong>{selectedTask.title}</strong>
            <small>{selectedTask.summary}</small>
          </div>
          <StatusPill status={selectedTask.status} />
        </div>
        <button
          aria-label={`Route notification for ${selectedTask.id}`}
          className="primary-button"
          type="button"
          onClick={onRouteNotification}
        >
          <RadioTower size={16} />
          Route notification
        </button>

        <div className="notification-list">
          {events.length === 0 ? <span className="notification-empty">No routed notification events yet</span> : null}
          {events.map((event) => (
            <article className="notification-event" key={event.id}>
              <div className="notification-event-head">
                <strong>{event.id}</strong>
                <StatusPill status={event.acknowledged ? "acknowledged" : event.level} />
              </div>
              <p>{event.summary}</p>
              <div className="notification-meta">
                <span>{event.taskId}</span>
                <span>{event.destination}</span>
              </div>
              <code>{event.evidencePath}</code>
              {event.sourceEventId ? (
                <div className="notification-source">
                  <strong>{event.sourceLabel ?? "Parser signal"}</strong>
                  <span>{event.sourceEventId}</span>
                  <small>{event.sourceSummary}</small>
                  <code>{event.sourceEvidencePath}</code>
                </div>
              ) : null}
              <button
                aria-label={`Open notification context ${event.id}`}
                className="small-action"
                type="button"
                onClick={() => onOpenNotificationContext(event.id)}
              >
                <ArrowRight size={14} />
                Open context
              </button>
              <button
                aria-label={`Acknowledge ${event.id}`}
                className="small-action"
                disabled={event.acknowledged}
                type="button"
                onClick={() => onAcknowledgeNotification(event.id)}
              >
                <CheckCircle2 size={14} />
                Acknowledge
              </button>
            </article>
          ))}
        </div>
      </div>

      <aside className="panel notification-rules">
        <div className="section-title">
          <Route size={18} />
          <span>Route rules</span>
        </div>
        <RuleRow status="waiting-input / failed / blocked" destination="desktop" />
        <RuleRow status="pending-review / done" destination="sidebar" />
        <RuleRow status="running / queued / todo" destination="mobile" />
        <div className="notification-summary">
          <strong>Queue status</strong>
          <span>Pending: {pendingEvents.length}</span>
          <span>Acknowledged: {acknowledgedEvents.length}</span>
          <code>.agent-workspace/notifications/events.jsonl</code>
        </div>
      </aside>
    </section>
  );
}

function RuleRow({ status, destination }: { status: string; destination: string }) {
  return (
    <div className="notification-rule-row">
      <span>{status}</span>
      <StatusPill status={destination} />
    </div>
  );
}
