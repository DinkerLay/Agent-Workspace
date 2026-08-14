import { describe, expect, it } from "vitest";
import { parseMetaAgentOutput } from "./meta-agent-output.js";

describe("Meta Agent provider output", () => {
  it("accepts one strict mode-scoped proposal without Provider-supplied Runtime identity", () => {
    expect(parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I prepared one reviewable change.",
      proposal: {
        operations: [{ kind: "template_profile_revision_select", executionProfileId: "profile_worker", profileRevisionId: "profile_revision_worker-xhigh" }],
        summary: "Upgrade the worker model.",
        rationale: "The requested task needs deeper research.",
        validationIssues: [],
      },
    }), "template_design")).toEqual({
      assistantMessage: "I prepared one reviewable change.",
      proposal: {
        operations: [{ kind: "template_profile_revision_select", executionProfileId: "profile_worker", profileRevisionId: "profile_revision_worker-xhigh" }],
        summary: "Upgrade the worker model.",
        rationale: "The requested task needs deeper research.",
        validationIssues: [],
      },
    });
  });

  it.each([
    { kind: "template_conductor_prompt_set", value: "replace everything" },
    { kind: "template_card_prompt_set", agentCardId: "agent_card_researcher", value: "replace everything" },
    { kind: "template_profile_model_set", executionProfileId: "profile_worker", value: "invented/model" },
    { kind: "template_card_profile_set", agentCardId: "agent_card_researcher", executionProfileId: "profile_other" },
    { kind: "template_card_update", agentCardId: "agent_card_researcher", systemPrompt: "replace everything" },
  ])("rejects non-localized or non-Host-issued operation $kind", (operation) => {
    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I bypassed the Template Draft tools.",
      proposal: {
        operations: [operation],
        summary: "Unsafe replacement.",
        rationale: "Unsafe replacement.",
        validationIssues: [],
      },
    }), "template_design")).toThrow();
  });

  it("accepts Card structure intent through proposal-local refs and rejects Provider-supplied Card identities", () => {
    expect(parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I prepared three independently reviewable research cards.",
      proposal: {
        operations: [
          {
            kind: "template_card_create",
            proposalRef: "search_1",
            cardKind: "researcher",
            title: "Search Agent 1",
            role: "Independent source search",
            executionProfileId: "profile_researcher",
            systemPrompt: "Research one independent branch and report evidence.",
            dispatchProfile: {
              title: "Independent search branch 1",
              description: "Use for one parallel evidence-search branch.",
            },
          },
          {
            kind: "template_card_update",
            agentCardId: "agent_card_researcher",
            title: "Lead Researcher",
          },
          {
            kind: "template_card_reorder",
            cardRefs: ["search_1", "agent_card_researcher"],
          },
        ],
        summary: "Add an independent search card.",
        rationale: "Each branch must be reviewable separately.",
        validationIssues: [],
      },
    }), "template_design")).toMatchObject({
      proposal: {
        operations: [
          expect.objectContaining({ kind: "template_card_create", proposalRef: "search_1" }),
          { kind: "template_card_update", agentCardId: "agent_card_researcher", title: "Lead Researcher" },
          { kind: "template_card_reorder", cardRefs: ["search_1", "agent_card_researcher"] },
        ],
      },
    });

    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I chose a Runtime identity.",
      proposal: {
        operations: [{
          kind: "template_card_create",
          proposalRef: "search_1",
          agentCardId: "agent_card_provider_spoofed",
          cardKind: "researcher",
          title: "Search Agent 1",
          executionProfileId: "profile_researcher",
          systemPrompt: "Search.",
          dispatchProfile: { title: "Search", description: "Search one branch." },
        }],
        summary: "Bad identity.",
        rationale: "The Provider must not allocate it.",
        validationIssues: [],
      },
    }), "template_design")).toThrow("meta_provider_operation_invalid");
  });

  it("accepts localized Prompt edits and Host Profile revision selection without a whole Prompt or forged Profile", () => {
    expect(parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "Prepared two localized changes.",
      proposal: {
        operations: [
          {
            kind: "template_card_prompt_edit",
            agentCardId: "agent_card_reviewer",
            oldText: "Return a clear pass, revise, or insufficient-evidence decision.",
            newText: "Return a clear pass, revise, or insufficient-evidence decision with cited gaps.",
          },
          {
            kind: "template_profile_revision_select",
            executionProfileId: "profile_reviewer",
            profileRevisionId: "profile_revision_reviewer-xhigh",
          },
          {
            kind: "template_deliverable_remove",
            artifactPath: "reports/obsolete.md",
          },
        ],
        summary: "Tighten one sentence and select the xhigh Host Profile.",
        rationale: "No unrelated Template field needs to change.",
        validationIssues: [],
      },
    }), "template_design")).toMatchObject({
      proposal: {
        operations: [
          expect.objectContaining({ kind: "template_card_prompt_edit" }),
          {
            kind: "template_profile_revision_select",
            executionProfileId: "profile_reviewer",
            profileRevisionId: "profile_revision_reviewer-xhigh",
          },
          {
            kind: "template_deliverable_remove",
            artifactPath: "reports/obsolete.md",
          },
        ],
      },
    });

    expect(() => parseMetaAgentOutput(JSON.stringify({
      assistantMessage: "I forged a Profile body.",
      proposal: {
        operations: [{
          kind: "template_profile_revision_select",
          executionProfileId: "profile_reviewer",
          profileRevisionId: "profile_revision_reviewer-xhigh",
          configIntent: { reasoningEffort: "xhigh" },
        }],
        summary: "Bad",
        rationale: "Provider must not author the Profile.",
        validationIssues: [],
      },
    }), "template_design")).toThrow("meta_provider_operation_invalid");
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
