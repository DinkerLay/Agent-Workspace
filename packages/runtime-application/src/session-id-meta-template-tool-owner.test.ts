import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntimeRepositories,
  SqliteRuntimeStore,
  type AcpMetaTurnRecordV3,
} from "@agent-workspace/runtime-store";
import { afterEach, describe, expect, it } from "vitest";
import { createMetaSessionV3, createTemplateDraft } from "@agent-workspace/runtime-domain";
import {
  BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
  installBuiltInTemplates,
} from "./built-in-templates.js";
import { hashDefinition, type JsonValue, type MetaMessageRecord } from "@agent-workspace/runtime-contracts";
import { createSessionIdMetaTemplateToolOwner } from "./session-id-meta-template-tool-owner.js";

const roots: string[] = [];
const NOW = "2026-08-14T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID Meta Template Draft tool owner", () => {
  it("reads stable targets and returns localized proposal operations without mutating the Draft", async () => {
    const fixture = createFixture();
    const profile = fixture.draft.definition.executionProfiles.find((entry) =>
      entry.executionProfileId === "profile_deepsearch-reviewer")!;
    if (!("profileRevisionId" in profile)) throw new Error("test_expected_v3_profile");
    const xhigh = {
      ...profile,
      profileRevisionId: "profile_revision_deepsearch-reviewer-xhigh",
      configIntent: { reasoningEffort: "xhigh" },
    };
    const owner = createSessionIdMetaTemplateToolOwner({
      templates: fixture.repositories.templateTask,
      toolOperations: fixture.repositories.configuration,
      listTemplateProfileRevisions: ({ executionProfileId }) => executionProfileId === profile.executionProfileId
        ? [profile, xhigh]
        : [],
    });
    const context = owner.createTurnContext({
      session: fixture.session,
      metaTurnId: "meta_turn_template-tool",
      targetRevision: fixture.draft.revision,
    });

    const read = await context.handleCall({
      providerCallId: "provider_call_read",
      name: "template_draft_read",
      arguments: { target: { kind: "profile", executionProfileId: profile.executionProfileId } },
      lease: context.lease,
    });
    expect(read.result).toMatchObject({
      targetRevision: fixture.draft.revision,
      profile: { profileRevisionId: profile.profileRevisionId },
      availableRevisions: [
        { profileRevisionId: profile.profileRevisionId },
        { profileRevisionId: xhigh.profileRevisionId, configIntent: { reasoningEffort: "xhigh" } },
      ],
    });

    const oldText = "Return a clear pass, revise, or insufficient-evidence decision with exact reasons.";
    const edit = await context.handleCall({
      providerCallId: "provider_call_edit",
      name: "template_draft_edit_prompt",
      arguments: {
        target: { kind: "card", agentCardId: "agent_card_deepsearch-reviewer" },
        oldText,
        newText: `${oldText} Cite every unresolved gap.`,
      },
      lease: context.lease,
    });
    expect(edit.result).toEqual({
      targetRevision: fixture.draft.revision,
      operation: {
        kind: "template_card_prompt_edit",
        agentCardId: "agent_card_deepsearch-reviewer",
        oldText,
        newText: `${oldText} Cite every unresolved gap.`,
      },
    });

    const selected = await context.handleCall({
      providerCallId: "provider_call_profile",
      name: "template_draft_select_profile",
      arguments: {
        executionProfileId: profile.executionProfileId,
        profileRevisionId: xhigh.profileRevisionId,
      },
      lease: context.lease,
    });
    expect(selected.result).toMatchObject({
      operation: {
        kind: "template_profile_revision_select",
        executionProfileId: profile.executionProfileId,
        profileRevisionId: xhigh.profileRevisionId,
      },
      selectedProfile: { configIntent: { reasoningEffort: "xhigh" } },
    });

    const metadata = await context.handleCall({
      providerCallId: "provider_call_metadata",
      name: "template_draft_update_metadata",
      arguments: { field: "description", value: "Research with explicit evidence review." },
      lease: context.lease,
    });
    expect(metadata.result).toEqual({
      targetRevision: fixture.draft.revision,
      operation: {
        kind: "template_metadata_set",
        field: "description",
        value: "Research with explicit evidence review.",
      },
    });

    const deliverable = await context.handleCall({
      providerCallId: "provider_call_deliverable",
      name: "template_draft_upsert_deliverable",
      arguments: {
        artifactPath: "reports/final.md",
        ownerAgentCardId: "agent_card_deepsearch-publisher",
        description: "Reviewed final report",
      },
      lease: context.lease,
    });
    expect(deliverable.result).toEqual({
      targetRevision: fixture.draft.revision,
      operation: {
        kind: "template_deliverable_upsert",
        artifactPath: "reports/final.md",
        ownerAgentCardId: "agent_card_deepsearch-publisher",
        description: "Reviewed final report",
      },
    });

    const removedDeliverable = await context.handleCall({
      providerCallId: "provider_call_delete_deliverable",
      name: "template_draft_delete_deliverable",
      arguments: { artifactPath: "reports/deepsearch-report.md" },
      lease: context.lease,
    });
    expect(removedDeliverable.result).toEqual({
      targetRevision: fixture.draft.revision,
      operation: {
        kind: "template_deliverable_remove",
        artifactPath: "reports/deepsearch-report.md",
      },
    });
    expect(owner.listTurnOperations("meta_turn_template-tool")).toEqual([
      (edit.result as { operation: unknown }).operation,
      (selected.result as { operation: unknown }).operation,
      (metadata.result as { operation: unknown }).operation,
      (deliverable.result as { operation: unknown }).operation,
      (removedDeliverable.result as { operation: unknown }).operation,
    ]);
    expect(fixture.repositories.templateTask.getDraft(fixture.draft.templateDraftId)).toEqual(fixture.draft);
    fixture.store.close();
  });

  it("fails closed on ambiguous text, non-Host Profile revisions, a stale Draft, and a foreign lease", async () => {
    const fixture = createFixture();
    const owner = createSessionIdMetaTemplateToolOwner({
      templates: fixture.repositories.templateTask,
      toolOperations: fixture.repositories.configuration,
      listTemplateProfileRevisions: () => [],
    });
    const context = owner.createTurnContext({
      session: fixture.session,
      metaTurnId: "meta_turn_template-tool",
      targetRevision: fixture.draft.revision,
    });
    const invoke = (name: string, args: unknown, lease: unknown = context.lease) => context.handleCall({
      providerCallId: `provider_call_${name}`,
      name,
      arguments: args,
      lease,
    });

    await expect(invoke("template_draft_edit_prompt", {
      target: { kind: "card", agentCardId: "agent_card_deepsearch-reviewer" },
      oldText: "evidence",
      newText: "traceable evidence",
    })).rejects.toThrow("meta_patch_text_match_ambiguous");
    await expect(invoke("template_draft_select_profile", {
      executionProfileId: "profile_deepsearch-reviewer",
      profileRevisionId: "profile_revision_forged",
    })).rejects.toThrow("meta_patch_profile_revision_not_host_issued");
    await expect(invoke("template_draft_read", { target: { kind: "template" } }, {}))
      .rejects.toThrow("meta_template_tool_lease_invalid");

    fixture.repositories.templateTask.updateDraft({
      ...fixture.draft,
      revision: fixture.draft.revision + 1,
      updatedAt: "2026-08-14T00:00:01.000Z",
    }, fixture.draft.revision);
    await expect(invoke("template_draft_read", { target: { kind: "template" } }))
      .rejects.toThrow("meta_patch_target_revision_stale");
    fixture.store.close();
  });
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-meta-template-tool-"));
  roots.push(root);
  const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
  const repositories = createRuntimeRepositories(store);
  installBuiltInTemplates(repositories, NOW);
  const version = repositories.templateTask.getTemplateVersion(BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID)!;
  const draft = createTemplateDraft({
    templateDraftId: "template_draft_template-tool",
    templateId: version.templateId,
    baseTemplateVersionId: version.templateVersionId,
    metadata: { title: "Deepsearch tool draft", slug: "deepsearch-tool-draft" },
    definition: version.definition,
    ownerId: "user_template-tool",
    now: NOW,
  });
  repositories.templateTask.createDraft(draft);
  const metaProfile = {
    metaProfileId: "meta_profile_template-tool",
    profileRevisionId: "profile_revision_meta-template-tool",
    providerFamily: "codex" as const,
    acpAgentKind: "codex_acp" as const,
    protocolMajor: 1 as const,
    role: "meta" as const,
    model: "gpt-5.6-luna",
    configIntent: {},
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  const session = createMetaSessionV3({
    metaSessionId: "meta_session_template-tool",
    ownerId: draft.ownerId,
    target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    metaProfileOptionId: "meta_profile_option_template-tool",
    metaProfile,
    now: NOW,
  });
  repositories.configuration.createMetaSession(session);
  const createdAt = "2026-08-14T00:00:01.000Z";
  const userMessage: MetaMessageRecord = {
    metaMessageId: "meta_message_template-tool-user",
    metaSessionId: session.metaSessionId,
    ownerId: session.ownerId,
    role: "user",
    content: "Edit the template with scoped tools.",
    contentDigest: hashDefinition("Edit the template with scoped tools."),
    createdAt,
  };
  const outputSchema: JsonValue = { type: "object" };
  const context: JsonValue = { targetRevision: draft.revision };
  const systemInstructions = "Use Template Draft tools for every mutation.";
  const turn: AcpMetaTurnRecordV3 = {
    metaTurnId: "meta_turn_template-tool",
    metaSessionId: session.metaSessionId,
    commandId: "command_template-tool",
    idempotencyKey: "template-tool",
    userMetaMessageId: userMessage.metaMessageId,
    assistantMetaMessageId: "meta_message_template-tool-assistant",
    metaPatchProposalId: "meta_patch_proposal_template-tool",
    profile: session.metaProfile,
    mode: session.mode,
    targetRevision: draft.revision,
    systemInstructions,
    systemInstructionsDigest: hashDefinition(systemInstructions),
    outputSchema,
    outputSchemaDigest: hashDefinition(outputSchema),
    context,
    contextDigest: hashDefinition(context),
    status: "pending",
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const appendedSession = { ...session, revision: session.revision + 1, updatedAt: createdAt };
  repositories.configuration.createMetaMessageAndTurn({
    session: appendedSession,
    expectedSessionRevision: session.revision,
    userMessage,
    turn,
  });
  return { store, repositories, draft, session: appendedSession };
}
