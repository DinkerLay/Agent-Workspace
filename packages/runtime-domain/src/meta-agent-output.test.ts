import { describe, expect, it } from "vitest";
import { parseMetaAgentOutput } from "./meta-agent-output.js";

describe("Meta Agent provider output", () => {
  it("accepts one strict mode-scoped proposal without Provider-supplied Runtime identity", () => {
    expect(parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I prepared one reviewable change.",
      proposal: {
        operations: [{ kind: "template_profile_model_set", executionProfileId: "profile_worker", value: "gpt-5.6" }],
        summary: "Upgrade the worker model.",
        rationale: "The requested task needs deeper research.",
        validationIssues: [],
      },
    }), "template_design")).toEqual({
      assistantMessage: "I prepared one reviewable change.",
      proposal: {
        operations: [{ kind: "template_profile_model_set", executionProfileId: "profile_worker", value: "gpt-5.6" }],
        summary: "Upgrade the worker model.",
        rationale: "The requested task needs deeper research.",
        validationIssues: [],
      },
    });
  });

  it("rejects Markdown wrapping, identities/revisions, unknown keys, and cross-mode operations", () => {
    expect(() => parseMetaAgentOutput("```json\n{}\n```", "template_design")).toThrow("meta_provider_final_invalid_json");
    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "No.",
      metaPatchProposalId: "meta_patch_proposal_spoofed",
    }), "template_design")).toThrow("meta_provider_final_invalid");
    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "No.",
      proposal: {
        targetRevision: 99,
        operations: [{ kind: "task_setup_title_set", value: "Cross mode" }],
        summary: "Bad",
        rationale: "Bad",
        validationIssues: [],
      },
    }), "template_design")).toThrow("meta_provider_proposal_invalid");
    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "No.",
      proposal: {
        operations: [{ kind: "task_setup_title_set", value: "Cross mode" }],
        summary: "Bad",
        rationale: "Bad",
        validationIssues: [],
      },
    }), "template_design")).toThrow("meta_session_mode_mismatch");
  });
});
