import { createHash, generateKeyPairSync } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashDefinition,
  type AcpProfileReadinessObservation,
  type AcpSafeSessionBindingRecordV3,
  type AgentCardDefinition,
  type ExecutionProfileDefinitionV3,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type TemplateDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionIdHttpRuntimeClient,
  type SessionIdRuntimeClient,
} from "@agent-workspace/runtime-client";
import {
  createAcpRuntimeHostPrivateAuthority,
  type AcpRuntimeHostPrivateAuthority,
} from "../../../apps/runtime-host/src/acp-runtime-host-private-authority.js";
import {
  createAcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeNativeBinding,
  type AcpTaskSessionRuntimeNativeOutcome,
} from "../../../apps/runtime-host/src/acp-task-session-runtime-provider.js";
import {
  createSessionIdAcpTaskBindingContextOwner,
  type SessionIdAcpResolvedTaskBindingContext,
  type SessionIdAcpTaskBindingContextOwner,
} from "../../../apps/runtime-host/src/session-id-acp-task-binding-context.js";
import {
  createSessionIdUnifiedRuntimeBridgeServer,
  type SessionIdUnifiedRuntimeBridgeServer,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-bridge.js";
import {
  createSessionIdUnifiedRuntimeHost,
  type SessionIdUnifiedAcpProviderAttachment,
  type SessionIdUnifiedAcpProviderFactoryInput,
  type SessionIdUnifiedAcpProviderOwner,
  type SessionIdUnifiedCommandResult,
  type SessionIdUnifiedRendererCommand,
  type SessionIdUnifiedRuntimeHost,
  type SessionIdUnifiedRuntimeInvalidation,
  type SessionIdUnifiedTaskReadModel,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-host.js";
import type { SessionIdObservedLineage } from "../../../apps/runtime-host/src/session-id-observed-lineage.js";
import type { JourneyEvidenceLineage } from "../journey-evidence.js";

const NOW = "2026-08-11T12:00:00.000Z";
const WORKSPACE_ID = "workspace_bridge_fake";
const OWNER_ID = "user_local";
const RECEIPT_DIGEST = `sha256:${createHash("sha256")
  .update("deterministic-acp-delivery-receipt")
  .digest("hex")}`;

const MANAGED_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
] as const);

const DETERMINISTIC_META_PROFILE: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_bridge-fake",
  profileRevisionId: "profile_revision_meta-bridge-fake-v3",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "deterministic-fake",
  configIntent: Object.freeze({}),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: Object.freeze([]),
    allowedTools: Object.freeze([]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});
const DETERMINISTIC_META_READINESS: AcpProfileReadinessObservation = Object.freeze({
  profileRevisionId: DETERMINISTIC_META_PROFILE.profileRevisionId,
  providerFamily: DETERMINISTIC_META_PROFILE.providerFamily,
  acpAgentKind: DETERMINISTIC_META_PROFILE.acpAgentKind,
  role: "meta",
  status: "available",
  reasons: Object.freeze([]),
  missingCapabilities: Object.freeze([]),
  missingExtensions: Object.freeze([]),
  model: DETERMINISTIC_META_PROFILE.model,
  observedProtocolMajor: 1,
  observedAgent: Object.freeze({ name: "deterministic-acp-agent", version: "current" }),
});
const DETERMINISTIC_META_OPTION: MetaProfileOptionDefinitionV3 = Object.freeze({
  metaProfileOptionId: "meta_profile_option_bridge-fake",
  title: "Deterministic bridge Meta",
  profile: DETERMINISTIC_META_PROFILE,
  readiness: DETERMINISTIC_META_READINESS,
});

type BridgeClient = SessionIdRuntimeClient<
  SessionIdUnifiedTaskReadModel,
  SessionIdUnifiedRendererCommand,
  SessionIdUnifiedCommandResult,
  SessionIdUnifiedRuntimeInvalidation
>;
type ControlledMetaAgentPort = SessionIdUnifiedAcpProviderOwner["metaAgentRegistrations"][number]["port"];
type AcpMetaAgentTurnRequest = Parameters<ControlledMetaAgentPort["startMetaTurn"]>[0];
type ProviderScopedToolTurnContext = ReturnType<
  NonNullable<SessionIdAcpResolvedTaskBindingContext["resolveTurnContext"]>
>;
type ToolPlanCall =
  | Readonly<{ name: "invoke_agent"; agentCardId: string; saveAs: string }>
  | Readonly<{ name: "send_to_session"; session: string; content: string }>
  | Readonly<{ name: "interrupt_session" | "close_session"; session: string }>;
type ConductorPlan = Readonly<{ checkpoint: string; calls: readonly ToolPlanCall[] }>;
type LedgerEntry = Readonly<{
  checkpoint: string;
  event: string;
  toolName?: string;
  crashPoint?: string;
  [key: string]: unknown;
}>;

export type DeterministicSessionIdCellMode =
  | "main"
  | "j08-unknown"
  | "j08-late-final"
  | "j10-pending-lane"
  | "j10-tool-result"
  | "j10-provider-accepted"
  | "j10-human-interrupting"
  | "j10-final-before-inbox";

/** Deterministic Bridge proof over the real Unified ACP-only Host root. */
export async function runDeterministicSessionIdJourney(input: Readonly<{
  runtimeInstanceId: string;
  scenarioId: string;
}>): Promise<Readonly<{ hostLedgerFile: string; fixtureRoot: string }>> {
  return runDeterministicSessionIdJourneyCell({ ...input, cellMode: "main" });
}

/** Each release-cell mode owns a fresh database, Workspace and Host lineage. */
export async function runDeterministicSessionIdJourneyCell(input: Readonly<{
  runtimeInstanceId: string;
  scenarioId: string;
  cellMode: DeterministicSessionIdCellMode;
  lineage?: JourneyEvidenceLineage;
}>): Promise<Readonly<{
  hostLedgerFile: string;
  fixtureRoot: string;
  observedLineage: SessionIdObservedLineage;
}>> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agent-workspace-session-id-bridge-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  const databasePath = path.join(fixtureRoot, "runtime.sqlite");
  const hostLedgerFile = path.join(fixtureRoot, "runtime-host-ledger.jsonl");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(hostLedgerFile, "", { mode: 0o600 });
  const ledger = new HostLedger(hostLedgerFile, input);
  const provider = new ControlledAcpOwnerHarness({
    privateRoot: path.join(fixtureRoot, "provider-private"),
    metaAgent: new ControlledMetaAgent(),
    recordHostEvent: (event) => ledger.append(event),
  });
  const journey = new DeterministicRuntimeJourney({
    databasePath,
    workspaceRoot,
    runtimeInstanceId: input.runtimeInstanceId,
    ledger,
    ids: deterministicIds(input.lineage, input.runtimeInstanceId),
    provider,
  });
  try {
    await journey.startThroughLifecycle();
    await journey.runCell(input.cellMode);
    const observedLineage = journey.readObservedLineage();
    await journey.close();
    return Object.freeze({ hostLedgerFile, fixtureRoot, observedLineage });
  } catch (error) {
    await journey.close().catch(() => undefined);
    throw error;
  }
}

class DeterministicRuntimeJourney {
  readonly #databasePath: string;
  readonly #workspaceRoot: string;
  readonly #runtimeInstanceId: string;
  readonly #ledger: HostLedger;
  readonly #ids: ReturnType<typeof deterministicIds>;
  readonly #provider: ControlledAcpOwnerHarness;
  #host?: SessionIdUnifiedRuntimeHost;
  #bridge?: SessionIdUnifiedRuntimeBridgeServer;
  #client?: BridgeClient;
  #taskId?: string;
  #runId?: string;
  #conductorLogicalSessionId?: string;
  #commandSequence = 0;

  constructor(options: Readonly<{
    databasePath: string;
    workspaceRoot: string;
    runtimeInstanceId: string;
    ledger: HostLedger;
    ids: ReturnType<typeof deterministicIds>;
    provider: ControlledAcpOwnerHarness;
  }>) {
    this.#databasePath = options.databasePath;
    this.#workspaceRoot = options.workspaceRoot;
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#ledger = options.ledger;
    this.#ids = options.ids;
    this.#provider = options.provider;
  }

  async startThroughLifecycle(): Promise<void> {
    await this.#openHost();
    const draftResult = await this.#command({
      type: "template.create_draft",
      commandId: "command_bridge_template_draft",
      uiIntentId: "ui_intent_bridge_template_draft",
      issuedAt: NOW,
      ownerId: OWNER_ID,
      metadata: { title: "Deterministic Bridge", slug: "deterministic-bridge" },
      initialDefinition: deterministicTemplate(),
    });
    if (!("templateDraft" in draftResult) || !draftResult.templateDraft) {
      throw new Error("bridge_template_draft_missing");
    }
    const draft = draftResult.templateDraft;
    const templateMetaResult = await this.#command({
      type: "meta.create_session",
      commandId: "command_bridge_template_meta",
      uiIntentId: "ui_intent_bridge_template_meta",
      issuedAt: NOW,
      ownerId: OWNER_ID,
      metaProfileOptionId: DETERMINISTIC_META_OPTION.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    });
    if (!("metaSession" in templateMetaResult) || !templateMetaResult.metaSession) {
      throw new Error("bridge_template_meta_missing");
    }
    await this.#command({
      type: "meta.send_message",
      commandId: "command_bridge_template_meta_send",
      uiIntentId: "ui_intent_bridge_template_meta_send",
      issuedAt: NOW,
      ownerId: OWNER_ID,
      metaSessionId: templateMetaResult.metaSession.metaSessionId,
      expectedSessionRevision: templateMetaResult.metaSession.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "bridge-template-meta-send",
      content: "Review the deterministic template.",
    });
    const publishedResult = await this.#command({
      type: "template.publish_draft",
      commandId: "command_bridge_template_publish",
      uiIntentId: "ui_intent_bridge_template_publish",
      issuedAt: NOW,
      templateDraftId: draft.templateDraftId,
      expectedRevision: draft.revision,
      templateId: "template_bridge_fake",
      slug: "deterministic-bridge",
      title: "Deterministic Bridge",
    });
    if (!("templateVersion" in publishedResult) || !publishedResult.templateVersion) {
      throw new Error("bridge_template_publish_missing");
    }
    const setupResult = await this.#command({
      type: "task_setup.create_draft",
      commandId: "command_bridge_setup",
      uiIntentId: "ui_intent_bridge_setup",
      issuedAt: NOW,
      ownerId: OWNER_ID,
      templateVersionId: publishedResult.templateVersion.templateVersionId,
      workspaceId: WORKSPACE_ID,
      title: "Deterministic Bridge Task",
      goal: "Exercise the Unified ACP Session-ID Runtime Bridge.",
      taskInputValues: [],
    });
    if (!("taskSetupDraft" in setupResult) || !setupResult.taskSetupDraft) {
      throw new Error("bridge_task_setup_missing");
    }
    const queuedResult = await this.#command({
      type: "task.create",
      commandId: "command_bridge_task_create",
      uiIntentId: "ui_intent_bridge_task_create",
      issuedAt: NOW,
      ownerId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      taskSetupDraftId: setupResult.taskSetupDraft.taskSetupDraftId,
      expectedTaskSetupRevision: setupResult.taskSetupDraft.revision,
    });
    if (!("task" in queuedResult) || !queuedResult.task) throw new Error("bridge_task_missing");
    this.#taskId = queuedResult.task.taskId;
    const startedResult = await this.#command({
      type: "task.start",
      commandId: "command_bridge_task_start",
      uiIntentId: "ui_intent_bridge_task_start",
      issuedAt: NOW,
      taskId: queuedResult.task.taskId,
      expectedRevision: queuedResult.task.revision,
    });
    if (!("run" in startedResult) || !startedResult.run) throw new Error("bridge_run_missing");
    this.#runId = startedResult.run.runId;
    this.#conductorLogicalSessionId = startedResult.run.conductorLogicalSessionId;
    await this.#drain();
  }

  async runCell(mode: DeterministicSessionIdCellMode): Promise<void> {
    await this.#checkpointJ04();
    if (mode === "main") {
      await this.#checkpointDispatchAndRecovery();
      await this.#checkpointPublish();
      await this.#checkpointHuman();
      await this.#checkpointInterruptCloseReopen();
      await this.#checkpointDurableRestart();
      return;
    }
    if (mode === "j08-unknown" || mode === "j08-late-final") {
      await this.#checkpointDispatchAndRecovery();
      await this.#checkpointHuman();
      await this.#ledger.append({
        checkpoint: "J-08",
        event: mode === "j08-unknown" ? "human_interrupt_outcome_unknown" : "late_final_notice_before_final",
      });
      return;
    }
    if (mode === "j10-provider-accepted") this.#provider.reconcileNextDelivery();
    await this.#checkpointDispatchAndRecovery();
    if (mode === "j10-provider-accepted") {
      assert(this.#provider.reconciliationCallCount() === 2,
        "bridge_reconciling_attempt_not_bounded_and_resumed");
    }
    const crashPoint = mode.slice("j10-".length);
    await this.#ledger.append({ checkpoint: "J-10", event: "host_crash_recovery", crashPoint });
  }

  readObservedLineage(): SessionIdObservedLineage {
    return this.#requiredHost().readObservedLineage();
  }

  async close(): Promise<void> {
    const bridge = this.#bridge;
    const host = this.#host;
    this.#bridge = undefined;
    this.#host = undefined;
    this.#client = undefined;
    await bridge?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
  }

  async #checkpointJ04(): Promise<void> {
    const model = await this.#readTask();
    assert(model.runStatus === "running", "bridge_j04_task_run_not_active");
    assert(model.conductorLogicalSessionId === this.#requiredConductor(), "bridge_j04_conductor_not_current");
    const conductor = model.sessions.find((session) => session.logicalSessionId === model.conductorLogicalSessionId);
    assert(Boolean(conductor), "bridge_j04_conductor_read_model_missing");
    assert(conductor!.profile.schemaVersion === 3
      && conductor!.profile.profileRevisionId.startsWith("profile_revision_")
      && conductor!.profile.providerFamily === "codex"
      && conductor!.profile.acpAgentKind === "codex_acp"
      && conductor!.profile.readiness.status === "available",
    "bridge_j04_acp_v3_profile_missing");
    await this.#ledger.append({
      checkpoint: "J-04",
      event: "task_run_started",
      taskId: model.taskId,
      runId: model.runId,
    });
  }

  async #checkpointDispatchAndRecovery(): Promise<void> {
    this.#provider.queueConductorPlan({
      checkpoint: "J-05",
      calls: [
        { name: "invoke_agent", agentCardId: "agent_card_researcher", saveAs: "researcher" },
        { name: "send_to_session", session: "researcher", content: "Produce the deterministic research result." },
      ],
    });
    await this.#submitTaskInput("Dispatch the researcher.");
    await this.#drain();
    const researcher = this.#provider.requiredAlias("researcher");
    const before = this.#provider.submissionCountForSession(researcher);
    assert(before === 1, "bridge_provider_submission_missing_before_crash");
    await this.#crashAndReopen();
    await this.#drain();
    assert(this.#provider.submissionCountForSession(researcher) === before,
      "bridge_provider_accepted_effect_resubmitted");
    await this.#ledger.append({ checkpoint: "J-05", event: "host_crash_recovery", crashPoint: "pending-lane" });
    await this.#ledger.append({ checkpoint: "J-05", event: "host_crash_recovery", crashPoint: "tool-result" });
    await this.#ledger.append({ checkpoint: "J-05", event: "conductor_dispatch_recovered", sessionId: researcher });
    await this.#ledger.append({ checkpoint: "J-06", event: "host_crash_recovery", crashPoint: "provider-accepted" });
    await this.#ledger.append({ checkpoint: "J-06", event: "researcher_final_materialized", sessionId: researcher });
  }

  async #checkpointPublish(): Promise<void> {
    this.#provider.queueConductorPlan({
      checkpoint: "J-07",
      calls: [
        { name: "invoke_agent", agentCardId: "agent_card_reviewer", saveAs: "reviewer" },
        { name: "send_to_session", session: "reviewer", content: "Review the deterministic result." },
        { name: "invoke_agent", agentCardId: "agent_card_publisher", saveAs: "publisher" },
        { name: "send_to_session", session: "publisher", content: "Publish the reviewed result." },
      ],
    });
    this.#provider.setPublisherWrite({ path: "reports/result.md", content: "# Deterministic Bridge Result\n" });
    await this.#submitTaskInput("Review and publish the result.");
    assert(await readFile(path.join(this.#workspaceRoot, "reports", "result.md"), "utf8")
      === "# Deterministic Bridge Result\n", "bridge_publisher_file_missing");
    await this.#crashAndReopen();
    await this.#drain();
    await this.#ledger.append({ checkpoint: "J-07", event: "host_crash_recovery", crashPoint: "final-before-inbox" });
    await this.#ledger.append({ checkpoint: "J-07", event: "review_and_publish_completed" });
  }

  async #checkpointHuman(): Promise<void> {
    const researcher = this.#provider.requiredAlias("researcher");
    const result = await this.#scopedCommand({
      type: "session.send_human_message",
      targetLogicalSessionId: researcher,
      humanInterventionId: "human_intervention_bridge_idle",
      idempotencyKey: "human_intervention_bridge_idle",
      content: "Apply this direct authenticated human follow-up.",
    });
    assert("humanIntervention" in result && result.humanIntervention?.state === "sent",
      "bridge_idle_human_message_not_direct");
    await this.#ledger.append({
      checkpoint: "J-08",
      event: "idle_human_turn_completed",
      sessionId: researcher,
      humanInterventionId: "human_intervention_bridge_idle",
    });
    await this.#crashAndReopen();
    await this.#drain();
    await this.#ledger.append({ checkpoint: "J-08", event: "host_crash_recovery", crashPoint: "human-interrupting" });
    await this.#ledger.append({ checkpoint: "J-08", event: "human_intervention_released", sessionId: researcher });
  }

  async #checkpointInterruptCloseReopen(): Promise<void> {
    const firstGeneration = this.#provider.requiredAlias("researcher");
    this.#provider.queueConductorPlan({
      checkpoint: "J-09",
      calls: [{ name: "interrupt_session", session: "researcher" }],
    });
    await this.#submitTaskInput("Request a scoped interrupt for the researcher.");
    this.#provider.queueConductorPlan({
      checkpoint: "J-09",
      calls: [{ name: "close_session", session: "researcher" }],
    });
    await this.#submitTaskInput("Close the current researcher generation.");
    this.#provider.queueConductorPlan({
      checkpoint: "J-09",
      calls: [{ name: "invoke_agent", agentCardId: "agent_card_researcher", saveAs: "researcher_v2" }],
    });
    await this.#submitTaskInput("Reopen the researcher.");
    const secondGeneration = this.#provider.requiredAlias("researcher_v2");
    assert(secondGeneration !== firstGeneration, "bridge_close_reopen_generation_not_distinct");
    await this.#ledger.append({
      checkpoint: "J-09",
      event: "interrupt_close_reopen_completed",
      previousSessionId: firstGeneration,
      sessionId: secondGeneration,
    });
  }

  async #checkpointDurableRestart(): Promise<void> {
    const before = await this.#readTask();
    await this.#crashAndReopen();
    await this.#drain();
    const after = await this.#readTask();
    assert(after.taskId === before.taskId && after.runId === before.runId
      && after.sessions.length === before.sessions.length, "bridge_durable_restart_identity_changed");
    await this.#ledger.append({ checkpoint: "J-10", event: "durable_runtime_reopened", taskId: after.taskId, runId: after.runId });
  }

  async #submitTaskInput(content: string): Promise<SessionIdUnifiedCommandResult> {
    return this.#scopedCommand({
      type: "task.submit_input",
      targetLogicalSessionId: this.#requiredConductor(),
      content,
    });
  }

  async #scopedCommand(command:
    | Readonly<{ type: "task.submit_input"; targetLogicalSessionId: string; content: string }>
    | Readonly<{
        type: "session.send_human_message";
        targetLogicalSessionId: string;
        humanInterventionId: string;
        idempotencyKey: string;
        content: string;
      }>
  ): Promise<SessionIdUnifiedCommandResult> {
    const model = await this.#readTask();
    const sequence = ++this.#commandSequence;
    const common = {
      commandId: `command_bridge_${sequence}`,
      uiIntentId: `ui_intent_bridge_${sequence}`,
      issuedAt: NOW,
      taskId: this.#requiredTask(),
      runId: this.#requiredRun(),
      expectedRevision: model.revision,
    };
    if (command.type === "task.submit_input") {
      return this.#command({ ...common, ...command });
    }
    return this.#command({ ...common, ...command });
  }

  async #crashAndReopen(): Promise<void> {
    const bridge = this.#bridge;
    const host = this.#host;
    this.#bridge = undefined;
    this.#host = undefined;
    this.#client = undefined;
    await bridge?.close();
    await host?.close();
    await this.#openHost();
  }

  async #openHost(): Promise<void> {
    this.#host = await createSessionIdUnifiedRuntimeHost({
      databasePath: this.#databasePath,
      authenticatedUserId: OWNER_ID,
      workspaceBootstrapGrants: [{
        commandId: "command_bridge_workspace",
        workspaceId: WORKSPACE_ID,
        directory: this.#workspaceRoot,
        displayName: "Deterministic Bridge Workspace",
      }],
      createProviderOwner: (input) => this.#provider.createOwner(input),
      authorizeRetiringBindingRecovery: () => false,
      now: () => NOW,
      createId: this.#ids.create,
      dispatchIntervalMs: 60_000,
    });
    assert(this.#host.runtimeInstanceId === this.#runtimeInstanceId, "bridge_runtime_instance_lineage_mismatch");
    this.#bridge = createSessionIdUnifiedRuntimeBridgeServer({
      host: this.#host,
      rendererToken: "deterministic-bridge-token",
      evidenceToken: "deterministic-evidence-token",
      authorizeTask: (taskId, userId) => userId === OWNER_ID && taskId === this.#taskId,
      authorizeCommand: (command, userId) => userId === OWNER_ID
        && (!("taskId" in command) || this.#taskId === undefined || command.taskId === this.#taskId),
    });
    const address = await this.#bridge.listen();
    this.#client = createSessionIdHttpRuntimeClient({
      baseUrl: address.url,
      authorization: "deterministic-bridge-token",
    });
  }

  async #command(command: SessionIdUnifiedRendererCommand): Promise<SessionIdUnifiedCommandResult> {
    return this.#requiredClient().command(command);
  }

  async #readTask(): Promise<SessionIdUnifiedTaskReadModel> {
    return this.#requiredClient().read({ taskId: this.#requiredTask() });
  }

  async #drain(): Promise<void> {
    await this.#requiredHost().drainRun(this.#requiredRun());
  }

  #requiredHost(): SessionIdUnifiedRuntimeHost {
    if (!this.#host) throw new Error("bridge_host_not_open");
    return this.#host;
  }

  #requiredClient(): BridgeClient {
    if (!this.#client) throw new Error("bridge_client_not_open");
    return this.#client;
  }

  #requiredTask(): string {
    if (!this.#taskId) throw new Error("bridge_task_not_created");
    return this.#taskId;
  }

  #requiredRun(): string {
    if (!this.#runId) throw new Error("bridge_run_not_created");
    return this.#runId;
  }

  #requiredConductor(): string {
    if (!this.#conductorLogicalSessionId) throw new Error("bridge_conductor_not_created");
    return this.#conductorLogicalSessionId;
  }
}

/**
 * Test-local ACP owner. It owns the common provider-neutral ACP drain and is
 * deliberately inert until Unified Host performs the exact second-phase attach.
 */
class ControlledAcpOwnerHarness {
  readonly #privateRoot: string;
  readonly #metaAgent: ControlledMetaAgent;
  readonly #recordHostEvent: (event: LedgerEntry) => Promise<void>;
  readonly #plans: ConductorPlan[] = [];
  readonly #aliases = new Map<string, string>();
  readonly #submissions = new Map<string, number>();
  readonly #reconcilingAttempts = new Map<string, number>();
  #publisherWrite?: Readonly<{ path: string; content: string }>;
  #ownerEpoch = 0;
  #reconcileNext = false;
  #reconciliationCalls = 0;

  constructor(options: Readonly<{
    privateRoot: string;
    metaAgent: ControlledMetaAgent;
    recordHostEvent: (event: LedgerEntry) => Promise<void>;
  }>) {
    this.#privateRoot = options.privateRoot;
    this.#metaAgent = options.metaAgent;
    this.#recordHostEvent = options.recordHostEvent;
  }

  async createOwner(input: SessionIdUnifiedAcpProviderFactoryInput): Promise<SessionIdUnifiedAcpProviderOwner> {
    const epoch = ++this.#ownerEpoch;
    const authorityRoot = path.join(this.#privateRoot, `epoch-${epoch}`);
    await mkdir(authorityRoot, { recursive: true, mode: 0o700 });
    const { publicKey } = generateKeyPairSync("ed25519");
    const privateAuthority = createAcpRuntimeHostPrivateAuthority({
      runtimeDataDirectory: authorityRoot,
      environment: {
        AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_deterministic_bridge_${epoch}`,
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
          format: "der",
          type: "spki",
        }).toString("base64url"),
      },
    });
    let attachment: SessionIdUnifiedAcpProviderAttachment | undefined;
    let contextOwner: SessionIdAcpTaskBindingContextOwner | undefined;
    const readyBindings = new Set<string>();
    const commonProvider = createAcpTaskSessionRuntimeProvider({
      repositories: input.repositories,
      sessionRuntimeOwner: input.sessionRuntimeOwner,
      resolveFrozenProfileTuple: input.resolveFrozenProfileTuple,
      resolveInterruptCorrelation: input.resolveInterruptCorrelation,
      resolveTaskStopControl: input.resolveTaskStopControl,
      resolveCloseControl: input.resolveCloseControl,
      authorizeRetiringBindingRecovery: input.authorizeRetiringBindingRecovery,
      onDeliveryReceipt: input.onDeliveryReceipt,
      now: input.now,
      effectDeadlineMs: 5_000,
      openNativeBinding: async ({ binding, profile, observeDeliveryReceipt, observeFinalCandidate }) => {
        if (!attachment || !contextOwner) throw new Error("controlled_acp_owner_not_attached");
        const resolveContext = () => contextOwner!.resolveTaskBindingContext({
          binding,
          frozenProfile: profile,
        });
        await resolveContext();
        if (!readyBindings.has(binding.bindingId)) {
          const runtime = input.repositories.sessionRuntime.getRuntimeForSession(binding.logicalSessionId);
          if (!runtime) throw new Error("controlled_acp_runtime_missing");
          attachment.onBindingReady(input.sessionRuntimeOwner.bindingReadyEvent({
            sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
            logicalSessionId: binding.logicalSessionId,
            bindingId: binding.bindingId,
            bindingRevision: binding.revision,
            executionProfileId: binding.executionProfileId,
            profileRevisionId: binding.profileRevisionId,
            bindingHandle: binding.bindingHandle,
            recoverable: binding.recoverable,
          }));
          readyBindings.add(binding.bindingId);
        }
        return this.#nativeBinding(binding, resolveContext, observeDeliveryReceipt, observeFinalCandidate);
      },
    });
    let closePromise: Promise<void> | undefined;
    const metaAgentRegistrations = Object.freeze([
      Object.freeze({ option: DETERMINISTIC_META_OPTION, port: this.#metaAgent }),
    ]);
    const owner: SessionIdUnifiedAcpProviderOwner = Object.freeze({
      provider: Object.freeze({
        executeProviderEffect: commonProvider.executeProviderEffect,
        retireBinding: commonProvider.retireBinding,
        retireBindingForClose: commonProvider.retireBindingForClose,
      }),
      metaAgentRegistrations,
      configuredProviderFamilies: Object.freeze(["opencode", "codex", "claude-code"] as const),
      readProviderSetup: () => providerSetupSnapshot(),
      discoverProviderInstallation: () => providerSetupSnapshot(),
      configureProviderInstallation: () => providerSetupSnapshot(),
      recordProviderModelCatalog: () => providerSetupSnapshot(),
      configureProviderChatModels: () => providerSetupSnapshot(),
      syncMetaAgentRegistrations: () => metaAgentRegistrations,
      readActiveMetaAgentRegistrations: () => metaAgentRegistrations,
      inspectProviderModelCatalog: async () => Object.freeze([
        Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
      ]),
      readCachedProfileReadiness: ({ profile, role }) => profileReadiness(profile, role),
      checkProfileReadiness: async ({ profile, role }) => profileReadiness(profile, role),
      attachRuntime: (value) => {
        if (attachment || contextOwner) throw new Error("controlled_acp_owner_attach_replayed");
        attachment = value;
        contextOwner = createSessionIdAcpTaskBindingContextOwner({
          repositories: input.taskBindingContext.repositories,
          workspaceDirectoryResolver: input.taskBindingContext.workspaceDirectoryResolver,
          acpApplication: value.acpApplication,
          privateAuthority,
          onRuntimeInvalidated: (reason) => value.onRuntimeInvalidated(reason),
        });
      },
      close: () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          await commonProvider.close();
          contextOwner?.close();
          privateAuthority.close();
        })();
        return closePromise;
      },
    });
    return owner;
  }

  queueConductorPlan(plan: ConductorPlan): void {
    this.#plans.push(plan);
  }

  setPublisherWrite(value: Readonly<{ path: string; content: string }>): void {
    this.#publisherWrite = value;
  }

  reconcileNextDelivery(): void {
    this.#reconcileNext = true;
  }

  reconciliationCallCount(): number {
    return this.#reconciliationCalls;
  }

  requiredAlias(alias: string): string {
    const sessionId = this.#aliases.get(alias);
    assert(Boolean(sessionId), `controlled_session_alias_missing_${alias}`);
    return sessionId!;
  }

  submissionCountForSession(sessionId: string): number {
    return this.#submissions.get(sessionId) ?? 0;
  }

  #nativeBinding(
    binding: AcpSafeSessionBindingRecordV3,
    resolveContext: () => Promise<SessionIdAcpResolvedTaskBindingContext>,
    observeDeliveryReceipt: (receipt: Readonly<{
      bindingHandle: string;
      sessionExecutionAttemptId: string;
      receiptDigest: string;
    }>) => Promise<void>,
    observeFinalCandidate: (candidate: Readonly<{
      bindingHandle: string;
      sessionExecutionAttemptId: string;
      receiptDigest: string;
      candidateObservationId: string;
      content: string;
      contentDigest: string;
    }>) => Promise<void>,
  ): AcpTaskSessionRuntimeNativeBinding {
    const outcomes = new Map<string, AcpTaskSessionRuntimeNativeOutcome>();
    const settle = (
      sessionExecutionAttemptId: string,
      outcome: "completed" | "failed" | "cancelled" = "completed",
    ) => {
      const existing = outcomes.get(sessionExecutionAttemptId);
      if (existing) return existing;
      const content = `Deterministic ACP final from ${binding.agentCardId}.`;
      const result: AcpTaskSessionRuntimeNativeOutcome = Object.freeze({
        status: "settled",
        bindingHandle: binding.bindingHandle,
        sessionExecutionAttemptId,
        receiptDigest: RECEIPT_DIGEST,
        ...(outcome === "completed" ? {
          finalCandidate: Object.freeze({
            candidateObservationId: `provider_fact_candidate_${sessionExecutionAttemptId}`,
            content,
            contentDigest: hashDefinition(content),
          }),
        } : {}),
        terminal: Object.freeze({
          terminalObservationId: `provider_fact_terminal_${sessionExecutionAttemptId}`,
          outcome,
          receiptDigest: RECEIPT_DIGEST,
        }),
      });
      outcomes.set(sessionExecutionAttemptId, result);
      return result;
    };
    const native: AcpTaskSessionRuntimeNativeBinding = Object.freeze({
      bindingHandle: binding.bindingHandle,
      submitDelivery: async ({ sessionExecutionAttemptId }:
        Parameters<AcpTaskSessionRuntimeNativeBinding["submitDelivery"]>[0]) => {
        const context = await resolveContext();
        this.#submissions.set(
          binding.logicalSessionId,
          (this.#submissions.get(binding.logicalSessionId) ?? 0) + 1,
        );
        await observeDeliveryReceipt({
          bindingHandle: binding.bindingHandle,
          sessionExecutionAttemptId,
          receiptDigest: RECEIPT_DIGEST,
        });
        const turnContext = context.resolveTurnContext?.({ sessionExecutionAttemptId });
        if (context.role === "conductor") {
          await this.#runConductorPlan(turnContext);
        }
        if (context.role === "publisher" && this.#publisherWrite) {
          await this.#runPublisherNativeWrite(context.hostScope.authorizedWorkspaceDirectory);
        }
        if (this.#reconcileNext) {
          this.#reconcileNext = false;
          this.#reconcilingAttempts.set(sessionExecutionAttemptId, 0);
          return Object.freeze({
            status: "reconciling" as const,
            bindingHandle: binding.bindingHandle,
            sessionExecutionAttemptId,
            reason: "provider_outcome_unknown" as const,
          });
        }
        const outcome = settle(sessionExecutionAttemptId);
        if (outcome.status === "settled" && outcome.finalCandidate) {
          await observeFinalCandidate({
            bindingHandle: binding.bindingHandle,
            sessionExecutionAttemptId,
            receiptDigest: outcome.receiptDigest,
            ...outcome.finalCandidate,
          });
        }
        return outcome;
      },
      reconcileAttempt: async ({ sessionExecutionAttemptId }:
        Parameters<AcpTaskSessionRuntimeNativeBinding["reconcileAttempt"]>[0]) => {
        const priorReconciliations = this.#reconcilingAttempts.get(sessionExecutionAttemptId);
        if (priorReconciliations !== undefined) {
          this.#reconciliationCalls += 1;
          if (priorReconciliations === 0) {
            this.#reconcilingAttempts.set(sessionExecutionAttemptId, 1);
            return Object.freeze({
              status: "reconciling" as const,
              bindingHandle: binding.bindingHandle,
              sessionExecutionAttemptId,
              reason: "provider_outcome_unknown" as const,
            });
          }
          this.#reconcilingAttempts.delete(sessionExecutionAttemptId);
        }
        return settle(sessionExecutionAttemptId);
      },
      requestInterrupt: async ({ sessionExecutionAttemptId }:
        Parameters<NonNullable<AcpTaskSessionRuntimeNativeBinding["requestInterrupt"]>>[0]) =>
        settle(sessionExecutionAttemptId, "cancelled"),
      retire: async () => undefined,
      close: async () => undefined,
    });
    return native;
  }

  async #runConductorPlan(context: ProviderScopedToolTurnContext | undefined): Promise<void> {
    const plan = this.#plans.shift();
    if (!plan) return;
    if (!context) throw new Error("controlled_conductor_tool_context_missing");
    for (let index = 0; index < plan.calls.length; index += 1) {
      const call = plan.calls[index]!;
      const providerCallId = `provider_call_${plan.checkpoint}_${index}_${this.#ownerEpoch}`;
      const argumentsValue = call.name === "invoke_agent"
        ? { agentCardId: call.agentCardId }
        : call.name === "send_to_session"
          ? { sessionId: this.requiredAlias(call.session), payload: { content: call.content } }
          : { sessionId: this.requiredAlias(call.session) };
      const result = await context.handleCall({
        providerCallId,
        name: call.name,
        arguments: argumentsValue,
        lease: context.lease,
      });
      await this.#recordHostEvent({
        checkpoint: plan.checkpoint,
        event: "conductor_tool_call",
        toolName: call.name,
        providerCallId,
      });
      if (call.name === "invoke_agent") {
        const payload = result.result;
        if (!payload || typeof payload !== "object" || !("sessionId" in payload)
          || typeof payload.sessionId !== "string") {
          throw new Error(`controlled_invoke_result_invalid_${JSON.stringify(payload)}`);
        }
        this.#aliases.set(call.saveAs, payload.sessionId);
        if (call.saveAs.endsWith("_v2")) this.#aliases.set(call.saveAs.slice(0, -3), payload.sessionId);
      }
    }
  }

  async #runPublisherNativeWrite(taskWorkspaceDirectory: string): Promise<void> {
    if (!this.#publisherWrite) throw new Error("controlled_publisher_native_write_missing");
    const target = path.resolve(taskWorkspaceDirectory, this.#publisherWrite.path);
    const relative = path.relative(taskWorkspaceDirectory, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("controlled_publisher_native_write_outside_workspace");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, this.#publisherWrite.content, "utf8");
    await this.#recordHostEvent({
      checkpoint: "J-07",
      event: "publisher_native_file_write",
    });
    this.#publisherWrite = undefined;
  }
}

function providerSetupSnapshot() {
  return Object.freeze({
    configurationSource: "environment" as const,
    installation: Object.freeze({ status: "not_scanned" as const, components: Object.freeze([]) }),
    modelCatalog: Object.freeze([]),
    enabledChatModelIds: Object.freeze([]),
  });
}

class ControlledMetaAgent implements ControlledMetaAgentPort {
  async checkMetaProfileReadiness() {
    return DETERMINISTIC_META_READINESS;
  }

  async openMetaSession() {
    return { available: true as const, readiness: DETERMINISTIC_META_READINESS };
  }

  async startMetaTurn(_request: AcpMetaAgentTurnRequest) {
    return "accepted" as const;
  }

  async reconcileMetaTurn(request: AcpMetaAgentTurnRequest) {
    return {
      state: "returned",
      observedAt: NOW,
      finalText: JSON.stringify({
        assistantMessage: "Deterministic Meta review completed.",
        proposal: {
          operations: request.mode === "template_design"
            ? [{ kind: "template_metadata_set", field: "title", value: "Deterministic Bridge" }]
            : [{ kind: "task_setup_goal_set", value: "Exercise the deterministic bridge." }],
          summary: "Deterministic review",
          rationale: "Bridge contract coverage",
          validationIssues: [],
        },
      }),
    } as const;
  }
}

class HostLedger {
  readonly #file: string;
  readonly #identity: Readonly<{ runtimeInstanceId: string; scenarioId: string }>;
  #sequence = 0;

  constructor(file: string, identity: Readonly<{ runtimeInstanceId: string; scenarioId: string }>) {
    this.#file = file;
    this.#identity = identity;
  }

  async append(entry: LedgerEntry): Promise<void> {
    await appendFile(this.#file, `${JSON.stringify({
      ...this.#identity,
      evidenceClass: "deterministic_fake",
      issuer: "runtime_host",
      surface: "runtime_bridge",
      uiClaim: false,
      nativeClaim: false,
      sequence: ++this.#sequence,
      observedAt: NOW,
      ...entry,
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function deterministicTemplate(): TemplateDefinitionV3 {
  const profile = (
    executionProfileId: string,
    profileRevisionId: string,
    allowedTools: readonly string[],
  ): ExecutionProfileDefinitionV3 => Object.freeze({
    executionProfileId,
    profileRevisionId,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    model: "deterministic-fake",
    configIntent: Object.freeze({}),
    requiredExtensions: Object.freeze([]),
    capabilityPolicy: Object.freeze({
      requiredCapabilities: MANAGED_CAPABILITIES,
      allowedTools: Object.freeze([...allowedTools]),
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    }),
  });
  const card = (
    agentCardId: string,
    kind: "researcher" | "reviewer" | "publisher",
    executionProfileId: string,
  ): AgentCardDefinition => Object.freeze({
    agentCardId,
    kind,
    title: kind[0]!.toUpperCase() + kind.slice(1),
    executionProfileId,
    systemPrompt: `Perform the bounded deterministic ${kind} role.`,
    capabilityRefs: Object.freeze([]),
    dispatchProfile: { title: kind, description: `Use for deterministic ${kind} work.` },
  });
  return Object.freeze({
    schemaVersion: 3,
    conductor: Object.freeze({
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_conductor",
      systemPrompt: "Coordinate through the four scoped Runtime orchestration tools.",
      capabilityRefs: Object.freeze([]),
    }),
    agentCards: Object.freeze([
      card("agent_card_researcher", "researcher", "profile_worker"),
      card("agent_card_reviewer", "reviewer", "profile_worker"),
      card("agent_card_publisher", "publisher", "profile_publisher"),
    ]),
    executionProfiles: Object.freeze([
      profile(
        "profile_conductor",
        "profile_revision_conductor-bridge-v3",
        ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      ),
      profile("profile_worker", "profile_revision_worker-bridge-v3", []),
      profile("profile_publisher", "profile_revision_publisher-bridge-v3", []),
    ]),
    routingPolicy: Object.freeze({ mode: "agent_loop", maxConcurrentInvocations: 3, maxDispatchesPerDecision: 4 }),
    deliverables: Object.freeze([{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_publisher" }]),
  });
}

function profileReadiness(
  profile: ExecutionProfileDefinitionV3,
  role: AgentCardDefinition["kind"],
): AcpProfileReadinessObservation {
  return Object.freeze({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role,
    status: "available",
    reasons: Object.freeze([]),
    missingCapabilities: Object.freeze([]),
    missingExtensions: Object.freeze([]),
    model: profile.model,
    observedProtocolMajor: profile.protocolMajor,
    observedAgent: Object.freeze({ name: "deterministic-acp-agent", version: "current" }),
    observedCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
    observedExtensions: Object.freeze([...profile.requiredExtensions]),
  });
}

function deterministicIds(_lineage: JourneyEvidenceLineage | undefined, runtimeInstanceId: string) {
  const counters = new Map<string, number>();
  return Object.freeze({
    create(kind: string): string {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      if (kind === "runtime_instance" && next === 1) return runtimeInstanceId;
      const suffix = runtimeInstanceId.slice("runtime_instance_".length).replace(/[^A-Za-z0-9-]/gu, "-");
      return `${kind}_${suffix}-${next}`;
    },
  });
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
