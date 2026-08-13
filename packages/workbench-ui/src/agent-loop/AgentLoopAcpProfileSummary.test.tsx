// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpProfileReadinessObservation } from "@agent-workspace/runtime-contracts";
import { AgentLoopAcpProfileSummary } from "./AgentLoopAcpProfileSummary";

afterEach(cleanup);

describe("AgentLoopAcpProfileSummary", () => {
  it("renders only the Host-safe ACP observation and capability summary", () => {
    render(<AgentLoopAcpProfileSummary
      allowedTools={["workspace.write"]}
      permissionMode="ask"
      readiness={readiness()}
      requiredCapabilities={["create_binding", "interrupt"]}
      requiredExtensions={["session/load"]}
      title="Execution Profile"
    />);

    const profile = screen.getByRole("region", { name: "Execution Profile" });
    expect(within(profile).getByText("Codex")).toBeTruthy();
    expect(within(profile).getByText("Codex ACP")).toBeTruthy();
    expect(within(profile).getByText("gpt-5.6-sol")).toBeTruthy();
    expect(within(profile).getByText("codex-acp 0.9.4")).toBeTruthy();
    expect(within(profile).getByText("0.147.0")).toBeTruthy();
    expect(within(profile).getAllByText("create_binding, interrupt")).toHaveLength(2);
    expect(within(profile).getAllByText("session/load")).toHaveLength(2);
    expect(within(profile).getByText("ask · workspace.write")).toBeTruthy();
    expect(profile.textContent).not.toMatch(/sha256|fingerprint|launcher|\/Users\//iu);
  });

  it("keeps a capability-missing Profile visible without deriving availability", () => {
    const observation: AcpProfileReadinessObservation = {
      ...readiness(),
      status: "capability_missing",
      reasons: ["acp_capability_missing"],
      missingCapabilities: ["interrupt"],
      observedCapabilities: ["create_binding"],
    };
    render(<AgentLoopAcpProfileSummary
      readiness={observation}
      requiredCapabilities={["create_binding", "interrupt"]}
      requiredExtensions={[]}
      title="Unavailable Profile"
    />);

    const profile = screen.getByRole("region", { name: "Unavailable Profile" });
    expect(within(profile).getByText("能力缺失")).toBeTruthy();
    expect(within(profile).getByText("acp_capability_missing")).toBeTruthy();
    expect(within(profile).getByText("Missing capabilities: interrupt")).toBeTruthy();
  });
});

function readiness(): AcpProfileReadinessObservation {
  return {
    profileRevisionId: "profile_revision_codex-starter-v1",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    role: "conductor",
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: "gpt-5.6-sol",
    observedProtocolMajor: 1,
    observedAgent: { name: "codex-acp", title: "codex-acp", version: "0.9.4" },
    observedArtifactVersion: "0.9.4",
    observedUpstreamVersion: "0.147.0",
    observedCapabilities: ["create_binding", "interrupt"],
    observedExtensions: ["session/load"],
  };
}
