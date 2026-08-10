import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ExecutionProfileDefinition,
  type MetaProfileDefinition,
  type MetaProfileOptionDefinition,
  type ProviderCapabilities,
  type ProviderEffect,
  type ProviderFact,
  type ProviderKind,
  type ProviderSessionBindingRecord,
  type SessionPresentation,
  type TaskRecord,
  type TaskInputValue,
  type TaskRunRecord,
} from "@agent-workspace/runtime-contracts";
import { createRuntimeRepositories, SqliteRuntimeStore, type RuntimeRepositories } from "@agent-workspace/runtime-store";
import { requestTaskStop } from "@agent-workspace/runtime-domain";
import { createFakeMetaAgent, FakeMetaAgent, templateDefinitionFixture } from "@agent-workspace/test-kit";
import type { ProviderPort } from "@agent-workspace/provider-port";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderRegistry } from "./provider.js";
import { createMetaProfileRegistry } from "./meta-profile.js";
import { createMetaAgentRegistry } from "./meta-agent.js";
import type { ManagedArtifactPort } from "./managed-artifact-port.js";
import { RuntimeApplication } from "./runtime-application.js";

const paths: string[] = [];
let counter = 0;

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true });
  counter = 0;
});

describe("RuntimeApplication", () => {
  it("keeps Meta proposals pending until an explicit whole apply, then atomically consumes Task Setup on user create", async () => {
    const { application, metaAgent, repositories, store } = createHarness({ metaProfiles: [metaProfileOptionFixture] });
    const definition = {
      ...templateDefinitionFixture(),
      taskInputSchema: {
        fields: [
          { fieldId: "audience", label: "Audience", kind: "short_text" as const, required: true },
          {
            fieldId: "format",
            label: "Format",
            kind: "choice" as const,
            required: true,
            options: [
              { optionId: "markdown", label: "Markdown" },
              { optionId: "html", label: "HTML" },
            ],
          },
        ],
      },
    };
    await application.execute({
      type: "template.import", commandId: "command_meta_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_meta", version: 1, slug: "meta", title: "Meta" },
        definition,
      },
    });
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const setupResult = await application.execute({
      type: "task_setup.create_draft",
      commandId: "command_task_setup",
      issuedAt: now(),
      ownerId: "user_1",
      templateVersionId: versionId,
      workspaceId: "workspace_1",
      title: "Meta-assisted task",
      goal: "Produce a reviewed result.",
      taskInputValues: [
        { fieldId: "format", value: "markdown" },
        { fieldId: "audience", value: "maintainers" },
      ],
    });
    const setup = setupResult.taskSetupDraft!;
    expect(setup.taskInputValues.map((value) => value.fieldId)).toEqual(["audience", "format"]);

    const sessionResult = await application.execute({
      type: "meta.create_session",
      commandId: "command_meta_session",
      issuedAt: now(),
      ownerId: "user_1",
      metaProfileOptionId: metaProfileOptionFixture.metaProfileOptionId,
      target: { kind: "task_setup_draft", taskSetupDraftId: setup.taskSetupDraftId },
    });
    let session = sessionResult.metaSession!;
    const sendCommand = {
      type: "meta.send_message",
      commandId: "command_meta_user_message",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision,
      expectedTargetRevision: setup.revision,
      idempotencyKey: "command_meta_user_message",
      content: "Please switch this setup to HTML.",
    } as const;
    const userMessage = await application.execute(sendCommand);
    session = userMessage.metaSession!;
    expect(application.read().configuration.metaTurns[0]).toMatchObject({ status: "pending", targetRevision: setup.revision });

    // Simulate a crash after the atomic Message+MetaTurn commit but before the
    // command receipt was durable. A reused command id with any changed field
    // must not be accepted as the original intent.
    store.run("DELETE FROM runtime_commands WHERE command_id = ?", sendCommand.commandId);
    await expect(application.execute({
      ...sendCommand,
      issuedAt: now(),
      expectedSessionRevision: sendCommand.expectedSessionRevision + 99,
    })).rejects.toThrow("meta_turn_command_retry_conflict");
    await expect(application.execute(sendCommand)).resolves.toMatchObject({
      metaMessage: { metaMessageId: application.read().configuration.metaTurns[0]!.userMetaMessageId },
    });
    await application.drainOutbox();
    const metaTurnId = application.read().configuration.metaTurns[0]!.metaTurnId;
    expect(metaAgent.started).toHaveLength(1);
    expect(metaAgent.started[0]).not.toHaveProperty("workspaceId");
    expect(metaAgent.started[0]).not.toHaveProperty("taskId");
    metaAgent.setReconciliation(metaTurnId, {
      state: "returned",
      observedAt: now(),
      finalText: JSON.stringify({
        assistantMessage: "I prepared one reviewable proposal.",
        proposal: {
        operations: [
          { kind: "task_setup_goal_set", value: "Produce a reviewed HTML result." },
          { kind: "task_setup_input_set", fieldId: "format", value: "html" },
        ],
        summary: "Switch the requested result to HTML.",
        rationale: "The user wants browser-verifiable output.",
        validationIssues: [],
        },
      }),
    });
    await application.drainOutbox();
    const configuration = application.read().configuration;
    session = configuration.metaSessions.find((candidate) => candidate.metaSessionId === session.metaSessionId)!;
    const proposal = configuration.metaPatchProposals[0]!;

    expect(proposal).toMatchObject({ state: "pending", sourceMetaProfile: metaProfileFixture, sourceMetaSessionRevision: 2 });
    expect(application.read().configuration.metaMessages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Please switch this setup to HTML." },
      { role: "assistant", content: "I prepared one reviewable proposal." },
    ]);
    expect(application.read().taskLibrary.tasks).toHaveLength(0);
    expect(application.read().configuration.taskSetupDrafts[0]).toMatchObject({ goal: "Produce a reviewed result.", revision: 1 });

    const applied = await application.execute({
      type: "meta.apply_patch",
      commandId: "command_meta_apply",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      metaPatchProposalId: proposal.metaPatchProposalId,
      expectedTargetRevision: setup.revision,
    });
    expect(applied.taskSetupDraft).toMatchObject({ goal: "Produce a reviewed HTML result.", revision: 2 });
    expect(applied.metaPatchProposal).toMatchObject({ state: "applied", appliedTargetRevision: 2 });

    await expect(application.execute({
      type: "task.create",
      commandId: "command_meta_task_wrong_owner",
      issuedAt: now(),
      taskId: "task_meta_wrong_owner",
      ownerId: "user_other",
      workspaceId: "workspace_1",
      taskSetupDraftId: setup.taskSetupDraftId,
      expectedTaskSetupRevision: 2,
    })).rejects.toThrow("task_setup_owner_mismatch");
    expect(application.read().taskLibrary.tasks).toHaveLength(0);

    const created = await application.execute({
      type: "task.create",
      commandId: "command_meta_task_create",
      issuedAt: now(),
      taskId: "task_meta",
      ownerId: "user_1",
      workspaceId: "workspace_1",
      taskSetupDraftId: setup.taskSetupDraftId,
      expectedTaskSetupRevision: 2,
    });
    expect(created.task).toMatchObject({ title: "Meta-assisted task", goal: "Produce a reviewed HTML result." });
    expect(repositories.templateTask.getArchitectureSnapshot("task_meta")?.taskInputValues).toEqual([
      { fieldId: "audience", value: "maintainers" },
      { fieldId: "format", value: "html" },
    ]);
    expect(application.read().configuration.taskSetupDrafts[0]).toMatchObject({ state: "consumed", createdTaskId: "task_meta", revision: 3 });

    await application.execute({
      type: "task.start", commandId: "command_meta_task_start", issuedAt: now(), taskId: "task_meta", expectedRevision: created.task!.revision,
    });
    await application.drainOutbox();
    const binding = application.read({ taskId: "task_meta" }).task!.bindings[0]!;
    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      kind: "binding_observed",
      payload: { nativeBindingRef: "native-meta" },
      deduplication: { providerEventId: "meta-binding" },
    }));
    await application.drainOutbox();
    const goalInput = application.read({ taskId: "task_meta" }).task!.inputs[0]!;
    expect(goalInput.content).toBe([
      "Task title: Meta-assisted task",
      "Task goal:",
      "Produce a reviewed HTML result.",
      "Task inputs:",
      "[audience] Audience",
      "maintainers",
      "",
      "[format] Format",
      "HTML [html]",
      "",
    ].join("\n"));
    const goalMessage = application.read({ taskId: "task_meta" }).task!.messages.find((message) => message.kind === "task_goal")!;
    const snapshot = repositories.templateTask.getArchitectureSnapshot("task_meta")!;
    expect(goalMessage).toMatchObject({
      contentDigest: snapshot.taskGoalContentDigest,
      taskGoalCompilerVersion: snapshot.taskGoalCompilerVersion,
    });
  });

  it("projects only safe Meta readiness and fails closed for an unavailable Host option", async () => {
    const unavailable: MetaProfileOptionDefinition = {
      ...metaProfileOptionFixture,
      metaProfileOptionId: "meta_profile_option_unavailable",
      availability: "unavailable",
      unavailableReason: "pinned_provider_missing",
    };
    const { application } = createHarness({ metaProfiles: [unavailable] });
    await application.execute({
      type: "template.create_draft",
      commandId: "command_meta_unavailable_draft",
      issuedAt: now(),
      ownerId: "user_1",
      metadata: { title: "Unavailable Meta" },
      initialDefinition: templateDefinitionFixture(),
    });
    const draft = application.read().templateLibrary.drafts[0]!;
    const option = application.read().configuration.metaProfileOptions[0]!;
    expect(option).toEqual({
      metaProfileOptionId: unavailable.metaProfileOptionId,
      title: unavailable.title,
      availability: "unavailable",
      unavailableReason: "pinned_provider_missing",
      profile: {
        provider: metaProfileFixture.provider,
        model: metaProfileFixture.model,
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    expect(JSON.stringify(option)).not.toContain("metaProfileId");
    expect(JSON.stringify(option)).not.toContain("allowedTools");
    await expect(application.execute({
      type: "meta.create_session",
      commandId: "command_meta_unavailable_session",
      issuedAt: now(),
      ownerId: "user_1",
      metaProfileOptionId: unavailable.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    })).rejects.toThrow("meta_profile_option_unavailable:pinned_provider_missing");
    expect(application.read().configuration.metaSessions).toEqual([]);
  });

  it("keeps an available Meta option fail-closed until the exact Host capability pin is probed", async () => {
    const { application } = createHarness({ metaProfiles: [metaProfileOptionFixture] });
    const invalidations: string[][] = [];
    application.subscribe((event) => {
      if (event.type === "runtime.invalidated") invalidations.push([...event.reasons]);
    });

    expect(application.read().configuration.metaProfileOptions[0]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "meta_agent_profile_probe_pending",
    });
    await expect(application.refreshMetaAgentReadiness()).resolves.toBe(true);
    expect(application.read().configuration.metaProfileOptions[0]).toMatchObject({
      availability: "available",
    });
    expect(invalidations).toContainEqual(["configuration_changed"]);
    await expect(application.refreshMetaAgentReadiness()).resolves.toBe(false);
  });

  it("projects a typed unavailable Meta option when the composed Provider misses its frozen pin", async () => {
    const metaAgent = createFakeMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: "0.147.0",
        protocolFingerprint: "sha256:wrong",
      },
    });
    const { application } = createHarness({ metaProfiles: [metaProfileOptionFixture], metaAgent });

    await application.refreshMetaAgentReadiness();
    expect(application.read().configuration.metaProfileOptions[0]).toMatchObject({
      availability: "unavailable",
      unavailableReason: "meta_profile_protocol_mismatch",
    });
    expect(JSON.stringify(application.read().configuration.metaProfileOptions[0])).not.toContain("sha256:wrong");
  });

  it("rejects stale Meta session and target revisions before a fresh registry can probe", async () => {
    const initialAgent = new CountingMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    const harness = createHarness({ metaProfiles: [metaProfileOptionFixture], metaAgent: initialAgent });
    await harness.application.execute({
      type: "template.create_draft",
      commandId: "command_meta_stale_draft",
      issuedAt: now(),
      ownerId: "user_1",
      metadata: { title: "Meta stale", slug: "meta-stale" },
      initialDefinition: templateDefinitionFixture(),
    });
    const draft = harness.application.read().templateLibrary.drafts[0]!;
    const session = (await harness.application.execute({
      type: "meta.create_session",
      commandId: "command_meta_stale_session",
      issuedAt: now(),
      ownerId: "user_1",
      metaProfileOptionId: metaProfileOptionFixture.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    })).metaSession!;

    const staleSessionAgent = new CountingMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    const staleSessionApplication = reopenApplication(harness, staleSessionAgent);
    await expect(staleSessionApplication.execute({
      type: "meta.send_message",
      commandId: "command_meta_stale_session_message",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision + 1,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "meta-stale-session",
      content: "This stale session must not cause a native probe.",
    })).rejects.toThrow("meta_session_revision_stale");
    expect(staleSessionAgent.probes).toBe(0);

    await harness.application.execute({
      type: "template.save_draft",
      commandId: "command_meta_stale_target_save",
      issuedAt: now(),
      templateDraftId: draft.templateDraftId,
      expectedRevision: draft.revision,
      metadata: draft.metadata,
      definition: draft.definition,
    });
    const staleTargetAgent = new CountingMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    const staleTargetApplication = reopenApplication(harness, staleTargetAgent);
    await expect(staleTargetApplication.execute({
      type: "meta.send_message",
      commandId: "command_meta_stale_target_message",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "meta-stale-target",
      content: "This stale target must not cause a native probe.",
    })).rejects.toThrow("meta_patch_target_revision_stale");
    expect(staleTargetAgent.probes).toBe(0);
  });

  it.each([
    ["accepted", "provider_accepted"],
    ["unknown", "ambiguous"],
  ] as const)("keeps a recovered %s Meta Turn durable while its port is absent, then only reconciles after recovery", async (
    initialAcceptance,
    durableStatus,
  ) => {
    const initialAgent = new CountingMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    const harness = createHarness({ metaProfiles: [metaProfileOptionFixture], metaAgent: initialAgent });
    await harness.application.execute({
      type: "template.create_draft",
      commandId: "command_meta_reconcile_draft",
      issuedAt: now(),
      ownerId: "user_1",
      metadata: { title: "Meta reconcile", slug: "meta-reconcile" },
      initialDefinition: templateDefinitionFixture(),
    });
    const draft = harness.application.read().templateLibrary.drafts[0]!;
    const session = (await harness.application.execute({
      type: "meta.create_session",
      commandId: "command_meta_reconcile_session",
      issuedAt: now(),
      ownerId: "user_1",
      metaProfileOptionId: metaProfileOptionFixture.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    })).metaSession!;
    await harness.application.execute({
      type: "meta.send_message",
      commandId: "command_meta_reconcile_message",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "meta-reconcile-message",
      content: "Return a proposal after native acceptance.",
    });
    initialAgent.setNextAcceptance(initialAcceptance);
    await harness.application.drainOutbox();
    const accepted = harness.application.read().configuration.metaTurns[0]!;
    expect(accepted.status).toBe(durableStatus);

    const missingPortApplication = reopenApplication(harness);
    await missingPortApplication.drainOutbox();
    expect(missingPortApplication.read().configuration.metaTurns[0]).toMatchObject({
      status: durableStatus,
    });
    expect(missingPortApplication.read().configuration.metaTurns[0]?.failureCode).toBe(accepted.failureCode);

    const recoveredAgent = new CountingMetaAgent({
      provider: "codex",
      capabilities: {
        providerVersion: metaProfileFixture.providerVersion,
        protocolFingerprint: metaProfileFixture.protocolFingerprint,
      },
    });
    recoveredAgent.failCapabilityProbe = true;
    recoveredAgent.setReconciliation(accepted.metaTurnId, { state: "running" });
    const recoveredApplication = reopenApplication(harness, recoveredAgent);

    await recoveredApplication.drainOutbox();

    expect(recoveredAgent.probes).toBe(0);
    expect(recoveredAgent.started).toEqual([]);
    expect(recoveredAgent.reconciled).toEqual([expect.objectContaining({ metaTurnId: accepted.metaTurnId })]);
    expect(recoveredApplication.read().configuration.metaTurns[0]).toMatchObject({ status: "provider_accepted" });
  });

  it("starts a ready Codex Conductor while an OpenCode Worker pin is unavailable, then rejects Worker materialization before effects", async () => {
    const codex = new RecordingProvider("codex");
    const opencode = new RecordingProvider("opencode", { providerVersion: "1.18.15" });
    const { application } = createHarness({ providerPorts: [codex, opencode] });
    const base = templateDefinitionFixture();
    const mixed = {
      ...base,
      conductor: { ...base.conductor, executionProfileId: "profile_conductor" },
      executionProfiles: base.executionProfiles.map((profile) => profile.executionProfileId === "profile_conductor"
        ? {
            ...profile,
            provider: "codex" as const,
            model: "gpt-5.6-sol",
            providerVersion: "0.146.0",
            protocolFingerprint: "sha256:codex-0.146",
            capabilityPolicy: { ...profile.capabilityPolicy, permissionMode: "deny" as const },
          }
        : {
            ...profile,
            provider: "opencode" as const,
            model: "opencode/deepseek-v4-flash-free",
            providerVersion: "1.18.13",
            protocolFingerprint: "sha256:opencode-1.18.13",
          }),
    };

    const ready = await createActiveTask(application, mixed);
    await application.refreshProviderReadiness();
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    expect(application.read().configuration.executionProfileReadiness.find((entry) =>
      entry.templateVersionId === versionId && entry.executionProfileId === "profile_worker",
    )).toMatchObject({
      status: "version_mismatch",
      unavailableReasons: ["provider_version_mismatch"],
    });
    expect(ready.binding.provider).toBe("codex");

    await completeConductorTurn(application, ready, "mixed-provider");
    await expect(application.execute({
      type: "invocation.invoke_agent",
      commandId: "command_mixed_provider_worker",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId),
      idempotencyKey: "mixed-provider-worker",
      invocationId: "invocation_mixed_provider_worker",
      agentCardId: "agent_card_researcher",
      instruction: "Research the stock.",
      messageSelections: [],
      acceptanceCriteria: ["Return cited findings."],
    })).rejects.toThrow("provider_version_mismatch");
    const projection = application.read({ taskId: ready.task.taskId }).task!;
    expect(projection.logicalSessions.filter((session) => session.kind === "card")).toEqual([]);
    expect(projection.bindings).toHaveLength(1);
    expect(opencode.requests).toEqual([]);
  });

  it("prioritizes new Meta work and round-robins ambiguous reconciliation across sessions", async () => {
    const { application, metaAgent } = createHarness({ metaProfiles: [metaProfileOptionFixture] });
    await application.execute({
      type: "template.import", commandId: "command_meta_queue_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_meta-queue", version: 1, slug: "meta-queue", title: "Meta Queue" },
        definition: templateDefinitionFixture(),
      },
    });
    const versionId = application.read().templateLibrary.templates
      .find(({ template }) => template.templateId === "template_meta-queue")!.template.activeVersionId!;
    const createPendingTurn = async (ordinal: number) => {
      const setup = (await application.execute({
        type: "task_setup.create_draft",
        commandId: `command_meta_queue_setup_${ordinal}`,
        issuedAt: now(),
        ownerId: "user_1",
        templateVersionId: versionId,
        workspaceId: "workspace_1",
        title: `Meta queue ${ordinal}`,
        goal: "Return a bounded configuration proposal.",
        taskInputValues: [],
      })).taskSetupDraft!;
      const session = (await application.execute({
        type: "meta.create_session",
        commandId: `command_meta_queue_session_${ordinal}`,
        issuedAt: now(),
        ownerId: "user_1",
        metaProfileOptionId: metaProfileOptionFixture.metaProfileOptionId,
        target: { kind: "task_setup_draft", taskSetupDraftId: setup.taskSetupDraftId },
      })).metaSession!;
      await application.execute({
        type: "meta.send_message",
        commandId: `command_meta_queue_message_${ordinal}`,
        issuedAt: now(),
        ownerId: "user_1",
        metaSessionId: session.metaSessionId,
        expectedSessionRevision: session.revision,
        expectedTargetRevision: setup.revision,
        idempotencyKey: `command_meta_queue_message_${ordinal}`,
        content: `Prepare proposal ${ordinal}.`,
      });
      return application.read().configuration.metaTurns.find((turn) => turn.metaSessionId === session.metaSessionId)!;
    };

    const first = await createPendingTurn(1);
    metaAgent.setNextAcceptance("unknown");
    await application.drainOutbox();
    expect(application.read().configuration.metaTurns.find((turn) => turn.metaTurnId === first.metaTurnId)?.status).toBe("ambiguous");

    const second = await createPendingTurn(2);
    metaAgent.setNextAcceptance("unknown");
    await application.drainOutbox();
    expect(metaAgent.started.map((request) => request.metaTurnId)).toEqual([first.metaTurnId, second.metaTurnId]);
    expect(application.read().configuration.metaTurns.find((turn) => turn.metaTurnId === second.metaTurnId)?.status).toBe("ambiguous");

    metaAgent.setReconciliation(first.metaTurnId, { state: "unknown" });
    metaAgent.setReconciliation(second.metaTurnId, { state: "unknown" });
    await application.drainOutbox();
    await application.drainOutbox();
    expect(metaAgent.reconciled.slice(-2).map((request) => request.metaTurnId)).toEqual([first.metaTurnId, second.metaTurnId]);
  });

  it("terminally fails an accepted Meta turn after its session is abandoned", async () => {
    const { application } = createHarness({ metaProfiles: [metaProfileOptionFixture] });
    await application.execute({
      type: "template.create_draft",
      commandId: "command_meta_abandon_draft",
      issuedAt: now(),
      ownerId: "user_1",
      metadata: { title: "Abandon Meta" },
      initialDefinition: templateDefinitionFixture(),
    });
    const draft = application.read().templateLibrary.drafts[0]!;
    const session = (await application.execute({
      type: "meta.create_session",
      commandId: "command_meta_abandon_session",
      issuedAt: now(),
      ownerId: "user_1",
      metaProfileOptionId: metaProfileOptionFixture.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    })).metaSession!;
    const sent = await application.execute({
      type: "meta.send_message",
      commandId: "command_meta_abandon_message",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "command_meta_abandon_message",
      content: "Prepare a proposal that will be abandoned.",
    });
    await application.drainOutbox();
    const turn = application.read().configuration.metaTurns[0]!;
    expect(turn.status).toBe("provider_accepted");

    await application.execute({
      type: "meta.abandon_session",
      commandId: "command_meta_abandon_now",
      issuedAt: now(),
      ownerId: "user_1",
      metaSessionId: session.metaSessionId,
      expectedRevision: sent.metaSession!.revision,
    });
    await application.drainOutbox();

    expect(application.read().configuration.metaTurns.find((candidate) => candidate.metaTurnId === turn.metaTurnId)).toMatchObject({
      status: "failed",
      failureCode: "meta_session_not_active",
    });
  });

  it("returns selected immutable Template Version history and pins a Version-derived Draft to Runtime's source", async () => {
    const { application } = createHarness();
    const original = templateDefinitionFixture();
    const revised = {
      ...original,
      conductor: { ...original.conductor, systemPrompt: `${original.conductor.systemPrompt} Revised.` },
    };
    await application.execute({
      type: "template.import", commandId: "command_history_import", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_history", version: 1, slug: "history", title: "History" },
        definition: original,
      },
    });

    expect(application.read().template).toBeUndefined();
    const firstSelection = application.read({ templateId: "template_history" }).template!;
    const firstVersion = firstSelection.versions[0]!;
    expect(firstSelection.versions).toEqual([expect.objectContaining({
      templateVersionId: firstVersion.templateVersionId,
      version: 1,
      definition: original,
    })]);
    expect(JSON.stringify(firstSelection)).not.toMatch(/nativeBindingRef|credential|workspaceRelativePath/i);

    await application.execute({
      type: "template.create_draft", commandId: "command_history_draft", issuedAt: now(), ownerId: "user_1",
      templateId: "template_history", baseTemplateVersionId: firstVersion.templateVersionId,
      metadata: { title: "History", slug: "history" },
      // Runtime must ignore this renderer-supplied alternative until a
      // revision-fenced save explicitly edits the anchored Draft.
      initialDefinition: revised,
    });
    const draft = application.read().templateLibrary.drafts[0]!;
    expect(draft).toMatchObject({
      templateId: "template_history",
      baseTemplateVersionId: firstVersion.templateVersionId,
      definition: original,
    });

    await application.execute({
      type: "template.save_draft", commandId: "command_history_save", issuedAt: now(),
      templateDraftId: draft.templateDraftId, expectedRevision: draft.revision,
      metadata: draft.metadata, definition: revised,
    });
    const saved = application.read().templateLibrary.drafts[0]!;
    await application.execute({
      type: "template.publish_draft", commandId: "command_history_publish", issuedAt: now(),
      templateDraftId: saved.templateDraftId, expectedRevision: saved.revision,
      templateId: "template_history", slug: "history", title: "History",
    });

    const history = application.read({ templateId: "template_history" }).template!;
    expect(history.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(history.versions[0]?.definition).toEqual(original);
    expect(history.versions[1]?.definition).toEqual(revised);
  });

  it("projects readiness only for active Versions unless one Template history is explicitly selected", async () => {
    const { application } = createHarness();
    const publishHistory = async (templateId: string, slug: string) => {
      const original = templateDefinitionFixture();
      await application.execute({
        type: "template.import",
        commandId: `command_visible_${slug}_import`,
        issuedAt: now(),
        mode: "create",
        package: {
          schemaVersion: 2,
          kind: "agent-workspace/template",
          template: { templateId, version: 1, slug, title: slug },
          definition: original,
        },
      });
      const firstVersionId = application.read({ templateId }).template!.versions[0]!.templateVersionId;
      await application.execute({
        type: "template.create_draft",
        commandId: `command_visible_${slug}_draft`,
        issuedAt: now(),
        ownerId: "user_1",
        templateId,
        baseTemplateVersionId: firstVersionId,
        metadata: { title: slug, slug },
        initialDefinition: original,
      });
      const draft = application.read().templateLibrary.drafts.find((candidate) => candidate.templateId === templateId)!;
      await application.execute({
        type: "template.save_draft",
        commandId: `command_visible_${slug}_save`,
        issuedAt: now(),
        templateDraftId: draft.templateDraftId,
        expectedRevision: draft.revision,
        metadata: draft.metadata,
        definition: {
          ...original,
          executionProfiles: original.executionProfiles.map((profile) => ({ ...profile, model: `${profile.model}-${slug}-v2` })),
        },
      });
      const saved = application.read().templateLibrary.drafts.find((candidate) => candidate.templateId === templateId)!;
      await application.execute({
        type: "template.publish_draft",
        commandId: `command_visible_${slug}_publish`,
        issuedAt: now(),
        templateDraftId: saved.templateDraftId,
        expectedRevision: saved.revision,
        templateId,
        slug,
        title: slug,
      });
      const versions = application.read({ templateId }).template!.versions;
      return { historical: versions[0]!.templateVersionId, active: versions[1]!.templateVersionId };
    };
    const alpha = await publishHistory("template_visible-alpha", "visible-alpha");
    const beta = await publishHistory("template_visible-beta", "visible-beta");

    const defaultVersionIds = new Set(application.read().configuration.executionProfileReadiness.map((entry) => entry.templateVersionId));
    expect(defaultVersionIds).toEqual(new Set([alpha.active, beta.active]));

    const focusedVersionIds = new Set(application.read({ templateId: "template_visible-alpha" })
      .configuration.executionProfileReadiness.map((entry) => entry.templateVersionId));
    expect(focusedVersionIds).toEqual(new Set([alpha.historical, alpha.active, beta.active]));
    expect(focusedVersionIds.has(beta.historical)).toBe(false);
  });

  it("projects cached Conductor readiness from the Task's historical architecture snapshot without probing on read", async () => {
    const { application, provider } = createHarness();
    const original = templateDefinitionFixture();
    await application.execute({
      type: "template.import",
      commandId: "command_task_readiness_import",
      issuedAt: now(),
      mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: {
          templateId: "template_task-readiness",
          version: 1,
          slug: "task-readiness",
          title: "Task readiness",
        },
        definition: original,
      },
    });
    const historicalVersionId = application.read({ templateId: "template_task-readiness" }).template!.versions[0]!.templateVersionId;
    await application.refreshProviderReadiness();
    await createTaskFromSetup(application, {
      commandId: "command_task_readiness_create",
      taskId: "task_snapshot-readiness",
      templateVersionId: historicalVersionId,
      title: "Snapshot readiness",
      goal: "Remain pinned to the historical Conductor profile.",
    });

    await application.execute({
      type: "template.create_draft",
      commandId: "command_task_readiness_draft",
      issuedAt: now(),
      ownerId: "user_1",
      templateId: "template_task-readiness",
      baseTemplateVersionId: historicalVersionId,
      metadata: { title: "Task readiness", slug: "task-readiness" },
      initialDefinition: original,
    });
    let draft = application.read().templateLibrary.drafts[0]!;
    await application.execute({
      type: "template.save_draft",
      commandId: "command_task_readiness_save",
      issuedAt: now(),
      templateDraftId: draft.templateDraftId,
      expectedRevision: draft.revision,
      metadata: draft.metadata,
      definition: {
        ...original,
        executionProfiles: original.executionProfiles.map((profile) => ({
          ...profile,
          provider: "codex" as const,
        })),
      },
    });
    draft = application.read().templateLibrary.drafts[0]!;
    await application.execute({
      type: "template.publish_draft",
      commandId: "command_task_readiness_publish",
      issuedAt: now(),
      templateDraftId: draft.templateDraftId,
      expectedRevision: draft.revision,
      templateId: "template_task-readiness",
      slug: "task-readiness",
      title: "Task readiness",
    });
    const activeVersionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    expect(activeVersionId).not.toBe(historicalVersionId);

    const probesBeforeRead = provider.capabilityProbes;
    const readModel = application.read({ taskId: "task_snapshot-readiness" });
    expect(provider.capabilityProbes).toBe(probesBeforeRead);
    expect(readModel.task?.conductorExecutionProfileReadiness).toEqual({
      templateVersionId: historicalVersionId,
      executionProfileId: original.conductor.executionProfileId,
      status: "available",
      unavailableReasons: [],
      missingCapabilities: [],
    });
    expect(readModel.configuration.executionProfileReadiness.find((entry) =>
      entry.templateVersionId === activeVersionId
      && entry.executionProfileId === original.conductor.executionProfileId,
    )).toMatchObject({
      status: "unavailable",
      unavailableReasons: ["provider_not_composed"],
    });
  });

  it("publishes a resolved sibling readiness even while another profile probe never settles", async () => {
    let readinessNowMs = 5_000;
    const available = new RecordingProvider("opencode");
    const hanging = new HangingReadinessProvider("codex");
    const harness = createHarness();
    const application = new RuntimeApplication({
      repositories: harness.repositories,
      providers: createProviderRegistry([available, hanging], {
        now: () => readinessNowMs,
        freshnessMs: 10,
        probeTimeoutMs: 50,
      }),
      workspaceDirectoryResolver: harness.workspaceResolver,
      now,
    });
    const base = templateDefinitionFixture();
    await application.execute({
      type: "template.import",
      commandId: "command_partial_readiness_import",
      issuedAt: now(),
      mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_partial-readiness", version: 1, slug: "partial-readiness", title: "Partial readiness" },
        definition: {
          ...base,
          executionProfiles: base.executionProfiles.map((profile) => profile.executionProfileId === "profile_worker"
            ? { ...profile, provider: "codex" as const }
            : profile),
        },
      },
    });
    const invalidations: string[][] = [];
    application.subscribe((event) => {
      if (event.type === "runtime.invalidated") invalidations.push([...event.reasons]);
    });

    const refreshing = application.refreshProviderReadiness();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let readiness = application.read().configuration.executionProfileReadiness;
    expect(readiness.find((entry) => entry.executionProfileId === "profile_conductor")).toMatchObject({ status: "available" });
    expect(readiness.find((entry) => entry.executionProfileId === "profile_worker")).toMatchObject({
      status: "checking",
      unavailableReasons: ["provider_probe_pending"],
    });
    expect(invalidations).toContainEqual(["configuration_changed"]);

    await expect(Promise.race([
      refreshing.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])).resolves.toBe("settled");
    readiness = application.read().configuration.executionProfileReadiness;
    expect(readiness.find((entry) => entry.executionProfileId === "profile_conductor")).toMatchObject({ status: "available" });
    expect(readiness.find((entry) => entry.executionProfileId === "profile_worker")).toMatchObject({
      status: "unavailable",
      unavailableReasons: ["provider_probe_failed"],
    });
    expect(invalidations).toContainEqual(["configuration_changed"]);

    readinessNowMs += 10;
    available.setCapabilities(["create_binding"]);
    await application.refreshProviderReadiness();
    readiness = application.read().configuration.executionProfileReadiness;
    expect(readiness.find((entry) => entry.executionProfileId === "profile_conductor")).toMatchObject({ status: "capability_missing" });
    expect(invalidations.filter((reasons) => reasons.includes("configuration_changed")).length).toBeGreaterThanOrEqual(2);
  });

  it("replays an accepted command exactly once and rejects a reused command ID with different intent", async () => {
    const { application } = createHarness();
    const command = {
      type: "template.create_draft" as const,
      commandId: "command_retry",
      issuedAt: now(),
      ownerId: "user_1",
      metadata: { title: "Retry-safe template", slug: "retry-safe" },
      initialDefinition: templateDefinitionFixture(),
    };

    const first = await application.execute(command);
    const replay = await application.execute(command);
    expect(replay).toEqual(first);
    expect(application.read().templateLibrary.drafts).toHaveLength(1);
    await expect(application.execute({ ...command, metadata: { ...command.metadata, title: "Different intent" } }))
      .rejects.toThrow("runtime_command_id_reused_with_different_payload");
  });

  it("imports/exports a template package without creating a second live writer", async () => {
    const { application } = createHarness();
    const definition = templateDefinitionFixture();
    const packageValue = {
      schemaVersion: 2 as const,
      kind: "agent-workspace/template" as const,
      template: { templateId: "template_team", version: 1, slug: "research-team", title: "Research Team" },
      definition,
    };

    await application.execute({ type: "template.import", commandId: "command_import", issuedAt: now(), package: packageValue, mode: "create" });
    const template = application.read().templateLibrary.templates[0];
    expect(template?.template.activeVersionId).toBeTruthy();
    const exported = await application.execute({
      type: "template.export", commandId: "command_export", issuedAt: now(), templateVersionId: template!.template.activeVersionId!,
    });
    expect(exported.templatePackage).toEqual(expect.objectContaining({ kind: "agent-workspace/template", definition }));
    expect(exported.templateAssets).toEqual([]);
    await expect(application.execute({ type: "template.import", commandId: "command_conflict", issuedAt: now(), package: {
      ...packageValue,
      definition: { ...definition, routingPolicy: { ...definition.routingPolicy, maxDispatchesPerDecision: 3 } },
    }, mode: "new_version" })).rejects.toThrow("template_import_version_conflict");
  });

  it("imports, persists, exports, retries, and protects an immutable binary asset manifest", async () => {
    const { application } = createHarness();
    const packageValue = {
      schemaVersion: 2 as const,
      kind: "agent-workspace/template" as const,
      template: { templateId: "template_assets", version: 1, slug: "assets", title: "Assets" },
      definition: templateDefinitionFixture(),
    };
    const assets = [{ path: "prompts/brief.bin", contentType: "application/octet-stream", base64: "AP8RIoA=" }];
    await application.execute({
      type: "template.import", commandId: "command_asset_import", issuedAt: now(), package: packageValue, assets, mode: "create",
    });
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const exported = await application.execute({
      type: "template.export", commandId: "command_asset_export", issuedAt: now(), templateVersionId: versionId,
    });
    expect(exported.templateAssets).toEqual(assets);
    expect(exported.templatePackage?.template.assetManifestHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);

    await expect(application.execute({
      type: "template.import", commandId: "command_asset_retry", issuedAt: now(), package: packageValue, assets, mode: "create",
    })).resolves.toBeDefined();
    expect(application.read().templateLibrary.templates[0]!.template.activeVersionId).toBe(versionId);
    await expect(application.execute({
      type: "template.import", commandId: "command_asset_conflict", issuedAt: now(), package: packageValue,
      assets: [{ ...assets[0]!, base64: "AP8RIoE=" }], mode: "new_version",
    })).rejects.toThrow("template_import_asset_manifest_conflict");
  });

  it("records Achieve as a direct user decision without a Run, claim, or artifact gate", async () => {
    const { application } = createHarness();
    await application.execute({
      type: "template.import", commandId: "command_accept_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2, kind: "agent-workspace/template",
        template: { templateId: "template_accept", version: 1, slug: "accept", title: "Acceptance" },
        definition: templateDefinitionFixture(),
      },
    });
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const created = await createTaskFromSetup(application, {
      commandId: "command_accept_task", taskId: "task_accept", templateVersionId: versionId,
      title: "User-owned acceptance", goal: "Record the user's decision.",
    });

    const achieved = await application.execute({
      type: "task.achieve", commandId: "command_accept", issuedAt: now(), taskId: "task_accept",
      expectedRevision: created.task!.revision, acceptedArtifactIds: [], acceptanceNote: "Accepted by the user.",
    });

    expect(achieved.task).toMatchObject({
      status: "queued",
      achievement: { acceptedArtifactIds: [], acceptanceNote: "Accepted by the user." },
    });
    await expect(application.execute({
      type: "task.start", commandId: "command_accept_start", issuedAt: now(), taskId: "task_accept",
      expectedRevision: achieved.task!.revision,
    })).rejects.toThrow("task_already_achieved");
  });

  it("preserves an Achieved Task through archive/restore and requires recycle-bin retention before permanent delete", async () => {
    const artifactPort = new RecordingArtifactPort();
    const { application, repositories } = createHarness({ managedArtifactPort: artifactPort });
    await application.execute({
      type: "template.import", commandId: "command_retention_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2, kind: "agent-workspace/template",
        template: { templateId: "template_retention", version: 1, slug: "retention", title: "Retention" },
        definition: templateDefinitionFixture(),
      },
    });
    const templateVersionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const created = await createTaskFromSetup(application, {
      commandId: "command_retention_task", taskId: "task_retention", templateVersionId,
      title: "Retain result", goal: "Preserve this completed Task.",
    });
    const achieved = await application.execute({
      type: "task.achieve", commandId: "command_retention_achieve", issuedAt: now(), taskId: "task_retention",
      expectedRevision: created.task!.revision, acceptedArtifactIds: [],
    });
    const archived = await application.execute({
      type: "task.archive", commandId: "command_retention_archive", issuedAt: now(), taskId: "task_retention",
      expectedRevision: achieved.task!.revision,
    });
    expect(archived.task).toMatchObject({
      taskId: "task_retention",
      achievement: { acceptedArtifactIds: [] },
      trashedAt: expect.any(String),
    });
    const preview = await application.execute({
      type: "task.preview_permanent_delete", commandId: "command_retention_preview", issuedAt: now(), taskId: "task_retention",
      expectedRevision: archived.task!.revision,
    });
    expect(preview.permanentDeletePreview).toEqual({ taskId: "task_retention", expectedRevision: archived.task!.revision, artifacts: [] });
    const restored = await application.execute({
      type: "task.restore", commandId: "command_retention_restore", issuedAt: now(), taskId: "task_retention",
      expectedRevision: archived.task!.revision,
    });
    expect(restored.task).toMatchObject({ taskId: "task_retention", achievement: { acceptedArtifactIds: [] } });
    expect(restored.task!.trashedAt).toBeUndefined();
    await expect(application.execute({
      type: "task.permanently_delete", commandId: "command_retention_too_early", issuedAt: now(), taskId: "task_retention",
      expectedRevision: restored.task!.revision, artifactIds: [],
    })).rejects.toThrow("task_not_in_recycle_bin");

    const archivedAgain = await application.execute({
      type: "task.archive", commandId: "command_retention_archive_again", issuedAt: now(), taskId: "task_retention",
      expectedRevision: restored.task!.revision,
    });
    const deleteCommand = {
      type: "task.permanently_delete" as const,
      commandId: "command_retention_delete",
      issuedAt: now(),
      taskId: "task_retention",
      expectedRevision: archivedAgain.task!.revision,
      artifactIds: [],
    };
    const removed = await application.execute(deleteCommand);
    expect(removed.permanentDelete).toMatchObject({ taskId: "task_retention", deletedArtifactIds: [], skippedArtifacts: [] });
    expect(repositories.templateTask.getTask("task_retention")).toBeUndefined();
    expect(artifactPort.deleteCalls).toHaveLength(1);
    await expect(application.execute(deleteCommand)).resolves.toEqual(removed);
  });

  it("requires a Host-authorized workspace ID and freezes the Host-canonical directory", async () => {
    const { application, repositories, workspaceResolver } = createHarness();
    await application.execute({
      type: "template.import", commandId: "command_workspace_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_workspace", version: 1, slug: "workspace", title: "Workspace" },
        definition: templateDefinitionFixture(),
      },
    });
    const templateVersionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;

    await expect(application.execute({
      type: "task_setup.create_draft", commandId: "command_unknown_workspace", issuedAt: now(), ownerId: "user_1",
      templateVersionId, workspaceId: "workspace_unknown", title: "Must not create", goal: "Reject an unknown workspace.", taskInputValues: [],
    })).rejects.toThrow("workspace_not_authorized");

    await application.execute({
      type: "workspace.authorize", commandId: "command_authorize_workspace", issuedAt: now(),
      workspaceId: "workspace_research", directory: "/workspace-link/research", displayName: "Research project",
    });
    const authorization = application.read().workspaceLibrary.authorizations.find((item) => item.workspaceId === "workspace_research");
    expect(authorization).toEqual(expect.objectContaining({
      workspaceId: "workspace_research",
      displayName: "Research project",
    }));
    expect(JSON.stringify(authorization)).not.toContain("/canonical/research");

    await createTaskFromSetup(application, {
      commandId: "command_authorized_workspace_task", taskId: "task_authorized_workspace",
      templateVersionId, workspaceId: "workspace_research", title: "Authorized task", goal: "Use the approved project only.",
    });
    expect(repositories.templateTask.getArchitectureSnapshot("task_authorized_workspace")?.workspace).toEqual({
      workspaceId: "workspace_research",
      cwd: "/canonical/research",
      displayName: "Research project",
    });
    expect(workspaceResolver.calls).toEqual(["/workspace-link/research", "/canonical/research"]);
  });

  it("keeps a delivery unconfirmed after effect acceptance and advances it only once from an observed fact", async () => {
    const { application, provider } = createHarness();
    const definition = templateDefinitionFixture();
    await application.execute({
      type: "template.create_draft", commandId: "command_draft", issuedAt: now(), ownerId: "user_1",
      metadata: { title: "Research Team", slug: "research-team" }, initialDefinition: definition,
    });
    const draft = application.read().templateLibrary.drafts[0]!;
    await application.execute({
      type: "template.publish_draft", commandId: "command_publish", issuedAt: now(), templateDraftId: draft.templateDraftId,
      expectedRevision: draft.revision, slug: "research-team", title: "Research Team",
    });
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const created = await createTaskFromSetup(application, {
      commandId: "command_task", taskId: "task_1", templateVersionId: versionId,
      title: "Investigate", goal: "Return evidence.",
    });
    const started = await application.execute({
      type: "task.start", commandId: "command_start", issuedAt: now(), taskId: "task_1", expectedRevision: created.task!.revision,
    });
    expect(await application.drainOutbox()).toBe(1);
    const initial = application.read({ taskId: "task_1" }).task!;
    const binding = initial.bindings[0]!;
    expect(binding.status).toBe("binding_effect_accepted");
    expect(provider.effects).toHaveLength(1);
    expect(provider.requests[0]!.request).toMatchObject({
      bootstrap: {
        purpose: "task_conductor",
        systemPrompt: definition.conductor.systemPrompt,
        dispatchRegistry: [{
          agentCardId: definition.agentCards[0]!.agentCardId,
          title: definition.agentCards[0]!.dispatchProfile!.title,
        }],
      },
    });
    expect(JSON.stringify(provider.requests[0]!.request)).not.toContain(definition.agentCards[0]!.systemPrompt);

    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "binding_observed",
      payload: { nativeBindingRef: "native-1" }, deduplication: { providerEventId: "binding-created" },
    }));
    const afterBinding = application.read({ taskId: "task_1" }).task!;
    expect(afterBinding.bindings[0]!.status).toBe("active");
    await application.reconcileBinding(binding.bindingId);
    expect(provider.reconciliationRequests[0]).toMatchObject({ bindingId: binding.bindingId, nativeBindingRef: "native-1" });
    await application.drainOutbox(); // Task Goal delivery
    let projection = application.read({ taskId: "task_1" }).task!;
    const goalInput = projection.inputs.find((input) => input.content.startsWith("Task title:"))!;
    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "input_received",
      correlation: { inputSubmissionId: goalInput.inputSubmissionId, nativeMessageId: "native-goal-1" },
      payload: {}, deduplication: { providerEventId: "goal-receipt-1" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "assistant_final",
      correlation: { inputSubmissionId: goalInput.inputSubmissionId }, payload: { content: "Goal acknowledged." },
      deduplication: { providerEventId: "goal-final-1" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "turn_completed",
      correlation: { inputSubmissionId: goalInput.inputSubmissionId }, payload: {},
      deduplication: { providerEventId: "goal-completed-1" },
    }));
    const inputCommand = {
      type: "task.submit_input" as const, commandId: "command_input", issuedAt: now(), taskId: "task_1",
      expectedRevision: started.task!.revision, runId: started.run!.runId,
      targetLogicalSessionId: started.run!.conductorLogicalSessionId, content: "Continue with a bounded answer.",
    };
    await application.execute(inputCommand);
    await application.drainOutbox();
    projection = application.read({ taskId: "task_1" }).task!;
    const userInput = projection.inputs.find((input) => input.content === inputCommand.content)!;
    expect(userInput.status).toBe("effect_accepted");
    expect(userInput.nativeMessageId).toBeUndefined();
    expect(provider.requests.find((entry) => entry.kind === "submit_delivery" && (entry.request as { inputSubmissionId?: string }).inputSubmissionId === userInput.inputSubmissionId)?.request).toMatchObject({
      bindingId: binding.bindingId,
      nativeBindingRef: "native-1",
      inputSubmissionId: userInput.inputSubmissionId,
    });

    const receipt = fact({
      bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "input_received",
      correlation: { inputSubmissionId: userInput.inputSubmissionId, nativeMessageId: "native-message-1" },
      payload: {}, deduplication: { providerEventId: "input-receipt-1" },
    });
    expect(await application.reconcileProviderFact(receipt)).toBe(true);
    expect(await application.reconcileProviderFact(receipt)).toBe(false);
    projection = application.read({ taskId: "task_1" }).task!;
    expect(projection.inputs.find((input) => input.inputSubmissionId === userInput.inputSubmissionId)).toMatchObject({ status: "provider_received", nativeMessageId: "native-message-1" });
  });

  it("persists invocation/attention facts and an explicit user achievement", async () => {
    const artifactPort = new RecordingArtifactPort();
    const { application, provider } = createHarness({ managedArtifactPort: artifactPort });
    const ready = await createActiveTask(application);

    await application.execute({
      type: "invocation.invoke_agent", commandId: "command_invoke", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId), idempotencyKey: "invoke-1", invocationId: "invocation_1",
      agentCardId: "agent_card_researcher", instruction: "Gather a verified result.", messageSelections: [],
      acceptanceCriteria: ["Return a concise, evidenced result."],
      requestedArtifacts: ["reports/NVDA-deepsearch.html"],
    });
    await application.drainOutbox(); // card binding local effect
    let projection = application.read({ taskId: ready.task.taskId }).task!;
    const workerBinding = projection.bindings.find((binding) => binding.logicalSessionId !== ready.binding.logicalSessionId)!;
    await application.reconcileProviderFact(fact({
      bindingId: workerBinding.bindingId, bindingRevision: workerBinding.bindingRevision, kind: "binding_observed",
      payload: { nativeBindingRef: "worker-native-1" }, deduplication: { providerEventId: "worker-bound-1" },
    }));
    await application.drainOutbox(); // staged invocation delivery
    projection = application.read({ taskId: ready.task.taskId }).task!;
    const invocation = projection.invocations[0]!;
    const workerTurn = projection.sessionTurns.find((turn) => turn.invocationId === invocation.invocationId)!;
    const workerInput = projection.inputs.find((input) => input.inputSubmissionId === workerTurn.inputSubmissionId)!;
    const workerDelivery = provider.requests.find(({ kind, request }) =>
      kind === "submit_delivery" && (request as { bindingId?: string }).bindingId === workerBinding.bindingId,
    )!.request as { invocationId?: string; content?: string; bootstrap?: { purpose?: string; systemPrompt?: string } };
    expect(workerDelivery).toMatchObject({
      invocationId: invocation.invocationId,
      bootstrap: {
        purpose: "task_worker",
        systemPrompt: templateDefinitionFixture().agentCards[0]!.systemPrompt,
      },
    });
    expect(workerDelivery.content).toContain("# 本次任务\nGather a verified result.");
    expect(workerDelivery.content).toContain("## 验收标准");
    expect(workerDelivery.content).toContain("## 请求产物\n- reports/NVDA-deepsearch.html");
    await application.reconcileProviderFact(fact({
      bindingId: workerBinding.bindingId, bindingRevision: workerBinding.bindingRevision, kind: "input_received",
      correlation: { inputSubmissionId: workerInput.inputSubmissionId, nativeMessageId: "worker-message-1" },
      payload: {}, deduplication: { providerEventId: "worker-receipt-1" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: workerBinding.bindingId, bindingRevision: workerBinding.bindingRevision, kind: "turn_started",
      // A restarted native bridge may recover only the durable client input ID;
      // Runtime must restore the exact Invocation relationship from its store.
      correlation: { inputSubmissionId: workerInput.inputSubmissionId }, payload: {}, deduplication: { providerEventId: "worker-turn-start-1" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: workerBinding.bindingId, bindingRevision: workerBinding.bindingRevision, kind: "assistant_final",
      correlation: { inputSubmissionId: workerInput.inputSubmissionId },
      payload: { content: "Complete verified result.\nArtifact: reports/NVDA-deepsearch.html" },
      deduplication: { providerEventId: "worker-final-1" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: workerBinding.bindingId, bindingRevision: workerBinding.bindingRevision, kind: "turn_completed",
      correlation: { inputSubmissionId: workerInput.inputSubmissionId }, payload: {},
      deduplication: { providerEventId: "worker-turn-complete-1" },
    }));
    projection = application.read({ taskId: ready.task.taskId }).task!;
    const finalMessage = projection.messages.find((message) => message.kind === "agent_final" && message.invocationId === invocation.invocationId)!;
    expect(finalMessage.content).toBe("Complete verified result.\nArtifact: reports/NVDA-deepsearch.html");
    expect(projection.invocations[0]).toMatchObject({ status: "returned", finalMessageId: finalMessage.messageId });
    expect(projection.inboxItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetLogicalSessionId: ready.run.conductorLogicalSessionId, renderedMessageId: finalMessage.messageId }),
    ]));
    expect(projection.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "provider_input_received", inputSubmissionId: workerInput.inputSubmissionId }),
      expect.objectContaining({ kind: "provider_turn_completed", invocationId: invocation.invocationId }),
      expect.objectContaining({ kind: "message_created", detail: "Complete verified result.\nArtifact: reports/NVDA-deepsearch.html" }),
    ]));
    expect(projection.timeline.some((item) => item.kind === "user_achieved")).toBe(false);

    const artifactCommand = {
      type: "artifact.verify_requested" as const,
      commandId: "command_verify_artifact",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId),
      idempotencyKey: "command_verify_artifact",
      sourceInvocationId: invocation.invocationId,
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
    };
    const verified = await application.execute(artifactCommand);
    expect(verified.artifactId).toMatch(/^artifact_/);
    expect(artifactPort.verifyCalls).toHaveLength(1);
    expect(application.read({ taskId: ready.task.taskId }).task!.artifacts).toEqual([
      expect.objectContaining({
        artifactId: verified.artifactId,
        taskId: ready.task.taskId,
        runId: ready.run.runId,
        displayName: "NVDA-deepsearch.html",
        sourceInvocationId: invocation.invocationId,
      }),
    ]);
    const claimReplay = await application.execute({
      ...artifactCommand,
      commandId: "command_verify_artifact_replay",
      idempotencyKey: "command_verify_artifact_replay",
    });
    expect(claimReplay.artifactId).toBe(verified.artifactId);
    expect(artifactPort.verifyCalls).toHaveLength(1);
    await expect(application.execute({
      ...artifactCommand,
      commandId: "command_verify_unrequested_artifact",
      idempotencyKey: "command_verify_unrequested_artifact",
      workspaceRelativePath: "reports/other.html",
    })).rejects.toThrow("artifact_path_not_requested");

    await application.reconcileProviderFact(fact({
      bindingId: ready.binding.bindingId, bindingRevision: ready.binding.bindingRevision, kind: "attention_requested",
      correlation: { attentionId: "attention_1", nativeRequestId: "native-permission-1" },
      payload: { kind: "permission", prompt: "Approve the verified artifact?" },
      deduplication: { providerEventId: "attention-request-1" },
    }));
    const attention = application.read({ taskId: ready.task.taskId }).task!.attentions[0]!;
    await expect(application.execute({
      type: "attention.respond", commandId: "command_attention_wrong_binding", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, attentionId: attention.attentionId, bindingId: workerBinding.bindingId,
      bindingRevision: workerBinding.bindingRevision, nativeRequestId: attention.nativeRequestId,
      response: { approved: true },
    })).rejects.toThrow("attention_binding_scope_mismatch");
    await application.execute({
      type: "attention.respond", commandId: "command_attention", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, attentionId: attention.attentionId, bindingId: attention.bindingId,
      bindingRevision: attention.bindingRevision, nativeRequestId: attention.nativeRequestId,
      response: { approved: true },
    });
    await application.drainOutbox();
    expect(application.read({ taskId: ready.task.taskId }).task!.attentions[0]).toMatchObject({ status: "effect_accepted" });

    const achieved = await application.execute({
      type: "task.achieve", commandId: "command_achieve", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, acceptedArtifactIds: [verified.artifactId!],
      acceptanceNote: "I accept this result.",
    });
    expect(achieved.task).toMatchObject({
      status: "running",
      achievement: { acceptedArtifactIds: [verified.artifactId], acceptanceNote: "I accept this result." },
    });
    expect(application.read({ taskId: ready.task.taskId }).task!.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user_achieved", detail: "I accept this result." }),
    ]));
  });

  it("stores and revokes a presentation descriptor without exposing native transport", async () => {
    const { application } = createHarness();
    const ready = await createActiveTask(application);
    const opened = await application.execute({
      type: "presentation.open", commandId: "command_presentation", issuedAt: now(), taskId: ready.task.taskId, bindingId: ready.binding.bindingId,
    });
    expect(opened.presentation).toMatchObject({ bindingId: ready.binding.bindingId, kind: "unavailable" });
    expect(application.read({ taskId: ready.task.taskId }).task!.presentations).toHaveLength(1);
    await application.execute({
      type: "presentation.release", commandId: "command_presentation_release", issuedAt: now(), presentationLeaseId: opened.presentation!.presentationLeaseId,
    });
    expect(application.read({ taskId: ready.task.taskId }).task!.presentations).toHaveLength(0);
  });

  it("releases a persistent Provider binding only after a native terminal fact, without treating it as Achieve", async () => {
    const { application, provider } = createHarness();
    const ready = await createActiveTask(application);
    const active = application.read({ taskId: ready.task.taskId }).task!;
    await application.execute({
      type: "task.stop", commandId: "command_stop", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: active.task.revision, runId: ready.run.runId, bindingIds: [ready.binding.bindingId],
    });
    await application.drainOutbox(); // request_interrupt local transport outcome only
    expect(provider.releasedBindings).toEqual([]);

    await application.reconcileProviderFact(fact({
      bindingId: ready.binding.bindingId,
      bindingRevision: ready.binding.bindingRevision,
      kind: "native_terminal",
      correlation: {},
      payload: { reason: "native_cancelled" },
      deduplication: { providerEventId: "native-terminal-1" },
    }));
    const stopped = application.read({ taskId: ready.task.taskId }).task!;
    expect(stopped.task.status).toBe("stopped");
    expect(stopped.task.achievement).toBeUndefined();
    expect(stopped.bindings).toEqual([expect.objectContaining({ status: "released" })]);
    expect(provider.releasedBindings).toEqual([]);

    await application.drainOutbox();
    expect(provider.releasedBindings).toEqual([ready.binding.bindingId]);
  });

  it("harness: stops an idle completed Binding through release without waiting for an impossible turn interrupt", async () => {
    const { application, provider } = createHarness();
    const ready = await createActiveTask(application);
    let projection = await completeConductorTurn(application, ready, "idle-stop");

    const stopping = await application.execute({
      type: "task.stop",
      commandId: "command_idle_stop",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: projection.task.revision,
      runId: ready.run.runId,
      bindingIds: [ready.binding.bindingId],
    });
    expect(stopping.task).toMatchObject({ status: "stopping" });
    await application.drainOutbox();

    projection = application.read({ taskId: ready.task.taskId }).task!;
    expect(provider.requests.some((entry) => entry.kind === "request_interrupt")).toBe(false);
    expect(provider.releasedBindings).toEqual([ready.binding.bindingId]);
    expect(projection.task.status).toBe("stopped");
    expect(projection.bindings).toEqual([expect.objectContaining({ status: "released" })]);
    expect(projection.logicalSessions).toEqual([expect.objectContaining({ status: "stopped" })]);
  });

  it("harness: recovers an older stopping intent by releasing a now-idle Binding after Host restart", async () => {
    const { application, provider, repositories } = createHarness();
    const ready = await createActiveTask(application);
    const projection = await completeConductorTurn(application, ready, "recover-idle-stop");
    const requested = requestTaskStop(projection.task, projection.activeRun!, projection.task.revision, now());
    repositories.transaction(() => {
      repositories.templateTask.updateTask(requested.task, projection.task.revision);
      repositories.templateTask.updateRun(requested.run);
    });

    await application.drainOutbox();

    const recovered = application.read({ taskId: ready.task.taskId }).task!;
    expect(provider.releasedBindings).toEqual([ready.binding.bindingId]);
    expect(recovered.task.status).toBe("stopped");
    expect(recovered.bindings).toEqual([expect.objectContaining({ status: "released" })]);
  });

  it("rejects stale Start before forcing any Provider capability probe", async () => {
    const { application, provider } = createHarness();
    const created = await createQueuedTask(application, "stale_start");

    await expect(application.execute({
      type: "task.start",
      commandId: "command_stale_start",
      issuedAt: now(),
      taskId: created.task!.taskId,
      expectedRevision: created.task!.revision + 1,
    })).rejects.toThrow("expected_revision_stale");

    expect(provider.capabilityProbes).toBe(0);
  });

  it("rejects stale Restart before forcing any additional Provider capability probe", async () => {
    const { application, provider } = createHarness();
    const ready = await createActiveTask(application);
    await application.execute({
      type: "task.stop",
      commandId: "command_stale_restart_stop",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      bindingIds: [ready.binding.bindingId],
    });
    await application.reconcileProviderFact(fact({
      bindingId: ready.binding.bindingId,
      bindingRevision: ready.binding.bindingRevision,
      kind: "native_terminal",
      payload: { reason: "terminal_before_stale_restart" },
      deduplication: { providerEventId: "stale-restart-terminal" },
    }));
    const stopped = application.read({ taskId: ready.task.taskId }).task!;
    const probesBefore = provider.capabilityProbes;

    await expect(application.execute({
      type: "task.restart",
      commandId: "command_stale_restart",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: stopped.task.revision - 1,
    })).rejects.toThrow("expected_revision_stale");

    expect(provider.capabilityProbes).toBe(probesBefore);
  });

  it("keeps Restart and Resume state atomic when fresh Provider readiness fails", async () => {
    const restartHarness = createHarness();
    const restartReady = await createActiveTask(restartHarness.application);
    await restartHarness.application.execute({
      type: "task.stop",
      commandId: "command_atomic_restart_stop",
      issuedAt: now(),
      taskId: restartReady.task.taskId,
      expectedRevision: restartReady.task.revision,
      runId: restartReady.run.runId,
      bindingIds: [restartReady.binding.bindingId],
    });
    await restartHarness.application.reconcileProviderFact(fact({
      bindingId: restartReady.binding.bindingId,
      bindingRevision: restartReady.binding.bindingRevision,
      kind: "native_terminal",
      payload: { reason: "terminal_before_atomic_restart" },
      deduplication: { providerEventId: "atomic-restart-terminal" },
    }));
    restartHarness.provider.setCapabilities(["create_binding", "provider_receipt", "reconcile"]);
    const restartBefore = restartHarness.application.read({ taskId: restartReady.task.taskId }).task!;
    const restartOutboxBefore = outboxCount(restartHarness.store);
    const restartEffectsBefore = restartHarness.provider.effects.length;

    await expect(restartHarness.application.execute({
      type: "task.restart",
      commandId: "command_atomic_restart",
      issuedAt: now(),
      taskId: restartReady.task.taskId,
      expectedRevision: restartBefore.task.revision,
    })).rejects.toThrow("execution_profile_unavailable");

    const restartAfter = restartHarness.application.read({ taskId: restartReady.task.taskId }).task!;
    expect(restartAfter.task).toEqual(restartBefore.task);
    expect(restartAfter.activeRun).toEqual(restartBefore.activeRun);
    expect(restartAfter.bindings).toEqual(restartBefore.bindings);
    expect(outboxCount(restartHarness.store)).toBe(restartOutboxBefore);
    expect(restartHarness.provider.effects).toHaveLength(restartEffectsBefore);

    const resumeHarness = createHarness();
    const resumeReady = await createActiveTask(resumeHarness.application);
    const blockedTask: TaskRecord = {
      ...resumeReady.task,
      status: "blocked",
      revision: resumeReady.task.revision + 1,
      updatedAt: now(),
    };
    const failedRun: TaskRunRecord = {
      ...resumeReady.run,
      status: "failed",
      revision: resumeReady.run.revision + 1,
      endedAt: now(),
    };
    resumeHarness.repositories.transaction(() => {
      resumeHarness.repositories.templateTask.updateTask(blockedTask, resumeReady.task.revision);
      resumeHarness.repositories.templateTask.updateRun(failedRun);
    });
    resumeHarness.provider.setCapabilities(["create_binding", "provider_receipt", "reconcile"]);
    const resumeBefore = resumeHarness.application.read({ taskId: resumeReady.task.taskId }).task!;
    const resumeOutboxBefore = outboxCount(resumeHarness.store);
    const resumeEffectsBefore = resumeHarness.provider.effects.length;

    await expect(resumeHarness.application.execute({
      type: "task.resume",
      commandId: "command_atomic_resume",
      issuedAt: now(),
      taskId: resumeReady.task.taskId,
      expectedRevision: blockedTask.revision,
      runId: resumeReady.run.runId,
    })).rejects.toThrow("execution_profile_unavailable");

    const resumeAfter = resumeHarness.application.read({ taskId: resumeReady.task.taskId }).task!;
    expect(resumeAfter.task).toEqual(resumeBefore.task);
    expect(resumeAfter.activeRun).toEqual(resumeBefore.activeRun);
    expect(resumeAfter.bindings).toEqual(resumeBefore.bindings);
    expect(outboxCount(resumeHarness.store)).toBe(resumeOutboxBefore);
    expect(resumeHarness.provider.effects).toHaveLength(resumeEffectsBefore);
  });

  it("restarts a fully released terminal Run as a distinct Run", async () => {
    const { application } = createHarness();
    const ready = await createActiveTask(application);
    await application.execute({
      type: "task.stop", commandId: "command_restart_stop", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, runId: ready.run.runId, bindingIds: [ready.binding.bindingId],
    });
    await application.reconcileProviderFact(fact({
      bindingId: ready.binding.bindingId, bindingRevision: ready.binding.bindingRevision, kind: "native_terminal",
      payload: { reason: "terminal_before_restart" }, deduplication: { providerEventId: "restart-terminal-1" },
    }));
    const stopped = application.read({ taskId: ready.task.taskId }).task!;
    expect(stopped.task).toMatchObject({ status: "stopped", activeRunId: ready.run.runId });

    const restarted = await application.execute({
      type: "task.restart", commandId: "command_restart", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: stopped.task.revision,
    });
    expect(restarted.task).toMatchObject({ status: "running", activeRunId: restarted.run!.runId });
    expect(restarted.run).toMatchObject({ status: "starting", runNumber: 2 });
    expect(restarted.run!.runId).not.toBe(ready.run.runId);
    expect(restarted.run!.conductorLogicalSessionId).not.toBe(ready.run.conductorLogicalSessionId);
    await expect(application.execute({
      type: "task.resume", commandId: "command_restart_old_resume", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: restarted.task!.revision, runId: ready.run.runId,
    })).rejects.toThrow("resume_requires_original_active_run");
  });

  it("refuses Stop before mutating Task state when the selected Provider no longer verifies interrupt", async () => {
    const { application, provider } = createHarness();
    const ready = await createActiveTask(application);
    const before = application.read({ taskId: ready.task.taskId }).task!;
    provider.setCapabilities(["create_binding", "provider_receipt", "reconcile"]);

    await expect(application.execute({
      type: "task.stop", commandId: "command_stop_unavailable", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: before.task.revision, runId: ready.run.runId, bindingIds: [ready.binding.bindingId],
    })).rejects.toThrow(`task_stop_interrupt_unavailable:${ready.binding.bindingId}`);

    const after = application.read({ taskId: ready.task.taskId }).task!;
    expect(after.task).toMatchObject({ status: "running", revision: before.task.revision });
    expect(provider.requests.some((entry) => entry.kind === "request_interrupt")).toBe(false);
  });

  it("keeps a portable managed Template but refuses to start it when the local Provider lacks a required capability", async () => {
    const { application, provider } = createHarness();
    await application.execute({
      type: "template.import", commandId: "command_capability_template", issuedAt: now(), mode: "create",
      package: {
        schemaVersion: 2,
        kind: "agent-workspace/template",
        template: { templateId: "template_capability", version: 1, slug: "capability", title: "Capability profile" },
        definition: templateDefinitionFixture(),
      },
    });
    const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
    const created = await createTaskFromSetup(application, {
      commandId: "command_capability_task", taskId: "task_capability", templateVersionId: versionId,
      title: "Capability gate", goal: "Require an interrupt-capable Provider.",
    });
    provider.setCapabilities(["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile"]);

    await expect(application.execute({
      type: "task.start", commandId: "command_capability_start", issuedAt: now(), taskId: "task_capability",
      expectedRevision: created.task!.revision,
    })).rejects.toThrow("execution_profile_unavailable:profile_conductor:capability_interrupt_unavailable");
  });

  it("stops every live Binding as one Run, marks active Invocations cancel-requested, and rejects new work while stopping", async () => {
    const { application } = createHarness();
    const ready = await createActiveTask(application);
    await application.execute({
      type: "invocation.invoke_agent", commandId: "command_stop_worker", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: ready.task.revision, runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId), idempotencyKey: "stop-worker", invocationId: "invocation_stop_worker",
      agentCardId: "agent_card_researcher", instruction: "Keep running until cancelled.", messageSelections: [],
      acceptanceCriteria: ["Return only after cancellation."],
    });
    await application.drainOutbox();
    const worker = application.read({ taskId: ready.task.taskId }).task!.bindings.find((binding) => binding.bindingId !== ready.binding.bindingId)!;
    await application.reconcileProviderFact(fact({
      bindingId: worker.bindingId, bindingRevision: worker.bindingRevision, kind: "binding_observed",
      payload: { nativeBindingRef: "worker-native-stop-1" }, deduplication: { providerEventId: "worker-bound-stop-1" },
    }));
    const beforeStop = application.read({ taskId: ready.task.taskId }).task!;

    await expect(application.execute({
      type: "task.stop", commandId: "command_stop_subset", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: beforeStop.task.revision, runId: ready.run.runId, bindingIds: [ready.binding.bindingId],
    })).rejects.toThrow("task_stop_bindings_incomplete");

    const stoppedIntent = await application.execute({
      type: "task.stop", commandId: "command_stop_all", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: beforeStop.task.revision, runId: ready.run.runId,
      bindingIds: [ready.binding.bindingId, worker.bindingId],
    });
    expect(stoppedIntent.task).toMatchObject({ status: "stopping" });
    expect(application.read({ taskId: ready.task.taskId }).task!.invocations).toEqual([
      expect.objectContaining({ invocationId: "invocation_stop_worker", status: "cancel_requested" }),
    ]);

    await expect(application.execute({
      type: "task.submit_input", commandId: "command_input_stopping", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: stoppedIntent.task!.revision, runId: ready.run.runId,
      targetLogicalSessionId: ready.run.conductorLogicalSessionId, content: "Do not send.",
    })).rejects.toThrow("task_run_not_accepting_new_work");
    await expect(application.execute({
      type: "invocation.invoke_agent", commandId: "command_invoke_stopping", issuedAt: now(), taskId: ready.task.taskId,
      expectedRevision: stoppedIntent.task!.revision, runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: "session_turn_stopping", idempotencyKey: "invoke-stopping", invocationId: "invocation_stopping",
      agentCardId: "agent_card_researcher", instruction: "Do not dispatch.", messageSelections: [], acceptanceCriteria: ["Do not run."],
    })).rejects.toThrow("task_run_not_accepting_new_work");

    await application.reconcileProviderFact(fact({
      bindingId: ready.binding.bindingId, bindingRevision: ready.binding.bindingRevision, kind: "native_terminal",
      payload: { reason: "conductor_cancelled" }, deduplication: { providerEventId: "conductor-terminal-stop-1" },
    }));
    expect(application.read({ taskId: ready.task.taskId }).task!.task.status).toBe("stopping");
    await application.reconcileProviderFact(fact({
      bindingId: worker.bindingId, bindingRevision: worker.bindingRevision, kind: "native_terminal",
      payload: { reason: "worker_cancelled" }, deduplication: { providerEventId: "worker-terminal-stop-1" },
    }));
    expect(application.read({ taskId: ready.task.taskId }).task!.task.status).toBe("stopped");
  });

  it("harness: materializes one complete final for terminal-first replay and never routes source hints", async () => {
    const { application } = createHarness();
    const ready = await createActiveTask(application);
    const worker = await createWorkerTurn(application, ready, "terminal_first");

    const terminal = fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "turn_completed",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: {},
      deduplication: { providerEventId: "terminal-first-completed" },
    });
    const final = fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "assistant_final",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: { content: "A complete final without RelayBlocks." },
      deduplication: { providerEventId: "terminal-first-final" },
    });

    expect(await application.reconcileProviderFact(terminal)).toBe(true);
    expect(application.read({ taskId: ready.task.taskId }).task!.messages.filter((message) => message.kind === "agent_final")).toHaveLength(0);
    expect(await application.reconcileProviderFact(final)).toBe(true);
    expect(await application.reconcileProviderFact(final)).toBe(false);

    const projection = application.read({ taskId: ready.task.taskId }).task!;
    const finals = projection.messages.filter((message) => message.sourceSessionTurnId === worker.turn.sessionTurnId && message.kind === "agent_final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.content).toBe("A complete final without RelayBlocks.");
    expect(projection.relayBlocks.filter((block) => block.sourceMessageId === finals[0]!.messageId)).toHaveLength(0);
    expect(projection.inboxItems.filter((item) => item.renderedMessageId === finals[0]!.messageId)).toEqual([
      expect.objectContaining({ targetLogicalSessionId: ready.run.conductorLogicalSessionId }),
    ]);
    expect(projection.task.achievement).toBeUndefined();
  });

  it("harness: keeps Provider activity human-only and rejects it as invoke, relay, or publish content", async () => {
    const { application } = createHarness();
    const ready = await createActiveTask(application);
    const worker = await createWorkerTurn(application, ready, "activity_not_routable");
    const activityId = "activity_renderer-only";
    const activityContent = "ACTIVITY_CONTENT_MUST_NOT_ROUTE";
    const before = application.read({ taskId: ready.task.taskId }).task!;
    const collaborationCounts = (projection: typeof before) => ({
      messages: projection.messages.length,
      relayBlocks: projection.relayBlocks.length,
      forwards: projection.messageForwards.length,
      inbox: projection.inboxItems.length,
    });

    expect(await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "activity_observed",
      correlation: {
        inputSubmissionId: worker.input.inputSubmissionId,
        invocationId: worker.invocationId,
        sessionTurnId: worker.turn.sessionTurnId,
      },
      payload: {
        schemaVersion: 1,
        activityId,
        category: "tool",
        phase: "completed",
        title: "Shell command",
        content: activityContent,
        updateMode: "replace",
        sequence: 1,
      },
      deduplication: { providerEventId: "activity-not-routable-completed" },
    }))).toBe(true);

    const withActivity = application.read({ taskId: ready.task.taskId }).task!;
    expect(withActivity.providerActivities).toEqual([
      expect.objectContaining({ activityId, content: activityContent, status: "completed" }),
    ]);
    expect(collaborationCounts(withActivity)).toEqual(collaborationCounts(before));

    const selection = [{ kind: "full_message" as const, sourceMessageId: activityId }];
    const decisionTurnId = conductorDecisionTurnId(application, ready.task.taskId);
    const common = {
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: withActivity.task.revision,
      runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: decisionTurnId,
      messageSelections: selection,
    };
    await expect(application.execute({
      ...common,
      type: "invocation.invoke_agent",
      commandId: "command_activity_invoke",
      idempotencyKey: "activity:invoke",
      invocationId: "invocation_activity_invoke",
      agentCardId: "agent_card_researcher",
      instruction: "This must not run.",
      acceptanceCriteria: [],
    })).rejects.toThrow("message_selection_source_not_found");
    await expect(application.execute({
      ...common,
      type: "session.relay_message",
      commandId: "command_activity_relay",
      idempotencyKey: "activity:relay",
      targetAgentCardId: "agent_card_researcher",
    })).rejects.toThrow("message_selection_source_not_found");
    await expect(application.execute({
      ...common,
      type: "session.publish_message",
      commandId: "command_activity_publish",
      idempotencyKey: "activity:publish",
      fanoutKey: "activity:publish",
      targetAgentCardIds: ["agent_card_researcher"],
    })).rejects.toThrow("message_selection_source_not_found");

    const after = application.read({ taskId: ready.task.taskId }).task!;
    expect(collaborationCounts(after)).toEqual(collaborationCounts(before));
    expect(JSON.stringify({
      messages: after.messages,
      relayBlocks: after.relayBlocks,
      messageForwards: after.messageForwards,
      inboxItems: after.inboxItems,
    })).not.toContain(activityContent);
  });

  it("harness: keeps a busy human intervention unsent until the old Turn safely returns", async () => {
    const { application, provider } = createHarness();
    const ready = await createActiveTask(application);
    const worker = await createWorkerTurn(application, ready, "human_late_final");
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "turn_started",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: {},
      deduplication: { providerEventId: "human-late-turn-started" },
    }));
    const before = application.read({ taskId: ready.task.taskId }).task!;
    const command = {
      type: "session.send_human_message" as const,
      commandId: "command_human_late_final",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      humanInterventionId: "human_intervention_late_final",
      idempotencyKey: "human:late-final",
      targetLogicalSessionId: worker.session.logicalSessionId,
      content: "Use the corrected premise after closing the current turn.",
    };

    await application.execute(command);
    let projection = application.read({ taskId: ready.task.taskId }).task!;
    expect(projection.humanInterventions).toEqual([expect.objectContaining({
      humanInterventionId: command.humanInterventionId,
      mode: "interrupt_then_send",
      state: "interrupting",
      affectedSessionTurnId: worker.turn.sessionTurnId,
      affectedInvocationId: worker.invocationId,
    })]);
    expect(projection.messages).toHaveLength(before.messages.length);
    expect(projection.inputs).toHaveLength(before.inputs.length);
    expect(projection.sessionTurns).toHaveLength(before.sessionTurns.length);
    await application.drainOutbox();
    expect(provider.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "request_interrupt", request: expect.objectContaining({
        bindingId: worker.binding.bindingId,
        invocationId: worker.invocationId,
      }) }),
    ]));

    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "transport_unknown",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: { reason: "interrupt outcome unknown" },
      deduplication: { providerEventId: "human-late-interrupt-unknown" },
    }));
    projection = application.read({ taskId: ready.task.taskId }).task!;
    expect(projection.humanInterventions[0]).toMatchObject({ state: "interrupting" });
    expect(projection.messages).toHaveLength(before.messages.length);

    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "assistant_final",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: { content: "The old invocation returned before interrupt confirmation." },
      deduplication: { providerEventId: "human-late-final" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "turn_completed",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: {},
      deduplication: { providerEventId: "human-late-completed" },
    }));

    projection = application.read({ taskId: ready.task.taskId }).task!;
    expect(projection.messages.filter((message) => message.sourceSessionTurnId === worker.turn.sessionTurnId && message.kind === "agent_final")).toHaveLength(1);
    expect(projection.messages.filter((message) => message.sourceSessionTurnId === worker.turn.sessionTurnId && message.kind === "runtime_notice")).toHaveLength(0);
    expect(projection.humanInterventions[0]).toMatchObject({ state: "sent" });
    expect(projection.messages.filter((message) => message.sourceHumanInterventionId === command.humanInterventionId)).toHaveLength(2);
    expect(projection.inboxItems.filter((item) => item.humanInterventionId === command.humanInterventionId).map((item) => item.targetLogicalSessionId).sort()).toEqual([
      ready.run.conductorLogicalSessionId,
      worker.session.logicalSessionId,
    ].sort());
    expect(projection.invocations.find((invocation) => invocation.invocationId === worker.invocationId)).toMatchObject({ status: "returned" });
  });

  it("harness: replays idle human direct after a receipt crash without duplicate Card or Conductor messages", async () => {
    const { application, provider, repositories, store, workspaceResolver } = createHarness();
    const ready = await createActiveTask(application);
    const worker = await createWorkerTurn(application, ready, "human_direct");
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "assistant_final",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: { content: "Worker is now idle." },
      deduplication: { providerEventId: "human-direct-final" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "turn_completed",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: {},
      deduplication: { providerEventId: "human-direct-completed" },
    }));
    const command = {
      type: "session.send_human_message" as const,
      commandId: "command_human_direct_replay",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      humanInterventionId: "human_intervention_direct_replay",
      idempotencyKey: "human:direct-replay",
      targetLogicalSessionId: worker.session.logicalSessionId,
      content: "Check this exact correction.",
    };
    await application.execute(command);
    store.run("DELETE FROM runtime_commands WHERE command_id = ?", command.commandId);
    const restarted = new RuntimeApplication({
      repositories,
      providers: createProviderRegistry([provider]),
      workspaceDirectoryResolver: workspaceResolver,
      now,
    });
    await restarted.execute(command);

    const projection = restarted.read({ taskId: ready.task.taskId }).task!;
    expect(projection.humanInterventions).toEqual([expect.objectContaining({
      humanInterventionId: command.humanInterventionId,
      mode: "direct",
      state: "sent",
    })]);
    expect(projection.messages.filter((message) => message.sourceHumanInterventionId === command.humanInterventionId)).toHaveLength(2);
    expect(projection.inboxItems.filter((item) => item.humanInterventionId === command.humanInterventionId)).toHaveLength(2);
  });

  it("harness: persists one explicit fan-out snapshot and rejects changed crash replays", async () => {
    const base = templateDefinitionFixture();
    const definition = {
      ...base,
      agentCards: [
        base.agentCards[0]!,
        { ...base.agentCards[0]!, agentCardId: "agent_card_reviewer", title: "Reviewer" },
        { ...base.agentCards[0]!, agentCardId: "agent_card_observer", title: "Observer" },
      ],
    };
    const { application, provider, repositories, store, workspaceResolver } = createHarness();
    const ready = await createActiveTask(application, definition);
    const worker = await createWorkerTurn(application, ready, "publish_source");
    const sourceContent = [
      "Private surrounding analysis.",
      "```relay",
      "topic: game.board",
      "audience: publish",
      "format: application/json",
      "---",
      '{"turn":4}',
      "```",
      "Private trailing analysis.",
    ].join("\n");
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "assistant_final",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: { content: sourceContent },
      deduplication: { providerEventId: "publish-source-final" },
    }));
    await application.reconcileProviderFact(fact({
      bindingId: worker.binding.bindingId,
      bindingRevision: worker.binding.bindingRevision,
      kind: "turn_completed",
      correlation: { inputSubmissionId: worker.input.inputSubmissionId },
      payload: {},
      deduplication: { providerEventId: "publish-source-completed" },
    }));
    let projection = application.read({ taskId: ready.task.taskId }).task!;
    const sourceMessage = projection.messages.find((message) => message.sourceSessionTurnId === worker.turn.sessionTurnId && message.kind === "agent_final")!;
    const block = projection.relayBlocks.find((entry) => entry.sourceMessageId === sourceMessage.messageId)!;
    const command = {
      type: "session.publish_message" as const,
      commandId: "command_publish_board",
      issuedAt: now(),
      taskId: ready.task.taskId,
      expectedRevision: ready.task.revision,
      runId: ready.run.runId,
      sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
      decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId),
      idempotencyKey: "publish:board:4",
      fanoutKey: "board:4",
      targetAgentCardIds: ["agent_card_researcher", "agent_card_reviewer", "agent_card_observer"],
      messageSelections: [{ kind: "relay_block" as const, sourceMessageId: sourceMessage.messageId, relayBlockId: block.relayBlockId }],
    };
    await application.execute(command);
    const partial = application.read({ taskId: ready.task.taskId }).task!;
    const observerSession = partial.logicalSessions.find((session) => session.agentCardId === "agent_card_observer")!;
    const missingForward = partial.messageForwards.find((forward) => forward.mode === "publish" && forward.targetLogicalSessionId === observerSession.logicalSessionId)!;
    const survivingForwardIds = partial.messageForwards
      .filter((forward) => forward.mode === "publish" && forward.forwardId !== missingForward.forwardId)
      .map((forward) => forward.forwardId)
      .sort();
    store.transaction(() => {
      store.run("DELETE FROM session_inbox_items WHERE forward_id = ?", missingForward.forwardId);
      store.run("DELETE FROM message_forward_selections WHERE forward_id = ?", missingForward.forwardId);
      store.run("DELETE FROM message_forwards WHERE forward_id = ?", missingForward.forwardId);
      store.run("DELETE FROM session_messages WHERE message_id = ?", missingForward.renderedMessageId);
      store.run("UPDATE message_forward_batches SET state = ? WHERE publish_batch_id = ?", "materializing", missingForward.publishBatchId!);
    });
    store.run("DELETE FROM runtime_commands WHERE command_id = ?", command.commandId);
    const restarted = new RuntimeApplication({
      repositories,
      providers: createProviderRegistry([provider]),
      workspaceDirectoryResolver: workspaceResolver,
      now,
    });
    await restarted.execute(command);

    projection = restarted.read({ taskId: ready.task.taskId }).task!;
    expect(projection.messageForwardBatches).toEqual([expect.objectContaining({
      fanoutKey: command.fanoutKey,
      state: "settled",
    })]);
    expect(projection.messageForwards.filter((forward) => forward.mode === "publish")).toHaveLength(3);
    expect(projection.messageForwards.filter((forward) => forward.mode === "publish" && forward.forwardId !== missingForward.forwardId)
      .map((forward) => forward.forwardId).filter((forwardId) => survivingForwardIds.includes(forwardId)).sort()).toEqual(survivingForwardIds);
    expect(projection.inboxItems.filter((item) => {
      const forward = item.forwardId ? projection.messageForwards.find((entry) => entry.forwardId === item.forwardId) : undefined;
      return forward?.mode === "publish";
    })).toHaveLength(3);
    expect(projection.logicalSessions.filter((session) => session.kind === "card").map((session) => session.ordinal)).toEqual([2, 3, 4]);
    const rendered = projection.messageForwards.filter((forward) => forward.mode === "publish")
      .map((forward) => projection.messages.find((message) => message.messageId === forward.renderedMessageId)!.content);
    expect(rendered.every((content) => content.includes('{"turn":4}') && !content.includes("Private surrounding analysis."))).toBe(true);

    await expect(restarted.execute({
      ...command,
      commandId: "command_publish_board_conflict",
      idempotencyKey: "publish:board:changed",
      targetAgentCardIds: ["agent_card_researcher", "agent_card_reviewer"],
    })).rejects.toThrow("message_forward_batch_replay_conflict");
  });
});

async function completeConductorTurn(
  application: RuntimeApplication,
  ready: Awaited<ReturnType<typeof createActiveTask>>,
  prefix: string,
) {
  await application.drainOutbox();
  let projection = application.read({ taskId: ready.task.taskId }).task!;
  const input = projection.inputs[0]!;
  await application.reconcileProviderFact(fact({
    provider: ready.binding.provider,
    bindingId: ready.binding.bindingId,
    bindingRevision: ready.binding.bindingRevision,
    kind: "input_received",
    correlation: { inputSubmissionId: input.inputSubmissionId, nativeTurnId: `${prefix}-turn` },
    payload: {},
    deduplication: { providerEventId: `${prefix}-input` },
  }));
  await application.reconcileProviderFact(fact({
    provider: ready.binding.provider,
    bindingId: ready.binding.bindingId,
    bindingRevision: ready.binding.bindingRevision,
    kind: "assistant_final",
    correlation: { inputSubmissionId: input.inputSubmissionId, nativeTurnId: `${prefix}-turn` },
    payload: { content: "Task Goal completed." },
    deduplication: { providerEventId: `${prefix}-final` },
  }));
  await application.reconcileProviderFact(fact({
    provider: ready.binding.provider,
    bindingId: ready.binding.bindingId,
    bindingRevision: ready.binding.bindingRevision,
    kind: "turn_completed",
    correlation: { inputSubmissionId: input.inputSubmissionId, nativeTurnId: `${prefix}-turn` },
    payload: {},
    deduplication: { providerEventId: `${prefix}-completed` },
  }));
  projection = application.read({ taskId: ready.task.taskId }).task!;
  expect(projection.sessionTurns).toEqual([expect.objectContaining({ status: "returned" })]);
  return projection;
}

async function createActiveTask(
  application: RuntimeApplication,
  definition: ReturnType<typeof templateDefinitionFixture> = templateDefinitionFixture(),
): Promise<{
  readonly task: TaskRecord;
  readonly run: TaskRunRecord;
  readonly binding: ProviderSessionBindingRecord;
}> {
  await application.execute({
    type: "template.create_draft", commandId: "command_active_draft", issuedAt: now(), ownerId: "user_1",
    metadata: { title: "Active Team", slug: "active-team" }, initialDefinition: definition,
  });
  const draft = application.read().templateLibrary.drafts[0]!;
  await application.execute({
    type: "template.publish_draft", commandId: "command_active_publish", issuedAt: now(), templateDraftId: draft.templateDraftId,
    expectedRevision: draft.revision, slug: "active-team", title: "Active Team",
  });
  const versionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
  const created = await createTaskFromSetup(application, {
    commandId: "command_active_task", taskId: "task_active", templateVersionId: versionId,
    title: "Active task", goal: "Produce reports/result.md.",
  });
  const started = await application.execute({
    type: "task.start", commandId: "command_active_start", issuedAt: now(), taskId: "task_active", expectedRevision: created.task!.revision,
  });
  await application.drainOutbox();
  const binding = application.read({ taskId: "task_active" }).task!.bindings[0]!;
  await application.reconcileProviderFact(fact({
    provider: binding.provider,
    bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, kind: "binding_observed",
    payload: { nativeBindingRef: "conductor-native-1" }, deduplication: { providerEventId: "conductor-bound-1" },
  }));
  const task = application.read({ taskId: "task_active" }).task!;
  return { task: task.task, run: task.activeRun!, binding: task.bindings[0]! };
}

async function createQueuedTask(application: RuntimeApplication, suffix: string) {
  const slug = `queued-${suffix.replaceAll("_", "-")}`;
  await application.execute({
    type: "template.create_draft",
    commandId: `command_${suffix}_draft`,
    issuedAt: now(),
    ownerId: "user_1",
    metadata: { title: `Queued ${suffix}`, slug },
    initialDefinition: templateDefinitionFixture(),
  });
  const draft = application.read().templateLibrary.drafts[0]!;
  await application.execute({
    type: "template.publish_draft",
    commandId: `command_${suffix}_publish`,
    issuedAt: now(),
    templateDraftId: draft.templateDraftId,
    expectedRevision: draft.revision,
    slug,
    title: `Queued ${suffix}`,
  });
  const templateVersionId = application.read().templateLibrary.templates[0]!.template.activeVersionId!;
  return createTaskFromSetup(application, {
    commandId: `command_${suffix}_task`,
    taskId: `task_${suffix}`,
    templateVersionId,
    title: `Queued ${suffix}`,
    goal: "Remain queued until explicitly started.",
  });
}

async function createTaskFromSetup(application: RuntimeApplication, input: Readonly<{
  commandId: string;
  taskId: string;
  templateVersionId: string;
  title: string;
  goal: string;
  ownerId?: string;
  workspaceId?: string;
  taskInputValues?: readonly TaskInputValue[];
}>) {
  const ownerId = input.ownerId ?? "user_1";
  const workspaceId = input.workspaceId ?? "workspace_1";
  const setupResult = await application.execute({
    type: "task_setup.create_draft",
    commandId: `${input.commandId}_setup`,
    issuedAt: now(),
    ownerId,
    templateVersionId: input.templateVersionId,
    workspaceId,
    title: input.title,
    goal: input.goal,
    taskInputValues: input.taskInputValues ?? [],
  });
  const setup = setupResult.taskSetupDraft!;
  return application.execute({
    type: "task.create",
    commandId: input.commandId,
    issuedAt: now(),
    taskId: input.taskId,
    ownerId,
    workspaceId,
    taskSetupDraftId: setup.taskSetupDraftId,
    expectedTaskSetupRevision: setup.revision,
  });
}

async function createWorkerTurn(
  application: RuntimeApplication,
  ready: Awaited<ReturnType<typeof createActiveTask>>,
  suffix: string,
  agentCardId = "agent_card_researcher",
) {
  const invocationId = `invocation_${suffix}`;
  await application.execute({
    type: "invocation.invoke_agent",
    commandId: `command_invoke_${suffix}`,
    issuedAt: now(),
    taskId: ready.task.taskId,
    expectedRevision: ready.task.revision,
    runId: ready.run.runId,
    sourceLogicalSessionId: ready.run.conductorLogicalSessionId,
    decidedBySessionTurnId: conductorDecisionTurnId(application, ready.task.taskId),
    idempotencyKey: `invoke:${suffix}`,
    invocationId,
    agentCardId,
    instruction: `Complete harness ${suffix}.`,
    messageSelections: [],
    acceptanceCriteria: ["Return one complete final Message."],
  });
  await application.drainOutbox();
  let projection = application.read({ taskId: ready.task.taskId }).task!;
  const session = projection.logicalSessions.find((entry) => entry.agentCardId === agentCardId)!;
  const binding = projection.bindings.find((entry) => entry.logicalSessionId === session.logicalSessionId)!;
  if (!binding.nativeBindingRef) {
    await application.reconcileProviderFact(fact({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      kind: "binding_observed",
      payload: { nativeBindingRef: `native-${suffix}` },
      deduplication: { providerEventId: `binding-observed-${suffix}` },
    }));
  }
  await application.drainOutbox();
  projection = application.read({ taskId: ready.task.taskId }).task!;
  const turn = projection.sessionTurns.find((entry) => entry.invocationId === invocationId)!;
  const input = projection.inputs.find((entry) => entry.inputSubmissionId === turn.inputSubmissionId)!;
  return { binding: projection.bindings.find((entry) => entry.bindingId === binding.bindingId)!, input, invocationId, session, turn };
}

function conductorDecisionTurnId(application: RuntimeApplication, taskId: string): string {
  const projection = application.read({ taskId }).task!;
  const turn = projection.sessionTurns.find((entry) => entry.kind === "conductor");
  if (!turn) throw new Error("test_conductor_turn_missing");
  return turn.sessionTurnId;
}

function createHarness(options: {
  readonly managedArtifactPort?: ManagedArtifactPort;
  readonly metaAgent?: FakeMetaAgent;
  readonly metaProfiles?: readonly MetaProfileOptionDefinition[];
  readonly providerPorts?: readonly ProviderPort[];
} = {}): {
  readonly application: RuntimeApplication;
  readonly provider: RecordingProvider;
  readonly metaAgent: FakeMetaAgent;
  readonly repositories: RuntimeRepositories;
  readonly store: SqliteRuntimeStore;
  readonly workspaceResolver: ReturnType<typeof createWorkspaceResolver>;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-application-"));
  paths.push(directory);
  const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite"), now });
  const provider = new RecordingProvider();
  const metaAgent = options.metaAgent ?? createFakeMetaAgent({
    provider: "codex",
    capabilities: {
      providerVersion: metaProfileFixture.providerVersion,
      protocolFingerprint: metaProfileFixture.protocolFingerprint,
    },
  });
  const repositories = createRuntimeRepositories(store);
  const workspaceResolver = createWorkspaceResolver();
  repositories.workspace.createAuthorization({
    workspaceId: "workspace_1",
    canonicalDirectory: "/tmp/project",
    displayName: "project",
    authorizedAt: now(),
  });
  return {
    provider,
    metaAgent,
    repositories,
    store,
    workspaceResolver,
    application: new RuntimeApplication({
      repositories,
      providers: createProviderRegistry(options.providerPorts ?? [provider]),
      workspaceDirectoryResolver: workspaceResolver,
      managedArtifactPort: options.managedArtifactPort,
      metaProfiles: createMetaProfileRegistry(options.metaProfiles ?? []),
      metaAgents: createMetaAgentRegistry([metaAgent]),
      now,
    }),
  };
}

function reopenApplication(
  harness: ReturnType<typeof createHarness>,
  metaAgent?: FakeMetaAgent,
): RuntimeApplication {
  return new RuntimeApplication({
    repositories: harness.repositories,
    providers: createProviderRegistry([harness.provider]),
    workspaceDirectoryResolver: harness.workspaceResolver,
    metaProfiles: createMetaProfileRegistry([metaProfileOptionFixture]),
    metaAgents: createMetaAgentRegistry(metaAgent ? [metaAgent] : []),
    now,
  });
}

const metaProfileFixture: MetaProfileDefinition = {
  metaProfileId: "meta_profile_test",
  provider: "codex",
  model: "gpt-5.6",
  providerVersion: "0.146.0",
  protocolFingerprint: "sha256:meta-test",
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

const metaProfileOptionFixture: MetaProfileOptionDefinition = {
  metaProfileOptionId: "meta_profile_option_test",
  title: "Locked Meta",
  availability: "available",
  profile: metaProfileFixture,
};

class RecordingArtifactPort implements ManagedArtifactPort {
  readonly deleteCalls: unknown[] = [];
  readonly verifyCalls: Parameters<ManagedArtifactPort["verifyArtifact"]>[0][] = [];

  async verifyArtifact(input: Parameters<ManagedArtifactPort["verifyArtifact"]>[0]) {
    this.verifyCalls.push(input);
    return {
      artifactId: input.artifactId,
      taskId: input.architecture.taskId,
      runId: input.runId,
      workspaceRelativePath: input.workspaceRelativePath,
      contentDigest: `sha256:${"a".repeat(64)}`,
      sourceInvocationId: input.sourceInvocationId,
      sourceMessageId: input.sourceMessageId,
      evidenceReferenceIds: input.evidenceReferenceIds,
      verifiedAt: input.verifiedAt,
    };
  }

  async previewArtifact(): Promise<never> {
    throw new Error("not_used_in_retention_test");
  }

  async previewPermanentDelete(input: Parameters<ManagedArtifactPort["previewPermanentDelete"]>[0]) {
    return {
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      artifacts: input.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, displayName: "artifact", state: "deletable" as const })),
    };
  }

  async deleteArtifacts(input: Parameters<ManagedArtifactPort["deleteArtifacts"]>[0]) {
    this.deleteCalls.push(input);
    return { deletedArtifactIds: [], skippedArtifacts: [] };
  }
}

function createWorkspaceResolver() {
  const calls: string[] = [];
  return {
    calls,
    async canonicalizeDirectory(directory: string) {
      calls.push(directory);
      if (directory === "/workspace-link/research") {
        return { canonicalDirectory: "/canonical/research", defaultDisplayName: "research" };
      }
      if (directory === "/canonical/research") {
        return { canonicalDirectory: "/canonical/research", defaultDisplayName: "research" };
      }
      if (directory === "/tmp/project") {
        return { canonicalDirectory: "/tmp/project", defaultDisplayName: "project" };
      }
      throw new Error("workspace_directory_not_found");
    },
  };
}

function now(): string {
  counter += 1;
  return new Date(Date.UTC(2026, 7, 6, 0, 0, counter)).toISOString();
}

function outboxCount(store: SqliteRuntimeStore): number {
  return Number(store.one<{ count: number }>("SELECT COUNT(*) AS count FROM outbox")?.count ?? 0);
}

function fact(input: Omit<ProviderFact, "providerFactId" | "provider" | "observedAt" | "correlation"> & {
  readonly provider?: ProviderKind;
  readonly correlation?: ProviderFact["correlation"];
}): ProviderFact {
  const { provider = "opencode", ...factInput } = input;
  return {
    providerFactId: `provider_fact_${counter + 1}`,
    provider,
    correlation: input.correlation ?? {},
    observedAt: now(),
    ...factInput,
  };
}

class CountingMetaAgent extends FakeMetaAgent {
  probes = 0;
  failCapabilityProbe = false;

  override describeMetaCapabilities(profile: MetaProfileDefinition) {
    this.probes += 1;
    if (this.failCapabilityProbe) return Promise.reject(new Error("transient_meta_probe_failure"));
    return super.describeMetaCapabilities(profile);
  }
}

class RecordingProvider implements ProviderPort {
  readonly effects: ProviderEffect[] = [];
  readonly requests: Array<{ readonly kind: ProviderEffect["kind"]; readonly request: object }> = [];
  readonly reconciliationRequests: Parameters<ProviderPort["reconcileBinding"]>[0][] = [];
  readonly releasedBindings: string[] = [];
  capabilityProbes = 0;
  #capabilities: ExecutionProfileDefinition["capabilityPolicy"]["requiredCapabilities"] | undefined;

  constructor(
    readonly provider: ProviderKind = "opencode",
    readonly reportedPin: Readonly<{ providerVersion?: string; protocolFingerprint?: string }> = {},
  ) {}

  async describeCapabilities(profile: ExecutionProfileDefinition): Promise<ProviderCapabilities> {
    this.capabilityProbes += 1;
    return {
      provider: this.provider,
      available: profile.provider === this.provider,
      providerVersion: this.reportedPin.providerVersion ?? profile.providerVersion,
      protocolFingerprint: this.reportedPin.protocolFingerprint ?? profile.protocolFingerprint,
      capabilities: this.#capabilities ?? profile.capabilityPolicy.requiredCapabilities,
      unavailableReasons: [],
    };
  }

  setCapabilities(capabilities: ExecutionProfileDefinition["capabilityPolicy"]["requiredCapabilities"]): void {
    this.#capabilities = capabilities;
  }

  async ensureBinding(request: Parameters<ProviderPort["ensureBinding"]>[0]): Promise<ProviderEffect> {
    return this.effect("ensure_binding", request);
  }

  async submitDelivery(request: Parameters<ProviderPort["submitDelivery"]>[0]): Promise<ProviderEffect> {
    return this.effect("submit_delivery", request);
  }

  async *observeBinding(): AsyncIterable<ProviderFact> { /* Tests reconcile facts explicitly. */ }

  async reconcileBinding(request: Parameters<ProviderPort["reconcileBinding"]>[0]): Promise<readonly ProviderFact[]> {
    this.reconciliationRequests.push(request);
    return [];
  }

  async requestInterrupt(request: Parameters<ProviderPort["requestInterrupt"]>[0]): Promise<ProviderEffect> {
    return this.effect("request_interrupt", request);
  }

  async respondAttention(request: Parameters<NonNullable<ProviderPort["respondAttention"]>>[0]): Promise<ProviderEffect> {
    return this.effect("respond_attention", request);
  }

  async openPresentation(): Promise<SessionPresentation> {
    throw new Error("not_used_in_application_test");
  }

  async releaseBinding(request: Parameters<ProviderPort["releaseBinding"]>[0]): Promise<void> {
    this.releasedBindings.push(request.bindingId);
  }

  private effect(kind: ProviderEffect["kind"], request: object): ProviderEffect {
    this.requests.push({ kind, request });
    const value = request as { bindingId?: unknown; inputSubmissionId?: unknown; invocationId?: unknown; attentionId?: unknown };
    const effect: ProviderEffect = {
      effectId: `effect_${this.effects.length + 1}`, kind, provider: "opencode", acceptance: "accepted", acceptedAt: now(),
      ...(typeof value.bindingId === "string" ? { bindingId: value.bindingId } : {}),
      ...(typeof value.inputSubmissionId === "string" ? { inputSubmissionId: value.inputSubmissionId } : {}),
      ...(typeof value.invocationId === "string" ? { invocationId: value.invocationId } : {}),
      ...(typeof value.attentionId === "string" ? { attentionId: value.attentionId } : {}),
    };
    this.effects.push(effect);
    return effect;
  }
}

class HangingReadinessProvider extends RecordingProvider {
  override describeCapabilities(_profile: ExecutionProfileDefinition): Promise<ProviderCapabilities> {
    this.capabilityProbes += 1;
    return new Promise(() => undefined);
  }
}
