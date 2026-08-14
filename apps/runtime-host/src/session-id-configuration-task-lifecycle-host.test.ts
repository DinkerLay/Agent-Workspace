import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpProfileReadinessObservation,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type SessionRuntimeBindingReadyEvent,
} from "@agent-workspace/runtime-contracts";
import { materializeCardSessionGeneration } from "@agent-workspace/runtime-domain";
import type {
  AcpMetaAgentPort,
  AcpMetaAgentTurnRequest,
} from "@agent-workspace/provider-port";
import {
  BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
  createAcpV3FrozenProfileTupleResolver,
  type SessionIdAcpOrchestrationCommandTaskScope,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createRuntimeRepositories,
  createSessionIdCanonicalStore,
  SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import {
  installLegacyTemplateV2Fixture,
  LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
} from "@agent-workspace/test-kit";
import type {
  SessionIdAcpApplicationReady,
  SessionIdAcpRunApplication,
} from "./session-id-acp-application-assembly.js";
import { createSessionIdAcpTaskLifecycleHost } from "./session-id-acp-task-lifecycle-host.js";
import { createSessionIdConfigurationTaskLifecycleHost } from "./session-id-configuration-task-lifecycle-host.js";

const NOW = "2026-08-12T16:00:00.000Z";
const roots: string[] = [];
const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID ACP-only configuration/lifecycle Host", () => {
  it("requires the explicit owner composition and has no direct-runtime surface or construction effect", async () => {
    const fixture = await createHarness();
    expect(fixture.providerExecutions).toEqual([]);
    expect(fixture.capturedScopes).toEqual([]);
    expect(fixture.meta.opens).toEqual([]);

    expect(() => createSessionIdConfigurationTaskLifecycleHost({
      ...fixture.hostOptions,
      unexpectedLegacySurface: [],
    } as never)).toThrow("session_id_lifecycle_host_options_invalid");

    const source = readFileSync(
      new URL("./session-id-configuration-task-lifecycle-host.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /ProviderPort|createProviderRegistry|createPersistentSessionIdOrchestrationApplication|providerEffects|providerPorts|closeProviderPorts|createRunLane|nativeBindingRef|\bcwd\b/u,
    );
    expect(source).not.toContain("@agent-workspace/provider-port");
  });

  it("atomically persists the ACP task_goal, freezes the v3 Profile tuple, and activates only on exact Conductor ready", async () => {
    const fixture = await createHarness();
    const started = await createAndStartTask(fixture, "ready");
    const binding = fixture.acp.binding.getCurrentBinding(started.run.conductorLogicalSessionId)!;
    const runtime = fixture.acp.sessionRuntime.getRuntimeForSession(started.run.conductorLogicalSessionId)!;

    expect(started.run.status).toBe("starting");
    expect(fixture.repositories.templateTask.getRun(started.run.runId)?.status).toBe("starting");
    expect(fixture.providerExecutions).toEqual([]);
    expect(started.acpTaskRuntime).toMatchObject({
      schemaVersion: 3,
      providerEffectIntentIds: [],
      bindings: [{
        bindingId: binding.bindingId,
        bindingHandle: binding.bindingHandle,
        profileRevisionId: binding.profileRevisionId,
        providerFamily: binding.providerFamily,
      }],
    });
    expect(fixture.capturedScopes).toHaveLength(1);
    expect(fixture.capturedScopes[0]?.agentCards).toHaveLength(3);
    expect(fixture.capturedScopes[0]?.agentCards.every((card) => (
      card.profileRevisionId.startsWith("profile_revision_")
        && card.providerFamily === "codex"
    ))).toBe(true);

    const messages = fixture.canonical.message.listMessages(started.run.runId);
    expect(messages).toEqual([
      expect.objectContaining({
        messageId: expect.stringMatching(/^message_/u),
        kind: "task_goal",
        content: expect.stringContaining("Goal ready"),
      }),
    ]);
    expect(fixture.canonical.orchestration.listInboxItems(started.run.conductorLogicalSessionId))
      .toEqual([expect.objectContaining({ renderedMessageId: messages[0]?.messageId, state: "pending" })]);
    expect(JSON.stringify({ binding, runtime, scope: fixture.capturedScopes[0] }))
      .not.toMatch(/raw|credential|absolutePath|nativeBindingRef|acpSessionId|requestId|optionId|cwd/iu);

    const ready = bindingReadyEvent(binding, runtime.sessionExecutionRuntimeId);
    expect(() => fixture.host.onBindingReady({ ...ready, bindingRevision: ready.bindingRevision + 1 }))
      .toThrow("session_id_binding_ready_fence_mismatch");
    expect(fixture.repositories.templateTask.getRun(started.run.runId)?.status).toBe("starting");
    expect(() => fixture.host.onBindingReady({ ...ready, extra: "forged" } as never))
      .toThrow("session_id_binding_ready_event_invalid");

    expect(fixture.host.onBindingReady(ready)).toMatchObject({ status: "running", revision: 2 });
    expect(fixture.host.onBindingReady(ready)).toMatchObject({ status: "running", revision: 2 });
    expect(fixture.repositories.templateTask.getRun(started.run.runId)?.status).toBe("running");
    expect(fixture.providerExecutions).toEqual([]);
  });

  it("accepts an exactly current Card ready event without promoting a starting Run", async () => {
    const fixture = await createHarness();
    const started = await createAndStartTask(fixture, "card-ready");
    const architecture = fixture.repositories.templateTask.getArchitectureSnapshot(started.task.taskId)!;
    if (architecture.definition.schemaVersion !== 3) throw new Error("controlled_architecture_v3_required");
    const card = architecture.definition.agentCards[0]!;
    const profile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === card.executionProfileId)!;
    const slot = fixture.canonical.taskRun.findSlot(started.run.runId, card.agentCardId)!;
    const materialized = materializeCardSessionGeneration({
      slot,
      taskId: started.task.taskId,
      runId: started.run.runId,
      agentCardId: card.agentCardId,
      executionProfileId: profile.executionProfileId,
      cardSessionSlotId: slot.cardSessionSlotId,
      sessionId: "logical_session_card-ready-current",
      now: NOW,
    });
    fixture.sqlite.transaction(() => {
      fixture.canonical.taskRun.materializeGeneration(materialized.slot, materialized.generation);
      fixture.acp.binding.createBinding({
        schemaVersion: 3,
        bindingId: "binding_card-ready-current",
        taskId: started.task.taskId,
        runId: started.run.runId,
        logicalSessionId: materialized.generation.sessionId,
        agentCardId: card.agentCardId,
        executionProfileId: profile.executionProfileId,
        profileRevisionId: profile.profileRevisionId,
        providerFamily: profile.providerFamily,
        bindingHandle: "binding_handle_card-ready-current",
        status: "active",
        recoverable: true,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }, { makeCurrent: true });
      fixture.acp.sessionRuntime.createRuntime({
        sessionExecutionRuntimeId: "session_execution_runtime_card-ready-current",
        taskId: started.task.taskId,
        runId: started.run.runId,
        logicalSessionId: materialized.generation.sessionId,
        state: "idle",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const cardBinding = fixture.acp.binding.getCurrentBinding(materialized.generation.sessionId)!;

    expect(fixture.host.onBindingReady(bindingReadyEvent(
      cardBinding,
      "session_execution_runtime_card-ready-current",
    ))).toBeUndefined();
    expect(fixture.repositories.templateTask.getRun(started.run.runId)?.status).toBe("starting");
  });

  it("rebuilds the identical persisted run scope without duplicating goal IDs and rejects v2 for new work", async () => {
    const fixture = await createHarness();
    const started = await createAndStartTask(fixture, "restart-scope");
    const firstApplication = fixture.host.orchestrationForRun(started.run.runId);
    const goalBefore = fixture.canonical.message.listMessages(started.run.runId);
    await fixture.host.close();
    fixture.host = fixture.openHost();
    const recoveredApplication = fixture.host.orchestrationForRun(started.run.runId);

    expect(recoveredApplication).toBe(firstApplication);
    expect(fixture.capturedScopes).toHaveLength(2);
    expect(fixture.capturedScopes[1]).toEqual(fixture.capturedScopes[0]);
    expect(fixture.canonical.message.listMessages(started.run.runId)).toEqual(goalBefore);

    await expect(fixture.host.lifecycle.execute({
      type: "task_setup.create_draft",
      commandId: "command_v2_read-only",
      issuedAt: NOW,
      ownerId: "user_host",
      templateVersionId: LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
      workspaceId: fixture.workspaceId,
      title: "Legacy setup",
      goal: "Must stay read-only",
      taskInputValues: [],
    })).rejects.toThrow("template_v2_read_only");
  });

  it("uses strict ACP Meta create then recovery-resume and closes only lifecycle-owned drains", async () => {
    const fixture = await createHarness();
    const version = requiredVersion(fixture);
    const draft = (await fixture.host.lifecycle.execute({
      type: "template.create_draft",
      commandId: "command_meta_template-draft",
      issuedAt: NOW,
      ownerId: "user_host",
      baseTemplateVersionId: version.templateVersionId,
      metadata: { title: "Meta target", slug: "meta-target" },
      initialDefinition: version.definition,
    })).templateDraft!;
    const session = (await fixture.host.lifecycle.execute({
      type: "meta.create_session",
      commandId: "command_meta_create-session",
      issuedAt: NOW,
      ownerId: "user_host",
      metaProfileOptionId: META_OPTION.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    })).metaSession!;
    expect(fixture.meta.opens).toEqual([]);
    await fixture.host.lifecycle.execute({
      type: "meta.send_message",
      commandId: "command_meta_send",
      issuedAt: NOW,
      ownerId: "user_host",
      metaSessionId: session.metaSessionId,
      expectedSessionRevision: session.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "meta:create-resume",
      content: "Improve the title.",
    });
    expect(await fixture.host.drainMetaTurns(1)).toBe(1);
    expect(fixture.meta.opens.map(({ disposition }) => disposition)).toEqual(["create"]);

    await fixture.host.close();
    expect(fixture.meta.close).not.toHaveBeenCalled();
    expect(fixture.providerClose).not.toHaveBeenCalled();
    expect(fixture.repositories.templateTask.getDraft(draft.templateDraftId)).toBeDefined();

    fixture.host = fixture.openHost();
    expect(await fixture.host.drainMetaTurns(1)).toBe(1);
    expect(fixture.meta.opens.map(({ disposition }) => disposition)).toEqual(["create", "resume"]);
    expect(fixture.host.lifecycle.read().configuration.metaPatchProposals)
      .toEqual([expect.objectContaining({ metaSessionId: session.metaSessionId })]);
    expect(fixture.meta.requests).toHaveLength(2);
    for (const request of fixture.meta.requests) {
      for (const forbidden of ["cwd", "workspaceId", "taskId", "runId", "bindingId"]) {
        expect(hasObjectKey(request, forbidden)).toBe(false);
      }
    }

    await fixture.ready.close();
    expect(fixture.providerClose).toHaveBeenCalledTimes(1);
    expect(fixture.meta.close).not.toHaveBeenCalled();
  });
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-lifecycle-host-"));
  roots.push(root);
  const sqlite = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite"), now: () => NOW });
  const repositories = createRuntimeRepositories(sqlite);
  installLegacyTemplateV2Fixture(repositories.templateTask, NOW);
  const canonical = createSessionIdCanonicalStore(sqlite);
  const resolveFrozenProfileTuple = createAcpV3FrozenProfileTupleResolver({
    templates: repositories.templateTask,
    taskRun: canonical.taskRun,
  });
  const acp = createAcpSessionRuntimeRepositories(sqlite, { resolveFrozenProfileTuple });
  const ids = stableIds();
  const providerExecutions: string[] = [];
  const providerClose = vi.fn(async () => undefined);
  const meta = controlledMetaAgent();
  const capturedScopes: SessionIdAcpOrchestrationCommandTaskScope[] = [];
  const workspaceId = "workspace_lifecycle-host";
  const ready = controlledAcpReady(canonical, ids, capturedScopes, providerClose);
  const hostOptions = Object.freeze({
    persistence: { sqlite, repositories, canonical },
    acpApplication: ready,
    acpTaskLifecycle: createSessionIdAcpTaskLifecycleHost({ now: () => NOW, createId: ids }),
    acpTaskOwners: { binding: acp.binding, sessionRuntime: acp.sessionRuntime },
    metaAgentRegistrations: [{ option: META_OPTION, port: meta.port }],
    listTemplateProfileRevisions: () => Object.freeze([]),
    now: () => NOW,
    createId: ids,
  });
  const openHost = () => createSessionIdConfigurationTaskLifecycleHost(hostOptions);
  const fixture = {
    root,
    workspaceId,
    sqlite,
    repositories,
    canonical,
    acp,
    ready,
    providerExecutions,
    providerClose,
    meta,
    capturedScopes,
    hostOptions,
    openHost,
    host: openHost(),
  };
  await fixture.host.lifecycle.execute({
    type: "workspace.authorize",
    commandId: "command_workspace_authorize",
    issuedAt: NOW,
    workspaceId,
    directory: root,
    displayName: "ACP lifecycle workspace",
  });
  let disposed = false;
  disposals.push(async () => {
    if (disposed) return;
    disposed = true;
    await fixture.host.close();
    await ready.close();
    sqlite.close();
  });
  return fixture;
}

function controlledAcpReady(
  canonical: ReturnType<typeof createSessionIdCanonicalStore>,
  createId: (kind: string) => string,
  capturedScopes: SessionIdAcpOrchestrationCommandTaskScope[],
  close: () => Promise<void>,
): SessionIdAcpApplicationReady {
  const applications = new Map<string, Readonly<{
    fingerprint: string;
    application: SessionIdAcpRunApplication;
  }>>();
  return Object.freeze({
    drainSeal: Object.freeze({
      total: 0,
      safe: 0,
      blocking: 0 as const,
      historicalUninspectedProtocolTables: Object.freeze([] as string[]),
    }),
    createRunApplication(scope) {
      capturedScopes.push(structuredClone(scope));
      const key = `${scope.taskId}\0${scope.runId}`;
      const fingerprint = JSON.stringify(scope);
      const existing = applications.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("session_id_acp_run_application_scope_drift");
        return existing.application;
      }
      const commandApplication = Object.freeze({
        enqueueTaskGoal(input: Readonly<{ messageId: string; content: string }>) {
          return canonical.transaction(({ message, orchestration }) => {
            const replay = message.getMessage(input.messageId);
            if (replay) {
              if (replay.taskId !== scope.taskId || replay.runId !== scope.runId
                || replay.kind !== "task_goal" || replay.contentDigest !== hashDefinition(input.content)) {
                throw new Error("task_goal_replay_conflict");
              }
              return Object.freeze({ status: "enqueued" as const });
            }
            message.createMessage({
              messageId: input.messageId,
              taskId: scope.taskId,
              runId: scope.runId,
              kind: "task_goal",
              content: input.content,
              canonicalContent: [{ kind: "text", text: input.content }],
              contentDigest: hashDefinition(input.content),
              createdAt: NOW,
            });
            orchestration.createInboxItem({
              inboxItemId: createId("inbox"),
              taskId: scope.taskId,
              runId: scope.runId,
              sessionId: scope.conductorSessionId,
              renderedMessageId: input.messageId,
              sequence: 1,
              priority: "human",
              state: "pending",
              createdAt: NOW,
              updatedAt: NOW,
            });
            return Object.freeze({ status: "enqueued" as const });
          });
        },
      });
      const application = Object.freeze({ commandApplication }) as unknown as SessionIdAcpRunApplication;
      applications.set(key, Object.freeze({ fingerprint, application }));
      return application;
    },
    close,
  });
}

async function createAndStartTask(fixture: Harness, stem: string) {
  const version = requiredVersion(fixture);
  const setup = (await fixture.host.lifecycle.execute({
    type: "task_setup.create_draft",
    commandId: `command_setup_${stem}`,
    issuedAt: NOW,
    ownerId: "user_host",
    templateVersionId: version.templateVersionId,
    workspaceId: fixture.workspaceId,
    title: `Task ${stem}`,
    goal: `Goal ${stem}`,
    taskInputValues: [
      { fieldId: "research-question", value: `Question ${stem}` },
      { fieldId: "report-language", value: "en" },
    ],
  })).taskSetupDraft!;
  const created = await fixture.host.lifecycle.execute({
    type: "task.create",
    commandId: `command_task_create_${stem}`,
    issuedAt: NOW,
    ownerId: "user_host",
    workspaceId: fixture.workspaceId,
    taskSetupDraftId: setup.taskSetupDraftId,
    expectedTaskSetupRevision: setup.revision,
  });
  const started = await fixture.host.lifecycle.execute({
    type: "task.start",
    commandId: `command_task_start_${stem}`,
    issuedAt: NOW,
    taskId: created.task!.taskId,
    expectedRevision: created.task!.revision,
  });
  return {
    task: started.task!,
    run: started.run!,
    acpTaskRuntime: started.acpTaskRuntime!,
  };
}

function requiredVersion(fixture: Harness) {
  const version = fixture.repositories.templateTask.getTemplateVersion(
    BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
  );
  if (!version) throw new Error("controlled_acp_version_missing");
  return version;
}

function bindingReadyEvent(
  binding: NonNullable<ReturnType<Harness["acp"]["binding"]["getBinding"]>>,
  sessionExecutionRuntimeId: string,
): SessionRuntimeBindingReadyEvent {
  return Object.freeze({
    type: "session_runtime.binding_ready" as const,
    sessionExecutionRuntimeId,
    logicalSessionId: binding.logicalSessionId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    bindingHandle: binding.bindingHandle,
    recoverable: binding.recoverable,
    observedAt: NOW,
  });
}

function stableIds() {
  const counters = new Map<string, number>();
  return (kind: string) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_lifecyclehost-${next}`;
  };
}

function controlledMetaAgent(): Readonly<{
  port: AcpMetaAgentPort;
  requests: AcpMetaAgentTurnRequest[];
  opens: Array<Readonly<{ metaSessionId: string; disposition: "create" | "resume" }>>;
  close: ReturnType<typeof vi.fn>;
}> {
  const requests: AcpMetaAgentTurnRequest[] = [];
  const opens: Array<Readonly<{ metaSessionId: string; disposition: "create" | "resume" }>> = [];
  const close = vi.fn(async () => undefined);
  const port: AcpMetaAgentPort = {
    async checkMetaProfileReadiness(metaProfileOptionId) {
      if (metaProfileOptionId !== META_OPTION.metaProfileOptionId) throw new Error("meta_profile_option_not_found");
      return META_READINESS;
    },
    async openMetaSession(input) {
      if (input.metaProfileOptionId !== META_OPTION.metaProfileOptionId) throw new Error("meta_profile_option_not_found");
      opens.push(Object.freeze({
        metaSessionId: input.metaSessionId,
        disposition: input.disposition,
      }));
      return Object.freeze({ available: true as const, readiness: META_READINESS });
    },
    async startMetaTurn(request, tools) {
      if (!tools) throw new Error("test_template_tools_missing");
      await tools.handleCall({
        providerCallId: "provider_call_lifecycle-title",
        name: "template_draft_update_metadata",
        arguments: { field: "title", value: "Meta revised title" },
        lease: tools.lease,
      });
      requests.push(request);
      return "accepted";
    },
    async reconcileMetaTurn(request) {
      requests.push(request);
      return {
        state: "returned" as const,
        observedAt: NOW,
        finalText: JSON.stringify({
          assistantMessage: "I prepared a title proposal.",
          proposal: {
            operations: [{ kind: "template_metadata_set", field: "title", value: "Meta revised title" }],
            summary: "Revise title",
            rationale: "Clearer",
            validationIssues: [],
          },
        }),
      };
    },
    close,
  };
  return { port, requests, opens, close };
}

const META_PROFILE: MetaProfileDefinitionV3 = {
  metaProfileId: "meta_profile_lifecycle-host",
  profileRevisionId: "profile_revision_meta-lifecycle-host-v3",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "gpt-5.6-sol",
  configIntent: {},
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

const META_READINESS: AcpProfileReadinessObservation = {
  profileRevisionId: META_PROFILE.profileRevisionId,
  providerFamily: META_PROFILE.providerFamily,
  acpAgentKind: META_PROFILE.acpAgentKind,
  role: "meta",
  status: "available",
  reasons: [],
  missingCapabilities: [],
  missingExtensions: [],
  model: META_PROFILE.model,
  observedArtifactVersion: "current",
  observedUpstreamVersion: "current",
};

const META_OPTION: MetaProfileOptionDefinitionV3 = {
  metaProfileOptionId: "meta_profile_option_lifecycle-host",
  title: "Lifecycle Host Meta",
  profile: META_PROFILE,
  readiness: META_READINESS,
};

function hasObjectKey(value: unknown, target: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasObjectKey(entry, target));
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, target)
    || Object.values(record).some((entry) => hasObjectKey(entry, target));
}
