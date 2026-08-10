import type {
  MetaPatchProposalRecord,
  RuntimeCommand,
  RuntimeReadModel,
  TaskSetupDraftRecord,
  TemplateDefinition,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient } from "@agent-workspace/runtime-client";
import { describe, expect, it, vi } from "vitest";
import { createAgentLoopConfigurationController } from "./agent-loop-configuration-controller";

describe("AgentLoopConfigurationController", () => {
  it("projects only the selected Draft's Meta facts and keeps the Host option identity opaque", async () => {
    const model = runtimeModel();
    const controller = createAgentLoopConfigurationController({
      client: client(model),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });

    const view = await controller.meta.load({
      kind: "template_design",
      draftId: "template_draft_1",
      draftRevision: 4,
    });

    expect(view.profileOptions).toEqual([{
      metaProfileOptionId: "meta_profile_option_1",
      label: "Codex Meta",
      detail: "codex · gpt-5.6 · 1.0.0",
      readiness: "available",
      unavailableReasons: [],
    }]);
    expect(JSON.stringify(view.profileOptions)).not.toContain("meta_profile_internal");
    expect(view.session).toMatchObject({
      metaSessionId: "meta_session_1",
      revision: 3,
      status: "active",
      messages: [
        { messageId: "meta_message_user", role: "user", content: "Change the worker model." },
        { messageId: "meta_message_assistant", role: "assistant", content: "I prepared a patch." },
      ],
    });
    expect(view.proposals).toEqual([expect.objectContaining({
      proposalId: "meta_patch_proposal_1",
      baseDraftRevision: 4,
      status: "pending",
      summary: "Use the research model",
      fieldDiffs: [expect.objectContaining({
        path: "definition.executionProfiles[profile_worker].model",
        operation: "replace",
        before: "gpt-5.6-mini",
        after: "gpt-5.6",
      })],
    })]);
  });

  it("submits typed Meta commands and never fabricates an assistant message or proposal", async () => {
    const calls: RuntimeCommand[] = [];
    const model = runtimeModel();
    const controller = createAgentLoopConfigurationController({
      client: client(model, async (command) => {
        calls.push(command);
        return receipt(command);
      }),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });
    const scope = { kind: "task_setup" as const, draftId: "task_setup_draft_1", draftRevision: 2 };

    await controller.meta.createSession({ scope, metaProfileOptionId: "meta_profile_option_1" });
    await controller.meta.sendMessage({
      scope,
      metaSessionId: "meta_session_setup",
      expectedSessionRevision: 5,
      content: "Return an HTML deliverable.",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      type: "meta.create_session",
      ownerId: "user_1",
      metaProfileOptionId: "meta_profile_option_1",
      target: { kind: "task_setup_draft", taskSetupDraftId: "task_setup_draft_1" },
    });
    expect(calls[1]).toMatchObject({
      type: "meta.send_message",
      ownerId: "user_1",
      metaSessionId: "meta_session_setup",
      expectedSessionRevision: 5,
      expectedTargetRevision: 2,
      idempotencyKey: "command_2",
      content: "Return an HTML deliverable.",
    });
    expect(calls[1]).not.toHaveProperty("metaMessageId");
    expect(calls.every((call) => call.type !== "meta.apply_patch")).toBe(true);
  });

  it("reuses the complete command envelope after an ambiguous bridge outcome", async () => {
    const calls: RuntimeCommand[] = [];
    let attempt = 0;
    const times = ["2026-08-09T00:00:00.000Z", "2026-08-09T00:00:09.000Z"];
    const controller = createAgentLoopConfigurationController({
      client: client(runtimeModel(), async (command) => {
        calls.push(command);
        attempt += 1;
        if (attempt === 1) throw new Error("bridge_outcome_ambiguous");
        return receipt(command);
      }),
      ownerId: "user_1",
      now: () => times[Math.min(attempt, times.length - 1)]!,
      createRuntimeId: deterministicIds(),
    });
    const input = {
      scope: { kind: "task_setup" as const, draftId: "task_setup_draft_1", draftRevision: 2 },
      metaSessionId: "meta_session_setup",
      expectedSessionRevision: 5,
      content: "Return an HTML deliverable.",
    };

    await expect(controller.meta.sendMessage(input)).rejects.toThrow("bridge_outcome_ambiguous");
    await expect(controller.meta.sendMessage(input)).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]?.issuedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(calls[1]).toMatchObject({
      commandId: "command_1",
      idempotencyKey: "command_1",
    });
  });

  it("subscribes the Meta surface only to configuration invalidations", async () => {
    let listener: ((invalidation: Parameters<Parameters<RuntimeClient["subscribe"]>[1]>[0]) => void) | undefined;
    const changed = vi.fn();
    const runtimeClient = client(runtimeModel());
    runtimeClient.subscribe = vi.fn(async (_request, next) => {
      listener = next;
      return () => undefined;
    });
    const controller = createAgentLoopConfigurationController({
      client: runtimeClient,
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });

    await controller.meta.subscribe?.(changed);
    listener?.({ type: "runtime.invalidated", sequence: 1, occurredAt: NOW, reasons: ["task_changed"] });
    listener?.({ type: "runtime.invalidated", sequence: 2, occurredAt: NOW, reasons: ["configuration_changed"] });

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an ambiguous Meta envelope after the target scope revision changes", async () => {
    const calls: RuntimeCommand[] = [];
    let attempt = 0;
    const controller = createAgentLoopConfigurationController({
      client: client(runtimeModel(), async (command) => {
        calls.push(command);
        attempt += 1;
        if (attempt === 1) throw new Error("bridge_outcome_ambiguous");
        return receipt(command);
      }),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });
    const base = {
      metaSessionId: "meta_session_setup",
      expectedSessionRevision: 5,
      content: "Return an HTML deliverable.",
    };

    await expect(controller.meta.sendMessage({
      ...base,
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 2 },
    })).rejects.toThrow("bridge_outcome_ambiguous");
    await controller.meta.sendMessage({
      ...base,
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 3 },
    });

    expect(calls.map((command) => command.commandId)).toEqual(["command_1", "command_2"]);
    expect(calls[0]).toMatchObject({ expectedTargetRevision: 2, idempotencyKey: "command_1" });
    expect(calls[1]).toMatchObject({ expectedTargetRevision: 3, idempotencyKey: "command_2" });
  });

  it("applies or rejects only the selected whole proposal with the current Draft revision fence", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopConfigurationController({
      client: client(runtimeModel(), async (command) => {
        calls.push(command);
        return receipt(command);
      }),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });
    const scope = { kind: "template_design" as const, draftId: "template_draft_1", draftRevision: 4 };

    await controller.meta.applyPatch({ scope, proposalId: "meta_patch_proposal_1", expectedDraftRevision: 4 });
    await controller.meta.rejectPatch({ scope, proposalId: "meta_patch_proposal_1", expectedDraftRevision: 4 });

    expect(calls).toEqual([
      expect.objectContaining({
        type: "meta.apply_patch",
        ownerId: "user_1",
        metaSessionId: "meta_session_1",
        metaPatchProposalId: "meta_patch_proposal_1",
        expectedTargetRevision: 4,
      }),
      expect.objectContaining({
        type: "meta.reject_patch",
        ownerId: "user_1",
        metaSessionId: "meta_session_1",
        metaPatchProposalId: "meta_patch_proposal_1",
      }),
    ]);
  });

  it("loads the exact historical Version and preserves ordered Task input fields", async () => {
    const reads: unknown[] = [];
    const model = runtimeModel();
    const controller = createAgentLoopConfigurationController({
      client: client(model, undefined, async (request) => {
        reads.push(request);
        return request?.templateId === "template_1" ? modelWithSelectedTemplate(model) : model;
      }),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });

    const view = await controller.taskSetup("task_setup_draft_1").load();

    expect(view.draft.templateVersion).toEqual({
      templateId: "template_1",
      templateVersionId: "template_version_1",
      templateTitle: "DeepSearch",
      version: 1,
    });
    expect(view.draft.schemaFields.map((field) => [field.fieldId, field.value])).toEqual([
      ["ticker", "600900"],
      ["format", "html"],
    ]);
    expect(view.draft.schemaFields[1]).toMatchObject({
      kind: "choice",
      options: [{ optionId: "markdown", label: "Markdown" }, { optionId: "html", label: "HTML" }],
    });
    expect(view.profileOptions.every((profile) => profile.readiness === "available")).toBe(true);
    expect(reads).toContainEqual({ templateId: "template_1" });
  });

  it("fails a Task Setup profile closed when the exact Version readiness is unavailable", async () => {
    const base = runtimeModel();
    const model: RuntimeReadModel = {
      ...base,
      configuration: {
        ...base.configuration,
        executionProfileReadiness: base.configuration.executionProfileReadiness.map((entry) =>
          entry.templateVersionId === "template_version_1" && entry.executionProfileId === "profile_worker"
            ? {
                ...entry,
                status: "version_mismatch",
                unavailableReasons: ["provider_version_mismatch"],
              }
            : entry,
        ),
      },
    };
    const controller = createAgentLoopConfigurationController({
      client: client(model, undefined, async (request) =>
        request?.templateId === "template_1" ? modelWithSelectedTemplate(model) : model,
      ),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });

    const view = await controller.taskSetup("task_setup_draft_1").load();

    expect(view.profileOptions.find((profile) => profile.executionProfileId === "profile_conductor")).toMatchObject({ readiness: "available" });
    expect(view.profileOptions.find((profile) => profile.executionProfileId === "profile_worker")).toMatchObject({
      readiness: "version_mismatch",
      unavailableReasons: ["provider_version_mismatch"],
    });
  });

  it("saves ordered values, creates from the durable Setup, and does not start the Task", async () => {
    const calls: RuntimeCommand[] = [];
    let model = runtimeModel();
    const runtimeClient = client(model, async (command) => {
      calls.push(command);
      if (command.type === "task_setup.save_draft") {
        const current = model.configuration.taskSetupDrafts[0]!;
        const saved: TaskSetupDraftRecord = {
          ...current,
          workspaceId: command.workspaceId,
          title: command.title,
          goal: command.goal,
          taskInputValues: command.taskInputValues,
          revision: current.revision + 1,
          updatedAt: NOW,
        };
        model = withSetupDraft(model, saved);
        return { ...receipt(command), taskSetupDraft: saved };
      }
      return receipt(command);
    }, async (request) => request?.templateId === "template_1" ? modelWithSelectedTemplate(model) : model);
    const controller = createAgentLoopConfigurationController({
      client: runtimeClient,
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });
    const setup = controller.taskSetup("task_setup_draft_1");

    const saved = await setup.saveDraft({
      taskSetupDraftId: "task_setup_draft_1",
      expectedRevision: 2,
      workspaceId: "workspace_1",
      title: "Yangtze Power research",
      goal: "Produce a reviewed HTML result.",
      schemaValues: { format: "html", ticker: "600900" },
    });
    const taskId = await setup.createTask({ taskSetupDraftId: "task_setup_draft_1", expectedRevision: saved.draft.revision });

    expect(calls[0]).toMatchObject({
      type: "task_setup.save_draft",
      ownerId: "user_1",
      taskInputValues: [
        { fieldId: "ticker", value: "600900" },
        { fieldId: "format", value: "html" },
      ],
    });
    expect(calls[1]).toMatchObject({
      type: "task.create",
      taskId,
      ownerId: "user_1",
      workspaceId: "workspace_1",
      taskSetupDraftId: "task_setup_draft_1",
      expectedTaskSetupRevision: 3,
    });
    expect(calls.map((call) => call.type)).not.toContain("task.start");
  });

  it("creates a durable Setup Draft before Task creation", async () => {
    const calls: RuntimeCommand[] = [];
    const created = { ...runtimeModel().configuration.taskSetupDrafts[0]!, taskSetupDraftId: "task_setup_draft_created" };
    const controller = createAgentLoopConfigurationController({
      client: client(runtimeModel(), async (command) => {
        calls.push(command);
        return command.type === "task_setup.create_draft"
          ? { ...receipt(command), taskSetupDraft: created }
          : receipt(command);
      }),
      ownerId: "user_1",
      now: () => NOW,
      createRuntimeId: deterministicIds(),
    });

    const draftId = await controller.createTaskSetupDraft({
      templateVersionId: "template_version_1",
      workspaceId: "workspace_1",
      title: "Yangtze Power research",
      goal: "Research fundamentals and return HTML.",
    });

    expect(draftId).toBe("task_setup_draft_created");
    expect(calls).toEqual([expect.objectContaining({
      type: "task_setup.create_draft",
      ownerId: "user_1",
      templateVersionId: "template_version_1",
      workspaceId: "workspace_1",
      taskInputValues: [],
    })]);
  });
});

const NOW = "2026-08-09T00:00:00.000Z";

function client(
  model: RuntimeReadModel,
  command?: RuntimeClient["command"],
  read?: RuntimeClient["read"],
): RuntimeClient {
  return {
    read: read ?? (async () => model),
    command: command ?? (async (input) => receipt(input)),
    subscribe: async () => () => undefined,
  };
}

function receipt(command: RuntimeCommand) {
  return { receipt: { commandId: command.commandId, acceptedAt: NOW } };
}

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}_${++sequence}`;
}

function runtimeModel(): RuntimeReadModel {
  const template = templateRecord();
  const frozenDefinition = definition();
  const taskSetupDraft: TaskSetupDraftRecord = {
    taskSetupDraftId: "task_setup_draft_1",
    ownerId: "user_1",
    templateVersionId: "template_version_1",
    workspaceId: "workspace_1",
    title: "Yangtze Power research",
    goal: "Research fundamentals.",
    taskInputValues: [{ fieldId: "ticker", value: "600900" }, { fieldId: "format", value: "html" }],
    state: "draft",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    generatedAt: NOW,
    configuration: {
      executionProfileReadiness: ["template_version_1", "template_version_2"].flatMap((templateVersionId) =>
        frozenDefinition.executionProfiles.map((profile) => ({
          templateVersionId,
          executionProfileId: profile.executionProfileId,
          status: "available" as const,
          unavailableReasons: [],
          missingCapabilities: [],
        })),
      ),
      metaProfileOptions: [{
        metaProfileOptionId: "meta_profile_option_1",
        title: "Codex Meta",
        availability: "available",
        profile: { provider: "codex", model: "gpt-5.6", providerVersion: "1.0.0", protocolFingerprint: "codex-v1" },
      }],
      taskSetupDrafts: [taskSetupDraft],
      metaSessions: [metaSession("meta_session_1", "template_design", { kind: "template_draft", templateDraftId: "template_draft_1" })],
      metaMessages: [
        { metaMessageId: "meta_message_user", metaSessionId: "meta_session_1", ownerId: "user_1", role: "user", content: "Change the worker model.", contentDigest: "user-digest", createdAt: NOW },
        { metaMessageId: "meta_message_assistant", metaSessionId: "meta_session_1", ownerId: "user_1", role: "assistant", content: "I prepared a patch.", contentDigest: "assistant-digest", createdAt: "2026-08-09T00:00:01.000Z" },
      ],
      metaPatchProposals: [proposal()],
      metaTurns: [],
    },
    workspaceLibrary: { authorizations: [{ workspaceId: "workspace_1", displayName: "Research", authorizedAt: NOW }] },
    templateLibrary: {
      templates: [{ template, activeVersion: version("template_version_2", 2) }],
      drafts: [{
        templateDraftId: "template_draft_1",
        templateId: "template_1",
        baseTemplateVersionId: "template_version_2",
        metadata: { title: "DeepSearch", slug: "deepsearch" },
        definition: definition(),
        status: "editing",
        revision: 4,
        ownerId: "user_1",
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
    taskLibrary: { tasks: [] },
  };
}

function modelWithSelectedTemplate(model: RuntimeReadModel): RuntimeReadModel {
  return {
    ...model,
    template: { template: templateRecord(), versions: [version("template_version_1", 1), version("template_version_2", 2)] },
  };
}

function withSetupDraft(model: RuntimeReadModel, draft: TaskSetupDraftRecord): RuntimeReadModel {
  return { ...model, configuration: { ...model.configuration, taskSetupDrafts: [draft] } };
}

function templateRecord() {
  return { templateId: "template_1", slug: "deepsearch", title: "DeepSearch", activeVersionId: "template_version_2", revision: 2, createdAt: NOW, updatedAt: NOW };
}

function version(templateVersionId: string, versionNumber: number) {
  return { templateVersionId, templateId: "template_1", version: versionNumber, definition: definition(), definitionHash: `${templateVersionId}-hash`, createdAt: NOW, publishedAt: NOW };
}

function definition(): TemplateDefinition {
  const policy = { requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"] as const, allowedTools: [], permissionMode: "ask" as const, maxConcurrentTurns: 1, maxNativeChildren: 0 };
  return {
    schemaVersion: 2,
    taskInputSchema: { fields: [
      { fieldId: "ticker", label: "Ticker", kind: "short_text", required: true, description: "Exchange ticker" },
      { fieldId: "format", label: "Format", kind: "choice", required: true, options: [{ optionId: "markdown", label: "Markdown" }, { optionId: "html", label: "HTML" }] },
    ] },
    conductor: { agentCardId: "agent_card_conductor", kind: "conductor", title: "Conductor", executionProfileId: "profile_conductor", systemPrompt: "Coordinate.", capabilityRefs: [] },
    agentCards: [{ agentCardId: "agent_card_worker", kind: "researcher", title: "Researcher", executionProfileId: "profile_worker", systemPrompt: "Research.", capabilityRefs: [], dispatchProfile: { title: "Research", description: "Find evidence." } }],
    executionProfiles: [
      { executionProfileId: "profile_conductor", provider: "codex", model: "gpt-5.6", providerVersion: "1.0.0", protocolFingerprint: "codex-v1", capabilityPolicy: policy },
      { executionProfileId: "profile_worker", provider: "codex", model: "gpt-5.6-mini", providerVersion: "1.0.0", protocolFingerprint: "codex-v1", capabilityPolicy: policy },
    ],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 2, maxDispatchesPerDecision: 2 },
    deliverables: [{ artifactPath: "reports/stock.html", ownerAgentCardId: "agent_card_worker" }],
  };
}

function metaSession(metaSessionId: string, mode: "template_design", target: { kind: "template_draft"; templateDraftId: string }) {
  return {
    metaSessionId,
    ownerId: "user_1",
    metaProfileOptionId: "meta_profile_option_1",
    metaProfile: { metaProfileId: "meta_profile_internal", provider: "codex" as const, model: "gpt-5.6", providerVersion: "1.0.0", protocolFingerprint: "codex-v1", capabilityPolicy: { requiredCapabilities: [], allowedTools: [], permissionMode: "deny" as const, maxConcurrentTurns: 1, maxNativeChildren: 0 } },
    state: "active" as const,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    mode,
    target,
  };
}

function proposal(): MetaPatchProposalRecord {
  const session = metaSession("meta_session_1", "template_design", { kind: "template_draft", templateDraftId: "template_draft_1" });
  return {
    metaPatchProposalId: "meta_patch_proposal_1",
    metaSessionId: session.metaSessionId,
    ownerId: "user_1",
    mode: "template_design",
    target: session.target,
    sourceMetaProfileOptionId: session.metaProfileOptionId,
    sourceMetaProfile: session.metaProfile,
    sourceMetaSessionRevision: 3,
    targetRevision: 4,
    operations: [{ kind: "template_profile_model_set", executionProfileId: "profile_worker", value: "gpt-5.6" }],
    summary: "Use the research model",
    rationale: "The worker needs stronger synthesis.",
    validationIssues: [],
    state: "pending",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
