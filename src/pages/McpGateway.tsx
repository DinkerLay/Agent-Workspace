import { FileText, Network, Play, ShieldCheck } from "lucide-react";
import { StatusPill } from "../components/common";
import type { McpServer, McpToolCallDecision, McpToolCallEvent } from "../types";

export function McpGateway({
  servers,
  selectedServerId,
  toolEvents,
  onSelectServer,
  onRequestToolCall,
  onResolveToolCall,
}: {
  servers: McpServer[];
  selectedServerId: string;
  toolEvents: McpToolCallEvent[];
  onSelectServer: (serverId: string) => void;
  onRequestToolCall: (serverId: string, toolName: string) => void;
  onResolveToolCall: (eventId: string, decision: McpToolCallDecision) => void;
}) {
  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? servers[0];
  const selectedEvents = toolEvents.filter((event) => event.serverId === selectedServer.id);

  return (
    <section className="mcp-layout">
      <div className="panel mcp-main">
        <div className="section-title">
          <Network size={18} />
          <span>MCP Gateway</span>
        </div>
        <div className="mcp-summary">
          <div>
            <strong>Manual UI and agent automation share the same domain model.</strong>
            <span>
              Agents can request tools, but the shell owns project scope, permission class, evidence paths, and review
              gates.
            </span>
          </div>
          <StatusPill status="project-scoped allowlist" />
        </div>

        <div className="mcp-server-list">
          {servers.map((server) => (
            <button
              aria-label={`Select MCP server ${server.name}`}
              className={server.id === selectedServer.id ? "mcp-server-row selected" : "mcp-server-row"}
              key={server.id}
              type="button"
              onClick={() => onSelectServer(server.id)}
            >
              <div>
                <strong>{server.name}</strong>
                <span>{server.futureStore}</span>
                <div className="mcp-tool-preview">
                  {server.tools.map((tool) => (
                    <small key={tool.name}>{tool.name}</small>
                  ))}
                </div>
              </div>
              <StatusPill status={server.status} />
            </button>
          ))}
        </div>
      </div>

      <aside className="panel mcp-detail">
        <div className="mcp-detail-head">
          <div>
            <span className="eyebrow">Selected server</span>
            <h2>{selectedServer.name}</h2>
          </div>
          <StatusPill status={selectedServer.phase} />
        </div>

        <div className="mcp-guardrails">
          <div className="section-title compact">
            <ShieldCheck size={16} />
            <span>Guardrails</span>
          </div>
          {selectedServer.guardrails.map((guardrail) => (
            <span key={guardrail}>{guardrail}</span>
          ))}
        </div>

        <div className="mcp-tool-grid">
          {selectedServer.tools.map((tool) => (
            <article className="mcp-tool-card" key={tool.name}>
              <div className="mcp-tool-head">
                <FileText size={16} />
                <strong>{tool.name}</strong>
                <StatusPill status={tool.permission} />
              </div>
              <p>{tool.purpose}</p>
              <code>{tool.evidence}</code>
              <span>{tool.targetSurface}</span>
              <button
                aria-label={`Request MCP tool call ${tool.name}`}
                className="small-action"
                type="button"
                onClick={() => onRequestToolCall(selectedServer.id, tool.name)}
              >
                <Play size={14} />
                Request tool call
              </button>
            </article>
          ))}
        </div>

        <div className="mcp-audit">
          <div className="section-title compact">
            <FileText size={16} />
            <span>Tool call audit</span>
          </div>
          {selectedEvents.length === 0 ? (
            <div className="mcp-event-card empty">
              <span>No tool call requested yet.</span>
            </div>
          ) : (
            selectedEvents.map((event) => (
              <article className="mcp-event-card" key={event.id}>
                <div className="mcp-event-head">
                  <strong>{event.toolName}</strong>
                  <StatusPill status={event.status} />
                </div>
                <p>{event.summary}</p>
                <div className="mcp-event-meta">
                  <span>{event.permission}</span>
                  <span>{event.targetSurface}</span>
                </div>
                <code>Evidence {event.evidencePath}</code>
                {event.decisionSummary ? <p>{event.decisionSummary}</p> : null}
                {event.decisionEvidencePath ? <code>{event.decisionEvidencePath}</code> : null}
                {event.status === "confirmation-required" ? (
                  <div className="button-row">
                    <button
                      aria-label={`Approve MCP tool call ${event.id}`}
                      className="small-action"
                      type="button"
                      onClick={() => onResolveToolCall(event.id, "approved")}
                    >
                      Approve
                    </button>
                    <button
                      aria-label={`Deny MCP tool call ${event.id}`}
                      className="small-action"
                      type="button"
                      onClick={() => onResolveToolCall(event.id, "denied")}
                    >
                      Deny
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          )}
        </div>
      </aside>
    </section>
  );
}
