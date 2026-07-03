import { Command, Globe2, MonitorPlay, Rocket } from "lucide-react";
import { StatusPill } from "../components/common";
import type { BrowserEvidence, BrowserTool, Task } from "../types";

export function BrowserAutomation({
  imageSrc,
  tools,
  selectedTask,
  activeToolName,
  evidence,
  onSelectTool,
  onCaptureEvidence,
}: {
  imageSrc: string;
  tools: BrowserTool[];
  selectedTask: Task;
  activeToolName: string;
  evidence: BrowserEvidence[];
  onSelectTool: (toolName: string) => void;
  onCaptureEvidence: () => void;
}) {
  const taskEvidence = evidence.filter((item) => item.taskId === selectedTask.id);

  return (
    <section className="browser-layout">
      <div className="panel browser-panel">
        <div className="browser-chrome">
          <Globe2 size={17} />
          <span>http://127.0.0.1:5188/</span>
          <button
            aria-label={`Capture browser evidence for ${selectedTask.id}`}
            className="ghost-button"
            type="button"
            onClick={onCaptureEvidence}
          >
            <MonitorPlay size={16} />
            Capture evidence
          </button>
        </div>
        <div className="browser-task-card">
          <div>
            <span className="eyebrow">Active task</span>
            <strong>{selectedTask.title}</strong>
            <small>{selectedTask.verification}</small>
          </div>
          <StatusPill status="Browser evidence" />
        </div>
        <div className="browser-window">
          <img src={imageSrc} alt="Browser automation reference" />
          <div className="browser-overlay">
            <strong>Project-isolated Chromium</strong>
            <span>cookies / localStorage / sessionStorage scoped per project</span>
          </div>
        </div>
      </div>
      <aside className="panel browser-tools">
        <div className="section-title">
          <Command size={18} />
          <span>Browser MCP tools</span>
        </div>
        {tools.map((tool) => (
          <button
            aria-label={`Select browser tool ${tool.name}`}
            className={activeToolName === tool.name ? "tool-row selected" : "tool-row"}
            key={tool.name}
            type="button"
            onClick={() => onSelectTool(tool.name)}
          >
            <Rocket size={15} />
            <span>{tool.name}</span>
            {activeToolName === tool.name ? <StatusPill status="Selected tool" /> : null}
          </button>
        ))}
        <div className="console-box">
          <strong>Evidence contract</strong>
          {tools.map((tool) => (
            <p key={tool.name}>
              {tool.name}: {tool.evidence}
            </p>
          ))}
        </div>
        <div className="browser-evidence-list">
          <strong>Captured evidence</strong>
          {taskEvidence.length === 0 ? <span>No evidence captured for active task</span> : null}
          {taskEvidence.map((item) => (
            <div className="browser-evidence-row" key={item.id}>
              <StatusPill status={item.toolName} />
              <span>{item.summary}</span>
              <code>{item.artifactPath}</code>
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}
