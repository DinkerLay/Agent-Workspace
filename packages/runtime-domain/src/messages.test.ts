import { describe, expect, it } from "vitest";
import { renderAgentAssignment } from "./messages.js";

describe("renderAgentAssignment", () => {
  it("renders requested project artifacts into the immutable Worker assignment", () => {
    const rendered = renderAgentAssignment({
      instruction: "Research NVDA and produce the requested deliverable.",
      acceptanceCriteria: ["Use cited evidence", "Include a risk section"],
      requestedArtifacts: ["reports/NVDA-deepsearch.html"],
      selections: [],
    });

    expect(rendered).toContain("## 请求产物");
    expect(rendered).toContain("- reports/NVDA-deepsearch.html");
    expect(rendered).toContain("Artifact: <项目相对路径>");
  });

  it("rejects absolute, parent-traversing, duplicate, or blank artifact requests", () => {
    const base = {
      instruction: "Produce the report.",
      acceptanceCriteria: ["Return a final"],
      selections: [],
    } as const;

    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: ["/tmp/report.html"] })).toThrow("invocation_requested_artifact_path_invalid");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: ["../report.html"] })).toThrow("invocation_requested_artifact_path_invalid");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: ["reports/result.html", "reports/result.html"] })).toThrow("invocation_requested_artifact_duplicate");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: [" "] })).toThrow("invocation_requested_artifact_path_invalid");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: Array.from({ length: 33 }, (_, index) => `reports/${index}.html`) })).toThrow("invocation_requested_artifact_count_invalid");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: Array.from({ length: 32 }, (_, index) => `reports/${index}-${"x".repeat(300)}.html`) })).toThrow("invocation_requested_artifact_total_length_exceeded");
    expect(() => renderAgentAssignment({ ...base, requestedArtifacts: ["reports/cafe\u0301.html", "reports/caf\u00e9.html"] })).toThrow("invocation_requested_artifact_duplicate");
  });
});
