import { ArrowRight, Code2, GitPullRequest, Network, Play, RefreshCcw, ShieldCheck } from "lucide-react";
import { StatusPill } from "../components/common";
import type { TeamRun, TeamWorkflow } from "../types";

export function Teams({
  workflows,
  selectedWorkflowId,
  activeRun,
  onSelectWorkflow,
  onStartTeamRun,
  onAdvanceTeamRun,
}: {
  workflows: TeamWorkflow[];
  selectedWorkflowId: string;
  activeRun?: TeamRun;
  onSelectWorkflow: (workflowId: string) => void;
  onStartTeamRun: () => void;
  onAdvanceTeamRun: () => void;
}) {
  const selected = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0];
  if (!selected) {
    return (
      <section className="teams-layout">
        <div className="panel canvas-panel">
          <div className="section-title">
            <Network size={18} />
            <span>Explicit handoff canvas</span>
          </div>
          <div className="team-run-card">
            <div className="section-title compact">
              <Network size={16} />
              <span>No team workflows configured</span>
            </div>
            <span className="team-empty">
              Team workflows are advanced capabilities and are disabled for this runtime workspace.
            </span>
          </div>
          <div className="button-row">
            <button aria-label="Start selected team workflow" className="primary-button" disabled type="button">
              <Play size={16} />
              Start workflow
            </button>
            <button aria-label="Advance handoff" className="ghost-button" disabled type="button">
              <ArrowRight size={16} />
              Advance handoff
            </button>
          </div>
        </div>
        <aside className="panel handoff-panel">
          <div className="section-title">
            <Network size={18} />
            <span>Team workflows</span>
          </div>
          <span className="team-empty">No workflow records available.</span>
        </aside>
      </section>
    );
  }
  const activeNode = activeRun ? selected.nodes[activeRun.activeNodeIndex] ?? selected.nodes[0] : selected.nodes[0];
  const canAdvance = activeRun?.status === "running";
  const advanceLabel = activeRun
    ? activeRun.status === "blocked"
      ? `Max cycle reached for ${activeRun.id}`
      : `Advance handoff for ${activeRun.id}`
    : "Advance handoff";

  return (
    <section className="teams-layout">
      <div className="panel canvas-panel">
        <div className="section-title">
          <Network size={18} />
          <span>Explicit handoff canvas</span>
        </div>
        <div className="team-selected-card">
          <div>
            <span className="eyebrow">Selected workflow</span>
            <strong>{selected.name}</strong>
            <small>{selected.nodes.join(" -> ")}</small>
          </div>
          <StatusPill status={selected.status} />
        </div>
        <div className="team-canvas">
          {selected.nodes.map((node, index) => (
            <div className="team-canvas-step" key={node}>
              <TeamNode
                active={activeRun?.activeNodeIndex === index}
                icon={nodeIcon(index)}
                title={node}
                detail={nodeDetail(node, index)}
              />
              {index < selected.nodes.length - 1 ? <ArrowRight className="canvas-arrow" size={28} /> : null}
            </div>
          ))}
        </div>
        <div className="loop-note">
          <RefreshCcw size={17} />
          <span>最后节点继续推进会进入下一轮，最多 {selected.maxCycles} 个 cycle。</span>
        </div>
        <div className="team-run-card">
          <div className="section-title compact">
            <Network size={16} />
            <span>Active TeamRun</span>
          </div>
          {activeRun ? (
            <>
              <div className="team-run-meta">
                <StatusPill status={activeRun.status} />
                <strong>{activeRun.id}</strong>
                <span>Cycle {activeRun.cycle} / {activeRun.maxCycles}</span>
                <span>Active node: {activeNode}</span>
              </div>
              <div className="team-guard">
                <div>
                  <ShieldCheck size={16} />
                  <strong>Max-cycle guard</strong>
                </div>
                <p>
                  {activeRun.status === "blocked"
                    ? "Handoff is blocked until user review."
                    : "Scheduler owns cycle limits before another handoff is allowed."}
                </p>
              </div>
              <code>{activeRun.handoffPayload}</code>
              <code>{activeRun.evidencePath}</code>
            </>
          ) : (
            <span className="team-empty">No team run started for selected workflow</span>
          )}
        </div>
        <div className="button-row">
          <button
            aria-label="Start selected team workflow"
            className="primary-button"
            type="button"
            onClick={onStartTeamRun}
          >
            <Play size={16} />
            Start workflow
          </button>
          <button
            aria-label={advanceLabel}
            className="ghost-button"
            disabled={!canAdvance}
            type="button"
            onClick={onAdvanceTeamRun}
          >
            <ArrowRight size={16} />
            {activeRun?.status === "blocked" ? "Max cycle reached" : "Advance handoff"}
          </button>
        </div>
      </div>
      <aside className="panel handoff-panel">
        <div className="section-title">
          <Network size={18} />
          <span>Team workflows</span>
        </div>
        {workflows.map((workflow) => (
          <button
            aria-label={`Select workflow ${workflow.name}`}
            className={workflow.id === selected.id ? "workflow-row selected" : "workflow-row"}
            key={workflow.id}
            type="button"
            onClick={() => onSelectWorkflow(workflow.id)}
          >
            <div>
              <strong>{workflow.name}</strong>
              <span>{workflow.nodes.join(" -> ")}</span>
            </div>
            <StatusPill status={workflow.status} />
            <code>{workflow.handoff}</code>
            <small>maxCycles: {workflow.maxCycles}</small>
          </button>
        ))}
      </aside>
    </section>
  );
}

function TeamNode({
  icon: Icon,
  title,
  detail,
  active,
}: {
  icon: typeof Code2;
  title: string;
  detail: string;
  active: boolean;
}) {
  return (
    <div className={active ? "team-node active" : "team-node"}>
      <Icon size={24} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function nodeIcon(index: number) {
  if (index === 0) return Code2;
  if (index === 1) return ShieldCheck;
  return GitPullRequest;
}

function nodeDetail(node: string, index: number) {
  if (node.toLowerCase().includes("qa")) return "运行验证，写 flags.qaPassed";
  if (node.toLowerCase().includes("review")) return "审核 diff，生成 commit proposal";
  if (index === 0) return "读取输入，产出 handoff payload";
  return "消费上游 handoff，更新 flags";
}
