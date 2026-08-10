import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  JsonObject,
  MetaProfileOptionDefinition,
  ProviderFact,
  ProviderFactCorrelation,
  ProviderFactKind,
  ProviderSessionBindingRecord,
  RuntimeCommandId,
  SessionMessageRecord,
  SessionTurnRecord,
  TaskRuntimeReadModel,
  TemplateDefinition,
} from "@agent-workspace/runtime-contracts";
import {
  createRuntimeConductorClient,
  createRuntimeConductorGateway,
} from "@agent-workspace/conductor-tools";
import type { RuntimeClient } from "@agent-workspace/runtime-client";
import type {
  MetaAgentPort,
  MetaAgentTurnRequest,
  ProviderPort,
} from "@agent-workspace/provider-port";
import { FakeProvider } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeBridgeServer,
  type RuntimeBridgeServer,
} from "../../apps/runtime-host/src/runtime-bridge.js";
import {
  createRuntimeHost,
  type RuntimeHost,
} from "../../apps/runtime-host/src/runtime-host.js";
import { createHttpRuntimeClient } from "../../packages/runtime-client/src/http.js";
import {
  JourneyEvidenceRecorder,
  type JourneyAssertion,
  type JourneyCheckpoint,
} from "./journey-evidence.js";

const USER_ID = "user_deepsearch";
const WORKSPACE_ID = "workspace_deepsearch";
const TASK_ID = "task_deepsearch";
const USER_BRIDGE_CREDENTIAL = "deepsearch-user-bridge";
const CONDUCTOR_BRIDGE_CREDENTIAL = "deepsearch-conductor-bridge";
const HTML_PATH = "reports/stock-research.html";
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("DeepSearch golden journey through Runtime Host HTTP bridges", () => {
  it("records DS-01..DS-09 from Template/Meta/Task Setup through Conductor intervention, verified HTML, restart, Achieve, and Stop", async () => {
    const preserveParent = process.env.AGENT_WORKSPACE_DEEPSEARCH_PRESERVE_PARENT?.trim();
    if (preserveParent && !path.isAbsolute(preserveParent)) throw new Error("deepsearch_preserve_parent_must_be_absolute");
    if (preserveParent) await mkdir(preserveParent, { recursive: true });
    const root = await mkdtemp(path.join(preserveParent || tmpdir(), "agent-workspace-deepsearch-"));
    if (preserveParent) process.stdout.write(`${JSON.stringify({ type: "deepsearch_fixture_preserved", root })}\n`);
    else cleanupRoots.push(root);
    const workspaceDirectory = path.join(root, "workspace");
    const evidenceDirectory = path.join(root, "evidence", "journey_deepsearch-http");
    const databasePath = path.join(root, "runtime.sqlite");
    await mkdir(workspaceDirectory, { recursive: true });

    const clock = new TestClock();
    const provider = new FakeProvider({ provider: "codex", now: () => clock.next() });
    const providerPort = providerPortFromFake(provider);
    const metaAgent = new ControlledMetaAgent(clock);
    const recorder = new JourneyEvidenceRecorder({
      root: evidenceDirectory,
      journeyId: "journey_deepsearch-http",
      aliasKey: Buffer.alloc(32, 23),
    });
    await recorder.initialize({
      harness: "runtime_host_http_bridge",
      providerMode: "controlled_fake_codex",
      trustedMetaBoundary: "meta_agent_port_only",
    });
    const assertions: JourneyAssertion[] = [];
    const facts = new ProviderFactFactory(clock);
    const metaProfileOptions = [metaProfileOption()] as const;

    let host = createRuntimeHost({
      databasePath,
      providerPorts: [providerPort],
      metaAgentPorts: [metaAgent],
      metaProfileOptions,
      now: () => clock.next(),
    });
    let userBridge = await openBridge(host, USER_BRIDGE_CREDENTIAL, {
      actor: "user",
      userId: USER_ID,
      workspaceIds: [WORKSPACE_ID],
    });
    let userClient = createHttpRuntimeClient({
      baseUrl: userBridge.url,
      authorization: USER_BRIDGE_CREDENTIAL,
    });
    let conductorBridge: OpenBridge | undefined;

    try {
      const definition = deepSearchDefinition();
      const createDraftCommand = {
        type: "template.create_draft" as const,
        commandId: "command_ds01-create-draft",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metadata: {
          title: "DeepSearch",
          slug: "deepsearch",
          description: "A reviewable multi-agent stock research template.",
        },
        initialDefinition: definition,
      };
      await userClient.command(createDraftCommand);
      let rootModel = await userClient.read();
      let templateDraft = rootModel.templateLibrary.drafts.find(({ metadata }) => metadata.slug === "deepsearch")!;
      expect(templateDraft).toMatchObject({ status: "editing", revision: 1 });
      expect(templateDraft.definition.schemaVersion).toBe(2);
      expect(templateDraft.definition.agentCards.map(({ agentCardId }) => agentCardId)).toEqual([
        "agent_card_researcher",
        "agent_card_reviewer",
        "agent_card_html-publisher",
      ]);
      expect(templateDraft.definition.taskInputSchema?.fields.map(({ fieldId, kind }) => ({ fieldId, kind }))).toEqual([
        { fieldId: "topic", kind: "short_text" },
        { fieldId: "brief", kind: "long_text" },
        { fieldId: "depth", kind: "choice" },
      ]);
      expect(templateDraft.definition.taskInputSchema?.fields[2]).toMatchObject({
        options: [
          { optionId: "quick", label: "Quick scan" },
          { optionId: "deep", label: "Deep review" },
        ],
      });
      expect(rootModel.taskLibrary.tasks).toHaveLength(0);
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-01",
        surface: "runtime-host",
        eventKind: "command_recorded",
        identities: { templateDraft: templateDraft.templateDraftId },
        summary: evidenceSummary(recorder, {
          writer: "template_meta_service",
          identity: templateDraft.templateDraftId,
          commandId: createDraftCommand.commandId,
          idempotencyKey: createDraftCommand.commandId,
          fence: "new draft",
          effectKind: "none",
          recovery: "durable draft and command receipt",
        }),
        observation: {
          state: templateDraft.status,
          schemaVersion: templateDraft.definition.schemaVersion,
          agentCardCount: templateDraft.definition.agentCards.length + 1,
          taskInputCount: templateDraft.definition.taskInputSchema?.fields.length ?? 0,
          taskCount: rootModel.taskLibrary.tasks.length,
          runCount: 0,
        },
        assertionIds: ["ds01-typed-template-draft-without-task"],
      });

      const createTemplateMeta = await userClient.command({
        type: "meta.create_session",
        commandId: "command_ds02-create-meta-session",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaProfileOptionId: "meta_profile_option_deepsearch-codex",
        target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
      });
      let templateMetaSession = createTemplateMeta.metaSession!;
      expect(templateMetaSession).toMatchObject({
        mode: "template_design",
        state: "active",
        revision: 1,
        metaProfile: {
          provider: "codex",
          providerVersion: "fake-provider/1",
          protocolFingerprint: "fake-provider-contract/v1",
          capabilityPolicy: {
            allowedTools: [],
            permissionMode: "deny",
            maxNativeChildren: 0,
          },
        },
      });
      await userClient.command({
        type: "meta.send_message",
        commandId: "command_ds02-send-meta-message",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaSessionId: templateMetaSession.metaSessionId,
        expectedSessionRevision: templateMetaSession.revision,
        expectedTargetRevision: templateDraft.revision,
        idempotencyKey: "command_ds02-send-meta-message",
        content: "Tighten the Researcher prompt and make the Publisher use its dedicated Codex profile.",
      });
      const templateMetaTurn = await drainUntilMetaReturned(host, userClient, templateMetaSession.metaSessionId);
      rootModel = await userClient.read();
      templateMetaSession = rootModel.configuration.metaSessions.find(({ metaSessionId }) => metaSessionId === templateMetaSession.metaSessionId)!;
      const templateMetaResponse = {
        message: rootModel.configuration.metaMessages.find(({ metaSessionId, role }) =>
          metaSessionId === templateMetaSession.metaSessionId && role === "assistant",
        )!,
        proposal: rootModel.configuration.metaPatchProposals.find(({ metaSessionId }) =>
          metaSessionId === templateMetaSession.metaSessionId,
        )!,
      };
      expect(templateMetaResponse.proposal).toMatchObject({
        state: "pending",
        targetRevision: 1,
        operations: [
          { kind: "template_card_prompt_set" },
          { kind: "template_card_profile_set" },
          { kind: "template_profile_model_set" },
        ],
      });
      expect(metaAgent.requests).toHaveLength(1);
      expect(metaAgent.requests[0]).toMatchObject({
        mode: "template_design",
        targetRevision: 1,
        profile: {
          provider: "codex",
          capabilityPolicy: { allowedTools: [], permissionMode: "deny", maxNativeChildren: 0 },
        },
      });
      expect(JSON.stringify(metaAgent.requests[0])).not.toMatch(/"(?:taskId|runId|bindingId|cwd|nativeBindingRef)"/);
      expect(rootModel.templateLibrary.drafts.find(({ templateDraftId }) => templateDraftId === templateDraft.templateDraftId)?.revision).toBe(1);
      expect(rootModel.taskLibrary.tasks).toHaveLength(0);

      await userClient.command({
        type: "meta.apply_patch",
        commandId: "command_ds02-apply-meta-patch",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaSessionId: templateMetaSession.metaSessionId,
        metaPatchProposalId: templateMetaResponse.proposal!.metaPatchProposalId,
        expectedTargetRevision: templateDraft.revision,
      });
      rootModel = await userClient.read();
      templateDraft = rootModel.templateLibrary.drafts.find(({ templateDraftId }) => templateDraftId === templateDraft.templateDraftId)!;
      expect(templateDraft.revision).toBe(2);
      expect(templateDraft.definition.agentCards.find(({ agentCardId }) => agentCardId === "agent_card_researcher")?.systemPrompt)
        .toContain("selected public-company topic");
      expect(templateDraft.definition.agentCards.find(({ agentCardId }) => agentCardId === "agent_card_html-publisher")?.executionProfileId)
        .toBe("profile_html-publisher");
      expect(templateDraft.definition.executionProfiles.find(({ executionProfileId }) => executionProfileId === "profile_html-publisher")?.model)
        .toBe("fake-codex-html-publisher-meta-selected");

      const publishCommand = {
        type: "template.publish_draft" as const,
        commandId: "command_ds02-publish",
        issuedAt: clock.next(),
        templateDraftId: templateDraft.templateDraftId,
        expectedRevision: templateDraft.revision,
        templateId: "template_deepsearch",
        slug: "deepsearch",
        title: "DeepSearch",
        description: "A reviewable multi-agent stock research template.",
      };
      await userClient.command(publishCommand);
      rootModel = await userClient.read({ templateId: "template_deepsearch" });
      const templateSelection = rootModel.template!;
      const publishedVersion = templateSelection.versions[0]!;
      expect(templateSelection.versions).toHaveLength(1);
      expect(publishedVersion.definition.taskInputSchema?.fields.map(({ fieldId }) => fieldId)).toEqual(["topic", "brief", "depth"]);
      expect(publishedVersion.definition.deliverables).toEqual([]);
      expect(rootModel.configuration.metaSessions.find(({ metaSessionId }) => metaSessionId === templateMetaSession.metaSessionId)?.state)
        .toBe("consumed");
      expect(rootModel.taskLibrary.tasks).toHaveLength(0);
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-02",
        surface: "runtime-host",
        eventKind: "domain_transition",
        identities: {
          template: templateSelection.template.templateId,
          templateVersion: publishedVersion.templateVersionId,
          templateDraft: templateDraft.templateDraftId,
          metaSession: templateMetaSession.metaSessionId,
          metaPatchProposal: templateMetaResponse.proposal!.metaPatchProposalId,
          metaMessage: templateMetaResponse.message.metaMessageId,
          metaProfileOption: templateMetaSession.metaProfileOptionId,
          metaTurn: recorder.aliasNative("meta_turn", templateMetaTurn.metaTurnId),
        },
        summary: evidenceSummary(recorder, {
          writer: "template_meta_service",
          identity: publishedVersion.templateVersionId,
          commandId: publishCommand.commandId,
          idempotencyKey: publishCommand.commandId,
          fence: "expectedDraftRevision=2",
          effectKind: "controlled_meta_response",
          recovery: "durable isolated messages proposal and immutable version",
          effectIdentity: templateMetaResponse.message.metaMessageId,
        }),
        observation: {
          state: "published",
          draftRevisionBeforeApply: 1,
          draftRevisionAfterApply: 2,
          orderedOperationCount: templateMetaResponse.proposal!.operations.length,
          metaTurnState: templateMetaTurn.status,
          metaProvider: templateMetaSession.metaProfile.provider,
          permissionMode: templateMetaSession.metaProfile.capabilityPolicy.permissionMode,
          allowedToolCount: templateMetaSession.metaProfile.capabilityPolicy.allowedTools.length,
          configuredDeliverableCount: publishedVersion.definition.deliverables?.length ?? 0,
          taskCount: rootModel.taskLibrary.tasks.length,
          trustedMetaBoundary: "meta_agent_port_only",
        },
        assertionIds: [
          "ds02-meta-proposal-applies-atomically-once",
          "ds02-meta-cannot-publish-without-user-command",
          "ds02-meta-provider-response-is-host-only",
        ],
      });

      await userClient.command({
        type: "workspace.authorize",
        commandId: "command_ds03-authorize-workspace",
        issuedAt: clock.next(),
        workspaceId: WORKSPACE_ID,
        directory: workspaceDirectory,
        displayName: "DeepSearch workspace",
      });
      const setupCreate = await userClient.command({
        type: "task_setup.create_draft",
        commandId: "command_ds03-create-setup",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        templateVersionId: publishedVersion.templateVersionId,
        workspaceId: WORKSPACE_ID,
        title: "Draft stock research",
        goal: "Prepare an initial stock research note.",
        taskInputValues: [
          { fieldId: "topic", value: "NVDA" },
          { fieldId: "brief", value: "Focus on business quality." },
          { fieldId: "depth", value: "quick" },
        ],
      });
      let setupDraft = setupCreate.taskSetupDraft!;
      const setupSave = await userClient.command({
        type: "task_setup.save_draft",
        commandId: "command_ds03-save-setup",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        taskSetupDraftId: setupDraft.taskSetupDraftId,
        expectedRevision: setupDraft.revision,
        workspaceId: WORKSPACE_ID,
        title: "NVDA research working draft",
        goal: "Prepare a reviewable NVDA research package.",
        taskInputValues: [
          { fieldId: "topic", value: "NVDA" },
          { fieldId: "brief", value: "Cover business quality and clearly label evidence gaps." },
          { fieldId: "depth", value: "deep" },
        ],
      });
      setupDraft = setupSave.taskSetupDraft!;
      expect(setupDraft).toMatchObject({ state: "draft", revision: 2, title: "NVDA research working draft" });
      const setupMetaCreate = await userClient.command({
        type: "meta.create_session",
        commandId: "command_ds03-create-meta-session",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaProfileOptionId: "meta_profile_option_deepsearch-codex",
        target: { kind: "task_setup_draft", taskSetupDraftId: setupDraft.taskSetupDraftId },
      });
      let setupMetaSession = setupMetaCreate.metaSession!;
      await userClient.command({
        type: "meta.send_message",
        commandId: "command_ds03-send-meta-message",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaSessionId: setupMetaSession.metaSessionId,
        expectedSessionRevision: setupMetaSession.revision,
        expectedTargetRevision: setupDraft.revision,
        idempotencyKey: "command_ds03-send-meta-message",
        content: "Configure a deep NVDA stock study while leaving the running Task's final delivery format open.",
      });
      const setupMetaTurn = await drainUntilMetaReturned(host, userClient, setupMetaSession.metaSessionId);
      rootModel = await userClient.read();
      setupMetaSession = rootModel.configuration.metaSessions.find(({ metaSessionId }) => metaSessionId === setupMetaSession.metaSessionId)!;
      const setupMetaResponse = {
        message: rootModel.configuration.metaMessages.find(({ metaSessionId, role }) =>
          metaSessionId === setupMetaSession.metaSessionId && role === "assistant",
        )!,
        proposal: rootModel.configuration.metaPatchProposals.find(({ metaSessionId }) =>
          metaSessionId === setupMetaSession.metaSessionId,
        )!,
      };
      expect(metaAgent.requests).toHaveLength(2);
      expect(metaAgent.requests[1]).toMatchObject({ mode: "task_setup", targetRevision: 2 });
      expect(metaAgent.requests[1]!.transcript.some(({ content }) => content.includes("Tighten the Researcher prompt"))).toBe(false);
      await userClient.command({
        type: "meta.apply_patch",
        commandId: "command_ds03-apply-meta-patch",
        issuedAt: clock.next(),
        ownerId: USER_ID,
        metaSessionId: setupMetaSession.metaSessionId,
        metaPatchProposalId: setupMetaResponse.proposal!.metaPatchProposalId,
        expectedTargetRevision: setupDraft.revision,
      });

      // Reconstructing a client models closing/reopening the configuration
      // surface; no abandon/create/Provider command occurs as a side effect.
      userClient = createHttpRuntimeClient({ baseUrl: userBridge.url, authorization: USER_BRIDGE_CREDENTIAL });
      rootModel = await userClient.read();
      setupDraft = rootModel.configuration.taskSetupDrafts.find(({ taskSetupDraftId }) => taskSetupDraftId === setupDraft.taskSetupDraftId)!;
      const setupMessages = rootModel.configuration.metaMessages.filter(({ metaSessionId }) => metaSessionId === setupMetaSession.metaSessionId);
      const templateMessages = rootModel.configuration.metaMessages.filter(({ metaSessionId }) => metaSessionId === templateMetaSession.metaSessionId);
      expect(setupDraft).toMatchObject({
        state: "draft",
        revision: 3,
        title: "NVDA DeepSearch",
        taskInputValues: [
          { fieldId: "topic", value: "NVDA stock" },
          { fieldId: "brief", value: "Cover business quality, valuation framing, catalysts, downside risks, and evidence gaps." },
          { fieldId: "depth", value: "deep" },
        ],
      });
      expect(setupMessages.map(({ role }) => role)).toEqual(["user", "assistant"]);
      expect(templateMessages.map(({ role }) => role)).toEqual(["user", "assistant"]);
      expect(setupMessages.some(({ content }) => content.includes("Tighten the Researcher prompt"))).toBe(false);
      expect(rootModel.taskLibrary.tasks).toHaveLength(0);
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-03",
        surface: "runtime-host",
        eventKind: "read_model_projected",
        identities: {
          templateVersion: publishedVersion.templateVersionId,
          taskSetupDraft: setupDraft.taskSetupDraftId,
          metaSession: setupMetaSession.metaSessionId,
          metaPatchProposal: setupMetaResponse.proposal!.metaPatchProposalId,
          metaTurn: recorder.aliasNative("meta_turn", setupMetaTurn.metaTurnId),
        },
        summary: evidenceSummary(recorder, {
          writer: "task_setup_service",
          identity: setupDraft.taskSetupDraftId,
          commandId: "command_ds03-apply-meta-patch",
          idempotencyKey: "command_ds03-apply-meta-patch",
          fence: "expectedDraftRevision=2",
          effectKind: "controlled_meta_response",
          recovery: "new HTTP client reads the same isolated durable setup session",
          effectIdentity: setupMetaResponse.message.metaMessageId,
        }),
        observation: {
          state: setupDraft.state,
          draftRevision: setupDraft.revision,
          setupMessageCount: setupMessages.length,
          metaTurnState: setupMetaTurn.status,
          templateMessageCount: templateMessages.length,
          historiesIsolated: true,
          explicitSaveRevision: 2,
          surfaceResumePreservedDraft: true,
          taskCount: rootModel.taskLibrary.tasks.length,
        },
        assertionIds: [
          "ds03-explicit-save-fences-task-setup-before-meta",
          "ds03-setup-meta-history-is-isolated",
          "ds03-surface-resume-preserves-draft-and-session",
          "ds03-setup-apply-does-not-create-task",
        ],
      });

      const createTaskCommand = {
        type: "task.create" as const,
        commandId: "command_ds04-create-task",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        ownerId: USER_ID,
        workspaceId: WORKSPACE_ID,
        taskSetupDraftId: setupDraft.taskSetupDraftId,
        expectedTaskSetupRevision: setupDraft.revision,
      };
      const createdTask = await userClient.command(createTaskCommand);
      const createReplay = await userClient.command(createTaskCommand);
      expect(createReplay).toEqual(createdTask);
      let taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      expect(taskProjection.task).toMatchObject({ taskId: TASK_ID, status: "queued", revision: 1 });
      expect(taskProjection.activeRun).toBeUndefined();
      expect((await userClient.read()).taskLibrary.tasks.filter(({ taskId }) => taskId === TASK_ID)).toHaveLength(1);
      expect((await userClient.read()).configuration.taskSetupDrafts.find(({ taskSetupDraftId }) => taskSetupDraftId === setupDraft.taskSetupDraftId))
        .toMatchObject({ state: "consumed", createdTaskId: TASK_ID, revision: 4 });
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-04",
        surface: "runtime-host",
        eventKind: "command_recorded",
        identities: {
          task: taskProjection.task.taskId,
          taskSetupDraft: setupDraft.taskSetupDraftId,
          templateVersion: publishedVersion.templateVersionId,
          workspace: WORKSPACE_ID,
        },
        summary: evidenceSummary(recorder, {
          writer: "task_run_service",
          identity: taskProjection.task.taskId,
          commandId: createTaskCommand.commandId,
          idempotencyKey: createTaskCommand.commandId,
          fence: "expectedTaskSetupRevision=3",
          effectKind: "workspace_resolution",
          recovery: "exact command replay returns the same task without a run",
        }),
        observation: {
          state: taskProjection.task.status,
          taskRevision: taskProjection.task.revision,
          activeRunPresent: false,
          replayEqual: true,
          duplicateTaskCount: 1,
          compilerVersion: "task-goal/v1",
        },
        assertionIds: [
          "ds04-create-is-idempotent-and-does-not-start",
          "ds04-task-freezes-selected-version-and-ordered-inputs",
        ],
      });

      const startResult = await userClient.command({
        type: "task.start",
        commandId: "command_ds05-start-task",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: createdTask.task!.revision,
      });
      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const run = startResult.run!;
      let conductorBinding = taskProjection.bindings.find(({ logicalSessionId }) => logicalSessionId === run.conductorLogicalSessionId)!;
      const conductorNative = "native-ds-conductor-000001";
      const conductorBindingFact = facts.create({
        binding: conductorBinding,
        kind: "binding_observed",
        payload: { nativeBindingRef: conductorNative },
        label: "conductor-binding",
      });
      await observeFact(host, provider, conductorBindingFact);
      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      conductorBinding = taskProjection.bindings.find(({ bindingId }) => bindingId === conductorBinding.bindingId)!;
      const taskGoal = taskProjection.messages.find(({ kind }) => kind === "task_goal")!;
      const expectedGoal = [
        "Task title: NVDA DeepSearch",
        "Task goal:",
        "Research NVDA as a public company.",
        "Separate sourced facts, interpretation, risks, and open questions.",
        "Task inputs:",
        "[topic] Topic",
        "NVDA stock",
        "",
        "[brief] Research brief",
        "Cover business quality, valuation framing, catalysts, downside risks, and evidence gaps.",
        "",
        "[depth] Depth",
        "Deep review [deep]",
        "",
      ].join("\n");
      expect(taskGoal).toMatchObject({ content: expectedGoal, taskGoalCompilerVersion: "task-goal/v1" });
      const goalInput = taskProjection.inputs.find(({ content }) => content === expectedGoal)!;
      const initialConductorTurn = await completeTurn({
        host,
        provider,
        facts,
        binding: conductorBinding,
        inputId: goalInput.inputSubmissionId,
        finalContent: "I will dispatch the bounded research assignment and retain all routing decisions.",
        label: "conductor-goal",
      });

      conductorBridge = await openBridge(host, CONDUCTOR_BRIDGE_CREDENTIAL, {
        actor: "conductor",
        taskId: TASK_ID,
        runId: run.runId,
        conductorLogicalSessionId: run.conductorLogicalSessionId,
      });
      const conductorClient = createRuntimeConductorClient(createHttpRuntimeClient({
        baseUrl: conductorBridge.url,
        authorization: CONDUCTOR_BRIDGE_CREDENTIAL,
      }));
      const researcherGateway = createRuntimeConductorGateway({
        client: conductorClient,
        scope: {
          taskId: TASK_ID,
          runId: run.runId,
          conductorLogicalSessionId: run.conductorLogicalSessionId,
          conductorSessionTurnId: initialConductorTurn.sessionTurnId,
        },
        now: () => clock.next(),
        createRuntimeId: runtimeIdSequence("command_ds05-invoke-researcher", "invocation_ds05-researcher"),
      });
      const researcherDispatch = await researcherGateway.invoke_agent({
        agentCardId: "agent_card_researcher",
        instruction: "Research the selected stock topic and return an evidence-led final for review.",
        messageSelections: [{ kind: "full_message", sourceMessageId: taskGoal.messageId }],
        acceptanceCriteria: ["Return sourced facts, interpretation, risks, and evidence gaps as one canonical final."],
        priority: "high",
      });
      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const stagedResearcher = stagedInvocationContext(taskProjection, researcherDispatch.invocationId);
      const researcherNative = "native-ds-researcher-000001";
      const researcherBindingFact = facts.create({
        binding: stagedResearcher.binding,
        kind: "binding_observed",
        payload: { nativeBindingRef: researcherNative },
        label: "researcher-binding",
      });
      await observeFact(host, provider, researcherBindingFact);
      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const researcher = invocationContext(taskProjection, researcherDispatch.invocationId);
      const researcherReceipt = facts.create({
        binding: researcher.binding,
        kind: "input_received",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
          nativeMessageId: "msg_ds-researcher-received",
        },
        payload: {},
        label: "researcher-receipt",
      });
      await observeFact(host, provider, researcherReceipt);
      const researcherStarted = facts.create({
        binding: researcher.binding,
        kind: "turn_started",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
        },
        payload: {},
        label: "researcher-started",
      });
      await observeFact(host, provider, researcherStarted);
      const researcherActivityStarted = facts.create({
        binding: researcher.binding,
        kind: "activity_observed",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
        },
        payload: activityPayload({
          activityId: "activity_ds05-research-sources",
          phase: "started",
          title: "Review source set",
          content: "Collecting bounded source notes for the research final.",
          sequence: 1,
        }),
        label: "researcher-activity-started",
      });
      await observeFact(host, provider, researcherActivityStarted);

      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      expect(taskProjection.sessionTurns.find(({ sessionTurnId }) => sessionTurnId === researcher.turn.sessionTurnId)?.status).toBe("running");
      expect(taskProjection.messages.some(({ content }) => content.includes(HTML_PATH))).toBe(false);
      const htmlRequirement = "最终以 reports/stock-research.html 交付；HTML 必须自包含，并清楚区分事实、判断、风险和证据缺口。";
      const correctionCommand = {
        type: "task.submit_input" as const,
        commandId: "command_ds06-conductor-intervention",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: taskProjection.task.revision,
        runId: run.runId,
        targetLogicalSessionId: run.conductorLogicalSessionId,
        content: htmlRequirement,
      };
      await userClient.command(correctionCommand);
      let afterCorrection = (await userClient.read({ taskId: TASK_ID })).task!;
      const correctionMessage = afterCorrection.messages.find(({ kind, content }) => kind === "user_input" && content === htmlRequirement)!;
      expect(afterCorrection.inboxItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetLogicalSessionId: run.conductorLogicalSessionId, renderedMessageId: correctionMessage.messageId }),
      ]));
      await host.drainOutbox();
      afterCorrection = (await userClient.read({ taskId: TASK_ID })).task!;
      const correctionInput = afterCorrection.inputs.find(({ content }) => content === htmlRequirement)!;
      const correctionTurn = await completeTurn({
        host,
        provider,
        facts,
        binding: conductorBinding,
        inputId: correctionInput.inputSubmissionId,
        finalContent: "HTML delivery requirement accepted. I will route it explicitly after research and review.",
        label: "conductor-html-correction",
      });

      const researcherActivityCompleted = facts.create({
        binding: researcher.binding,
        kind: "activity_observed",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
        },
        payload: activityPayload({
          activityId: "activity_ds05-research-sources",
          phase: "completed",
          title: "Review source set",
          content: "Bounded source notes prepared for the canonical final.",
          sequence: 2,
        }),
        label: "researcher-activity-completed",
      });
      await observeFact(host, provider, researcherActivityCompleted);
      const researcherFinalContent = [
        "Research packet for NVDA:",
        "- Fact set: demand remains sensitive to data-center investment cycles.",
        "- Interpretation: execution quality and ecosystem position support resilience, but valuation can amplify disappointment.",
        "- Risks: customer concentration, supply constraints, competition, regulation, and multiple compression.",
        "- Evidence gaps: refresh current filings, segment mix, consensus ranges, and scenario inputs before publication.",
      ].join("\n");
      const researcherFinalFact = facts.create({
        binding: researcher.binding,
        kind: "assistant_final",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
        },
        payload: { content: researcherFinalContent },
        label: "researcher-final",
      });
      await observeFact(host, provider, researcherFinalFact);
      const researcherTerminalFact = facts.create({
        binding: researcher.binding,
        kind: "turn_completed",
        correlation: {
          inputSubmissionId: researcher.input.inputSubmissionId,
          invocationId: researcherDispatch.invocationId,
          sessionTurnId: researcher.turn.sessionTurnId,
        },
        payload: {},
        label: "researcher-completed",
      });
      await observeFact(host, provider, researcherTerminalFact);
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const researcherFinal = finalForInvocation(taskProjection, researcherDispatch.invocationId);
      expect(taskProjection.invocations.find(({ invocationId }) => invocationId === researcherDispatch.invocationId))
        .toMatchObject({ status: "returned", finalMessageId: researcherFinal.messageId });
      expect(taskProjection.providerActivities.find(({ activityId }) => activityId === "activity_ds05-research-sources"))
        .toMatchObject({ category: "tool", status: "completed" });
      expect(taskProjection.messages.some(({ content }) => content.includes("Bounded source notes prepared for the canonical final."))).toBe(false);

      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-05",
        surface: "provider",
        eventKind: "provider_fact_observed",
        identities: {
          task: TASK_ID,
          run: run.runId,
          binding: researcher.binding.bindingId,
          invocation: researcherDispatch.invocationId,
          message: researcherFinal.messageId,
          sessionTurn: researcher.turn.sessionTurnId,
          providerFact: researcherTerminalFact.providerFactId,
          providerNativeBinding: recorder.aliasNative("provider_binding", researcherNative),
        },
        summary: evidenceSummary(recorder, {
          writer: "message_turn_provider_fact_services",
          identity: researcherDispatch.invocationId,
          commandId: researcherDispatch.commandId,
          idempotencyKey: researcherDispatch.commandId,
          fence: `expectedTaskRevision=${taskProjection.task.revision}`,
          effectKind: "fake_codex_binding_delivery_and_facts",
          recovery: "binding receipt final and terminal facts are durable and deduplicable",
          effectIdentity: researcherTerminalFact.providerFactId,
        }),
        observation: {
          state: "returned",
          goalCompilerVersion: taskGoal.taskGoalCompilerVersion!,
          goalContentDigest: taskGoal.contentDigest,
          provider: researcher.binding.provider,
          receiptObserved: true,
          finalCount: taskProjection.messages.filter(({ invocationId, kind }) => invocationId === researcherDispatch.invocationId && kind === "agent_final").length,
          terminalObserved: true,
          humanOnlyActivityCount: taskProjection.providerActivities.filter(({ invocationId }) => invocationId === researcherDispatch.invocationId).length,
        },
        assertionIds: [
          "ds05-task-goal-and-codex-binding-correlate",
          "ds05-researcher-receipt-final-terminal-are-complete",
          "ds05-provider-activity-remains-human-only",
        ],
      });
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-06",
        surface: "runtime-host",
        eventKind: "domain_transition",
        identities: {
          task: TASK_ID,
          run: run.runId,
          logicalSession: run.conductorLogicalSessionId,
          message: correctionMessage.messageId,
          input: correctionInput.inputSubmissionId,
          sessionTurn: correctionTurn.sessionTurnId,
        },
        summary: evidenceSummary(recorder, {
          writer: "message_turn_services",
          identity: correctionMessage.messageId,
          commandId: correctionCommand.commandId,
          idempotencyKey: correctionCommand.commandId,
          fence: `expectedTaskRevision=${taskProjection.task.revision}`,
          effectKind: "conductor_input_delivery",
          recovery: "durable message inbox input and returned conductor turn",
          effectIdentity: correctionInput.inputSubmissionId,
        }),
        observation: {
          state: correctionTurn.status,
          fixedTargetWasConductor: correctionCommand.targetLogicalSessionId === run.conductorLogicalSessionId,
          researcherWasRunningAtSubmission: true,
          htmlRequirementFirstAppearedAtRuntime: true,
          durableInboxPresent: true,
          tabSelectionCouldRetarget: false,
          artifactPath: HTML_PATH,
        },
        assertionIds: [
          "ds06-task-input-targets-conductor-durably",
          "ds06-running-research-does-not-hide-user-correction",
        ],
      });

      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const researchDecisionInput = inputForMessage(taskProjection, researcherFinal.messageId);
      const researchDecisionTurn = await completeTurn({
        host,
        provider,
        facts,
        binding: conductorBinding,
        inputId: researchDecisionInput.inputSubmissionId,
        finalContent: "Research received. I will send the complete final to Reviewer.",
        label: "conductor-research-decision",
      });
      const reviewerGateway = createRuntimeConductorGateway({
        client: conductorClient,
        scope: {
          taskId: TASK_ID,
          runId: run.runId,
          conductorLogicalSessionId: run.conductorLogicalSessionId,
          conductorSessionTurnId: researchDecisionTurn.sessionTurnId,
        },
        now: () => clock.next(),
        createRuntimeId: runtimeIdSequence("command_ds07-invoke-reviewer", "invocation_ds07-reviewer"),
      });
      const reviewerDispatch = await reviewerGateway.invoke_agent({
        agentCardId: "agent_card_reviewer",
        instruction: "Review the complete Researcher final and return a publication decision with explicit gaps.",
        messageSelections: [{ kind: "full_message", sourceMessageId: researcherFinal.messageId }],
        acceptanceCriteria: ["Return one complete review final suitable for an HTML Publisher."],
      });
      const reviewer = await prepareInvocation({ host, client: userClient, provider, facts, taskId: TASK_ID, invocationId: reviewerDispatch.invocationId, label: "reviewer" });
      const reviewerFinalContent = "Review passed with caveats: preserve the stated evidence gaps, label scenario judgments, avoid live-price claims, and show downside risks prominently.";
      await finishTurn({
        host,
        provider,
        facts,
        binding: reviewer.binding,
        inputId: reviewer.input.inputSubmissionId,
        turnId: reviewer.turn.sessionTurnId,
        finalContent: reviewerFinalContent,
        label: "reviewer",
        invocationId: reviewerDispatch.invocationId,
      });
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const reviewerFinal = finalForInvocation(taskProjection, reviewerDispatch.invocationId);

      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const reviewDecisionInput = inputForMessage(taskProjection, reviewerFinal.messageId);
      const reviewDecisionTurn = await completeTurn({
        host,
        provider,
        facts,
        binding: conductorBinding,
        inputId: reviewDecisionInput.inputSubmissionId,
        finalContent: "Review accepted. I will explicitly route the user HTML requirement and Reviewer final to HTML Publisher.",
        label: "conductor-review-decision",
      });
      const publisherGateway = createRuntimeConductorGateway({
        client: conductorClient,
        scope: {
          taskId: TASK_ID,
          runId: run.runId,
          conductorLogicalSessionId: run.conductorLogicalSessionId,
          conductorSessionTurnId: reviewDecisionTurn.sessionTurnId,
        },
        now: () => clock.next(),
        createRuntimeId: runtimeIdSequence("command_ds07-invoke-publisher", "invocation_ds07-publisher"),
      });
      const publisherDispatch = await publisherGateway.invoke_agent({
        agentCardId: "agent_card_html-publisher",
        instruction: "Create the final self-contained HTML report from the explicitly selected requirement and review.",
        messageSelections: [
          { kind: "full_message", sourceMessageId: correctionMessage.messageId },
          { kind: "full_message", sourceMessageId: reviewerFinal.messageId },
        ],
        acceptanceCriteria: [
          "Write one self-contained HTML file.",
          "Return a canonical final with the exact Artifact declaration line.",
        ],
        requestedArtifacts: [HTML_PATH],
        priority: "high",
      });
      const publisher = await prepareInvocation({ host, client: userClient, provider, facts, taskId: TASK_ID, invocationId: publisherDispatch.invocationId, label: "publisher" });
      const publisherActivityStarted = facts.create({
        binding: publisher.binding,
        kind: "activity_observed",
        correlation: {
          inputSubmissionId: publisher.input.inputSubmissionId,
          invocationId: publisherDispatch.invocationId,
          sessionTurnId: publisher.turn.sessionTurnId,
        },
        payload: activityPayload({
          activityId: "activity_ds08-write-html",
          phase: "started",
          title: "Write HTML report",
          content: "Preparing the requested workspace artifact.",
          sequence: 1,
        }),
        label: "publisher-write-started",
      });
      await observeFact(host, provider, publisherActivityStarted);
      const html = selfContainedStockResearchHtml();
      const htmlAbsolutePath = path.join(workspaceDirectory, HTML_PATH);
      await mkdir(path.dirname(htmlAbsolutePath), { recursive: true });
      await writeFile(htmlAbsolutePath, html, "utf8");
      const publisherActivityCompleted = facts.create({
        binding: publisher.binding,
        kind: "activity_observed",
        correlation: {
          inputSubmissionId: publisher.input.inputSubmissionId,
          invocationId: publisherDispatch.invocationId,
          sessionTurnId: publisher.turn.sessionTurnId,
        },
        payload: activityPayload({
          activityId: "activity_ds08-write-html",
          phase: "completed",
          title: "Write HTML report",
          content: "The requested workspace artifact is ready for final declaration.",
          sequence: 2,
        }),
        label: "publisher-write-completed",
      });
      await observeFact(host, provider, publisherActivityCompleted);
      const publisherFinalContent = `The reviewed self-contained stock research report is ready.\nArtifact: ${HTML_PATH}`;
      await finishTurn({
        host,
        provider,
        facts,
        binding: publisher.binding,
        inputId: publisher.input.inputSubmissionId,
        turnId: publisher.turn.sessionTurnId,
        invocationId: publisherDispatch.invocationId,
        finalContent: publisherFinalContent,
        label: "publisher",
      });
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const publisherFinal = finalForInvocation(taskProjection, publisherDispatch.invocationId);
      const reviewerForward = taskProjection.messageForwards.find(({ commandId }) => commandId === reviewerDispatch.commandId)!;
      const publisherForward = taskProjection.messageForwards.find(({ commandId }) => commandId === publisherDispatch.commandId)!;
      expect(reviewerForward.selections.map(({ sourceMessageId }) => sourceMessageId)).toEqual([researcherFinal.messageId]);
      expect(publisherForward.selections.map(({ sourceMessageId }) => sourceMessageId)).toEqual([
        correctionMessage.messageId,
        reviewerFinal.messageId,
      ]);
      expect(publisherFinal.content).toBe(publisherFinalContent);
      expect(taskProjection.invocations.find(({ invocationId }) => invocationId === publisherDispatch.invocationId)?.requestedArtifacts)
        .toEqual([HTML_PATH]);

      await host.drainOutbox();
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const publisherDecisionInput = inputForMessage(taskProjection, publisherFinal.messageId);
      const conductorFinalContent = `Research, review, and HTML publication completed through explicit Runtime forwards.\nArtifact: ${HTML_PATH}`;
      const conductorFinalTurn = await completeTurn({
        host,
        provider,
        facts,
        binding: conductorBinding,
        inputId: publisherDecisionInput.inputSubmissionId,
        finalContent: conductorFinalContent,
        label: "conductor-publisher-final",
      });
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      const conductorFinal = taskProjection.messages.find(({ sourceSessionTurnId, content }) =>
        sourceSessionTurnId === conductorFinalTurn.sessionTurnId && content === conductorFinalContent,
      )!;
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-07",
        surface: "runtime-host",
        eventKind: "domain_transition",
        identities: {
          task: TASK_ID,
          run: run.runId,
          invocation: publisherDispatch.invocationId,
          message: publisherFinal.messageId,
          messageForward: publisherForward.forwardId,
          sessionTurn: conductorFinalTurn.sessionTurnId,
        },
        summary: evidenceSummary(recorder, {
          writer: "message_turn_services",
          identity: publisherForward.forwardId,
          commandId: publisherDispatch.commandId,
          idempotencyKey: publisherDispatch.commandId,
          fence: `expectedTaskRevision=${taskProjection.task.revision}`,
          effectKind: "ordered_runtime_forward_and_delivery",
          recovery: "forward selections rendered messages inbox inputs and turns are durable",
          effectIdentity: publisher.input.inputSubmissionId,
        }),
        observation: {
          state: "publisher_returned",
          explicitInvokeCount: taskProjection.invocations.length,
          explicitForwardCount: taskProjection.messageForwards.length,
          reviewerSelectionCount: reviewerForward.selections.length,
          publisherSelectionCount: publisherForward.selections.length,
          orderedPublisherSelection: true,
          sharedReadSurfacePresent: false,
          providerToProviderCallPresent: false,
        },
        assertionIds: [
          "ds07-research-review-publish-use-explicit-ordered-forwards",
          "ds07-no-hidden-workflow-or-provider-to-provider-routing",
        ],
      });

      const artifactGateway = createRuntimeConductorGateway({
        client: conductorClient,
        scope: {
          taskId: TASK_ID,
          runId: run.runId,
          conductorLogicalSessionId: run.conductorLogicalSessionId,
          conductorSessionTurnId: conductorFinalTurn.sessionTurnId,
        },
        now: () => clock.next(),
        createRuntimeId: runtimeIdSequence("command_ds08-register-artifact"),
      });
      const registration = await artifactGateway.register_artifact({
        sourceInvocationId: publisherDispatch.invocationId,
        workspaceRelativePath: HTML_PATH,
      });
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      expect(taskProjection.artifacts).toEqual([
        expect.objectContaining({
          artifactId: registration.artifactId,
          taskId: TASK_ID,
          runId: run.runId,
          displayName: "stock-research.html",
          sourceInvocationId: publisherDispatch.invocationId,
        }),
      ]);
      const firstPreview = await userClient.command({
        type: "artifact.preview",
        commandId: "command_ds08-preview-artifact",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: taskProjection.task.revision,
        artifactId: registration.artifactId,
      });
      expect(firstPreview.artifactPreview).toMatchObject({
        artifactId: registration.artifactId,
        state: "available",
        contentType: "text/html",
        content: html,
      });
      expect(firstPreview.artifactPreview?.content).not.toMatch(/https?:\/\//i);
      expect(taskProjection.providerActivities.find(({ activityId }) => activityId === "activity_ds08-write-html"))
        .toMatchObject({ status: "completed", category: "tool" });
      expect(taskProjection.messages.some(({ content }) => content.includes("The requested workspace artifact is ready for final declaration."))).toBe(false);

      // Restart every Host/Bridge object over the same SQLite file. The fake
      // Provider returns all prior facts from reconcileBinding; Runtime accepts
      // zero duplicates and restores the durable read model and Artifact.
      await conductorBridge.close();
      conductorBridge = undefined;
      await userBridge.close();
      await host.close();
      host = createRuntimeHost({
        databasePath,
        providerPorts: [providerPort],
        metaAgentPorts: [metaAgent],
        metaProfileOptions,
        now: () => clock.next(),
      });
      userBridge = await openBridge(host, USER_BRIDGE_CREDENTIAL, {
        actor: "user",
        userId: USER_ID,
        workspaceIds: [WORKSPACE_ID],
      });
      userClient = createHttpRuntimeClient({ baseUrl: userBridge.url, authorization: USER_BRIDGE_CREDENTIAL });
      const beforeRecovery = (await userClient.read({ taskId: TASK_ID })).task!;
      const acceptedOnRecovery: number[] = [];
      for (const binding of beforeRecovery.bindings) acceptedOnRecovery.push(await host.application.reconcileBinding(binding.bindingId));
      expect(acceptedOnRecovery.every((count) => count === 0)).toBe(true);
      taskProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      expect(taskProjection.messages.find(({ messageId }) => messageId === conductorFinal.messageId)?.content).toBe(conductorFinalContent);
      expect(taskProjection.artifacts[0]).toMatchObject({ artifactId: registration.artifactId, sourceInvocationId: publisherDispatch.invocationId });
      expect(taskProjection.invocations).toHaveLength(3);
      const recoveredPreview = await userClient.command({
        type: "artifact.preview",
        commandId: "command_ds08-preview-after-restart",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: taskProjection.task.revision,
        artifactId: registration.artifactId,
      });
      expect(recoveredPreview.artifactPreview).toEqual(firstPreview.artifactPreview);
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-08",
        surface: "runtime-host",
        eventKind: "read_model_projected",
        identities: {
          task: TASK_ID,
          run: run.runId,
          artifact: registration.artifactId,
          invocation: publisherDispatch.invocationId,
          message: publisherFinal.messageId,
          sessionTurn: conductorFinalTurn.sessionTurnId,
          providerNativeBinding: recorder.aliasNative("provider_binding", conductorNative),
        },
        summary: evidenceSummary(recorder, {
          writer: "artifact_service",
          identity: registration.artifactId,
          commandId: registration.commandId,
          idempotencyKey: registration.commandId,
          fence: `expectedTaskRevision=${taskProjection.task.revision}`,
          effectKind: "workspace_file_verification",
          recovery: "Host restart replays zero duplicate facts and preserves verified preview",
          effectIdentity: publisherFinal.messageId,
        }),
        observation: {
          state: recoveredPreview.artifactPreview!.state,
          artifactContentType: recoveredPreview.artifactPreview!.contentType!,
          artifactPath: HTML_PATH,
          publisherFinalDeclaredExactPath: true,
          conductorFinalProjected: true,
          hostRestartRecovered: true,
          duplicateProviderFactCount: acceptedOnRecovery.reduce((sum, count) => sum + count, 0),
          previewContainsExternalNetworkReference: false,
        },
        assertionIds: [
          "ds08-artifact-requires-requested-canonical-final-provenance",
          "ds08-html-preview-survives-host-restart",
          "ds08-tool-activity-cannot-substitute-for-final",
        ],
        optionalAssertions: [{ id: "real-provider-browser-electron-gates", outcome: "NOT_EXERCISED", required: false }],
      });

      const achieved = await userClient.command({
        type: "task.achieve",
        commandId: "command_ds09-achieve",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: taskProjection.task.revision,
        acceptedArtifactIds: [registration.artifactId],
        acceptanceNote: "Accepted after reviewing the verified HTML preview.",
      });
      expect(achieved.task).toMatchObject({
        status: "running",
        achievement: {
          acceptedArtifactIds: [registration.artifactId],
          acceptanceNote: "Accepted after reviewing the verified HTML preview.",
        },
      });
      const beforeStop = (await userClient.read({ taskId: TASK_ID })).task!;
      const stopCommand = {
        type: "task.stop" as const,
        commandId: "command_ds09-stop",
        issuedAt: clock.next(),
        taskId: TASK_ID,
        expectedRevision: beforeStop.task.revision,
        runId: run.runId,
        bindingIds: beforeStop.bindings.map(({ bindingId }) => bindingId),
      };
      await userClient.command(stopCommand);
      await host.drainOutbox();
      const finalProjection = (await userClient.read({ taskId: TASK_ID })).task!;
      expect(finalProjection.task).toMatchObject({
        status: "stopped",
        achievement: { acceptedArtifactIds: [registration.artifactId] },
      });
      expect(finalProjection.activeRun).toMatchObject({ status: "stopped" });
      expect(finalProjection.bindings.every(({ status }) => status === "released")).toBe(true);
      expect(finalProjection.timeline.filter(({ kind }) => kind === "user_achieved")).toHaveLength(1);
      expect(await readFile(path.join(workspaceDirectory, HTML_PATH), "utf8")).toBe(html);
      await recordCheckpoint(recorder, clock, assertions, {
        checkpoint: "DS-09",
        surface: "runtime-host",
        eventKind: "cleanup",
        identities: {
          task: TASK_ID,
          run: run.runId,
          artifact: registration.artifactId,
        },
        summary: evidenceSummary(recorder, {
          writer: "task_run_service",
          identity: TASK_ID,
          commandId: stopCommand.commandId,
          idempotencyKey: stopCommand.commandId,
          fence: `expectedTaskRevision=${beforeStop.task.revision}`,
          effectKind: "provider_binding_release",
          recovery: "achievement and stop remain independent durable transitions",
        }),
        observation: {
          state: finalProjection.task.status,
          achievedWhileRunActive: achieved.task!.status === "running",
          acceptedArtifactCount: finalProjection.task.achievement!.acceptedArtifactIds.length,
          releasedBindingCount: finalProjection.bindings.filter(({ status }) => status === "released").length,
          achieveTimelineCount: finalProjection.timeline.filter(({ kind }) => kind === "user_achieved").length,
          artifactFilePreserved: true,
        },
        assertionIds: [
          "ds09-preview-precedes-explicit-achieve",
          "ds09-achieve-does-not-stop-active-run",
          "ds09-stop-is-independent-and-preserves-artifact",
        ],
      });

      const attachment = await recorder.writeJsonAttachment("deepsearch-final-projection.json", {
        taskId: finalProjection.task.taskId,
        runId: finalProjection.activeRun!.runId,
        artifactId: finalProjection.artifacts[0]!.artifactId,
        status: finalProjection.task.status,
        runStatus: finalProjection.activeRun!.status,
        messageCount: finalProjection.messages.length,
        invocationCount: finalProjection.invocations.length,
        forwardCount: finalProjection.messageForwards.length,
        providerActivityCount: finalProjection.providerActivities.length,
        artifactCount: finalProjection.artifacts.length,
      });
      expect(attachment).toBe("attachments/deepsearch-final-projection.json");
      await recorder.finalize({
        outcome: "PASS",
        assertions,
        residualRisks: [
          "Real Provider processes, interactive Browser rendering, zero-network interception, and Electron IPC are separate capability gates.",
          "The Meta path uses a controlled fake MetaAgentPort; real Codex Meta execution remains a separate capability gate.",
        ],
      });
      const ledger = (await readFile(path.join(evidenceDirectory, "checkpoint-ledger.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { checkpoint: string; sequence: number });
      expect(ledger.map(({ checkpoint }) => checkpoint)).toEqual([
        "DS-01",
        "DS-02",
        "DS-03",
        "DS-04",
        "DS-05",
        "DS-06",
        "DS-07",
        "DS-08",
        "DS-09",
      ]);
      expect(ledger.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      if (conductorBridge) await conductorBridge.close();
      await userBridge.close();
      await host.close();
    }
  }, 30_000);
});

type OpenBridge = Readonly<{
  url: string;
  close(): Promise<void>;
}>;

async function openBridge(
  host: RuntimeHost,
  credential: string,
  scope: NonNullable<Parameters<typeof createRuntimeBridgeServer>[0]["scope"]>,
): Promise<OpenBridge> {
  const bridge: RuntimeBridgeServer = createRuntimeBridgeServer({ host, token: credential, scope });
  const address = await bridge.listen();
  return Object.freeze({ url: address.url, close: () => bridge.close() });
}

async function drainUntilMetaReturned(host: RuntimeHost, client: RuntimeClient, metaSessionId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await host.drainOutbox();
    const model = await client.read();
    const turn = [...model.configuration.metaTurns]
      .reverse()
      .find((candidate) => candidate.metaSessionId === metaSessionId);
    if (turn?.status === "returned") return turn;
    if (turn && ["failed", "rejected"].includes(turn.status)) {
      throw new Error(`controlled_meta_turn_${turn.status}:${turn.failureCode ?? "unknown"}`);
    }
  }
  throw new Error("controlled_meta_turn_not_returned");
}

function deepSearchDefinition(): TemplateDefinition {
  const requiredCapabilities = [
    "create_binding",
    "resume_binding",
    "input_correlation",
    "provider_receipt",
    "reconcile",
    "interrupt",
  ] as const;
  const profile = (executionProfileId: string, model: string) => ({
    executionProfileId,
    provider: "codex" as const,
    model,
    providerVersion: "fake-provider/1",
    protocolFingerprint: "fake-provider-contract/v1",
    capabilityPolicy: {
      requiredCapabilities,
      allowedTools: [],
      permissionMode: "ask" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  });
  return {
    schemaVersion: 2,
    taskInputSchema: {
      fields: [
        {
          fieldId: "topic",
          label: "Topic",
          kind: "short_text",
          required: true,
          description: "Public company or security to research.",
        },
        {
          fieldId: "brief",
          label: "Research brief",
          kind: "long_text",
          required: true,
          description: "Scope, questions, and evidence expectations.",
        },
        {
          fieldId: "depth",
          label: "Depth",
          kind: "choice",
          required: true,
          options: [
            { optionId: "quick", label: "Quick scan" },
            { optionId: "deep", label: "Deep review" },
          ],
        },
      ],
    },
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_conductor",
      systemPrompt: "Own every cross-session decision and preserve explicit message provenance.",
      capabilityRefs: [],
    },
    agentCards: [
      {
        agentCardId: "agent_card_researcher",
        kind: "researcher",
        title: "Researcher",
        executionProfileId: "profile_researcher",
        systemPrompt: "Research only the selected topic and return bounded findings.",
        capabilityRefs: [],
        dispatchProfile: {
          title: "Stock evidence research",
          description: "Gather a bounded research packet for a public-company topic.",
        },
      },
      {
        agentCardId: "agent_card_reviewer",
        kind: "reviewer",
        title: "Reviewer",
        executionProfileId: "profile_reviewer",
        systemPrompt: "Review only explicitly forwarded evidence and state publication gaps.",
        capabilityRefs: [],
        dispatchProfile: {
          title: "Research review",
          description: "Review a complete research final and return a publication decision.",
        },
      },
      {
        agentCardId: "agent_card_html-publisher",
        kind: "publisher",
        title: "Publisher",
        // Meta explicitly moves this Card to its dedicated profile.
        executionProfileId: "profile_reviewer",
        systemPrompt: "Create only the explicitly requested report format and declare its exact relative path in final.",
        capabilityRefs: [],
        dispatchProfile: {
          title: "Report publication",
          description: "Turn reviewed content into one explicitly requested final artifact.",
        },
      },
    ],
    executionProfiles: [
      profile("profile_conductor", "fake-codex-conductor"),
      profile("profile_researcher", "fake-codex-researcher"),
      profile("profile_reviewer", "fake-codex-reviewer"),
      profile("profile_html-publisher", "fake-codex-html-publisher"),
    ],
    routingPolicy: {
      mode: "agent_loop",
      maxConcurrentInvocations: 3,
      maxDispatchesPerDecision: 2,
    },
    deliverables: [],
  };
}

function metaProfileOption(): MetaProfileOptionDefinition {
  return {
    metaProfileOptionId: "meta_profile_option_deepsearch-codex",
    title: "Controlled Codex Meta",
    availability: "available",
    profile: {
      metaProfileId: "meta_profile_deepsearch-codex",
      provider: "codex",
      model: "fake-codex-meta",
      providerVersion: "fake-provider/1",
      protocolFingerprint: "fake-provider-contract/v1",
      capabilityPolicy: {
        requiredCapabilities: [],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
  };
}

class TestClock {
  #tick = 0;

  next(): string {
    this.#tick += 1;
    return new Date(Date.UTC(2026, 7, 9, 0, 0, 0, this.#tick)).toISOString();
  }
}

class ControlledMetaAgent implements MetaAgentPort {
  readonly provider = "codex" as const;
  readonly requests: MetaAgentTurnRequest[] = [];
  readonly #started = new Map<string, MetaAgentTurnRequest>();

  constructor(private readonly clock: TestClock) {}

  async describeMetaCapabilities(profile: Parameters<MetaAgentPort["describeMetaCapabilities"]>[0]) {
    return {
      provider: this.provider,
      available: profile.provider === this.provider,
      providerVersion: profile.providerVersion,
      protocolFingerprint: profile.protocolFingerprint,
      unavailableReasons: [],
    };
  }

  async startMetaTurn(request: MetaAgentTurnRequest): Promise<"accepted"> {
    const existing = this.#started.get(request.metaTurnId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error("controlled_meta_turn_replay_conflict");
    if (!existing) {
      this.#started.set(request.metaTurnId, request);
      this.requests.push(request);
    }
    return "accepted";
  }

  async reconcileMetaTurn(request: MetaAgentTurnRequest): ReturnType<MetaAgentPort["reconcileMetaTurn"]> {
    if (!this.#started.has(request.metaTurnId)) return { state: "absent" };
    return {
      state: "returned",
      finalText: JSON.stringify(request.mode === "template_design" ? templateMetaOutput() : setupMetaOutput()),
      observedAt: this.clock.next(),
    };
  }
}

function templateMetaOutput() {
  return {
    assistantMessage: "I prepared one ordered proposal for review.",
    proposal: {
      operations: [
        {
          kind: "template_card_prompt_set",
          agentCardId: "agent_card_researcher",
          value: "Research only the selected public-company topic, preserve source distinctions, and return a complete evidence-led final.",
        },
        {
          kind: "template_card_profile_set",
          agentCardId: "agent_card_html-publisher",
          executionProfileId: "profile_html-publisher",
        },
        {
          kind: "template_profile_model_set",
          executionProfileId: "profile_html-publisher",
          value: "fake-codex-html-publisher-meta-selected",
        },
      ],
      summary: "Strengthen research and pin the Publisher profile.",
      rationale: "The Publisher should use its dedicated execution profile without pre-deciding the Task's delivery format.",
      validationIssues: [],
    },
  };
}

function setupMetaOutput() {
  return {
    assistantMessage: "I prepared one Task Setup proposal without reading Template Meta history.",
    proposal: {
      operations: [
        { kind: "task_setup_title_set", value: "NVDA DeepSearch" },
        {
          kind: "task_setup_goal_set",
          value: "Research NVDA as a public company.\nSeparate sourced facts, interpretation, risks, and open questions.",
        },
        { kind: "task_setup_input_set", fieldId: "topic", value: "NVDA stock" },
        {
          kind: "task_setup_input_set",
          fieldId: "brief",
          value: "Cover business quality, valuation framing, catalysts, downside risks, and evidence gaps.",
        },
        { kind: "task_setup_input_set", fieldId: "depth", value: "deep" },
      ],
      summary: "Turn the placeholder into a deep NVDA research setup.",
      rationale: "The selected immutable Template exposes exactly these ordered inputs.",
      validationIssues: [],
    },
  };
}

class ProviderFactFactory {
  #ordinal = 0;

  constructor(private readonly clock: TestClock) {}

  create(input: Readonly<{
    binding: ProviderSessionBindingRecord;
    kind: ProviderFactKind;
    correlation?: ProviderFactCorrelation;
    payload: JsonObject;
    label: string;
  }>): ProviderFact {
    this.#ordinal += 1;
    return {
      providerFactId: `provider_fact_ds-${this.#ordinal}`,
      provider: "codex",
      bindingId: input.binding.bindingId,
      bindingRevision: input.binding.bindingRevision,
      kind: input.kind,
      deduplication: { providerEventId: `controlled-${input.label}-${this.#ordinal}` },
      correlation: input.correlation ?? {},
      payload: input.payload,
      observedAt: this.clock.next(),
    };
  }
}

/**
 * The shared FakeProvider intentionally exposes a smaller fixture interface.
 * This adapter is the test's controlled ProviderPort and drops no Runtime
 * request data that the fake needs to correlate effects or reconciliation.
 */
function providerPortFromFake(provider: FakeProvider): ProviderPort {
  return {
    provider: provider.provider,
    describeCapabilities: (profile) => provider.describeCapabilities(profile),
    ensureBinding: (request) => provider.ensureBinding(request),
    submitDelivery: (request) => provider.submitDelivery(request),
    observeBinding: (request) => provider.observeBinding(request),
    reconcileBinding: (request) => provider.reconcileBinding(request),
    requestInterrupt: (request) => provider.requestInterrupt(request),
    respondAttention: (request) => provider.respondAttention(request),
    releaseBinding: (request) => provider.releaseBinding(request),
  };
}

async function observeFact(host: RuntimeHost, provider: FakeProvider, fact: ProviderFact): Promise<void> {
  provider.emitFact(fact);
  expect(await host.reconcileProviderFact(fact)).toBe(true);
}

function activityPayload(input: Readonly<{
  activityId: string;
  phase: "started" | "completed";
  title: string;
  content: string;
  sequence: number;
}>): JsonObject {
  return {
    schemaVersion: 1,
    activityId: input.activityId,
    category: "tool",
    phase: input.phase,
    title: input.title,
    content: input.content,
    updateMode: "replace",
    sequence: input.sequence,
  };
}

async function prepareInvocation(input: Readonly<{
  host: RuntimeHost;
  client: RuntimeClient;
  provider: FakeProvider;
  facts: ProviderFactFactory;
  taskId: string;
  invocationId: string;
  label: string;
}>): Promise<ReturnType<typeof invocationContext>> {
  await input.host.drainOutbox();
  let projection = (await input.client.read({ taskId: input.taskId })).task!;
  const staged = stagedInvocationContext(projection, input.invocationId);
  const observed = input.facts.create({
    binding: staged.binding,
    kind: "binding_observed",
    payload: { nativeBindingRef: `native-ds-${input.label}-000001` },
    label: `${input.label}-binding`,
  });
  await observeFact(input.host, input.provider, observed);
  await input.host.drainOutbox();
  projection = (await input.client.read({ taskId: input.taskId })).task!;
  const context = invocationContext(projection, input.invocationId);
  const receipt = input.facts.create({
    binding: context.binding,
    kind: "input_received",
    correlation: {
      inputSubmissionId: context.input.inputSubmissionId,
      invocationId: input.invocationId,
      sessionTurnId: context.turn.sessionTurnId,
      nativeMessageId: `msg_ds-${input.label}-received`,
    },
    payload: {},
    label: `${input.label}-receipt`,
  });
  await observeFact(input.host, input.provider, receipt);
  const started = input.facts.create({
    binding: context.binding,
    kind: "turn_started",
    correlation: {
      inputSubmissionId: context.input.inputSubmissionId,
      invocationId: input.invocationId,
      sessionTurnId: context.turn.sessionTurnId,
    },
    payload: {},
    label: `${input.label}-started`,
  });
  await observeFact(input.host, input.provider, started);
  return context;
}

async function completeTurn(input: Readonly<{
  host: RuntimeHost;
  provider: FakeProvider;
  facts: ProviderFactFactory;
  binding: ProviderSessionBindingRecord;
  inputId: string;
  finalContent: string;
  label: string;
  invocationId?: string;
}>): Promise<SessionTurnRecord> {
  const before = input.host.read({ taskId: input.binding.taskId }).task!;
  const turn = before.sessionTurns.find(({ inputSubmissionId }) => inputSubmissionId === input.inputId)!;
  const receipt = input.facts.create({
    binding: input.binding,
    kind: "input_received",
    correlation: {
      inputSubmissionId: input.inputId,
      sessionTurnId: turn.sessionTurnId,
      nativeMessageId: `msg_ds-${input.label}-received`,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    },
    payload: {},
    label: `${input.label}-receipt`,
  });
  await observeFact(input.host, input.provider, receipt);
  const started = input.facts.create({
    binding: input.binding,
    kind: "turn_started",
    correlation: {
      inputSubmissionId: input.inputId,
      sessionTurnId: turn.sessionTurnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    },
    payload: {},
    label: `${input.label}-started`,
  });
  await observeFact(input.host, input.provider, started);
  await finishTurn({ ...input, turnId: turn.sessionTurnId });
  const after = input.host.read({ taskId: input.binding.taskId }).task!;
  const returned = after.sessionTurns.find(({ sessionTurnId }) => sessionTurnId === turn.sessionTurnId)!;
  expect(returned.status).toBe("returned");
  return returned;
}

async function finishTurn(input: Readonly<{
  host: RuntimeHost;
  provider: FakeProvider;
  facts: ProviderFactFactory;
  binding: ProviderSessionBindingRecord;
  inputId: string;
  turnId: string;
  finalContent: string;
  label: string;
  invocationId?: string;
}>): Promise<void> {
  const correlation = {
    inputSubmissionId: input.inputId,
    sessionTurnId: input.turnId,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
  };
  const finalFact = input.facts.create({
    binding: input.binding,
    kind: "assistant_final",
    correlation,
    payload: { content: input.finalContent },
    label: `${input.label}-final`,
  });
  await observeFact(input.host, input.provider, finalFact);
  const terminalFact = input.facts.create({
    binding: input.binding,
    kind: "turn_completed",
    correlation,
    payload: {},
    label: `${input.label}-completed`,
  });
  await observeFact(input.host, input.provider, terminalFact);
}

function invocationContext(projection: TaskRuntimeReadModel, invocationId: string) {
  const staged = stagedInvocationContext(projection, invocationId);
  const turn = projection.sessionTurns.find((candidate) => candidate.invocationId === invocationId)!;
  const input = projection.inputs.find(({ inputSubmissionId }) => inputSubmissionId === turn.inputSubmissionId)!;
  expect(turn).toBeDefined();
  expect(input).toBeDefined();
  return { ...staged, turn, input };
}

function stagedInvocationContext(projection: TaskRuntimeReadModel, invocationId: string) {
  const invocation = projection.invocations.find((candidate) => candidate.invocationId === invocationId)!;
  const binding = projection.bindings.find(({ bindingId }) => bindingId === invocation.bindingId)!;
  const session = projection.logicalSessions.find(({ logicalSessionId }) => logicalSessionId === invocation.targetLogicalSessionId)!;
  expect(invocation).toBeDefined();
  expect(binding).toBeDefined();
  expect(session).toBeDefined();
  return { invocation, binding, session };
}

function finalForInvocation(projection: TaskRuntimeReadModel, invocationId: string): SessionMessageRecord {
  const finals = projection.messages.filter(({ kind, invocationId: candidate }) => kind === "agent_final" && candidate === invocationId);
  expect(finals).toHaveLength(1);
  return finals[0]!;
}

function inputForMessage(projection: TaskRuntimeReadModel, messageId: string) {
  const inbox = projection.inboxItems.find(({ renderedMessageId, targetLogicalSessionId }) =>
    renderedMessageId === messageId && targetLogicalSessionId === projection.activeRun!.conductorLogicalSessionId,
  )!;
  const input = projection.inputs.find(({ inputSubmissionId }) => inputSubmissionId === inbox.deliveryInputSubmissionId)!;
  expect(inbox).toBeDefined();
  expect(input).toBeDefined();
  return input;
}

function runtimeIdSequence(...ids: readonly string[]): (prefix: "command" | "invocation") => string {
  let index = 0;
  return (prefix) => {
    const value = ids[index++];
    if (!value || !value.startsWith(`${prefix}_`)) throw new Error("test_runtime_id_sequence_mismatch");
    return value;
  };
}

function evidenceSummary(
  recorder: JourneyEvidenceRecorder,
  input: Readonly<{
    writer: string;
    identity: string;
    commandId: string;
    idempotencyKey: string;
    fence: string;
    effectKind: string;
    recovery: string;
    effectIdentity?: string;
  }>,
): JourneyCheckpoint["summary"] {
  return {
    durableWriter: input.writer,
    durableIdentity: input.identity,
    command: {
      commandId: input.commandId as RuntimeCommandId,
      idempotencyKey: recorder.aliasNative("idempotency_key", input.idempotencyKey),
      fence: input.fence,
    },
    externalEffect: {
      kind: input.effectKind,
      recovery: input.recovery,
      ...(input.effectIdentity ? { effectIdentity: input.effectIdentity } : {}),
    },
  };
}

async function recordCheckpoint(
  recorder: JourneyEvidenceRecorder,
  clock: TestClock,
  allAssertions: JourneyAssertion[],
  input: Readonly<{
    checkpoint: JourneyCheckpoint["checkpoint"];
    surface: JourneyCheckpoint["surface"];
    eventKind: JourneyCheckpoint["eventKind"];
    identities: NonNullable<JourneyCheckpoint["identities"]>;
    summary: JourneyCheckpoint["summary"];
    observation: JourneyCheckpoint["observation"];
    assertionIds: readonly string[];
    optionalAssertions?: readonly JourneyAssertion[];
  }>,
): Promise<void> {
  const checkpointAssertions = [
    ...input.assertionIds.map((id) => ({ id, outcome: "PASS" as const })),
    ...(input.optionalAssertions ?? []),
  ];
  allAssertions.push(...checkpointAssertions);
  await recorder.record({
    checkpoint: input.checkpoint,
    surface: input.surface,
    eventKind: input.eventKind,
    observedAt: clock.next(),
    identities: input.identities,
    summary: input.summary,
    observation: input.observation,
    assertions: checkpointAssertions,
  });
}

function selfContainedStockResearchHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>NVDA DeepSearch</title>",
    "  <style>",
    "    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3; }",
    "    body { margin: 0; padding: 48px 24px; } main { max-width: 920px; margin: auto; }",
    "    h1 { letter-spacing: -0.04em; } section { margin: 20px 0; padding: 20px; border: 1px solid #30363d; border-radius: 14px; background: #161b22; }",
    "    .fact { border-left: 4px solid #58a6ff; } .risk { border-left: 4px solid #f85149; } .gap { border-left: 4px solid #d29922; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <p>DeepSearch · reviewed research artifact</p>",
    "    <h1>NVDA research brief</h1>",
    '    <section class="fact"><h2>Sourced fact frame</h2><p>Demand remains sensitive to data-center investment cycles; refresh current filings before use.</p></section>',
    '    <section><h2>Interpretation</h2><p>Execution quality and ecosystem position may support resilience, while valuation can amplify disappointment.</p></section>',
    '    <section class="risk"><h2>Risks</h2><p>Customer concentration, supply constraints, competition, regulation, and multiple compression.</p></section>',
    '    <section class="gap"><h2>Evidence gaps</h2><p>Update segment mix, consensus ranges, and scenario inputs before any investment decision.</p></section>',
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
