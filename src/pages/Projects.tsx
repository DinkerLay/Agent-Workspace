import {
  ArrowRight,
  Bot,
  Command,
  FolderOpen,
  Globe2,
  MapPinned,
  Plus,
  SquareTerminal,
  UserPlus,
} from "lucide-react";
import { StatusPill } from "../components/common";
import type {
  Agent,
  AgentCluster,
  AgentProfileEvent,
  AgentRun,
  AgentTemplate,
  DevCommand,
  Project,
  ProjectContextEvent,
  Task,
} from "../types";

export function Projects({
  agents,
  agentClusters,
  agentTemplates,
  agentProfileEvents,
  commands,
  projectContextEvents,
  projects,
  runs,
  selectedProjectId,
  tasks,
  onAddAgent,
  onOpenWorkbench,
  onSelectProject,
}: {
  agents: Agent[];
  agentClusters: AgentCluster[];
  agentTemplates: AgentTemplate[];
  agentProfileEvents: AgentProfileEvent[];
  commands: DevCommand[];
  projectContextEvents: ProjectContextEvent[];
  projects: Project[];
  runs: AgentRun[];
  selectedProjectId: string;
  tasks: Task[];
  onAddAgent: (templateId: string) => void;
  onOpenWorkbench: () => void;
  onSelectProject: (projectId: string) => void;
}) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const projectClusters = selectedProject.agentClusterIds
    .map((clusterId) => agentClusters.find((cluster) => cluster.id === clusterId))
    .filter((cluster): cluster is AgentCluster => Boolean(cluster));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const projectAgentCount = projectClusters.reduce((count, cluster) => count + cluster.agentIds.length, 0);
  const projectTasks = tasks.filter((task) => selectedProject.taskIds.includes(task.id));
  const projectCommands = commands.filter((command) => selectedProject.commandIds.includes(command.id));
  const activeRuns = runs.filter((run) =>
    projectTasks.some((task) => task.id === run.taskId && run.status !== "completed"),
  );
  const projectZones = groupProjectsByZone(projects);
  const recentContextEvents = [...projectContextEvents]
    .filter((event) => event.projectId === selectedProject.id)
    .reverse()
    .slice(0, 3);
  const recentProfileEvents = [...agentProfileEvents]
    .filter((event) => event.projectId === selectedProject.id)
    .reverse()
    .slice(0, 3);

  return (
    <section className="projects-layout">
      <div className="panel projects-main">
        <div className="section-title">
          <FolderOpen size={18} />
          <span>项目驾驶舱</span>
        </div>
        <div className="project-card-list">
          {projectZones.map(({ zone, items }) => (
            <div className="project-zone-group" key={zone}>
              <div className="project-zone-head">
                <strong>{zone} zone</strong>
                <span>{items.length} projects</span>
              </div>
              {items.map((project) => (
                <button
                  aria-label={`选择项目 ${project.name}`}
                  className={project.id === selectedProject.id ? "project-card-row selected" : "project-card-row"}
                  key={project.id}
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                >
                  <div>
                    <strong>{project.name}</strong>
                    <span>{project.path}</span>
                  </div>
                  <StatusPill status={project.status} />
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="project-signal-grid">
          <ProjectSignal icon={Bot} label="agent clusters" value={`${projectClusters.length} clusters / ${projectAgentCount} agents`} />
          <ProjectSignal icon={Command} label="dev command sessions" value={String(projectCommands.length)} />
          <ProjectSignal icon={Globe2} label="project-scoped browser state" value={selectedProject.browserProfile} />
          <ProjectSignal icon={SquareTerminal} label="active run surfaces" value={String(activeRuns.length)} />
        </div>

        <div className="project-task-grid">
          {projectTasks.map((task) => (
            <article className="project-task-card" key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <span>{task.source}</span>
              </div>
              <StatusPill status={task.status} />
            </article>
          ))}
        </div>
      </div>

      <aside className="panel project-inspector">
        <div className="project-context">
          <MapPinned size={18} />
          <div>
            <span className="eyebrow">已选上下文</span>
            <strong>{selectedProject.zone}</strong>
            <code>工作区路径: {selectedProject.path}</code>
            <code>manifest: .agent-workspace/projects/{selectedProject.id}.json</code>
          </div>
        </div>

        <div className="project-context-audit">
          <div className="section-title compact">
            <MapPinned size={16} />
            <span>工作区上下文审计</span>
          </div>
          {recentContextEvents.length ? (
            recentContextEvents.map((event) => (
              <article className="project-context-event" key={event.id}>
                <div>
                  <strong>{event.summary}</strong>
                  <StatusPill status={event.zone} />
                </div>
                <small>{event.selectedAt}</small>
                <code>{event.manifestPath}</code>
                <code>{event.browserProfile}</code>
              </article>
            ))
          ) : (
            <span className="project-context-empty">还没有记录项目上下文事件</span>
          )}
        </div>

        <div className="project-roster">
          <strong>Agent 集群</strong>
          {projectClusters.map((cluster) => (
            <article className="project-cluster-card" key={cluster.id}>
              <div className="project-cluster-head">
                <div>
                  <strong>{cluster.name}</strong>
                  <small>
                    {cluster.level === "project-default" ? "Project Runtime / 内部默认集群" : `Task / ${cluster.taskId}`}
                  </small>
                </div>
                <StatusPill status={cluster.level === "project-default" ? "project default" : "task group"} />
              </div>
              <code>{cluster.evidencePath}</code>
              <div className="project-cluster-agents">
                {cluster.agentIds
                  .map((agentId) => agentsById.get(agentId))
                  .filter((agent): agent is Agent => Boolean(agent))
                  .map((agent) => (
                    <div className="project-agent-card" key={agent.id}>
                      <span style={{ backgroundColor: agent.accent }}>{agent.name.slice(0, 1)}</span>
                      <div>
                        <strong>{agent.name}</strong>
                        <small>
                          {agent.provider} / {agent.model}
                        </small>
                      </div>
                      <StatusPill status={agent.status} />
                    </div>
                  ))}
              </div>
            </article>
          ))}
        </div>

        <div className="agent-setup-panel">
          <div className="section-title compact">
            <UserPlus size={16} />
            <span>Agent 配置</span>
          </div>
          {agentTemplates.map((template) => (
            <article className="agent-template-card" key={template.id}>
              <div className="agent-template-head">
                <span className="agent-avatar" style={{ backgroundColor: template.accent }}>
                  {template.name[0]}
                </span>
                <div>
                  <strong>{template.name}</strong>
                  <small>
                    {template.provider} / {template.model}
                  </small>
                </div>
                <StatusPill status={template.worktreePolicy} />
              </div>
              <code>{template.systemPromptPath}</code>
              <button
                aria-label={`从模板添加 Agent ${template.name}`}
                className="small-action"
                type="button"
                onClick={() => onAddAgent(template.id)}
              >
                <Plus size={14} />
                添加 Agent
              </button>
            </article>
          ))}
        </div>

        <div className="agent-profile-audit">
          <div className="section-title compact">
            <Bot size={16} />
            <span>Agent profile 审计</span>
          </div>
          {recentProfileEvents.length ? (
            recentProfileEvents.map((event) => (
              <article className="agent-profile-event" key={event.id}>
                <div>
                  <strong>{event.summary}</strong>
                  <StatusPill status={event.worktreePolicy} />
                </div>
                <small>{event.createdAt}</small>
                <code>{event.systemPromptPath}</code>
                <code>{event.manifestPath}</code>
              </article>
            ))
          ) : (
            <span className="agent-profile-empty">还没有记录 Agent profile 事件</span>
          )}
        </div>

        <div className="project-command-list">
          <strong>Commands</strong>
          {projectCommands.map((command) => (
            <div className="project-command-card" key={command.id}>
              <div>
                <strong>{command.name}</strong>
                <code>{command.command}</code>
              </div>
              <StatusPill status={command.status} />
            </div>
          ))}
        </div>

        <button
          aria-label="打开所选项目工作台"
          className="primary-button wide"
          type="button"
          onClick={onOpenWorkbench}
        >
          打开所选项目工作台
          <ArrowRight size={16} />
        </button>
      </aside>
    </section>
  );
}

function groupProjectsByZone(projects: Project[]) {
  const zoneOrder: Project["zone"][] = ["work", "personal", "side-project"];
  return zoneOrder
    .map((zone) => ({
      zone,
      items: projects.filter((project) => project.zone === zone),
    }))
    .filter((group) => group.items.length > 0);
}

function ProjectSignal({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
}) {
  return (
    <div className="project-signal">
      <Icon size={17} />
      <div>
        <strong>{label}</strong>
        <span>{value}</span>
      </div>
    </div>
  );
}
