import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionExecutionRuntimeOwner,
} from "../../../packages/runtime-application/src/session-execution-runtime-owner.js";
import {
  createAcpSessionRuntimeRepositories,
  SqliteRuntimeStore,
  type AcpSessionRuntimeRepositories,
  type AcpV3FrozenProfileTuple,
  type AcpV3SessionRuntimeRepository,
} from "@agent-workspace/runtime-store";
import {
  AcpTaskSessionRuntimeProviderError,
  createAcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeNativeBinding,
  type AcpTaskSessionRuntimeNativeOutcome,
} from "./acp-task-session-runtime-provider.js";

const NOW = "2026-08-12T00:00:00.000Z";
const RECEIPT = `sha256:${"a".repeat(64)}`;
const FINAL = "One safe provider-neutral final.";
const PROFILE: AcpV3FrozenProfileTuple = Object.freeze({
  schemaVersion: 3,
  executionProfileId: "profile_codex_task",
  profileRevisionId: "profile_revision_codex_task",
  providerFamily: "codex",
});
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("provider-neutral ACP Task Session Runtime provider", () => {
  it("uses the durable intent/Attempt as truth and replays a settlement without a second native submit", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Produce one bounded final.");
    const native = fakeNativeBinding({
      submitDelivery: async ({ sessionExecutionAttemptId }) => settledOutcome(sessionExecutionAttemptId),
    });
    const openNativeBinding = vi.fn(async () => native);
    const provider = fixture.provider({ openNativeBinding });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "settled",
      replayed: false,
      settlement: {
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        outcome: "completed",
        receiptDigest: RECEIPT,
        finalContent: FINAL,
      },
    });
    expect(native.submitDelivery).toHaveBeenCalledTimes(1);
    expect(native.reconcileAttempt).not.toHaveBeenCalled();
    expect(fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)).toMatchObject({
      state: "settled",
      receiptDigest: RECEIPT,
      finalCandidate: { content: FINAL },
      terminal: { outcome: "completed" },
    });

    const freshHostProvider = fixture.provider({
      openNativeBinding: vi.fn(async () => {
        throw new Error("settled replay must not open a native Binding");
      }),
    });
    await expect(freshHostProvider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "settled",
      replayed: true,
    });
    expect(native.submitDelivery).toHaveBeenCalledTimes(1);

    await freshHostProvider.close();
    await provider.close();
    fixture.close();
  });

  it("rejects a task-stop-suppressed delivery before opening or touching a native Binding", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Suppress this delivery before adapter handoff.");
    expect(fixture.repositories.reliability.suppressUnhandedProviderEffectIntents({
      taskId: intent.taskId,
      runId: intent.runId,
      logicalSessionId: intent.logicalSessionId,
      inputSubmissionIds: [intent.inputSubmissionId],
      suppressedAt: NOW,
    })).toEqual([intent.providerEffectIntentId]);
    const openNativeBinding = vi.fn(async () => fakeNativeBinding());
    const provider = fixture.provider({ openNativeBinding });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toEqual({
      disposition: "rejected",
      providerEffectIntentId: intent.providerEffectIntentId,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
      code: "acp_task_session_provider_effect_suppressed",
    });
    expect(openNativeBinding).not.toHaveBeenCalled();

    await provider.close();
    fixture.close();
  });

  it("commits and publishes the exact receipt before the native prompt settles", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Keep running after the receipt.");
    let resolveOutcome!: (outcome: AcpTaskSessionRuntimeNativeOutcome) => void;
    const outcome = new Promise<AcpTaskSessionRuntimeNativeOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let announceReceipt!: () => void;
    const receiptObserved = new Promise<void>((resolve) => {
      announceReceipt = resolve;
    });
    const onDeliveryReceipt = vi.fn(async (observation) => {
      expect(observation).toMatchObject({
        providerEffectIntentId: intent.providerEffectIntentId,
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        inputSubmissionId: intent.inputSubmissionId,
        orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
        bindingHandle: "binding_handle_codex_task",
        receiptDigest: RECEIPT,
      });
      expect(fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)).toMatchObject({
        receiptDigest: RECEIPT,
      });
      announceReceipt();
    });
    const provider = fixture.provider({
      onDeliveryReceipt,
      openNativeBinding: async ({ observeDeliveryReceipt }) => fakeNativeBinding({
        submitDelivery: async ({ bindingHandle, sessionExecutionAttemptId }) => {
          await observeDeliveryReceipt({
            bindingHandle,
            sessionExecutionAttemptId,
            receiptDigest: RECEIPT,
          });
          return outcome;
        },
      }),
    });

    const pending = provider.executeProviderEffect(intent.providerEffectIntentId);
    await receiptObserved;
    expect(onDeliveryReceipt).toHaveBeenCalledTimes(1);
    expect(fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)?.settlement)
      .toBeUndefined();

    resolveOutcome(settledOutcome(intent.sessionExecutionAttemptId));
    await expect(pending).resolves.toMatchObject({ disposition: "settled" });
    expect(onDeliveryReceipt).toHaveBeenCalledTimes(1);

    await provider.close();
    fixture.close();
  });

  it("durably records an exact partial final before terminal and a fresh Host reconciles without resubmit", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Persist the final candidate before terminal.");
    let finishOriginal!: (outcome: AcpTaskSessionRuntimeNativeOutcome) => void;
    const originalOutcome = new Promise<AcpTaskSessionRuntimeNativeOutcome>((resolve) => {
      finishOriginal = resolve;
    });
    let announceCandidate!: () => void;
    const candidateCommitted = new Promise<void>((resolve) => {
      announceCandidate = resolve;
    });
    let originalNative!: AcpTaskSessionRuntimeNativeBinding;
    const originalProvider = fixture.provider({
      openNativeBinding: async ({ observeDeliveryReceipt, observeFinalCandidate }) => {
        originalNative = fakeNativeBinding({
          submitDelivery: async ({ bindingHandle, sessionExecutionAttemptId }) => {
            await observeDeliveryReceipt({ bindingHandle, sessionExecutionAttemptId, receiptDigest: RECEIPT });
            const observation = {
              bindingHandle,
              sessionExecutionAttemptId,
              receiptDigest: RECEIPT,
              candidateObservationId: `provider_fact_candidate_${sessionExecutionAttemptId}`,
              content: FINAL,
              contentDigest: hashDefinition(FINAL),
            };
            await observeFinalCandidate(observation);
            expect(fixture.repositories.sessionRuntime.getAttempt(sessionExecutionAttemptId)).toMatchObject({
              state: "candidate_observed",
              receiptDigest: RECEIPT,
              finalCandidate: {
                candidateObservationId: observation.candidateObservationId,
                content: FINAL,
                contentDigest: hashDefinition(FINAL),
              },
            });
            await observeFinalCandidate(observation);
            const conflictingContent = "A conflicting candidate must fail closed.";
            await expect(observeFinalCandidate({
              ...observation,
              content: conflictingContent,
              contentDigest: hashDefinition(conflictingContent),
            })).rejects.toMatchObject({ code: "acp_task_session_final_candidate_conflict" });
            announceCandidate();
            return originalOutcome;
          },
        });
        return originalNative;
      },
    });

    const interruptedExecution = originalProvider.executeProviderEffect(intent.providerEffectIntentId);
    await candidateCommitted;

    const recoveredNative = fakeNativeBinding({
      reconcileAttempt: async ({ sessionExecutionAttemptId }) => settledOutcome(sessionExecutionAttemptId),
    });
    const recoveredProvider = fixture.provider({ openNativeBinding: async () => recoveredNative });
    await expect(recoveredProvider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "settled",
      replayed: false,
      settlement: { outcome: "completed", finalContent: FINAL },
    });
    expect(recoveredNative.submitDelivery).not.toHaveBeenCalled();
    expect(recoveredNative.reconcileAttempt).toHaveBeenCalledTimes(1);

    finishOriginal(reconcilingOutcome(intent.sessionExecutionAttemptId));
    await expect(interruptedExecution).resolves.toMatchObject({ disposition: "reconciling" });
    await recoveredProvider.close();
    await originalProvider.close();
    fixture.close();
  });

  it("marks the Attempt reconciling before submit and a fresh Host only reconciles an unknown outcome", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Do not duplicate this prompt.");
    const firstNative = fakeNativeBinding({
      submitDelivery: async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId),
    });
    const firstProvider = fixture.provider({
      openNativeBinding: async () => {
        expect(fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)?.state)
          .toBe("reconciling");
        return firstNative;
      },
    });

    await expect(firstProvider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
      reason: "native_outcome_unknown",
    });
    expect(fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)?.state)
      .toBe("reconciling");
    expect(firstNative.submitDelivery).toHaveBeenCalledTimes(1);
    await firstProvider.close();

    const recoveredNative = fakeNativeBinding({
      reconcileAttempt: async ({ sessionExecutionAttemptId }) => settledOutcome(sessionExecutionAttemptId),
    });
    const recoveredProvider = fixture.provider({ openNativeBinding: async () => recoveredNative });
    await expect(recoveredProvider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "settled",
      replayed: false,
    });
    expect(recoveredNative.submitDelivery).not.toHaveBeenCalled();
    expect(recoveredNative.reconcileAttempt).toHaveBeenCalledTimes(1);

    await recoveredProvider.close();
    fixture.close();
  });

  it("fails a conflicting receipt through the SR owner instead of converting it to transport ambiguity", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Reconcile one exact receipt.");
    const attempt = fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)!;
    fixture.owner.handleDeliveryReceipt({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      receiptDigest: `sha256:${"b".repeat(64)}`,
    });
    const native = fakeNativeBinding({
      reconcileAttempt: async ({ sessionExecutionAttemptId }) => settledOutcome(sessionExecutionAttemptId),
    });
    const provider = fixture.provider({ openNativeBinding: async () => native });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).rejects.toMatchObject({
      code: "acp_task_session_observation_conflict",
    });
    expect(native.submitDelivery).not.toHaveBeenCalled();
    expect(native.reconcileAttempt).toHaveBeenCalledTimes(1);
    const persisted = fixture.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId)!;
    expect(persisted).toMatchObject({
      state: "reconciling",
      receiptDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(persisted.finalCandidate).toBeUndefined();
    expect(persisted.terminal).toBeUndefined();

    await provider.close();
    fixture.close();
  });

  it("fails the exact current Binding and frozen Profile fences before any native effect", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Fence this effect.");
    fixture.setFrozenProfile(undefined);
    const openNativeBinding = vi.fn(async () => fakeNativeBinding());
    const provider = fixture.provider({ openNativeBinding });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).rejects.toMatchObject({
      code: "acp_task_session_frozen_profile_missing",
    });
    expect(openNativeBinding).not.toHaveBeenCalled();

    fixture.setFrozenProfile(PROFILE);
    const current = fixture.repositories.binding.getCurrentBinding("logical_session_codex_task")!;
    fixture.repositories.binding.updateBinding({
      ...current,
      status: "recovering",
      revision: 2,
      updatedAt: "2026-08-12T00:00:01.000Z",
    }, 1);
    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).rejects.toMatchObject({
      code: "acp_task_session_binding_revision_stale",
    });
    expect(openNativeBinding).not.toHaveBeenCalled();

    await provider.close();
    fixture.close();
  });

  it("reports a safe post-open execution-fence drift without weakening the fence", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Fence the post-open native submit.");
    const diagnostics: Array<Readonly<{ code: string; stage: string }>> = [];
    const native = fakeNativeBinding();
    const provider = fixture.provider({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      openNativeBinding: vi.fn(async () => {
        const current = fixture.repositories.binding.getCurrentBinding(intent.logicalSessionId)!;
        fixture.repositories.binding.updateBinding({
          ...current,
          revision: current.revision + 1,
          updatedAt: "2026-08-12T00:00:01.000Z",
        }, current.revision);
        return native;
      }),
    });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).rejects.toMatchObject({
      code: "acp_task_session_binding_revision_stale",
    });
    expect(native.submitDelivery).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      { code: "acp_task_session_native_open_started", stage: "native_open" },
      { code: "acp_task_session_native_open_available", stage: "native_open" },
      { code: "acp_task_session_binding_revision_stale", stage: "native_effect_fence" },
    ]);

    await provider.close();
    fixture.close();
  });

  it("requires exact durable control/Attempt/Turn correlation and never repeats one native interrupt", async () => {
    const fixture = createFixture();
    const submitIntent = fixture.stageSubmit("Remain ambiguous while an interrupt is correlated.");
    let resolveSubmit!: (outcome: AcpTaskSessionRuntimeNativeOutcome) => void;
    let announceSubmit!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      announceSubmit = resolve;
    });
    const submitOutcome = new Promise<AcpTaskSessionRuntimeNativeOutcome>((resolve) => {
      resolveSubmit = resolve;
    });
    const native = fakeNativeBinding({
      submitDelivery: async () => {
        announceSubmit();
        return submitOutcome;
      },
      requestInterrupt: async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId),
    });
    const provider = fixture.provider({ openNativeBinding: async () => native });
    const pendingSubmit = provider.executeProviderEffect(submitIntent.providerEffectIntentId);
    await submitStarted;

    const interruptIntent = fixture.stageInterrupt(
      submitIntent.sessionExecutionAttemptId,
      "session_control_codex_task_1",
    );
    fixture.setInterruptCorrelation(undefined);
    await expect(provider.executeProviderEffect(interruptIntent.providerEffectIntentId)).resolves.toEqual({
      disposition: "rejected",
      providerEffectIntentId: interruptIntent.providerEffectIntentId,
      sessionExecutionAttemptId: interruptIntent.sessionExecutionAttemptId,
      code: "acp_task_session_interrupt_correlation_missing",
    });
    expect(native.requestInterrupt).not.toHaveBeenCalled();

    fixture.setInterruptCorrelation(Object.freeze({
      sessionControlAuditId: interruptIntent.sessionControlAuditId!,
      sessionExecutionAttemptId: interruptIntent.sessionExecutionAttemptId,
      orchestrationSessionTurnId: interruptIntent.orchestrationSessionTurnId,
    }));
    await expect(provider.executeProviderEffect(interruptIntent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
      reason: "native_outcome_unknown",
    });
    await expect(provider.executeProviderEffect(interruptIntent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
    });
    expect(native.requestInterrupt).toHaveBeenCalledTimes(1);

    resolveSubmit(reconcilingOutcome(submitIntent.sessionExecutionAttemptId));
    await pendingSubmit;

    await provider.close();

    // A fresh Host may safely rebuild/load the same Binding to reconcile the
    // durable Attempt. That does not prove ownership of the old prompt lease,
    // so replaying the durable Control must never dispatch a second cancel.
    const freshNative = fakeNativeBinding();
    const freshProvider = fixture.provider({ openNativeBinding: async () => freshNative });
    await expect(freshProvider.executeProviderEffect(submitIntent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
    });
    await expect(freshProvider.executeProviderEffect(interruptIntent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
      reason: "interrupt_native_binding_not_active",
    });
    expect(freshNative.requestInterrupt).not.toHaveBeenCalled();

    await freshProvider.close();
    fixture.close();
  });

  it("makes a failed native cleanup sticky while still attempting every cleanup step", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Exercise sticky cleanup.");
    const native = fakeNativeBinding({
      submitDelivery: async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId),
      retire: async () => {
        throw new Error("controlled retire rejection");
      },
    });
    const provider = fixture.provider({ openNativeBinding: async () => native });
    await provider.executeProviderEffect(intent.providerEffectIntentId);

    await expect(provider.close()).rejects.toMatchObject({
      code: "acp_task_session_cleanup_unconfirmed",
    });
    expect(native.retire).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);
    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).rejects.toMatchObject({
      code: "acp_task_session_cleanup_unconfirmed",
    });
    await expect(provider.close()).rejects.toMatchObject({
      code: "acp_task_session_cleanup_unconfirmed",
    });
    fixture.close();
  });

  it("retires an idle current Binding only after its durable intent and exact task_stop Control exist", async () => {
    const fixture = createFixture();
    const intent = fixture.stageRetirement();
    const native = fakeNativeBinding();
    const openNativeBinding = vi.fn(async ({ observeDeliveryReceipt }) => {
      expect(fixture.repositories.reliability.getBindingRetirementIntent(intent.bindingRetirementIntentId))
        .toMatchObject({ state: "retiring", attempts: 1 });
      await expect(observeDeliveryReceipt({
        bindingHandle: intent.bindingHandle,
        sessionExecutionAttemptId: "session_execution_attempt_forbidden",
        receiptDigest: RECEIPT,
      })).rejects.toMatchObject({ code: "acp_task_session_retirement_receipt_forbidden" });
      return native;
    });
    const provider = fixture.provider({ openNativeBinding });

    await expect(provider.retireBinding(intent.bindingRetirementIntentId)).resolves.toEqual({
      disposition: "released",
      bindingRetirementIntentId: intent.bindingRetirementIntentId,
      bindingId: intent.bindingId,
      replayed: false,
    });
    expect(openNativeBinding).toHaveBeenCalledTimes(1);
    expect(native.retire).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(fixture.repositories.binding.getCurrentBinding(intent.logicalSessionId)).toBeUndefined();
    expect(fixture.repositories.binding.getBinding(intent.bindingId)).toMatchObject({
      status: "released",
      recoverable: false,
      revision: 2,
    });
    expect(fixture.repositories.reliability.getBindingRetirementIntent(intent.bindingRetirementIntentId))
      .toMatchObject({ state: "released", attempts: 1, revision: 3 });

    const replay = fixture.provider({
      openNativeBinding: vi.fn(async () => { throw new Error("released replay cannot open native Binding"); }),
      resolveTaskStopControl: () => undefined,
    });
    await expect(replay.retireBinding(intent.bindingRetirementIntentId)).resolves.toMatchObject({
      disposition: "released",
      replayed: true,
    });
    expect(native.retire).toHaveBeenCalledTimes(1);
    await replay.close();
    await provider.close();
    fixture.close();
  });

  it("retires for close only through the close-specific Control resolver and method", async () => {
    const fixture = createFixture();
    const intent = fixture.stageRetirement();
    const native = fakeNativeBinding();
    const openNativeBinding = vi.fn(async () => native);
    const resolveCloseControl = vi.fn(() => Object.freeze({
      kind: "close" as const,
      state: "requested" as const,
    }));
    const provider = fixture.provider({
      openNativeBinding,
      resolveTaskStopControl: () => undefined,
      resolveCloseControl,
    }) as ReturnType<typeof createAcpTaskSessionRuntimeProvider> & Readonly<{
      retireBindingForClose(bindingRetirementIntentId: string): Promise<unknown>;
    }>;

    await expect(provider.retireBinding(intent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_task_stop_control_not_current",
    });
    await expect(provider.retireBindingForClose(intent.bindingRetirementIntentId)).resolves.toMatchObject({
      disposition: "released",
      bindingRetirementIntentId: intent.bindingRetirementIntentId,
      replayed: false,
    });
    expect(openNativeBinding).toHaveBeenCalledTimes(1);
    expect(native.retire).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(resolveCloseControl).toHaveBeenCalledTimes(2);
    expect(resolveCloseControl).toHaveBeenNthCalledWith(1, {
      taskId: intent.taskId,
      runId: intent.runId,
      logicalSessionId: intent.logicalSessionId,
      sessionControlAuditId: intent.sessionControlAuditId,
      idempotencyKey: intent.idempotencyKey,
      bindingId: intent.bindingId,
      bindingRevision: intent.bindingRevision,
      executionProfileId: intent.executionProfileId,
      profileRevisionId: intent.profileRevisionId,
      providerFamily: intent.providerFamily,
    });
    await provider.close();
    fixture.close();
  });

  it("does not self-deadlock a Card close behind an in-flight effect for another Binding", async () => {
    const fixture = createFixture();
    const unrelated = fixture.stageUnrelatedSubmit("Keep the Conductor effect in flight.");
    const retirement = fixture.stageRetirement();
    let releaseUnrelated!: () => void;
    const unrelatedGate = new Promise<void>((resolve) => { releaseUnrelated = resolve; });
    const unrelatedNative = fakeNativeBinding({
      bindingHandle: unrelated.effect.bindingHandle,
      submitDelivery: async ({ sessionExecutionAttemptId }) => {
        await unrelatedGate;
        return Object.freeze({
          status: "reconciling" as const,
          bindingHandle: unrelated.effect.bindingHandle,
          sessionExecutionAttemptId,
          reason: "provider_outcome_unknown" as const,
        });
      },
    });
    const retiredNative = fakeNativeBinding();
    const provider = fixture.provider({
      openNativeBinding: async ({ binding }) => binding.bindingHandle === unrelated.effect.bindingHandle
        ? unrelatedNative
        : retiredNative,
      resolveTaskStopControl: () => undefined,
      resolveCloseControl: () => Object.freeze({ kind: "close" as const, state: "requested" as const }),
    });

    const unrelatedExecution = provider.executeProviderEffect(unrelated.providerEffectIntentId);
    await vi.waitFor(() => expect(unrelatedNative.submitDelivery).toHaveBeenCalledTimes(1));
    const retirementExecution = provider.retireBindingForClose(retirement.bindingRetirementIntentId);
    const first = await Promise.race([
      retirementExecution.then(() => "retired" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 20)),
    ]);
    releaseUnrelated();
    await unrelatedExecution;
    await retirementExecution;

    expect(first).toBe("retired");
    expect(retiredNative.retire).toHaveBeenCalledTimes(1);
    await provider.close();
    fixture.close();
  });

  it("rejects stale task_stop Control before claim or native effect", async () => {
    const fixture = createFixture();
    const intent = fixture.stageRetirement();
    const openNativeBinding = vi.fn(async () => fakeNativeBinding());
    const provider = fixture.provider({
      openNativeBinding,
      resolveTaskStopControl: () => undefined,
    });
    await expect(provider.retireBinding(intent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_task_stop_control_not_current",
    });
    expect(openNativeBinding).not.toHaveBeenCalled();
    expect(fixture.repositories.reliability.getBindingRetirementIntent(intent.bindingRetirementIntentId))
      .toMatchObject({ state: "pending", attempts: 0, revision: 1 });
    await provider.close();
    fixture.close();
  });

  it("rechecks current Binding revision and frozen Profile before retirement effect", async () => {
    const staleBinding = createFixture();
    const bindingIntent = staleBinding.stageRetirement();
    const current = staleBinding.repositories.binding.getCurrentBinding(bindingIntent.logicalSessionId)!;
    staleBinding.repositories.binding.updateBinding({
      ...current,
      status: "recovering",
      revision: 2,
      updatedAt: "2026-08-12T00:00:01.000Z",
    }, 1);
    const bindingOpen = vi.fn(async () => fakeNativeBinding());
    const bindingProvider = staleBinding.provider({ openNativeBinding: bindingOpen });
    await expect(bindingProvider.retireBinding(bindingIntent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_binding_revision_stale",
    });
    expect(bindingOpen).not.toHaveBeenCalled();
    expect(staleBinding.repositories.reliability.getBindingRetirementIntent(bindingIntent.bindingRetirementIntentId))
      .toMatchObject({ state: "pending" });
    await bindingProvider.close();
    staleBinding.close();

    const staleProfile = createFixture();
    const profileIntent = staleProfile.stageRetirement();
    staleProfile.setFrozenProfile(undefined);
    const profileOpen = vi.fn(async () => fakeNativeBinding());
    const profileProvider = staleProfile.provider({ openNativeBinding: profileOpen });
    await expect(profileProvider.retireBinding(profileIntent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_frozen_profile_mismatch",
    });
    expect(profileOpen).not.toHaveBeenCalled();
    expect(staleProfile.repositories.reliability.getBindingRetirementIntent(profileIntent.bindingRetirementIntentId))
      .toMatchObject({ state: "pending" });
    await profileProvider.close();
    staleProfile.close();
  });

  it("keeps an unconfirmed retirement unknown/current and permits retiring recovery only with confirmed-dead authority", async () => {
    const failed = createFixture();
    const failedIntent = failed.stageRetirement();
    const failedNative = fakeNativeBinding({
      retire: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("controlled retirement timeout")), { once: true });
      }),
    });
    const failedProvider = failed.provider({
      openNativeBinding: async () => failedNative,
      effectDeadlineMs: 5,
    });
    await expect(failedProvider.retireBinding(failedIntent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_cleanup_unconfirmed",
    });
    expect(failed.repositories.reliability.getBindingRetirementIntent(failedIntent.bindingRetirementIntentId))
      .toMatchObject({ state: "unknown", attempts: 1 });
    expect(failed.repositories.binding.getCurrentBinding(failedIntent.logicalSessionId)).toMatchObject({
      bindingId: failedIntent.bindingId,
      status: "active",
    });
    await expect(failedProvider.retireBinding(failedIntent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_cleanup_unconfirmed",
    });
    await expect(failedProvider.close()).resolves.toBeUndefined();
    failed.close();

    const recovering = createFixture();
    const recoveryIntent = recovering.stageRetirement();
    recovering.repositories.reliability.claimBindingRetirementIntent({
      bindingRetirementIntentId: recoveryIntent.bindingRetirementIntentId,
      expectedRevision: 1,
      mode: "initial",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });
    const deniedOpen = vi.fn(async () => fakeNativeBinding());
    const denied = recovering.provider({ openNativeBinding: deniedOpen });
    await expect(denied.retireBinding(recoveryIntent.bindingRetirementIntentId)).rejects.toMatchObject({
      code: "acp_task_session_binding_retirement_in_progress",
    });
    expect(deniedOpen).not.toHaveBeenCalled();
    await denied.close();

    const recoveredNative = fakeNativeBinding();
    const recovered = recovering.provider({
      openNativeBinding: async () => recoveredNative,
      authorizeRetiringBindingRecovery: () => true,
    });
    await expect(recovered.retireBinding(recoveryIntent.bindingRetirementIntentId)).resolves.toMatchObject({
      disposition: "released",
      replayed: false,
    });
    expect(recoveredNative.retire).toHaveBeenCalledTimes(1);
    expect(recovering.repositories.reliability.getBindingRetirementIntent(recoveryIntent.bindingRetirementIntentId))
      .toMatchObject({ state: "released", attempts: 2 });
    await recovered.close();
    recovering.close();
  });

  it("bounds a hung effect, aborts it, reconciles, and confirms native cleanup", async () => {
    const fixture = createFixture();
    const intent = fixture.stageSubmit("Bound this native effect.");
    const native = fakeNativeBinding({
      submitDelivery: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("controlled abort")), { once: true });
      }),
    });
    const provider = fixture.provider({
      openNativeBinding: async () => native,
      effectDeadlineMs: 5,
    });

    await expect(provider.executeProviderEffect(intent.providerEffectIntentId)).resolves.toMatchObject({
      disposition: "reconciling",
      reason: "native_effect_timeout",
    });
    expect(native.cancelTimedOutEffect).toHaveBeenCalledTimes(1);
    expect(native.reconcileAttempt).toHaveBeenCalledTimes(1);
    expect(native.retire).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(1);

    await provider.close();
    fixture.close();
  });

  it("exposes only typed safe errors and drops dependency exception details", async () => {
    expect(new AcpTaskSessionRuntimeProviderError("acp_task_session_test_error"))
      .toMatchObject({ name: "AcpTaskSessionRuntimeProviderError", code: "acp_task_session_test_error" });

    const fixture = createFixture();
    const intent = fixture.stageSubmit("Do not expose dependency errors.");
    const privateDetail = "/private/provider/path credential=controlled-secret";
    const provider = createAcpTaskSessionRuntimeProvider({
      repositories: fixture.repositories,
      sessionRuntimeOwner: fixture.owner,
      resolveFrozenProfileTuple: () => {
        throw new Error(privateDetail);
      },
      resolveInterruptCorrelation: () => undefined,
      onDeliveryReceipt: async () => undefined,
      openNativeBinding: async () => fakeNativeBinding(),
      effectDeadlineMs: 1_000,
    });
    let observed: unknown;
    try {
      await provider.executeProviderEffect(intent.providerEffectIntentId);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AcpTaskSessionRuntimeProviderError);
    expect(observed).toMatchObject({ code: "acp_task_session_frozen_profile_read_failed" });
    expect(String(observed)).not.toContain(privateDetail);
    expect((observed as Error).stack).not.toContain(privateDetail);

    await provider.close();
    fixture.close();
  });
});

type InterruptCorrelation = Readonly<{
  sessionControlAuditId: string;
  sessionExecutionAttemptId: string;
  orchestrationSessionTurnId: string;
}>;

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-task-provider-"));
  temporaryDirectories.push(directory);
  const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite"), now: () => NOW });
  seedCanonicalSession(store);
  let frozenProfile: AcpV3FrozenProfileTuple | undefined = PROFILE;
  let interruptCorrelation: InterruptCorrelation | undefined;
  const resolveFrozenProfileTuple = () => frozenProfile;
  const repositories = createAcpSessionRuntimeRepositories(store, { resolveFrozenProfileTuple });
  repositories.binding.createBinding(bindingRecord(), { makeCurrent: true });
  let attemptSequence = 0;
  let effectSequence = 0;
  let commandSequence = 0;
  let runtimeSequence = 0;
  const owner = createSessionExecutionRuntimeOwner({
    repository: sessionExecutionRepository(repositories),
    commandTransaction: sessionRuntimeCommandTransaction(repositories),
    now: () => NOW,
    createRuntimeId: () => ++runtimeSequence === 1
      ? "session_execution_runtime_codex_task"
      : `session_execution_runtime_codex_task_${runtimeSequence}`,
    createAttemptId: () => `session_execution_attempt_codex_task_${++attemptSequence}`,
    createProviderEffectIntentId: () => `provider_effect_codex_task_${++effectSequence}`,
  });
  const runtime = owner.ensureRuntime({
    taskId: "task_codex_task",
    runId: "run_codex_task",
    logicalSessionId: "logical_session_codex_task",
  });

  const stageSubmit = (content: string) => {
    commandSequence += 1;
    const latestRuntime = repositories.sessionRuntime.getRuntime(runtime.sessionExecutionRuntimeId)!;
    const execution = owner.executeCommand({
      type: "session_runtime.submit_delivery",
      commandId: `command_codex_task_submit_${commandSequence}`,
      idempotencyKey: `codex-task-submit:${commandSequence}`,
      taskId: "task_codex_task",
      runId: "run_codex_task",
      logicalSessionId: "logical_session_codex_task",
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: latestRuntime.revision,
      bindingId: "binding_codex_task",
      bindingRevision: 1,
      executionProfileId: PROFILE.executionProfileId,
      profileRevisionId: PROFILE.profileRevisionId,
      bindingHandle: "binding_handle_codex_task",
      inputSubmissionId: `input_codex_task_${commandSequence}`,
      orchestrationSessionTurnId: `session_turn_codex_task_${commandSequence}`,
      content,
      contentDigest: hashDefinition(content),
    });
    return execution.intent;
  };

  const stageInterrupt = (sessionExecutionAttemptId: string, sessionControlAuditId: string) => {
    commandSequence += 1;
    const latestRuntime = repositories.sessionRuntime.getRuntime(runtime.sessionExecutionRuntimeId)!;
    const attempt = repositories.sessionRuntime.getAttempt(sessionExecutionAttemptId)!;
    const execution = owner.executeCommand({
      type: "session_runtime.request_interrupt",
      commandId: `command_codex_task_interrupt_${commandSequence}`,
      idempotencyKey: `codex-task-interrupt:${commandSequence}`,
      taskId: attempt.taskId,
      runId: attempt.runId,
      logicalSessionId: attempt.logicalSessionId,
      sessionExecutionRuntimeId: attempt.sessionExecutionRuntimeId,
      expectedRuntimeRevision: latestRuntime.revision,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
      bindingHandle: "binding_handle_codex_task",
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      inputSubmissionId: attempt.inputSubmissionId,
      orchestrationSessionTurnId: attempt.orchestrationSessionTurnId,
      sessionControlAuditId,
    });
    return execution.intent;
  };

  const stageUnrelatedSubmit = (content: string) => {
    store.run(
      `INSERT INTO session_id_card_session_slots(
         card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
         latest_generation, revision, created_at, updated_at
       ) VALUES ('card_session_slot_codex_conductor', 'task_codex_task', 'run_codex_task',
         'agent_card_codex_conductor', 'logical_session_codex_conductor', 1, 1, ?, ?)`,
      NOW,
      NOW,
    );
    store.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES ('logical_session_codex_conductor', 'card_session_slot_codex_conductor',
         'task_codex_task', 'run_codex_task', 'card', 3, 'agent_card_codex_conductor',
         'profile_codex_task', 'profile_revision_codex_task', 1, 'current', ?)`,
      NOW,
    );
    const unrelatedBinding = Object.freeze({
      ...bindingRecord(),
      bindingId: "binding_codex_conductor",
      logicalSessionId: "logical_session_codex_conductor",
      agentCardId: "agent_card_codex_conductor",
      bindingHandle: "binding_handle_codex_conductor",
    });
    repositories.binding.createBinding(unrelatedBinding, { makeCurrent: true });
    const unrelatedRuntime = owner.ensureRuntime({
      taskId: "task_codex_task",
      runId: "run_codex_task",
      logicalSessionId: unrelatedBinding.logicalSessionId,
    });
    commandSequence += 1;
    return owner.executeCommand({
      type: "session_runtime.submit_delivery",
      commandId: `command_codex_task_submit_${commandSequence}`,
      idempotencyKey: `codex-task-submit:${commandSequence}`,
      taskId: "task_codex_task",
      runId: "run_codex_task",
      logicalSessionId: unrelatedBinding.logicalSessionId,
      sessionExecutionRuntimeId: unrelatedRuntime.sessionExecutionRuntimeId,
      expectedRuntimeRevision: unrelatedRuntime.revision,
      bindingId: unrelatedBinding.bindingId,
      bindingRevision: unrelatedBinding.revision,
      executionProfileId: unrelatedBinding.executionProfileId,
      profileRevisionId: unrelatedBinding.profileRevisionId,
      bindingHandle: unrelatedBinding.bindingHandle,
      inputSubmissionId: `input_codex_task_${commandSequence}`,
      orchestrationSessionTurnId: `session_turn_codex_task_${commandSequence}`,
      content,
      contentDigest: hashDefinition(content),
    }).intent;
  };

  const stageRetirement = (): AcpV3BindingRetirementIntentRecord => {
    const intent: AcpV3BindingRetirementIntentRecord = {
      bindingRetirementIntentId: "binding_retirement_codex_task",
      commandId: "command_retire-codex-task",
      idempotencyKey: "task-stop:codex-task",
      taskId: "task_codex_task",
      runId: "run_codex_task",
      logicalSessionId: "logical_session_codex_task",
      bindingId: "binding_codex_task",
      bindingRevision: 1,
      bindingHandle: "binding_handle_codex_task",
      executionProfileId: PROFILE.executionProfileId,
      profileRevisionId: PROFILE.profileRevisionId,
      providerFamily: PROFILE.providerFamily,
      sessionControlAuditId: "session_control_task-stop-codex-task",
      state: "pending",
      attempts: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return repositories.reliability.createBindingRetirementIntent(intent);
  };

  return Object.freeze({
    repositories,
    owner,
    stageSubmit,
    stageUnrelatedSubmit,
    stageInterrupt,
    stageRetirement,
    setFrozenProfile(value: AcpV3FrozenProfileTuple | undefined) {
      frozenProfile = value;
    },
    setInterruptCorrelation(value: InterruptCorrelation | undefined) {
      interruptCorrelation = value;
    },
    provider(input: Readonly<{
      openNativeBinding: Parameters<typeof createAcpTaskSessionRuntimeProvider>[0]["openNativeBinding"];
      effectDeadlineMs?: number;
      onDeliveryReceipt?: Parameters<typeof createAcpTaskSessionRuntimeProvider>[0]["onDeliveryReceipt"];
      resolveTaskStopControl?: Parameters<typeof createAcpTaskSessionRuntimeProvider>[0]["resolveTaskStopControl"];
      resolveCloseControl?: (scope: Readonly<{
        taskId: string;
        runId: string;
        logicalSessionId: string;
        sessionControlAuditId: string;
        idempotencyKey: string;
        bindingId: string;
        bindingRevision: number;
        executionProfileId: string;
        profileRevisionId: string;
        providerFamily: string;
      }>) => Readonly<{ kind: "close"; state: "requested" }> | undefined;
      authorizeRetiringBindingRecovery?: Parameters<typeof createAcpTaskSessionRuntimeProvider>[0]["authorizeRetiringBindingRecovery"];
      onDiagnostic?: Parameters<typeof createAcpTaskSessionRuntimeProvider>[0]["onDiagnostic"];
    }>) {
      const providerOptions = {
        repositories,
        sessionRuntimeOwner: owner,
        resolveFrozenProfileTuple,
        resolveInterruptCorrelation: () => interruptCorrelation,
        onDeliveryReceipt: input.onDeliveryReceipt ?? (async () => undefined),
        openNativeBinding: input.openNativeBinding,
        resolveTaskStopControl: input.resolveTaskStopControl
          ?? (() => Object.freeze({ kind: "task_stop" as const, state: "requested" as const })),
        resolveCloseControl: input.resolveCloseControl,
        authorizeRetiringBindingRecovery: input.authorizeRetiringBindingRecovery,
        now: () => NOW,
        effectDeadlineMs: input.effectDeadlineMs ?? 1_000,
        onDiagnostic: input.onDiagnostic,
      };
      return createAcpTaskSessionRuntimeProvider(providerOptions);
    },
    close() {
      store.close();
    },
  });
}

function fakeNativeBinding(overrides: Partial<AcpTaskSessionRuntimeNativeBinding> = {}): AcpTaskSessionRuntimeNativeBinding {
  return Object.freeze({
    bindingHandle: overrides.bindingHandle ?? "binding_handle_codex_task",
    submitDelivery: vi.fn(overrides.submitDelivery
      ?? (async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId))),
    reconcileAttempt: vi.fn(overrides.reconcileAttempt
      ?? (async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId))),
    requestInterrupt: vi.fn(overrides.requestInterrupt
      ?? (async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId))),
    respondInteraction: vi.fn(overrides.respondInteraction
      ?? (async ({ sessionExecutionAttemptId }) => reconcilingOutcome(sessionExecutionAttemptId))),
    cancelTimedOutEffect: vi.fn(overrides.cancelTimedOutEffect ?? (async () => undefined)),
    retire: vi.fn(overrides.retire ?? (async () => undefined)),
    close: vi.fn(overrides.close ?? (async () => undefined)),
  });
}

function settledOutcome(sessionExecutionAttemptId: string): AcpTaskSessionRuntimeNativeOutcome {
  return Object.freeze({
    status: "settled",
    bindingHandle: "binding_handle_codex_task",
    sessionExecutionAttemptId,
    receiptDigest: RECEIPT,
    finalCandidate: Object.freeze({
      candidateObservationId: `provider_fact_candidate_${sessionExecutionAttemptId}`,
      content: FINAL,
      contentDigest: hashDefinition(FINAL),
    }),
    terminal: Object.freeze({
      terminalObservationId: `provider_fact_terminal_${sessionExecutionAttemptId}`,
      outcome: "completed",
      receiptDigest: RECEIPT,
    }),
  });
}

function reconcilingOutcome(sessionExecutionAttemptId: string): AcpTaskSessionRuntimeNativeOutcome {
  return Object.freeze({
    status: "reconciling",
    bindingHandle: "binding_handle_codex_task",
    sessionExecutionAttemptId,
    reason: "provider_outcome_unknown",
  });
}

function sessionExecutionRepository(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    ...sessionExecutionRecords(repositories.sessionRuntime),
    transaction<T>(work: (records: ReturnType<typeof sessionExecutionRecords>) => T): T {
      return repositories.transaction(({ sessionRuntime }) => work(sessionExecutionRecords(sessionRuntime)));
    },
  });
}

function sessionExecutionRecords(repository: AcpV3SessionRuntimeRepository) {
  return Object.freeze({
    findRuntimeByLogicalSessionId: repository.getRuntimeForSession,
    getRuntime: repository.getRuntime,
    insertRuntime: repository.createRuntime,
    updateRuntime: repository.updateRuntime,
    getAttempt: repository.getAttempt,
    insertAttempt: repository.createAttempt,
    updateAttempt: repository.updateAttempt,
  });
}

function sessionRuntimeCommandTransaction(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    run<T>(work: (owners: Readonly<{
      sessionExecution: ReturnType<typeof sessionExecutionRecords>;
      providerEffects: Readonly<{
        findByCommandId(commandId: string): ReturnType<AcpSessionRuntimeRepositories["reliability"]["getProviderEffectIntent"]>;
        findByIdempotencyKey(idempotencyKey: string): ReturnType<AcpSessionRuntimeRepositories["reliability"]["getProviderEffectIntent"]>;
        insert(intent: Parameters<AcpSessionRuntimeRepositories["reliability"]["createProviderEffectIntent"]>[0]): void;
      }>;
    }>) => T): T {
      return repositories.transaction(({ sessionRuntime, reliability }) => work({
        sessionExecution: sessionExecutionRecords(sessionRuntime),
        providerEffects: {
          findByCommandId: (commandId) => reliability.listProviderEffectIntents()
            .find((intent) => intent.commandId === commandId),
          findByIdempotencyKey: (idempotencyKey) => reliability.listProviderEffectIntents()
            .find((intent) => intent.idempotencyKey === idempotencyKey),
          insert: (intent) => { reliability.createProviderEffectIntent(intent); },
        },
      }));
    },
  });
}

function seedCanonicalSession(store: SqliteRuntimeStore): void {
  store.run(
    `INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
     VALUES ('template_codex_task', 'codex-task', 'Codex Task', 'active', 1, ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO template_versions(
       template_version_id, template_id, version, schema_version, definition_json,
       definition_hash, asset_manifest_hash, created_at, published_at
     ) VALUES ('template_version_codex_task', 'template_codex_task', 1, 3, '{}',
       'sha256:codex-task', 'sha256:empty', ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO task_architecture_snapshots(
       architecture_snapshot_id, task_id, template_id, template_version_id,
       template_definition_hash, definition_json, workspace_json, created_at
     ) VALUES ('architecture_codex_task', 'task_codex_task', 'template_codex_task',
       'template_version_codex_task', 'sha256:codex-task', '{}',
       '{"workspaceId":"workspace_codex_task"}', ?)`,
    NOW,
  );
  store.run(
    `INSERT INTO tasks(
       task_id, architecture_snapshot_id, title, goal, status, active_run_id,
       revision, created_at, updated_at
     ) VALUES ('task_codex_task', 'architecture_codex_task', 'Codex Task', 'Use ACP safely.',
       'running', 'run_codex_task', 1, ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO task_runs(
       run_id, task_id, conductor_logical_session_id, status, run_number,
       revision, started_at
     ) VALUES ('run_codex_task', 'task_codex_task', 'logical_session_codex_task',
       'running', 1, 1, ?)`,
    NOW,
  );
  store.run(
    `INSERT INTO session_id_card_session_slots(
       card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
       latest_generation, revision, created_at, updated_at
     ) VALUES ('card_session_slot_codex_task', 'task_codex_task', 'run_codex_task',
       'agent_card_codex_task', 'logical_session_codex_task', 1, 1, ?, ?)`,
    NOW,
    NOW,
  );
  store.run(
    `INSERT INTO session_id_logical_sessions(
       session_id, card_session_slot_id, task_id, run_id, session_kind,
       architecture_schema_version, agent_card_id, execution_profile_id,
       profile_revision_id, generation, lifecycle, created_at
     ) VALUES ('logical_session_codex_task', 'card_session_slot_codex_task',
       'task_codex_task', 'run_codex_task', 'card', 3, 'agent_card_codex_task',
       'profile_codex_task', 'profile_revision_codex_task', 1, 'current', ?)`,
    NOW,
  );
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: "binding_codex_task",
    taskId: "task_codex_task",
    runId: "run_codex_task",
    logicalSessionId: "logical_session_codex_task",
    agentCardId: "agent_card_codex_task",
    executionProfileId: PROFILE.executionProfileId,
    profileRevisionId: PROFILE.profileRevisionId,
    providerFamily: "codex",
    bindingHandle: "binding_handle_codex_task",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
