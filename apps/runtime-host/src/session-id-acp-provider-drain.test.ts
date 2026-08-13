import {
  hashDefinition,
  type SessionExecutionSettlement,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdAcpEffectObservation,
} from "@agent-workspace/runtime-application";
import { describe, expect, it } from "vitest";
import type {
  AcpTaskSessionRuntimeProviderResult,
} from "./acp-task-session-runtime-provider.js";
import {
  createSessionIdAcpProviderDrain,
  SessionIdAcpProviderDrainError,
} from "./session-id-acp-provider-drain.js";

const NOW = "2026-08-12T10:00:00.000Z";

describe("Session-ID ACP provider drain", () => {
  it("commits completed, failed and cancelled settlements through the single result owner", async () => {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      const submit = intent("submit_delivery", `provider_effect_${outcome}`);
      const settlement = settled(submit, outcome);
      const fixture = drainFixture({ intents: [submit], result: providerSettled(submit, settlement) });

      await expect(fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId }))
        .resolves.toEqual({
          disposition: "settled",
          providerEffectIntentId: submit.providerEffectIntentId,
          sessionExecutionAttemptId: submit.sessionExecutionAttemptId,
          commandType: submit.commandType,
          reconciliationRequired: false,
        });
      expect(fixture.settlements).toEqual([settlement]);
      expect(fixture.observations).toEqual([]);
    }
  });

  it("maps delivery ambiguity and proven pre-receipt rejection to exact OR observations", async () => {
    const unknown = intent("submit_delivery", "provider_effect_submit_unknown");
    const unknownFixture = drainFixture({
      intents: [unknown],
      result: providerReconciling(unknown, "native_effect_timeout"),
    });
    await expect(unknownFixture.drain.drain({ providerEffectIntentId: unknown.providerEffectIntentId }))
      .resolves.toMatchObject({ disposition: "reconciling", reconciliationRequired: true });
    expect(unknownFixture.observations).toEqual([{
      kind: "delivery_unknown",
      providerEffectIntentId: unknown.providerEffectIntentId,
      sessionExecutionAttemptId: unknown.sessionExecutionAttemptId,
    }]);

    const rejected = intent("submit_delivery", "provider_effect_submit_rejected");
    const rejectedFixture = drainFixture({
      intents: [rejected],
      result: providerReconciling(rejected, "native_effect_rejected"),
    });
    await expect(rejectedFixture.drain.drain({ providerEffectIntentId: rejected.providerEffectIntentId }))
      .resolves.toMatchObject({ disposition: "rejected", reconciliationRequired: false });
    expect(rejectedFixture.observations).toEqual([{
      kind: "delivery_rejected",
      providerEffectIntentId: rejected.providerEffectIntentId,
      sessionExecutionAttemptId: rejected.sessionExecutionAttemptId,
    }]);
  });

  it("projects reconciliation and interaction ambiguity against the unique original delivery intent", async () => {
    for (const commandType of ["reconcile_attempt", "respond_interaction"] as const) {
      const submit = intent("submit_delivery", `provider_effect_original_${commandType}`);
      const followup = intent(commandType, `provider_effect_${commandType}`, submit);
      const fixture = drainFixture({
        intents: [submit, followup],
        result: providerReconciling(followup, "native_outcome_unknown"),
      });

      await expect(fixture.drain.drain({ providerEffectIntentId: followup.providerEffectIntentId }))
        .resolves.toMatchObject({ disposition: "reconciling", reconciliationRequired: true });
      expect(fixture.observations).toEqual([{
        kind: "delivery_unknown",
        providerEffectIntentId: submit.providerEffectIntentId,
        sessionExecutionAttemptId: submit.sessionExecutionAttemptId,
      }]);
    }
  });

  it("distinguishes accepted, unknown and rejected interrupt outcomes", async () => {
    const cases = [
      ["native_outcome_unknown", "interrupt_accepted", "reconciling", true],
      ["native_effect_failed", "interrupt_unknown", "reconciling", true],
      ["native_effect_timeout", "interrupt_unknown", "reconciling", true],
      ["interrupt_native_binding_not_active", "interrupt_unknown", "reconciling", true],
      ["native_effect_rejected", "interrupt_rejected", "rejected", false],
    ] as const;
    for (const [reason, kind, disposition, reconciliationRequired] of cases) {
      const submit = intent("submit_delivery", `provider_effect_submit_${reason}`);
      const interrupt = intent("request_interrupt", `provider_effect_interrupt_${reason}`, submit);
      const fixture = drainFixture({
        intents: [submit, interrupt],
        result: providerReconciling(interrupt, reason),
      });
      await expect(fixture.drain.drain({ providerEffectIntentId: interrupt.providerEffectIntentId }))
        .resolves.toMatchObject({ disposition, reconciliationRequired });
      expect(fixture.observations).toEqual([{
        kind,
        providerEffectIntentId: interrupt.providerEffectIntentId,
        sessionExecutionAttemptId: interrupt.sessionExecutionAttemptId,
      }]);
    }

    const submit = intent("submit_delivery", "provider_effect_submit_unsupported");
    const interrupt = intent("request_interrupt", "provider_effect_interrupt_unsupported", submit);
    const fixture = drainFixture({
      intents: [submit, interrupt],
      result: providerRejected(interrupt, "acp_task_session_interrupt_unsupported"),
    });
    await expect(fixture.drain.drain({ providerEffectIntentId: interrupt.providerEffectIntentId }))
      .resolves.toMatchObject({ disposition: "rejected", reconciliationRequired: false });
    expect(fixture.observations[0]).toMatchObject({ kind: "interrupt_rejected" });
  });

  it("single-flights exact drains and rejects result, attempt, and original-delivery ambiguity", async () => {
    const submit = intent("submit_delivery", "provider_effect_singleflight");
    let resolve!: (value: AcpTaskSessionRuntimeProviderResult) => void;
    const pending = new Promise<AcpTaskSessionRuntimeProviderResult>((done) => { resolve = done; });
    const fixture = drainFixture({ intents: [submit], result: pending });
    const first = fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId });
    const second = fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId });
    expect(fixture.providerCalls).toEqual([submit.providerEffectIntentId]);
    resolve(providerReconciling(submit, "native_outcome_unknown"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fixture.observations).toHaveLength(1);

    const mismatched = drainFixture({
      intents: [submit],
      result: providerReconciling({ ...submit, sessionExecutionAttemptId: "session_execution_attempt_other" },
        "native_outcome_unknown"),
    });
    await expect(mismatched.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId }))
      .rejects.toMatchObject({ code: "session_id_acp_provider_drain_result_scope_mismatch" });

    const reconcile = intent("reconcile_attempt", "provider_effect_reconcile_ambiguous", submit);
    const duplicate = { ...submit, providerEffectIntentId: "provider_effect_submit_duplicate" };
    const ambiguous = drainFixture({
      intents: [submit, duplicate, reconcile],
      result: providerReconciling(reconcile, "native_outcome_unknown"),
    });
    await expect(ambiguous.drain.drain({ providerEffectIntentId: reconcile.providerEffectIntentId }))
      .rejects.toMatchObject({ code: "session_id_acp_provider_drain_delivery_intent_ambiguous" });
  });

  it("serializes submit, reconcile, and interaction effects for one durable Attempt without mixing results", async () => {
    const submit = intent("submit_delivery", "provider_effect_serial_submit");
    const reconcile = intent("reconcile_attempt", "provider_effect_serial_reconcile", submit);
    const interaction = intent("respond_interaction", "provider_effect_serial_interaction", submit);
    const effects = [submit, reconcile, interaction];
    const gates = new Map(effects.map((effect) => [effect.providerEffectIntentId, deferred<void>()]));
    let active = 0;
    let maximumActive = 0;
    const fixture = drainFixture({
      intents: effects,
      result: async (providerEffectIntentId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates.get(providerEffectIntentId)!.promise;
        active -= 1;
        return providerReconciling(
          effects.find((effect) => effect.providerEffectIntentId === providerEffectIntentId)!,
          "native_outcome_unknown",
        );
      },
    });

    const submitDrain = fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId });
    const reconcileDrain = fixture.drain.drain({ providerEffectIntentId: reconcile.providerEffectIntentId });
    const interactionDrain = fixture.drain.drain({ providerEffectIntentId: interaction.providerEffectIntentId });
    expect(fixture.providerCalls).toEqual([submit.providerEffectIntentId]);
    expect(maximumActive).toBe(1);

    gates.get(submit.providerEffectIntentId)!.resolve();
    await submitDrain;
    await waitForCalls(fixture.providerCalls, 2);
    expect(fixture.providerCalls).toEqual([
      submit.providerEffectIntentId,
      reconcile.providerEffectIntentId,
    ]);
    gates.get(reconcile.providerEffectIntentId)!.resolve();
    await reconcileDrain;
    await waitForCalls(fixture.providerCalls, 3);
    gates.get(interaction.providerEffectIntentId)!.resolve();

    await expect(interactionDrain).resolves.toMatchObject({
      providerEffectIntentId: interaction.providerEffectIntentId,
      commandType: "session_runtime.respond_interaction",
    });
    expect(await submitDrain).toMatchObject({
      providerEffectIntentId: submit.providerEffectIntentId,
      commandType: "session_runtime.submit_delivery",
    });
    expect(await reconcileDrain).toMatchObject({
      providerEffectIntentId: reconcile.providerEffectIntentId,
      commandType: "session_runtime.reconcile_attempt",
    });
    expect(maximumActive).toBe(1);
  });

  it("allows different Attempts and an interrupt to overlap while exact interrupt replay stays single-flight", async () => {
    const submitA = withAttempt(
      intent("submit_delivery", "provider_effect_parallel_submit_a"),
      "session_execution_attempt_parallel_a",
    );
    const submitB = withAttempt(
      intent("submit_delivery", "provider_effect_parallel_submit_b"),
      "session_execution_attempt_parallel_b",
    );
    const interruptA = intent("request_interrupt", "provider_effect_parallel_interrupt_a", submitA);
    const effects = [submitA, submitB, interruptA];
    const gates = new Map(effects.map((effect) => [effect.providerEffectIntentId, deferred<void>()]));
    let active = 0;
    let maximumActive = 0;
    const fixture = drainFixture({
      intents: effects,
      result: async (providerEffectIntentId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates.get(providerEffectIntentId)!.promise;
        active -= 1;
        const effect = effects.find((candidate) =>
          candidate.providerEffectIntentId === providerEffectIntentId)!;
        return providerReconciling(effect, "native_outcome_unknown");
      },
    });

    const first = fixture.drain.drain({ providerEffectIntentId: submitA.providerEffectIntentId });
    const second = fixture.drain.drain({ providerEffectIntentId: submitB.providerEffectIntentId });
    const interruptFirst = fixture.drain.drain({ providerEffectIntentId: interruptA.providerEffectIntentId });
    const interruptReplay = fixture.drain.drain({ providerEffectIntentId: interruptA.providerEffectIntentId });
    expect(fixture.providerCalls).toEqual([
      submitA.providerEffectIntentId,
      submitB.providerEffectIntentId,
      interruptA.providerEffectIntentId,
    ]);
    expect(maximumActive).toBe(3);

    for (const gate of gates.values()) gate.resolve();
    await expect(Promise.all([first, second, interruptFirst, interruptReplay])).resolves.toHaveLength(4);
    expect(fixture.providerCalls.filter((id) => id === interruptA.providerEffectIntentId)).toHaveLength(1);
  });

  it("releases an Attempt queue after rejection and fails closed on durable same-Attempt scope conflict", async () => {
    const submit = intent("submit_delivery", "provider_effect_release_submit");
    const reconcile = intent("reconcile_attempt", "provider_effect_release_reconcile", submit);
    const fixture = drainFixture({
      intents: [submit, reconcile],
      result: async (providerEffectIntentId) => {
        if (providerEffectIntentId === submit.providerEffectIntentId) {
          throw new Error("controlled_provider_failure");
        }
        return providerReconciling(reconcile, "native_outcome_unknown");
      },
    });
    const rejected = fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId });
    const recovered = fixture.drain.drain({ providerEffectIntentId: reconcile.providerEffectIntentId });
    expect(fixture.providerCalls).toEqual([submit.providerEffectIntentId]);
    await expect(rejected).rejects.toMatchObject({
      code: "session_id_acp_provider_drain_execution_failed",
    });
    await expect(recovered).resolves.toMatchObject({
      providerEffectIntentId: reconcile.providerEffectIntentId,
      commandType: "session_runtime.reconcile_attempt",
    });
    expect(fixture.providerCalls).toEqual([
      submit.providerEffectIntentId,
      reconcile.providerEffectIntentId,
    ]);

    const conflicting = Object.freeze({
      ...reconcile,
      taskId: "task_cross_scope",
    });
    const conflictFixture = drainFixture({
      intents: [submit, conflicting],
      result: providerReconciling(conflicting, "native_outcome_unknown"),
    });
    await expect(conflictFixture.drain.drain({
      providerEffectIntentId: conflicting.providerEffectIntentId,
    })).rejects.toMatchObject({
      code: "session_id_acp_provider_drain_attempt_scope_conflict",
    });
    expect(conflictFixture.providerCalls).toEqual([]);
  });

  it("rejects caller authority fields and never projects raw Provider identity or paths", async () => {
    const submit = intent("submit_delivery", "provider_effect_safe_projection");
    const fixture = drainFixture({
      intents: [submit],
      result: providerReconciling(submit, "native_outcome_unknown"),
    });
    await expect(fixture.drain.drain({
      providerEffectIntentId: submit.providerEffectIntentId,
      workspaceDirectory: "/private/workspace",
    } as never)).rejects.toMatchObject({ code: "session_id_acp_provider_drain_input_invalid" });
    expect(fixture.providerCalls).toEqual([]);

    const result = await fixture.drain.drain({ providerEffectIntentId: submit.providerEffectIntentId });
    expect(JSON.stringify(result)).not.toMatch(/(?:cwd|path|credential|raw|sessionId|nativeBindingRef)/iu);
    expect(new SessionIdAcpProviderDrainError("safe_code")).toMatchObject({
      name: "SessionIdAcpProviderDrainError",
      code: "safe_code",
    });
  });
});

function drainFixture(input: Readonly<{
  intents: readonly SessionRuntimeProviderEffectIntentRecord[];
  result:
    | AcpTaskSessionRuntimeProviderResult
    | Promise<AcpTaskSessionRuntimeProviderResult>
    | ((providerEffectIntentId: string) =>
        AcpTaskSessionRuntimeProviderResult | Promise<AcpTaskSessionRuntimeProviderResult>);
}>) {
  const observations: SessionIdAcpEffectObservation[] = [];
  const settlements: SessionExecutionSettlement[] = [];
  const providerCalls: string[] = [];
  const drain = createSessionIdAcpProviderDrain({
    provider: {
      async executeProviderEffect(providerEffectIntentId) {
        providerCalls.push(providerEffectIntentId);
        return typeof input.result === "function"
          ? input.result(providerEffectIntentId)
          : input.result;
      },
    },
    providerEffects: {
      getProviderEffectIntent: (providerEffectIntentId) =>
        input.intents.find((candidate) => candidate.providerEffectIntentId === providerEffectIntentId),
      listProviderEffectIntents: (sessionExecutionAttemptId) =>
        input.intents.filter((candidate) => candidate.sessionExecutionAttemptId === sessionExecutionAttemptId),
    },
    resultOwner: {
      acceptEffectObservation(observation) {
        observations.push(observation);
        return { status: "recorded", outcome: observation.kind } as never;
      },
      acceptSettlement(settlement) {
        settlements.push(settlement);
        return { status: "recorded", outcome: "delivery_failed" } as never;
      },
    },
  });
  return { drain, observations, settlements, providerCalls };
}

function withAttempt(
  source: SessionRuntimeProviderEffectIntentRecord,
  sessionExecutionAttemptId: string,
): SessionRuntimeProviderEffectIntentRecord {
  return Object.freeze({
    ...source,
    sessionExecutionAttemptId,
    effect: Object.freeze({ ...source.effect, sessionExecutionAttemptId }),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCalls(calls: readonly string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && calls.length < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(calls).toHaveLength(count);
}

type IntentKind = "submit_delivery" | "reconcile_attempt" | "request_interrupt" | "respond_interaction";

function intent(
  kind: IntentKind,
  providerEffectIntentId: string,
  source?: SessionRuntimeProviderEffectIntentRecord,
): SessionRuntimeProviderEffectIntentRecord {
  const attemptId = source?.sessionExecutionAttemptId ?? "session_execution_attempt_drain";
  const common = {
    providerEffectIntentId,
    commandId: `command_${providerEffectIntentId.slice("provider_effect_".length)}`,
    idempotencyKey: `drain:${providerEffectIntentId}`,
    commandType: `session_runtime.${kind}` as const,
    commandFingerprint: hashDefinition({ kind, providerEffectIntentId }),
    taskId: "task_drain",
    runId: "run_drain",
    logicalSessionId: "logical_session_drain",
    sessionExecutionRuntimeId: "session_execution_runtime_drain",
    sessionExecutionAttemptId: attemptId,
    inputSubmissionId: "input_drain",
    orchestrationSessionTurnId: "session_turn_drain",
    bindingId: "binding_drain",
    bindingRevision: 1,
    executionProfileId: "profile_drain",
    profileRevisionId: "profile_revision_drain",
    state: "pending" as const,
    createdAt: NOW,
  };
  if (kind === "submit_delivery") return Object.freeze({
    ...common,
    effect: Object.freeze({
      kind,
      bindingHandle: "binding_handle_drain",
      sessionExecutionAttemptId: attemptId,
      content: "hello",
    }),
  });
  if (kind === "request_interrupt") return Object.freeze({
    ...common,
    sessionControlAuditId: "session_control_drain",
    effect: Object.freeze({
      kind,
      bindingHandle: "binding_handle_drain",
      sessionExecutionAttemptId: attemptId,
      sessionControlAuditId: "session_control_drain",
    }),
  });
  if (kind === "respond_interaction") return Object.freeze({
    ...common,
    interactionId: "interaction_drain",
    effect: Object.freeze({
      kind,
      bindingHandle: "binding_handle_drain",
      sessionExecutionAttemptId: attemptId,
      interactionId: "interaction_drain",
      choiceId: "choice_drain",
    }),
  });
  return Object.freeze({
    ...common,
    effect: Object.freeze({
      kind,
      bindingHandle: "binding_handle_drain",
      sessionExecutionAttemptId: attemptId,
    }),
  });
}

function settled(
  source: SessionRuntimeProviderEffectIntentRecord,
  outcome: "completed" | "failed" | "cancelled",
): SessionExecutionSettlement {
  return Object.freeze({
    sessionExecutionRuntimeId: source.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: source.sessionExecutionAttemptId,
    taskId: source.taskId,
    runId: source.runId,
    logicalSessionId: source.logicalSessionId,
    bindingId: source.bindingId,
    bindingRevision: source.bindingRevision,
    executionProfileId: source.executionProfileId,
    profileRevisionId: source.profileRevisionId,
    inputSubmissionId: source.inputSubmissionId,
    orchestrationSessionTurnId: source.orchestrationSessionTurnId,
    outcome,
    receiptDigest: hashDefinition(`receipt:${outcome}`),
    ...(outcome === "completed" ? {
      finalContent: "done",
      finalContentDigest: hashDefinition("done"),
    } : {}),
    settledAt: NOW,
  });
}

function providerSettled(
  source: SessionRuntimeProviderEffectIntentRecord,
  settlement: SessionExecutionSettlement,
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "settled",
    providerEffectIntentId: source.providerEffectIntentId,
    sessionExecutionAttemptId: source.sessionExecutionAttemptId,
    replayed: false,
    settlement,
  });
}

function providerReconciling(
  source: Pick<SessionRuntimeProviderEffectIntentRecord, "providerEffectIntentId" | "sessionExecutionAttemptId">,
  reason: Extract<AcpTaskSessionRuntimeProviderResult, { disposition: "reconciling" }>["reason"],
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "reconciling",
    providerEffectIntentId: source.providerEffectIntentId,
    sessionExecutionAttemptId: source.sessionExecutionAttemptId,
    reason,
  });
}

function providerRejected(
  source: SessionRuntimeProviderEffectIntentRecord,
  code: Extract<AcpTaskSessionRuntimeProviderResult, { disposition: "rejected" }>["code"],
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "rejected",
    providerEffectIntentId: source.providerEffectIntentId,
    sessionExecutionAttemptId: source.sessionExecutionAttemptId,
    code,
  });
}
