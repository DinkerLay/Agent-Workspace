import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hashDefinition,
  type AcpProfileReadinessObservation,
  type AcpSafeSessionBindingRecordV3,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type ProviderCapability,
  type SessionExecutionAttemptRecord,
} from "@agent-workspace/runtime-contracts";
import { canonicalizeFinal } from "@agent-workspace/runtime-domain";
import type {
  AcpMetaAgentPort,
  AcpMetaAgentTurnRequest,
  ProviderScopedToolCallResult,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type { AcpMetaAgentRegistration } from "@agent-workspace/runtime-application";
import type { AcpV3FrozenProfileTuple } from "@agent-workspace/runtime-store";
import {
  createAcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeNativeBinding,
  type AcpTaskSessionRuntimeNativeOutcome,
} from "../../../apps/runtime-host/src/acp-task-session-runtime-provider.js";
import { createSessionIdAcpTaskBindingContextOwner } from "../../../apps/runtime-host/src/session-id-acp-task-binding-context.js";
import type {
  SessionIdUnifiedAcpProviderAttachment,
  SessionIdUnifiedAcpProviderFactoryInput,
  SessionIdUnifiedAcpProviderOwner,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-host.js";
const CONTROLLED_CODEX_MODEL = "gpt-5.4";
const CONTROLLED_META_MODEL = "gpt-5.6";
const RECEIPT_PREFIX = "controlled-acp-receipt:";
const REQUIRED_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
] satisfies readonly ProviderCapability[]);

export const CONTROLLED_PROVIDER_STAGES = Object.freeze([
  "j05_researcher_waiting_observed",
  "j06_researcher_final_observed",
  "j08_idle_human_delivered_observed",
  "j08_busy_human_held_observed",
  "j08_late_final_human_held_observed",
  "j09_human_interrupt_intent_recorded",
  "j09_conductor_interrupt_intent_recorded",
] as const);

export type ControlledProviderStage = typeof CONTROLLED_PROVIDER_STAGES[number];

export const CONTROLLED_JOURNEY_CELL_MODES = Object.freeze([
  "main",
  "j08-unknown",
  "j08-late-final",
  "j10-pending-lane",
  "j10-tool-result",
  "j10-provider-accepted",
  "j10-human-interrupting",
  "j10-final-before-inbox",
] as const);

export type ControlledJourneyCellMode = typeof CONTROLLED_JOURNEY_CELL_MODES[number];
export type ControlledJourneyRestartPoint = Exclude<ControlledJourneyCellMode, "main" | "j08-late-final">;
type ControlledToolCheckpoint = "J-05" | "J-06" | "J-07" | "J-08" | "J-09" | "J-10" | "J-11";

export type ControlledJourneyHostOperation = Readonly<{
  kind:
    | "provider_effect_accepted"
    | "provider_clock_advanced"
    | "conductor_tool_result"
    | "publisher_native_file_write"
    | "meta_turn_returned"
    | "branch_restart_point_ready"
    | "branch_restart_resumed"
    | "branch_outcome_staged"
    | "provider_background_failure";
  observedAt: string;
  provider?: "codex";
  agentCardId?: string;
  bindingId?: string;
  inputSubmissionId?: string;
  toolName?: "invoke_agent" | "send_to_session" | "interrupt_session" | "close_session";
  providerCallId?: string;
  checkpoint?: ControlledToolCheckpoint;
  sessionId?: string;
  stage?: ControlledProviderStage;
  cellMode?: ControlledJourneyCellMode;
  crashPoint?: string;
  resultStatus?: string;
  rejectionCode?: string;
  failureCode?: string;
}>;

const CONTROLLED_META_PROFILE: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_controlled-codex-acp",
  profileRevisionId: "profile_revision_meta-controlled-codex-acp-v3",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: CONTROLLED_META_MODEL,
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

const CONTROLLED_META_READINESS: AcpProfileReadinessObservation = Object.freeze({
  profileRevisionId: CONTROLLED_META_PROFILE.profileRevisionId,
  providerFamily: CONTROLLED_META_PROFILE.providerFamily,
  acpAgentKind: CONTROLLED_META_PROFILE.acpAgentKind,
  role: "meta",
  status: "available",
  reasons: Object.freeze([]),
  missingCapabilities: Object.freeze([]),
  missingExtensions: Object.freeze([]),
  model: CONTROLLED_META_PROFILE.model,
  observedProtocolMajor: 1,
  observedAgent: Object.freeze({ name: "controlled-codex-acp", version: "deterministic" }),
});

const CONTROLLED_META_PROFILE_OPTION: MetaProfileOptionDefinitionV3 = Object.freeze({
  metaProfileOptionId: "meta_profile_option_codex",
  title: "Codex ACP Meta · controlled",
  profile: CONTROLLED_META_PROFILE,
  readiness: CONTROLLED_META_READINESS,
});
type ControlledRole = "conductor" | "publisher" | "worker" | "reviewer";
type AttemptStateName =
  | "active"
  | "completed"
  | "facts_deferred"
  | "final_only"
  | "interrupt_pending"
  | "interrupted"
  | "interrupt_unknown"
  | "late_final_waiting"
  | "late_final";

type AttemptState = {
  readonly bindingId: string;
  readonly bindingHandle: string;
  readonly bindingRevision: number;
  readonly sessionExecutionAttemptId: string;
  readonly inputSubmissionId: string;
  readonly agentCardId: string;
  readonly role: ControlledRole;
  readonly content: string;
  readonly finalContent: string;
  readonly receiptDigest: string;
  readonly taskWorkspaceDirectory: string;
  readonly toolContext?: ProviderScopedToolTurnContext;
  state: AttemptStateName;
};

type WorkflowPhase =
  | "await_task_goal"
  | "researcher_waiting"
  | "researcher_dispatched"
  | "reviewer_waiting"
  | "reviewer_dispatched"
  | "await_idle_human"
  | "busy_send_waiting"
  | "busy_send_active"
  | "held_human_active"
  | "notice_followup_active"
  | "conductor_interrupt_requested"
  | "reopened_and_publisher_dispatched"
  | "completed";

export function normalizeControlledJourneyCellMode(value: unknown): ControlledJourneyCellMode {
  if (typeof value !== "string" || !(CONTROLLED_JOURNEY_CELL_MODES as readonly string[]).includes(value)) {
    throw new Error("controlled_journey_cell_mode_invalid");
  }
  return value as ControlledJourneyCellMode;
}

class ControlledProviderClock {
  readonly #stages: readonly ControlledProviderStage[];
  readonly #onRelease: (stage: ControlledProviderStage) => void | Promise<void>;
  readonly #released = new Set<ControlledProviderStage>();
  readonly #waiters = new Map<ControlledProviderStage, Set<() => void>>();

  constructor(
    stages: readonly ControlledProviderStage[],
    onRelease: (stage: ControlledProviderStage) => void | Promise<void>,
  ) {
    this.#stages = stages;
    this.#onRelease = onRelease;
  }

  async release(stage: ControlledProviderStage): Promise<Readonly<{ status: "released" | "replayed" }>> {
    const index = this.#stages.indexOf(stage);
    if (index < 0) throw new Error("controlled_provider_stage_invalid");
    if (this.#released.has(stage)) return Object.freeze({ status: "replayed" as const });
    const expected = this.#stages[this.#released.size];
    if (stage !== expected) throw new Error("controlled_provider_stage_out_of_order");
    this.#released.add(stage);
    for (const resolve of this.#waiters.get(stage) ?? []) resolve();
    this.#waiters.delete(stage);
    await this.#onRelease(stage);
    return Object.freeze({ status: "released" as const });
  }

  wait(stage: ControlledProviderStage): Promise<void> {
    if (this.#released.has(stage)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const current = this.#waiters.get(stage) ?? new Set<() => void>();
      current.add(resolve);
      this.#waiters.set(stage, current);
    });
  }

  snapshot(): Readonly<{ releasedStages: readonly ControlledProviderStage[]; nextStage?: ControlledProviderStage }> {
    const releasedStages = this.#stages.filter((stage) => this.#released.has(stage));
    const nextStage = this.#stages[releasedStages.length];
    return Object.freeze({
      releasedStages: Object.freeze(releasedStages),
      ...(nextStage ? { nextStage } : {}),
    });
  }
}

class ControlledJourneyMetaAgent implements AcpMetaAgentPort {
  readonly #now: () => string;
  readonly #recordOperation: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
  readonly #accepted = new Set<string>();

  constructor(options: Readonly<{
    now: () => string;
    recordOperation: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
  }>) {
    this.#now = options.now;
    this.#recordOperation = options.recordOperation;
  }

  async checkMetaProfileReadiness() {
    return CONTROLLED_META_READINESS;
  }

  async openMetaSession() {
    return Object.freeze({ available: true as const, readiness: CONTROLLED_META_READINESS });
  }

  async startMetaTurn(request: AcpMetaAgentTurnRequest) {
    this.#accepted.add(request.metaTurnId);
    return "accepted" as const;
  }

  async reconcileMetaTurn(request: AcpMetaAgentTurnRequest) {
    if (!this.#accepted.has(request.metaTurnId)) return Object.freeze({ state: "absent" as const });
    const finalText = JSON.stringify({
      assistantMessage: request.mode === "template_design"
        ? "I prepared one small, reviewable Template title refinement."
        : "I prepared one small, reviewable Task goal refinement.",
      proposal: {
        operations: request.mode === "template_design"
          ? [{ kind: "template_metadata_set", field: "title", value: "Deep Research · Meta reviewed" }]
          : [{ kind: "task_setup_goal_set", value: "Produce a reviewed report with explicit provenance." }],
        summary: request.mode === "template_design" ? "Clarify the Template title" : "Clarify the Task goal",
        rationale: "Keep the proposal visible, bounded, and independently applicable by the authenticated user.",
        validationIssues: [],
      },
    });
    await this.#recordOperation(Object.freeze({
      kind: "meta_turn_returned",
      provider: "codex",
      resultStatus: request.mode,
      observedAt: this.#now(),
    }));
    return Object.freeze({ state: "returned" as const, finalText, observedAt: this.#now() });
  }

  async close(): Promise<void> {}
}

function createControlledSessionIdJourneyControlPlane(options: Readonly<{
  cellMode: ControlledJourneyCellMode;
  now: () => string;
  recordOperation: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
}>): Readonly<{
  clock: ControlledProviderClock;
  metaAgent: AcpMetaAgentPort;
}> {
  const clockStages: readonly ControlledProviderStage[] = options.cellMode === "main"
    ? CONTROLLED_PROVIDER_STAGES.filter((stage) => stage !== "j08_late_final_human_held_observed")
    : options.cellMode === "j08-late-final"
      ? Object.freeze(["j08_late_final_human_held_observed"] as const)
      : Object.freeze([]);
  const clock = new ControlledProviderClock(clockStages, async (stage) => {
    await options.recordOperation(Object.freeze({
      kind: "provider_clock_advanced",
      provider: "codex",
      stage,
      observedAt: options.now(),
    }));
  });
  return Object.freeze({
    clock,
    metaAgent: new ControlledJourneyMetaAgent(options),
  });
}

export type ControlledSessionIdJourneyAcpOwner = Readonly<{
  cellMode: ControlledJourneyCellMode;
  createProviderOwner(
    input: SessionIdUnifiedAcpProviderFactoryInput,
  ): SessionIdUnifiedAcpProviderOwner;
  clock: Readonly<{
    release(stage: ControlledProviderStage): Promise<Readonly<{ status: "released" | "replayed" }>>;
    snapshot(): Readonly<{ releasedStages: readonly ControlledProviderStage[]; nextStage?: ControlledProviderStage }>;
  }>;
  snapshot(): Readonly<{
    cellMode: ControlledJourneyCellMode;
    workflowPhase: string;
    interruptRequestCount: number;
    activeInputCount: number;
    branchRestartReady: boolean;
    branchRestartResumed: boolean;
    failed?: string;
  }>;
  awaitHostRestartPoint(): Promise<ControlledJourneyRestartPoint>;
  resumeAfterHostRestart(): Promise<void>;
}>;

/**
 * Deterministic release issuer backed by the same provider-neutral ACP-v3
 * provider used by production assembly. It owns no legacy Task-provider
 * interface, raw native identity, cwd, superseded outbox, or fact writer.
 */
export function createControlledSessionIdJourneyAcpOwner(options: Readonly<{
  cellMode?: ControlledJourneyCellMode;
  now?: () => string;
  recordOperation?: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
  onFatal?: (error: Error) => void;
  effectDeadlineMs?: number;
}> = {}): ControlledSessionIdJourneyAcpOwner {
  const cellMode = normalizeControlledJourneyCellMode(options.cellMode ?? "main");
  const now = options.now ?? (() => new Date().toISOString());
  const recordOperation = options.recordOperation ?? (() => undefined);
  const control = createControlledSessionIdJourneyControlPlane({ cellMode, now, recordOperation });
  const runtime = new ControlledAcpJourneyRuntime({
    cellMode,
    now,
    recordOperation,
    waitForStage: (stage) => control.clock.wait(stage),
    onFatal: options.onFatal,
  });
  let ownerOpen = false;

  return Object.freeze({
    cellMode,
    createProviderOwner(input) {
      if (ownerOpen) throw new Error("controlled_acp_provider_owner_already_open");
      ownerOpen = true;
      return createOwner(input);
    },
    clock: control.clock,
    snapshot: () => runtime.snapshot(),
    awaitHostRestartPoint: () => runtime.awaitHostRestartPoint(),
    resumeAfterHostRestart: () => runtime.resumeAfterHostRestart(),
  });

  function createOwner(input: SessionIdUnifiedAcpProviderFactoryInput): SessionIdUnifiedAcpProviderOwner {
    let attachment: SessionIdUnifiedAcpProviderAttachment | undefined;
    let taskContext: ReturnType<typeof createSessionIdAcpTaskBindingContextOwner> | undefined;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const bindingReady = new Set<string>();
    const provider = createAcpTaskSessionRuntimeProvider({
      repositories: input.repositories,
      sessionRuntimeOwner: input.sessionRuntimeOwner,
      resolveFrozenProfileTuple: input.resolveFrozenProfileTuple,
      resolveInterruptCorrelation: input.resolveInterruptCorrelation,
      resolveTaskStopControl: input.resolveTaskStopControl,
      resolveCloseControl: input.resolveCloseControl,
      authorizeRetiringBindingRecovery: input.authorizeRetiringBindingRecovery,
      onDeliveryReceipt: input.onDeliveryReceipt,
      now: input.now,
      effectDeadlineMs: options.effectDeadlineMs ?? 10 * 60_000,
      async openNativeBinding({ binding, profile, observeDeliveryReceipt, observeFinalCandidate }) {
        if (closed) throw new Error("controlled_acp_provider_owner_closed");
        const attached = attachment;
        const contextOwner = taskContext;
        if (!attached || !contextOwner) throw new Error("controlled_acp_runtime_not_attached");
        const context = await contextOwner.resolveTaskBindingContext({ binding, frozenProfile: profile });
        const native = runtime.openNativeBinding({
          binding,
          profile,
          role: context.role,
          taskWorkspaceDirectory: context.hostScope.authorizedWorkspaceDirectory,
          resolveTurnContext: context.resolveTurnContext,
          getAttempt: input.repositories.sessionRuntime.getAttempt,
          observeDeliveryReceipt,
          observeFinalCandidate,
        });
        const readyKey = `${binding.bindingId}\0${binding.revision}`;
        if (!bindingReady.has(readyKey)) {
          const currentRuntime = input.repositories.sessionRuntime.getRuntimeForSession(binding.logicalSessionId);
          if (!currentRuntime || currentRuntime.taskId !== binding.taskId
            || currentRuntime.runId !== binding.runId
            || currentRuntime.logicalSessionId !== binding.logicalSessionId) {
            throw new Error("controlled_acp_binding_ready_runtime_mismatch");
          }
          await attached.onBindingReady(input.sessionRuntimeOwner.bindingReadyEvent({
            sessionExecutionRuntimeId: currentRuntime.sessionExecutionRuntimeId,
            logicalSessionId: binding.logicalSessionId,
            bindingId: binding.bindingId,
            bindingRevision: binding.revision,
            executionProfileId: binding.executionProfileId,
            profileRevisionId: binding.profileRevisionId,
            bindingHandle: binding.bindingHandle,
            recoverable: binding.recoverable,
          }));
          bindingReady.add(readyKey);
        }
        return native;
      },
    });
    const metaAgentRegistrations: readonly AcpMetaAgentRegistration[] = Object.freeze([
      Object.freeze({ option: CONTROLLED_META_PROFILE_OPTION, port: control.metaAgent }),
    ]);
    return Object.freeze({
      provider,
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
        Object.freeze({ modelId: CONTROLLED_META_MODEL, label: CONTROLLED_META_MODEL }),
      ]),
      readCachedProfileReadiness: controlledReadiness,
      checkProfileReadiness: async (value) => controlledReadiness(value) ?? Object.freeze({
        profileRevisionId: value.profile.profileRevisionId,
        providerFamily: value.profile.providerFamily,
        acpAgentKind: value.profile.acpAgentKind,
        role: value.role,
        status: "unavailable" as const,
        reasons: Object.freeze(["acp_controlled_profile_unavailable"]),
        missingCapabilities: Object.freeze([]),
        missingExtensions: Object.freeze([]),
        model: value.profile.model,
      }),
      async attachRuntime(value) {
        if (closed) throw new Error("controlled_acp_provider_owner_closed");
        if (attachment) throw new Error("controlled_acp_runtime_already_attached");
        attachment = value;
        taskContext = createSessionIdAcpTaskBindingContextOwner({
          repositories: input.taskBindingContext.repositories,
          workspaceDirectoryResolver: input.taskBindingContext.workspaceDirectoryResolver,
          acpApplication: value.acpApplication,
          privateAuthority: Object.freeze({
            taskPrivateRootAuthority: Object.freeze({
              toJSON: () => Object.freeze({ kind: "acp_task_private_root_authority" as const }),
            }),
          }),
          onRuntimeInvalidated: value.onRuntimeInvalidated,
        });
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        taskContext?.close();
        closePromise = provider.close().finally(() => {
          ownerOpen = false;
        });
        return closePromise;
      },
    });
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

class ControlledAcpJourneyRuntime {
  readonly #cellMode: ControlledJourneyCellMode;
  readonly #now: () => string;
  readonly #recordOperation: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
  readonly #waitForStage: (stage: ControlledProviderStage) => Promise<void>;
  readonly #onFatal?: (error: Error) => void;
  readonly #attempts = new Map<string, AttemptState>();
  readonly #sessions = new Map<"researcher" | "researcher_v2" | "reviewer" | "publisher", string>();
  readonly #toolOrdinals = new Map<string, number>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #phase: WorkflowPhase = "await_task_goal";
  #interruptRequestCount = 0;
  #noticeCount = 0;
  #branchRestartReady = false;
  #branchRestartResumed = false;
  #resolveBranchRestart!: (point: ControlledJourneyRestartPoint) => void;
  readonly #branchRestart = new Promise<ControlledJourneyRestartPoint>((resolve) => {
    this.#resolveBranchRestart = resolve;
  });
  #failure?: Error;

  constructor(options: Readonly<{
    cellMode: ControlledJourneyCellMode;
    now: () => string;
    recordOperation: (operation: ControlledJourneyHostOperation) => void | Promise<void>;
    waitForStage: (stage: ControlledProviderStage) => Promise<void>;
    onFatal?: (error: Error) => void;
  }>) {
    this.#cellMode = options.cellMode;
    this.#now = options.now;
    this.#recordOperation = options.recordOperation;
    this.#waitForStage = options.waitForStage;
    this.#onFatal = options.onFatal;
  }

  openNativeBinding(input: Readonly<{
    binding: AcpSafeSessionBindingRecordV3;
    profile: AcpV3FrozenProfileTuple;
    role: ControlledRole;
    taskWorkspaceDirectory: string;
    resolveTurnContext?: (input: Readonly<{ sessionExecutionAttemptId: string }>) => ProviderScopedToolTurnContext | undefined;
    getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
    observeDeliveryReceipt(receipt: Readonly<{
      bindingHandle: string;
      sessionExecutionAttemptId: string;
      receiptDigest: string;
    }>): Promise<void>;
    observeFinalCandidate(observation: Readonly<{
      bindingHandle: string;
      sessionExecutionAttemptId: string;
      receiptDigest: string;
      candidateObservationId: string;
      content: string;
      contentDigest: string;
    }>): Promise<void>;
  }>): AcpTaskSessionRuntimeNativeBinding {
    const { binding } = input;
    if (input.profile.executionProfileId !== binding.executionProfileId
      || input.profile.profileRevisionId !== binding.profileRevisionId
      || input.profile.providerFamily !== binding.providerFamily) {
      throw new Error("controlled_acp_profile_fence_mismatch");
    }
    const native: AcpTaskSessionRuntimeNativeBinding = Object.freeze({
      bindingHandle: binding.bindingHandle,
      submitDelivery: async ({ bindingHandle, sessionExecutionAttemptId, content, signal }:
        Parameters<AcpTaskSessionRuntimeNativeBinding["submitDelivery"]>[0]) => {
        this.#ensureHealthy();
        this.#assertBindingHandle(binding.bindingHandle, bindingHandle);
        const attempt = this.#requiredAttempt(input.getAttempt, binding, sessionExecutionAttemptId);
        let state = this.#attempts.get(sessionExecutionAttemptId);
        if (!state) {
          const receiptDigest = hashDefinition(`${RECEIPT_PREFIX}${sessionExecutionAttemptId}`);
          await input.observeDeliveryReceipt({ bindingHandle, sessionExecutionAttemptId, receiptDigest });
          const toolContext = input.resolveTurnContext?.({ sessionExecutionAttemptId });
          state = {
            bindingId: binding.bindingId,
            bindingHandle,
            bindingRevision: binding.revision,
            sessionExecutionAttemptId,
            inputSubmissionId: attempt.inputSubmissionId,
            agentCardId: binding.agentCardId,
            role: input.role,
            taskWorkspaceDirectory: input.taskWorkspaceDirectory,
            content,
            finalContent: finalFor(binding.agentCardId, input.role),
            receiptDigest,
            ...(toolContext ? { toolContext } : {}),
            state: input.role === "conductor" ? "active" : initialWorkerState(content),
          };
          this.#attempts.set(sessionExecutionAttemptId, state);
          await this.#recordAccepted(state, "submit_delivery");
          await this.#beginDelivery(state, input.observeFinalCandidate);
        } else {
          this.#assertAttemptReplay(state, binding, attempt, content, input.role);
        }
        return await this.#waitForOutcome(state, signal);
      },
      reconcileAttempt: async ({ bindingHandle, sessionExecutionAttemptId }:
        Parameters<AcpTaskSessionRuntimeNativeBinding["reconcileAttempt"]>[0]) => {
        this.#ensureHealthy();
        this.#assertBindingHandle(binding.bindingHandle, bindingHandle);
        const state = this.#attempts.get(sessionExecutionAttemptId);
        return state ? this.#outcome(state) : reconciling(bindingHandle, sessionExecutionAttemptId);
      },
      requestInterrupt: async ({ bindingHandle, sessionExecutionAttemptId }:
        Parameters<NonNullable<AcpTaskSessionRuntimeNativeBinding["requestInterrupt"]>>[0]) => {
        this.#ensureHealthy();
        this.#assertBindingHandle(binding.bindingHandle, bindingHandle);
        const state = this.#attempts.get(sessionExecutionAttemptId);
        if (!state) throw new Error("controlled_acp_interrupt_attempt_missing");
        return await this.#interrupt(state);
      },
      retire: async () => undefined,
      close: async () => undefined,
    });
    return native;
  }

  snapshot() {
    return Object.freeze({
      cellMode: this.#cellMode,
      workflowPhase: this.#phase,
      interruptRequestCount: this.#interruptRequestCount,
      activeInputCount: [...this.#attempts.values()].filter(({ state }) =>
        state === "active" || state === "interrupt_pending" || state === "late_final_waiting").length,
      branchRestartReady: this.#branchRestartReady,
      branchRestartResumed: this.#branchRestartResumed,
      ...(this.#failure ? { failed: this.#failure.message } : {}),
    });
  }

  async awaitHostRestartPoint(): Promise<ControlledJourneyRestartPoint> {
    if (this.#cellMode === "main" || this.#cellMode === "j08-late-final") {
      throw new Error("controlled_journey_restart_not_required");
    }
    return this.#branchRestart;
  }

  async resumeAfterHostRestart(): Promise<void> {
    if (!this.#branchRestartReady || this.#branchRestartResumed) {
      throw new Error("controlled_journey_restart_resume_invalid");
    }
    this.#branchRestartResumed = true;
    for (const state of this.#attempts.values()) {
      if (this.#cellMode === "j10-human-interrupting" && state.state === "interrupt_pending") {
        this.#setState(state, "interrupted");
      } else if (this.#cellMode !== "j08-unknown"
        && ["active", "facts_deferred", "final_only"].includes(state.state)) {
        this.#setState(state, "completed");
      }
    }
    await this.#recordOperation(Object.freeze({
      kind: "branch_restart_resumed",
      provider: "codex",
      cellMode: this.#cellMode,
      crashPoint: this.#cellMode.replace(/^j(?:08|10)-/u, ""),
      observedAt: this.#now(),
    }));
  }

  async #beginDelivery(
    state: AttemptState,
    observeFinalCandidate: (observation: Readonly<{
      bindingHandle: string;
      sessionExecutionAttemptId: string;
      receiptDigest: string;
      candidateObservationId: string;
      content: string;
      contentDigest: string;
    }>) => Promise<void>,
  ): Promise<void> {
    try {
      if (state.role === "conductor") {
        if (this.#cellMode === "main") await this.#driveConductor(state);
        else await this.#driveBranchConductor(state);
      } else if (state.role === "publisher") {
        await this.#publishThroughNativeFileTool(state);
        if (this.#cellMode === "j10-final-before-inbox" && !this.#branchRestartResumed) {
          this.#setState(state, "final_only");
          await observeFinalCandidate(Object.freeze({
            bindingHandle: state.bindingHandle,
            sessionExecutionAttemptId: state.sessionExecutionAttemptId,
            receiptDigest: state.receiptDigest,
            candidateObservationId: observationId("candidate", state.sessionExecutionAttemptId),
            content: state.finalContent,
            contentDigest: hashDefinition(state.finalContent),
          }));
          await this.#markBranchRestartReady("j10-final-before-inbox");
        } else {
          this.#setState(state, "completed");
          this.#phase = "completed";
        }
      } else if (this.#cellMode === "j10-provider-accepted" && !this.#branchRestartResumed) {
        this.#setState(state, "facts_deferred");
        await this.#markBranchRestartReady("j10-provider-accepted");
      } else if (isHeldHumanContent(state.content)) {
        this.#setState(state, this.#branchRestartResumed || this.#cellMode === "j08-late-final" ? "completed" : "active");
        this.#phase = state.state === "completed" ? "completed" : "held_human_active";
      } else if (isBusyHoldContent(state.content)) {
        this.#setState(state, "active");
        this.#phase = "busy_send_active";
      } else {
        this.#setState(state, "completed");
      }
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #interrupt(state: AttemptState): Promise<AcpTaskSessionRuntimeNativeOutcome> {
    if (state.state === "completed" || state.state === "late_final" || state.state === "interrupted") {
      return this.#outcome(state);
    }
    this.#interruptRequestCount += 1;
    await this.#recordAccepted(state, "request_interrupt");
    if (this.#cellMode === "j08-unknown") {
      this.#setState(state, "interrupt_unknown");
      await this.#markBranchRestartReady("j08-unknown");
      return this.#outcome(state);
    }
    if (this.#cellMode === "j08-late-final") {
      this.#setState(state, "late_final_waiting");
      await this.#recordOperation(Object.freeze({
        kind: "branch_outcome_staged",
        provider: "codex",
        cellMode: this.#cellMode,
        crashPoint: "late-final",
        observedAt: this.#now(),
      }));
      await this.#waitForStage("j08_late_final_human_held_observed");
      this.#setState(state, "late_final");
      return this.#outcome(state);
    }
    if (this.#cellMode === "j10-human-interrupting") {
      this.#setState(state, "interrupt_pending");
      await this.#markBranchRestartReady("j10-human-interrupting");
      return this.#outcome(state);
    }
    this.#setState(state, "interrupt_pending");
    const stage = this.#interruptRequestCount === 1
      ? "j08_busy_human_held_observed" as const
      : this.#interruptRequestCount === 2
        ? "j09_human_interrupt_intent_recorded" as const
        : this.#interruptRequestCount === 3
          ? "j09_conductor_interrupt_intent_recorded" as const
          : undefined;
    if (!stage) throw new Error("controlled_provider_interrupt_sequence_invalid");
    await this.#waitForStage(stage);
    this.#setState(state, "interrupted");
    return this.#outcome(state);
  }

  async #driveBranchConductor(state: AttemptState): Promise<void> {
    if (this.#sessions.has("researcher")
      && ["j08-unknown", "j08-late-final", "j10-human-interrupting"].includes(this.#cellMode)) {
      this.#setState(state, "completed");
      return;
    }
    if (this.#branchRestartResumed) {
      if (this.#cellMode === "j10-pending-lane") {
        await this.#invoke(state, "agent_card_researcher", "researcher", "J-10");
      }
      this.#setState(state, "completed");
      this.#phase = "completed";
      return;
    }
    if (this.#cellMode === "j10-pending-lane") {
      await this.#markBranchRestartReady("j10-pending-lane");
      return;
    }
    if (this.#cellMode === "j10-tool-result") {
      await this.#invoke(state, "agent_card_researcher", "researcher", "J-10");
      await this.#markBranchRestartReady("j10-tool-result");
      return;
    }
    if (this.#cellMode === "j10-provider-accepted") {
      const researcher = await this.#invoke(state, "agent_card_researcher", "researcher", "J-10");
      await this.#send(state, researcher, { content: "Recover the accepted Provider effect without resubmission." }, "J-10");
      this.#setState(state, "completed");
      return;
    }
    if (this.#cellMode === "j10-final-before-inbox") {
      const publisher = await this.#invoke(state, "agent_card_publisher", "publisher", "J-10");
      await this.#send(state, publisher, { content: "Return a final before terminal reconciliation." }, "J-10");
      this.#setState(state, "completed");
      return;
    }
    const researcher = await this.#invoke(state, "agent_card_researcher", "researcher", "J-08");
    await this.#send(state, researcher, {
      content: "Remain active until the authenticated human priority path is exercised.",
    }, "J-08");
    this.#setState(state, "completed");
    this.#phase = "busy_send_active";
  }

  async #driveConductor(state: AttemptState): Promise<void> {
    const envelope = finalEnvelope(state.content);
    if (this.#phase === "await_task_goal") {
      const researcher = await this.#invoke(state, "agent_card_researcher", "researcher", "J-05");
      this.#phase = "researcher_waiting";
      await this.#waitForStage("j05_researcher_waiting_observed");
      await this.#send(state, researcher, {
        content: "Research the scoped task and return one reviewable relay block.",
      }, "J-06");
      this.#phase = "researcher_dispatched";
      this.#setState(state, "completed");
      return;
    }
    if (envelope && envelope.sourceSessionId === this.#sessions.get("researcher")
      && this.#phase === "researcher_dispatched") {
      const reviewer = await this.#invoke(state, "agent_card_reviewer", "reviewer", "J-07");
      this.#phase = "reviewer_waiting";
      await this.#waitForStage("j06_researcher_final_observed");
      const relay = canonicalizeFinal({ messageId: envelope.messageId, content: envelope.content })
        .find((block) => block.kind === "relay");
      if (!relay || relay.kind !== "relay") throw new Error("controlled_researcher_relay_block_missing");
      await this.#send(state, reviewer, {
        content: "Review only the selected Researcher relay block.",
        messageRefs: [{ kind: "relay_block", sourceMessageId: envelope.messageId, relayBlockId: relay.relayBlockId }],
      }, "J-07");
      this.#phase = "reviewer_dispatched";
      this.#setState(state, "completed");
      return;
    }
    if (envelope && envelope.sourceSessionId === this.#sessions.get("reviewer")
      && this.#phase === "reviewer_dispatched") {
      this.#phase = "await_idle_human";
      this.#setState(state, "completed");
      return;
    }
    if (isHumanMirror(state.content) && this.#phase === "await_idle_human") {
      this.#phase = "busy_send_waiting";
      await this.#waitForStage("j08_idle_human_delivered_observed");
      await this.#send(state, this.#session("researcher"), {
        content: "Remain active until the authenticated human priority path is exercised.",
      }, "J-08");
      this.#phase = "busy_send_active";
      this.#setState(state, "completed");
      return;
    }
    const notice = sessionNoticeEnvelope(state.content);
    if (notice) {
      this.#noticeCount += 1;
      if (this.#noticeCount === 2) {
        await this.#send(state, this.#session("researcher"), {
          content: "Continue after the confirmed human scoped interrupt and remain active.",
          messageRefs: [{ kind: "full_message", sourceMessageId: notice.messageId }],
        }, "J-09");
        this.#phase = "notice_followup_active";
      } else if (this.#noticeCount === 3) {
        const retiredResearcher = this.#session("researcher");
        await this.#control(state, "close_session", retiredResearcher, "J-09");
        const reopened = await this.#invoke(state, "agent_card_researcher", "researcher_v2", "J-09");
        this.#sessions.set("researcher", reopened);
        await this.#sendExpectRejected(
          state,
          retiredResearcher,
          { content: "Verify that the retired Researcher generation cannot receive new work." },
          "orchestration_session_not_current",
          "J-09",
        );
        const publisher = await this.#invoke(state, "agent_card_publisher", "publisher", "J-11");
        await this.#send(state, publisher, {
          content: "Publish the reviewed result to reports/result.md through the scoped workspace tool.",
        }, "J-11");
        this.#phase = "reopened_and_publisher_dispatched";
      }
      this.#setState(state, "completed");
      return;
    }
    if (isReopenIntent(state.content) && this.#phase === "notice_followup_active") {
      await this.#control(state, "interrupt_session", this.#session("researcher"), "J-09");
      this.#phase = "conductor_interrupt_requested";
      this.#setState(state, "completed");
      return;
    }
    this.#setState(state, "completed");
  }

  async #invoke(
    state: AttemptState,
    agentCardId: string,
    alias: "researcher" | "researcher_v2" | "reviewer" | "publisher",
    checkpoint: ControlledToolCheckpoint,
  ): Promise<string> {
    const result = await this.#tool(state, "invoke_agent", { agentCardId }, checkpoint);
    const sessionId = result.result && typeof result.result === "object"
      ? (result.result as { sessionId?: unknown }).sessionId
      : undefined;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("controlled_invoke_result_invalid");
    this.#sessions.set(alias, sessionId);
    return sessionId;
  }

  async #send(
    state: AttemptState,
    sessionId: string,
    payload: Readonly<Record<string, unknown>>,
    checkpoint: ControlledToolCheckpoint,
  ): Promise<void> {
    const result = await this.#tool(state, "send_to_session", { sessionId, payload }, checkpoint);
    assertToolStatus(result, "accepted", "controlled_send_result_invalid");
  }

  async #sendExpectRejected(
    state: AttemptState,
    sessionId: string,
    payload: Readonly<Record<string, unknown>>,
    expectedReason: string,
    checkpoint: "J-09",
  ): Promise<void> {
    try {
      const result = await this.#tool(state, "send_to_session", { sessionId, payload }, checkpoint);
      if (toolResultRejection(result.result) !== expectedReason) {
        throw new Error("controlled_old_session_rejection_invalid");
      }
    } catch (error) {
      if (safeToolRejectionCode(error) !== expectedReason) throw error;
    }
  }

  async #control(
    state: AttemptState,
    name: "interrupt_session" | "close_session",
    sessionId: string,
    checkpoint: ControlledToolCheckpoint,
  ): Promise<void> {
    const result = await this.#tool(state, name, { sessionId }, checkpoint);
    assertToolStatus(result, name === "close_session" ? "closed" : "accepted", `controlled_${name}_result_invalid`);
  }

  async #tool(
    state: AttemptState,
    name: "invoke_agent" | "send_to_session" | "interrupt_session" | "close_session",
    argumentsValue: Readonly<Record<string, unknown>>,
    checkpoint: ControlledToolCheckpoint,
  ): Promise<ProviderScopedToolCallResult> {
    const context = requiredToolContext(state, "runtime_orchestration");
    const ordinal = (this.#toolOrdinals.get(state.inputSubmissionId) ?? 0) + 1;
    this.#toolOrdinals.set(state.inputSubmissionId, ordinal);
    const providerCallId = `controlled_call_${checkpoint.toLowerCase()}_${ordinal}_${name}_${state.inputSubmissionId}`;
    try {
      const result = await context.handleCall({
        providerCallId,
        name,
        arguments: argumentsValue,
        lease: context.lease,
      });
      const rejectionCode = toolResultRejection(result.result);
      await this.#recordOperation(Object.freeze({
        kind: "conductor_tool_result",
        provider: "codex",
        inputSubmissionId: state.inputSubmissionId,
        toolName: name,
        providerCallId,
        checkpoint,
        ...toolCallIdentity(name, argumentsValue, result.result),
        resultStatus: toolResultStatus(result.result),
        ...(rejectionCode ? { rejectionCode } : {}),
        observedAt: this.#now(),
      }));
      return result;
    } catch (error) {
      await this.#recordOperation(Object.freeze({
        kind: "conductor_tool_result",
        provider: "codex",
        inputSubmissionId: state.inputSubmissionId,
        toolName: name,
        providerCallId,
        checkpoint,
        ...toolCallIdentity(name, argumentsValue),
        resultStatus: "rejected",
        rejectionCode: safeToolRejectionCode(error),
        observedAt: this.#now(),
      }));
      throw error;
    }
  }

  async #publishThroughNativeFileTool(state: AttemptState): Promise<void> {
    const target = path.join(state.taskWorkspaceDirectory, "reports", "result.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      "# Controlled Journey Result\n\nReviewed and published through the Provider's native file tools.\n",
      "utf8",
    );
    await this.#recordOperation(Object.freeze({
      kind: "publisher_native_file_write",
      provider: "codex",
      bindingId: state.bindingId,
      inputSubmissionId: state.inputSubmissionId,
      resultStatus: "completed",
      observedAt: this.#now(),
    }));
  }

  async #waitForOutcome(state: AttemptState, signal: AbortSignal): Promise<AcpTaskSessionRuntimeNativeOutcome> {
    if (this.#isImmediateOutcome(state.state)) return this.#outcome(state);
    while (!this.#isImmediateOutcome(state.state)) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("controlled_acp_effect_aborted"));
        const waiters = this.#waiters.get(state.sessionExecutionAttemptId) ?? new Set<() => void>();
        const onAbort = () => {
          waiters.delete(onState);
          reject(new Error("controlled_acp_effect_aborted"));
        };
        const onState = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        waiters.add(onState);
        this.#waiters.set(state.sessionExecutionAttemptId, waiters);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return this.#outcome(state);
  }

  #isImmediateOutcome(state: AttemptStateName): boolean {
    return [
      "completed",
      "facts_deferred",
      "final_only",
      "interrupted",
      "interrupt_unknown",
      "interrupt_pending",
      "late_final",
    ].includes(state);
  }

  #outcome(state: AttemptState): AcpTaskSessionRuntimeNativeOutcome {
    if (state.state === "completed" || state.state === "late_final") {
      return Object.freeze({
        status: "settled" as const,
        bindingHandle: state.bindingHandle,
        sessionExecutionAttemptId: state.sessionExecutionAttemptId,
        receiptDigest: state.receiptDigest,
        finalCandidate: Object.freeze({
          candidateObservationId: observationId("candidate", state.sessionExecutionAttemptId),
          content: state.finalContent,
          contentDigest: hashDefinition(state.finalContent),
        }),
        terminal: Object.freeze({
          terminalObservationId: observationId("terminal", state.sessionExecutionAttemptId),
          outcome: "completed" as const,
          receiptDigest: state.receiptDigest,
        }),
      });
    }
    if (state.state === "interrupted") {
      return Object.freeze({
        status: "settled" as const,
        bindingHandle: state.bindingHandle,
        sessionExecutionAttemptId: state.sessionExecutionAttemptId,
        receiptDigest: state.receiptDigest,
        terminal: Object.freeze({
          terminalObservationId: observationId("terminal", state.sessionExecutionAttemptId),
          outcome: "cancelled" as const,
          receiptDigest: state.receiptDigest,
        }),
      });
    }
    return reconciling(state.bindingHandle, state.sessionExecutionAttemptId);
  }

  #requiredAttempt(
    getAttempt: (id: string) => SessionExecutionAttemptRecord | undefined,
    binding: AcpSafeSessionBindingRecordV3,
    attemptId: string,
  ): SessionExecutionAttemptRecord {
    const attempt = getAttempt(attemptId);
    if (!attempt || attempt.bindingId !== binding.bindingId
      || attempt.bindingRevision !== binding.revision
      || attempt.logicalSessionId !== binding.logicalSessionId
      || attempt.executionProfileId !== binding.executionProfileId
      || attempt.profileRevisionId !== binding.profileRevisionId) {
      throw new Error("controlled_acp_attempt_fence_mismatch");
    }
    return attempt;
  }

  #assertAttemptReplay(
    state: AttemptState,
    binding: AcpSafeSessionBindingRecordV3,
    attempt: SessionExecutionAttemptRecord,
    content: string,
    role: ControlledRole,
  ): void {
    if (state.bindingId !== binding.bindingId || state.bindingRevision !== binding.revision
      || state.inputSubmissionId !== attempt.inputSubmissionId || state.content !== content || state.role !== role) {
      throw new Error("controlled_acp_attempt_replay_conflict");
    }
  }

  #assertBindingHandle(expected: string, actual: string): void {
    if (expected !== actual) throw new Error("controlled_acp_binding_handle_mismatch");
  }

  #setState(state: AttemptState, value: AttemptStateName): void {
    state.state = value;
    for (const resolve of this.#waiters.get(state.sessionExecutionAttemptId) ?? []) resolve();
    this.#waiters.delete(state.sessionExecutionAttemptId);
  }

  async #markBranchRestartReady(point: ControlledJourneyRestartPoint): Promise<void> {
    if (this.#branchRestartReady) return;
    this.#branchRestartReady = true;
    await this.#recordOperation(Object.freeze({
      kind: "branch_restart_point_ready",
      provider: "codex",
      cellMode: this.#cellMode,
      crashPoint: point.replace(/^j(?:08|10)-/u, ""),
      observedAt: this.#now(),
    }));
    this.#resolveBranchRestart(point);
  }

  async #recordAccepted(state: AttemptState, resultStatus: "submit_delivery" | "request_interrupt"): Promise<void> {
    await this.#recordOperation(Object.freeze({
      kind: "provider_effect_accepted",
      provider: "codex",
      bindingId: state.bindingId,
      inputSubmissionId: state.inputSubmissionId,
      resultStatus,
      observedAt: this.#now(),
    }));
  }

  async #fail(error: unknown): Promise<void> {
    const failure = error instanceof Error ? error : new Error("controlled_provider_background_failed");
    this.#failure = failure;
    await this.#recordOperation(Object.freeze({
      kind: "provider_background_failure",
      provider: "codex",
      failureCode: safeToolRejectionCode(failure),
      observedAt: this.#now(),
    }));
    this.#onFatal?.(failure);
  }

  #session(alias: "researcher" | "reviewer" | "publisher"): string {
    const sessionId = this.#sessions.get(alias);
    if (!sessionId) throw new Error(`controlled_session_alias_missing_${alias}`);
    return sessionId;
  }

  #ensureHealthy(): void {
    if (this.#failure) throw this.#failure;
  }
}

const controlledReadiness: SessionIdUnifiedAcpProviderOwner["readCachedProfileReadiness"] = (input) => {
  const profile = input.profile;
  if (profile.providerFamily !== "codex") return undefined;
  const expectedTools = input.role === "conductor"
    ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
    : [];
  const reasons: string[] = [];
  if (profile.model !== CONTROLLED_CODEX_MODEL) reasons.push("acp_controlled_model_not_frozen");
  if (profile.acpAgentKind !== "codex_acp") reasons.push("acp_controlled_agent_kind_mismatch");
  if (profile.protocolMajor !== 1) reasons.push("acp_controlled_protocol_not_supported");
  if (profile.capabilityPolicy.permissionMode !== "deny"
    || profile.capabilityPolicy.maxConcurrentTurns !== 1
    || profile.capabilityPolicy.maxNativeChildren !== 0) {
    reasons.push("acp_controlled_policy_mismatch");
  }
  if (!sameSet(profile.capabilityPolicy.allowedTools, expectedTools)) reasons.push("acp_controlled_tool_policy_mismatch");
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((capability) =>
    !profile.capabilityPolicy.requiredCapabilities.includes(capability));
  const missingExtensions = Object.freeze([...profile.requiredExtensions]);
  return Object.freeze({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role: input.role,
    status: reasons.length === 0 && missingCapabilities.length === 0 && missingExtensions.length === 0
      ? "available" as const
      : "unavailable" as const,
    reasons: Object.freeze(reasons),
    missingCapabilities: Object.freeze(missingCapabilities),
    missingExtensions,
    model: profile.model,
    observedProtocolMajor: 1,
    observedAgent: Object.freeze({ name: "controlled-codex-acp", version: "deterministic" }),
    observedCapabilities: REQUIRED_CAPABILITIES,
    observedExtensions: Object.freeze([]),
  });
};

function initialWorkerState(content: string): AttemptStateName {
  return isBusyHoldContent(content) || isHeldHumanContent(content) ? "active" : "completed";
}

function finalFor(agentCardId: string, role: ControlledRole): string {
  if (role === "conductor") return "Controlled Conductor planning turn completed.";
  if (agentCardId === "agent_card_researcher") {
    return [
      "Research complete with one selected review snapshot.",
      "",
      "```relay",
      "topic: controlled.research.findings",
      "to: agent_card_reviewer",
      "audience: one",
      "format: text/markdown",
      "---",
      "The controlled Researcher produced the bounded evidence snapshot for Reviewer.",
      "```",
    ].join("\n");
  }
  if (agentCardId === "agent_card_reviewer") {
    return "Reviewer approved only the selected Researcher snapshot for publication.";
  }
  if (role === "publisher") return "Publisher wrote reports/result.md through the scoped workspace tool.";
  return `Controlled final from ${agentCardId}.`;
}

function requiredToolContext(
  state: AttemptState,
  capabilityClass: ProviderScopedToolTurnContext["capabilityClass"],
): ProviderScopedToolTurnContext {
  const context = state.toolContext;
  if (!context || context.capabilityClass !== capabilityClass) {
    throw new Error("controlled_provider_scoped_tool_context_missing");
  }
  return context;
}

function reconciling(bindingHandle: string, sessionExecutionAttemptId: string): AcpTaskSessionRuntimeNativeOutcome {
  return Object.freeze({
    status: "reconciling" as const,
    bindingHandle,
    sessionExecutionAttemptId,
    reason: "provider_outcome_unknown" as const,
  });
}

function observationId(kind: "candidate" | "terminal", attemptId: string): string {
  return `provider_fact_controlled_${kind}_${attemptId.replace(/^session_execution_attempt_/u, "")}`;
}

function finalEnvelope(content: string): Readonly<{
  messageId: string;
  sourceSessionId: string;
  content: string;
}> | undefined {
  const withoutDirectory = content.split("\n\n<agent-workspace-card-directory>", 1)[0] ?? content;
  const match = /^\[FinalForConductor messageId=([^\s]+) sourceSessionId=([^\s]+)\]\n([\s\S]+)$/u.exec(withoutDirectory);
  return match ? Object.freeze({ messageId: match[1]!, sourceSessionId: match[2]!, content: match[3]! }) : undefined;
}

function isHumanMirror(content: string): boolean {
  return content.includes("[HumanInterventionForConductor ") && content.includes("First direct message while idle");
}

function sessionNoticeEnvelope(content: string): Readonly<{ messageId: string; sourceSessionId: string }> | undefined {
  if (!content.includes("Scoped interrupt confirmed for Session")) return undefined;
  const match = /^\[SessionNoticeForConductor messageId=([^\s]+) sessionId=([^\s]+)\]/u.exec(content);
  return match ? Object.freeze({ messageId: match[1]!, sourceSessionId: match[2]! }) : undefined;
}

function isReopenIntent(content: string): boolean {
  return content.includes("Interrupt and reopen Researcher");
}

function isBusyHoldContent(content: string): boolean {
  return content.includes("Remain active until the authenticated human priority path is exercised")
    || content.includes("Continue after the confirmed human scoped interrupt and remain active");
}

function isHeldHumanContent(content: string): boolean {
  return content.includes("Add the held human constraint");
}

function assertToolStatus(result: ProviderScopedToolCallResult, expected: string, code: string): void {
  const status = result.result && typeof result.result === "object"
    ? (result.result as { status?: unknown }).status
    : undefined;
  if (status !== expected) throw new Error(code);
}

function toolResultStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as { status?: unknown; sessionId?: unknown };
  if (typeof record.status === "string") return record.status;
  if (typeof record.sessionId === "string") return "session_created";
  return "unknown";
}

function toolResultRejection(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as { status?: unknown; reason?: unknown };
  return result.status === "rejected" && typeof result.reason === "string" ? result.reason : undefined;
}

function toolCallIdentity(
  name: "invoke_agent" | "send_to_session" | "interrupt_session" | "close_session",
  argumentsValue: Readonly<Record<string, unknown>>,
  result?: unknown,
): Readonly<{ sessionId?: string; agentCardId?: string }> {
  if (name === "invoke_agent" && result && typeof result === "object" && !Array.isArray(result)
    && typeof (result as { sessionId?: unknown }).sessionId === "string") {
    return Object.freeze({
      sessionId: (result as { sessionId: string }).sessionId,
      ...(typeof argumentsValue.agentCardId === "string" ? { agentCardId: argumentsValue.agentCardId } : {}),
    });
  }
  return typeof argumentsValue.sessionId === "string"
    ? Object.freeze({ sessionId: argumentsValue.sessionId })
    : Object.freeze({});
}

function safeToolRejectionCode(error: unknown): string {
  const value = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : undefined;
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,159}$/u.test(value)
    ? value
    : "controlled_tool_rejection_unclassified";
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
