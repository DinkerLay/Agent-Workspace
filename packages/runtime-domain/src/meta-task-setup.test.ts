import type {
  MetaProfileDefinition,
  TaskInputSchema,
  TemplateDraftRecord,
  TemplateDefinition,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  applyMetaPatchProposalToTaskSetup,
  applyMetaPatchProposalToTemplateDraft,
  appendMetaMessage,
  compileTaskGoal,
  consumeTaskSetupDraft,
  createMetaPatchProposal,
  createMetaSession,
  createTaskSetupDraft,
  rejectMetaPatchProposal,
} from "./meta-task-setup";

const now = "2026-08-09T00:00:00.000Z";

describe("Meta and Task Setup domain", () => {
  it("keeps Task Input values in schema order and compiles one deterministic Task Goal", () => {
    const draft = createTaskSetupDraft({
      taskSetupDraftId: "task_setup_draft_1",
      ownerId: "user_1",
      templateVersionId: "template_version_1",
      workspaceId: "workspace_1",
      title: "  Audit runtime  ",
      goal: "  Verify the complete\r\nvertical slice.  ",
      schema,
      taskInputValues: [
        { fieldId: "depth", value: "deep" },
        { fieldId: "audience", value: "maintainers" },
      ],
      now,
    });

    expect(draft.taskInputValues).toEqual([
      { fieldId: "audience", value: "maintainers" },
      { fieldId: "depth", value: "deep" },
    ]);
    const expected = [
      "Task title: Audit runtime",
      "Task goal:",
      "Verify the complete",
      "vertical slice.",
      "Task inputs:",
      "[audience] Audience",
      "maintainers",
      "",
      "[depth] Depth",
      "Deep [deep]",
      "",
    ].join("\n");
    const compiled = compileTaskGoal(draft, schema);
    expect(compiled).toBe(expected);
    expect([...new TextEncoder().encode(compiled)]).toEqual([...new TextEncoder().encode(expected)]);
    expect(compiled.endsWith("\n") && !compiled.endsWith("\n\n")).toBe(true);

    const consumed = consumeTaskSetupDraft(draft, "task_1", draft.revision, now);
    expect(consumed).toMatchObject({ state: "consumed", createdTaskId: "task_1", revision: 2 });
  });

  it("applies every ordered Template proposal operation in one revision and never accepts a stale partial apply", () => {
    const templateDraft = templateDraftFixture();
    const session = createMetaSession({
      metaSessionId: "meta_session_template",
      ownerId: "user_1",
      target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const proposal = createMetaPatchProposal({
      metaPatchProposalId: "meta_patch_proposal_template",
      session,
      targetRevision: templateDraft.revision,
      operations: [
        { kind: "template_profile_model_set", executionProfileId: "profile_default", value: "gpt-5.6" },
        { kind: "template_card_profile_set", agentCardId: "agent_card_worker", executionProfileId: "profile_default" },
        { kind: "template_deliverable_upsert", artifactPath: "reports/result.html", ownerAgentCardId: "agent_card_worker", description: "Verified HTML report" },
        { kind: "template_deliverable_upsert", artifactPath: "reports/obsolete.md", ownerAgentCardId: "agent_card_worker" },
        { kind: "template_deliverable_remove", artifactPath: "reports/obsolete.md" },
        { kind: "template_metadata_set", field: "title", value: "Refined runtime audit" },
      ],
      summary: "Refine the selected profile and deliverable.",
      rationale: "The user requested a browser-verifiable report.",
      validationIssues: [],
      now,
    });

    const applied = applyMetaPatchProposalToTemplateDraft({
      draft: templateDraft,
      session,
      proposal,
      expectedTargetRevision: 3,
      now,
    });

    expect(applied.draft.revision).toBe(4);
    expect(applied.draft.metadata.title).toBe("Refined runtime audit");
    expect(applied.draft.definition.executionProfiles[0]?.model).toBe("gpt-5.6");
    expect(applied.draft.definition.deliverables).toEqual([
      { artifactPath: "reports/result.html", ownerAgentCardId: "agent_card_worker", description: "Verified HTML report" },
    ]);
    expect(applied.proposal).toMatchObject({ state: "applied", appliedTargetRevision: 4 });
    expect(() => applyMetaPatchProposalToTemplateDraft({
      draft: applied.draft,
      session,
      proposal,
      expectedTargetRevision: 3,
      now,
    })).toThrow("meta_patch_target_revision_stale");
  });

  it("atomically creates, updates, removes, and reorders Runtime-owned Agent Cards", () => {
    const templateDraft = templateDraftFixture();
    const session = createMetaSession({
      metaSessionId: "meta_session_template_structure",
      ownerId: "user_1",
      target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const proposal = createMetaPatchProposal({
      metaPatchProposalId: "meta_patch_proposal_template_structure",
      session,
      targetRevision: templateDraft.revision,
      operations: [
        {
          kind: "template_card_create",
          agentCardId: "agent_card_search-1",
          cardKind: "researcher",
          title: "Search Agent 1",
          role: "Independent source search",
          executionProfileId: "profile_default",
          systemPrompt: "Research one evidence branch.",
          dispatchProfile: { title: "Search branch 1", description: "Use for the first evidence branch." },
        },
        {
          kind: "template_card_create",
          agentCardId: "agent_card_search-2",
          cardKind: "researcher",
          title: "Search Agent 2",
          executionProfileId: "profile_default",
          systemPrompt: "Research another evidence branch.",
          dispatchProfile: { title: "Search branch 2", description: "Use for the second evidence branch." },
        },
        {
          kind: "template_card_update",
          agentCardId: "agent_card_search-2",
          title: "Search Agent B",
          role: "Contradiction search",
        },
        { kind: "template_card_remove", agentCardId: "agent_card_worker" },
        { kind: "template_card_reorder", agentCardIds: ["agent_card_search-2", "agent_card_search-1"] },
      ],
      summary: "Create two independent search cards.",
      rationale: "Separate evidence branches remain independently reviewable.",
      validationIssues: [],
      now,
    });

    const applied = applyMetaPatchProposalToTemplateDraft({
      draft: templateDraft,
      session,
      proposal,
      expectedTargetRevision: templateDraft.revision,
      now,
    });

    expect(applied.draft.revision).toBe(templateDraft.revision + 1);
    expect(applied.draft.definition.agentCards).toEqual([
      {
        agentCardId: "agent_card_search-2",
        kind: "researcher",
        title: "Search Agent B",
        role: "Contradiction search",
        executionProfileId: "profile_default",
        systemPrompt: "Research another evidence branch.",
        capabilityRefs: [],
        dispatchProfile: { title: "Search branch 2", description: "Use for the second evidence branch." },
      },
      {
        agentCardId: "agent_card_search-1",
        kind: "researcher",
        title: "Search Agent 1",
        role: "Independent source search",
        executionProfileId: "profile_default",
        systemPrompt: "Research one evidence branch.",
        capabilityRefs: [],
        dispatchProfile: { title: "Search branch 1", description: "Use for the first evidence branch." },
      },
    ]);
    expect(applied.proposal).toMatchObject({ state: "applied", appliedTargetRevision: templateDraft.revision + 1 });
  });

  it("applies a Prompt edit only when its old text occurs exactly once", () => {
    const base = templateDraftFixture();
    const session = createMetaSession({
      metaSessionId: "meta_session_template_precise_edit",
      ownerId: "user_1",
      target: { kind: "template_draft", templateDraftId: base.templateDraftId },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const proposalFor = (metaPatchProposalId: string, oldText: string) => createMetaPatchProposal({
      metaPatchProposalId,
      session,
      targetRevision: base.revision,
      operations: [{
        kind: "template_card_prompt_edit",
        agentCardId: "agent_card_worker",
        oldText,
        newText: "Review claims and cite every unresolved gap.",
      }],
      summary: "Tighten one sentence.",
      rationale: "No complete Prompt replacement is needed.",
      validationIssues: [],
      now,
    });

    const applied = applyMetaPatchProposalToTemplateDraft({
      draft: base,
      session,
      proposal: proposalFor("meta_patch_proposal_precise", "Review the implementation."),
      expectedTargetRevision: base.revision,
      now,
    });
    expect(applied.draft.definition.agentCards[0]?.systemPrompt)
      .toBe("Review claims and cite every unresolved gap.");

    expect(() => applyMetaPatchProposalToTemplateDraft({
      draft: {
        ...base,
        definition: {
          ...base.definition,
          agentCards: [{ ...base.definition.agentCards[0]!, systemPrompt: "Review. Review." }],
        },
      },
      session,
      proposal: proposalFor("meta_patch_proposal_ambiguous", "Review."),
      expectedTargetRevision: base.revision,
      now,
    })).toThrow("meta_patch_text_match_ambiguous");
  });

  it("rejects removal of a deliverable owner and rejects incomplete Card reorder without mutating the Draft", () => {
    const base = templateDraftFixture();
    const templateDraft = {
      ...base,
      definition: {
        ...base.definition,
        deliverables: [{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_worker" }],
      },
    };
    const session = createMetaSession({
      metaSessionId: "meta_session_template_structure_invalid",
      ownerId: "user_1",
      target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const proposalFor = (metaPatchProposalId: string, operations: Parameters<typeof createMetaPatchProposal>[0]["operations"]) => createMetaPatchProposal({
      metaPatchProposalId,
      session,
      targetRevision: templateDraft.revision,
      operations,
      summary: "Invalid structural edit.",
      rationale: "This must fail atomically.",
      validationIssues: [],
      now,
    });

    expect(() => applyMetaPatchProposalToTemplateDraft({
      draft: templateDraft,
      session,
      proposal: proposalFor("meta_patch_proposal_remove_owner", [
        { kind: "template_card_remove", agentCardId: "agent_card_worker" },
      ]),
      expectedTargetRevision: templateDraft.revision,
      now,
    })).toThrow("meta_patch_agent_card_in_use");

    expect(() => applyMetaPatchProposalToTemplateDraft({
      draft: base,
      session,
      proposal: proposalFor("meta_patch_proposal_bad_reorder", [
        {
          kind: "template_card_create",
          agentCardId: "agent_card_search-1",
          cardKind: "researcher",
          title: "Search Agent 1",
          executionProfileId: "profile_default",
          systemPrompt: "Research one evidence branch.",
          dispatchProfile: { title: "Search branch", description: "Use for one evidence branch." },
        },
        { kind: "template_card_reorder", agentCardIds: ["agent_card_search-1"] },
      ]),
      expectedTargetRevision: base.revision,
      now,
    })).toThrow("meta_patch_agent_card_reorder_invalid");

    expect(templateDraft).toEqual({ ...base, definition: { ...base.definition, deliverables: [{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_worker" }] } });
  });

  it("keeps Template Design and Task Setup sessions isolated and rejects a whole proposal without changing its target", () => {
    const setup = createTaskSetupDraft({
      taskSetupDraftId: "task_setup_draft_2",
      ownerId: "user_1",
      templateVersionId: "template_version_1",
      workspaceId: "workspace_1",
      title: "Initial title",
      goal: "Initial goal",
      schema,
      taskInputValues: [
        { fieldId: "audience", value: "maintainers" },
        { fieldId: "depth", value: "brief" },
      ],
      now,
    });
    const session = createMetaSession({
      metaSessionId: "meta_session_setup",
      ownerId: "user_1",
      target: { kind: "task_setup_draft", taskSetupDraftId: setup.taskSetupDraftId },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const proposal = createMetaPatchProposal({
      metaPatchProposalId: "meta_patch_proposal_setup",
      session,
      targetRevision: setup.revision,
      operations: [
        { kind: "task_setup_goal_set", value: "Updated goal" },
        { kind: "task_setup_input_set", fieldId: "depth", value: "deep" },
      ],
      summary: "Update setup inputs.",
      rationale: "Keep the user in control of create/start.",
      validationIssues: [],
      now,
    });

    expect(() => applyMetaPatchProposalToTemplateDraft({
      draft: templateDraftFixture(),
      session,
      proposal,
      expectedTargetRevision: 3,
      now,
    })).toThrow("meta_session_mode_mismatch");

    const rejected = rejectMetaPatchProposal({ proposal, session, now });
    expect(rejected.state).toBe("rejected");
    expect(setup).toMatchObject({ title: "Initial title", goal: "Initial goal", revision: 1 });
    expect(() => applyMetaPatchProposalToTaskSetup({
      draft: setup,
      schema,
      session,
      proposal: rejected,
      expectedTargetRevision: 1,
      now,
    })).toThrow("meta_patch_not_pending");
  });

  it("keeps Meta messages in their object-scoped revision lane", () => {
    const session = createMetaSession({
      metaSessionId: "meta_session_messages",
      ownerId: "user_1",
      target: { kind: "task_setup_draft", taskSetupDraftId: "task_setup_draft_messages" },
      metaProfileOptionId: "meta_profile_option_deny",
      metaProfile,
      now,
    });
    const appended = appendMetaMessage({
      session,
      metaMessageId: "meta_message_user_1",
      expectedSessionRevision: 1,
      role: "user",
      content: "Refine only this Task Setup Draft.",
      now,
    });
    expect(appended.session).toMatchObject({
      revision: 2,
      target: { kind: "task_setup_draft", taskSetupDraftId: "task_setup_draft_messages" },
    });
    expect(appended.message).toMatchObject({
      metaSessionId: session.metaSessionId,
      role: "user",
      content: "Refine only this Task Setup Draft.",
      contentDigest: expect.stringMatching(/^fnv1a64:/),
    });
    expect(() => appendMetaMessage({
      session: appended.session,
      metaMessageId: "meta_message_assistant_stale",
      expectedSessionRevision: 1,
      role: "assistant",
      content: "This must not be appended on a stale lane.",
      now,
    })).toThrow("meta_session_revision_stale");
  });
});

const schema: TaskInputSchema = {
  fields: [
    { fieldId: "audience", label: "Audience", kind: "short_text", required: true },
    {
      fieldId: "depth",
      label: "Depth",
      kind: "choice",
      required: true,
      options: [
        { optionId: "brief", label: "Brief" },
        { optionId: "deep", label: "Deep" },
      ],
    },
    { fieldId: "notes", label: "Notes", kind: "long_text", required: false },
  ],
};

const metaProfile: MetaProfileDefinition = {
  metaProfileId: "meta_profile_deny",
  provider: "codex",
  model: "gpt-5.6",
  providerVersion: "0.146.0",
  protocolFingerprint: "sha256:meta-profile",
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

function templateDraftFixture(): TemplateDraftRecord {
  return {
    templateDraftId: "template_draft_1",
    metadata: { title: "Runtime audit", slug: "runtime-audit" },
    definition: templateDefinitionFixture(),
    status: "editing",
    revision: 3,
    ownerId: "user_1",
    createdAt: now,
    updatedAt: now,
  };
}

function templateDefinitionFixture(): TemplateDefinition {
  return {
    schemaVersion: 2,
    taskInputSchema: schema,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      systemPrompt: "Coordinate the audit.",
      executionProfileId: "profile_default",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "reviewer",
      title: "Reviewer",
      systemPrompt: "Review the implementation.",
      executionProfileId: "profile_default",
      capabilityRefs: [],
      dispatchProfile: { title: "Reviewer", description: "Reviews the implementation." },
    }],
    executionProfiles: [{
      executionProfileId: "profile_default",
      provider: "codex",
      model: "gpt-5.4",
      providerVersion: "0.146.0",
      protocolFingerprint: "sha256:test",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [],
  };
}
