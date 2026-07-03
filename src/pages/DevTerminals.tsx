import { FileClock, MonitorPlay, Play, Square, SquareTerminal } from "lucide-react";
import { StatusPill } from "../components/common";
import type { DevCommand, DevCommandEvent, RuntimeContract } from "../types";

export function DevTerminals({
  commands,
  contracts,
  events,
  onStartCommand,
  onStopCommand,
}: {
  commands: DevCommand[];
  contracts: RuntimeContract[];
  events: DevCommandEvent[];
  onStartCommand: (commandId: string) => void;
  onStopCommand: (commandId: string) => void;
}) {
  const ptyContract = contracts.find((contract) => contract.id === "pty-service");
  const runningCommands = commands.filter((command) => command.status === "running");
  const recentEvents = [...events].reverse().slice(0, 5);

  return (
    <section className="terminals-layout">
      <div className="panel terminals-main">
        <div className="section-title">
          <MonitorPlay size={18} />
          <span>Project command manager</span>
        </div>
        <div className="terminal-kind-strip">
          <div>
            <strong>Agent PTY</strong>
            <span>coding agent session, task-bound, transcript required</span>
          </div>
          <div>
            <strong>Dev Server PTY</strong>
            <span>long-running project process, command-bound, restartable</span>
          </div>
          <div>
            <strong>One-shot Command</strong>
            <span>verification or build command, evidence-bound</span>
          </div>
        </div>
        <div className="command-grid">
          {commands.map((command) => (
            <article className="command-card" key={command.id}>
              <div className="command-head">
                <SquareTerminal size={18} />
                <div>
                  <strong>{command.name}</strong>
                  <span>{command.kind}</span>
                </div>
                <StatusPill status={command.status} />
              </div>
              <code>{command.command}</code>
              <p>{command.log}</p>
              <div className="button-row">
                {command.status === "running" ? (
                  <button
                    aria-label={`Stop ${command.name}`}
                    className="small-action"
                    type="button"
                    onClick={() => onStopCommand(command.id)}
                  >
                    <Square size={14} />
                    Stop
                  </button>
                ) : (
                  <button
                    aria-label={`Start ${command.name}`}
                    className="small-action"
                    type="button"
                    onClick={() => onStartCommand(command.id)}
                  >
                    <Play size={14} />
                    Start
                  </button>
                )}
                {command.port ? <span className="port-pill">:{command.port}</span> : null}
              </div>
            </article>
          ))}
        </div>
      </div>

      <aside className="panel terminal-contract">
        <div className="section-title">
          <SquareTerminal size={18} />
          <span>PTY boundary</span>
        </div>
        <p>{ptyContract?.purpose}</p>
        <div className="evidence-box">
          <strong>Command sessions</strong>
          <code>{runningCommands.length} running</code>
          <code>{commands.length - runningCommands.length} stopped</code>
          <p>Dev Server PTY and one-shot commands are command-bound evidence, not AgentRun records.</p>
        </div>
        <div className="command-event-panel">
          <div className="section-title compact">
            <FileClock size={16} />
            <span>Command lifecycle audit</span>
          </div>
          {recentEvents.length ? (
            recentEvents.map((event) => (
              <article className="command-event-card" key={event.id}>
                <div>
                  <strong>{event.summary}</strong>
                  <StatusPill status={event.status} />
                </div>
                <small>
                  {event.commandId} · {event.action} · {event.createdAt}
                </small>
                <code>{event.evidencePath}</code>
                <code>{event.logPath}</code>
              </article>
            ))
          ) : (
            <span className="command-event-empty">No command lifecycle events yet</span>
          )}
        </div>
        <div className="evidence-box">
          <strong>Scheduler responsibilities</strong>
          {ptyContract?.schedulerOwns.map((item) => <code key={item}>{item}</code>)}
        </div>
        <div className="evidence-box">
          <strong>Agent responsibilities</strong>
          {ptyContract?.agentOwns.map((item) => <code key={item}>{item}</code>)}
        </div>
      </aside>
    </section>
  );
}
