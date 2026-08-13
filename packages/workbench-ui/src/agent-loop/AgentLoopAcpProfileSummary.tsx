import type { AcpProfileReadinessObservation } from "@agent-workspace/runtime-contracts";

export type AgentLoopAcpProfileSummaryProps = Readonly<{
  readiness: AcpProfileReadinessObservation;
  title: string;
  permissionMode?: "ask" | "preapproved" | "deny";
  allowedTools?: readonly string[];
  requiredCapabilities: readonly string[];
  requiredExtensions: readonly string[];
  className?: string;
}>;

/**
 * One provider-neutral rendering of the Host's safe ACP observation. The
 * Renderer does not turn family/model/version strings into authority: action
 * gates must use the exact `readiness.status` supplied by the Host.
 */
export function AgentLoopAcpProfileSummary({
  allowedTools = [],
  className = "",
  permissionMode,
  readiness,
  requiredCapabilities,
  requiredExtensions,
  title,
}: AgentLoopAcpProfileSummaryProps) {
  const agent = readiness.observedAgent;
  const agentLabel = agent
    ? [agent.title ?? agent.name, agent.version].filter(Boolean).join(" ")
    : "Not observed";
  return <section
    aria-label={title}
    className={`awb-agent-loop-acp-profile is-${readiness.status} ${className}`.trim()}
    data-profile-revision-id={readiness.profileRevisionId}
  >
    <header>
      <strong>{title}</strong>
      <span>{readinessLabel(readiness.status)}</span>
    </header>
    <dl>
      <div><dt>Profile revision</dt><dd>{readiness.profileRevisionId}</dd></div>
      <div><dt>Provider family</dt><dd>{providerLabel(readiness.providerFamily)}</dd></div>
      <div><dt>ACP Agent</dt><dd>{agentKindLabel(readiness.acpAgentKind)}</dd></div>
      <div><dt>Model</dt><dd>{readiness.model}</dd></div>
      <div><dt>Observed Agent</dt><dd>{agentLabel}</dd></div>
      <div><dt>Artifact</dt><dd>{readiness.observedArtifactVersion ?? "Not observed"}</dd></div>
      <div><dt>Upstream</dt><dd>{readiness.observedUpstreamVersion ?? "Not observed"}</dd></div>
      <div><dt>ACP protocol</dt><dd>{readiness.observedProtocolMajor === undefined ? "Not observed" : `v${readiness.observedProtocolMajor}`}</dd></div>
      <div><dt>Required capabilities</dt><dd>{listLabel(requiredCapabilities)}</dd></div>
      <div><dt>Required extensions</dt><dd>{listLabel(requiredExtensions)}</dd></div>
      <div><dt>Observed capabilities</dt><dd>{listLabel(readiness.observedCapabilities ?? [])}</dd></div>
      <div><dt>Observed extensions</dt><dd>{listLabel(readiness.observedExtensions ?? [])}</dd></div>
      {permissionMode ? <div><dt>Permission / Tools</dt><dd>{permissionMode} · {allowedTools.length ? allowedTools.join(", ") : "no tools"}</dd></div> : null}
    </dl>
    {readiness.reasons.length ? <ul aria-label="Host readiness reasons">
      {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
    </ul> : null}
    {readiness.missingCapabilities.length ? <p>Missing capabilities: {readiness.missingCapabilities.join(", ")}</p> : null}
    {readiness.missingExtensions.length ? <p>Missing extensions: {readiness.missingExtensions.join(", ")}</p> : null}
  </section>;
}

export function providerLabel(providerFamily: AcpProfileReadinessObservation["providerFamily"]): string {
  switch (providerFamily) {
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "claude-code": return "Claude Code";
  }
}

export function agentKindLabel(acpAgentKind: AcpProfileReadinessObservation["acpAgentKind"]): string {
  switch (acpAgentKind) {
    case "native_acp": return "Native ACP";
    case "codex_acp": return "Codex ACP";
    case "claude_agent_acp": return "Claude Agent ACP";
  }
}

export function readinessLabel(status: AcpProfileReadinessObservation["status"]): string {
  switch (status) {
    case "available": return "可用";
    case "checking": return "检查中";
    case "capability_missing": return "能力缺失";
    case "unavailable": return "不可用";
  }
}

function listLabel(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}
