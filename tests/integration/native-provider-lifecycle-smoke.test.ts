import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import type {
  ExecutionProfileDefinition,
  ProviderCapability,
  ProviderFact,
  ProviderKind,
  ProviderSessionBootstrap,
} from "@agent-workspace/runtime-contracts";
import type { ProviderPort } from "@agent-workspace/provider-port";
import {
  createRuntimeProviderPorts,
  parseRuntimeProviderConfiguration,
  type RuntimeProviderConfigurationEntry,
} from "../../apps/runtime-host/src/provider-composition.js";

const RUN_NATIVE_LIFECYCLE_SMOKE = process.env.AGENT_WORKSPACE_RUN_NATIVE_PROVIDER_LIFECYCLE_SMOKE === "1";
const nativeLifecycleSmoke = RUN_NATIVE_LIFECYCLE_SMOKE ? it : it.skip;

const CORE_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);

const DIRECT_TRANSPORT_FOR_PROVIDER: Readonly<Record<ProviderKind, string>> = Object.freeze({
  opencode: "opencode-server",
  codex: "codex-app-server",
  "claude-code": "claude-code-stream",
});

const DEFAULT_PROMPT = "Reply with exactly: AGENT_WORKSPACE_LIFECYCLE_SMOKE_OK";
const INTERRUPT_PROMPT = "Write a long, detailed explanation of the number sequence from one to one thousand. Do not use tools.";

type SmokeInput = Readonly<{
  readonly provider: ProviderKind;
  readonly model: string;
  readonly prompt: string;
  readonly configuration: string;
  readonly evidencePath: string;
  readonly timeoutMs: number;
  readonly exerciseInterrupt: boolean;
}>;

type EvidencePhase = Readonly<{
  readonly name: string;
  readonly acceptance?: "accepted" | "rejected" | "unknown";
  readonly factKinds?: Readonly<Record<string, number>>;
  readonly nativeBindingRefHash?: string;
  readonly inputObserved?: boolean;
  readonly finalObserved?: boolean;
  readonly terminalObserved?: boolean;
  readonly interruptConfirmed?: boolean;
}>;

type SmokeEvidence = {
  readonly schemaVersion: 1;
  readonly kind: "agent-workspace-native-provider-lifecycle-smoke";
  readonly test: "tests/integration/native-provider-lifecycle-smoke.test.ts";
  readonly startedAt: string;
  provider?: ProviderKind;
  directTransportKind?: string;
  providerVersion?: string;
  protocolFingerprint?: string;
  capabilityReport?: Readonly<{
    readonly available: boolean;
    readonly capabilities: readonly string[];
    readonly unavailableReasons: readonly string[];
  }>;
  readonly phases: EvidencePhase[];
  outcome?: "passed" | "failed";
  failureClass?: "configuration" | "lifecycle" | "evidence" | "cleanup";
  /** Stable local error identity only; never a Provider diagnostic or message. */
  failure?: Readonly<{ readonly name: string; readonly code?: string }>;
  finishedAt?: string;
  residualRisk?: string;
};

class NativeFactTimeoutError extends Error {
  constructor(readonly facts: readonly ProviderFact[]) {
    super("native_smoke_expected_native_fact_missing");
    this.name = "NativeFactTimeoutError";
  }
}

describe("native Provider lifecycle smoke (explicit opt-in)", () => {
  nativeLifecycleSmoke("uses the Runtime Host composition path and records only redacted native evidence", async () => {
    let input: SmokeInput | undefined;
    let evidence: SmokeEvidence | undefined;
    let temporaryRoot: string | undefined;
    let firstPort: ProviderPort | undefined;
    let resumedPort: ProviderPort | undefined;
    let activeRequest: BindingRequest | undefined;
    let failureClass: SmokeEvidence["failureClass"];
    let currentPhase = "configuration";

    try {
      input = readInput();
      evidence = {
        schemaVersion: 1,
        kind: "agent-workspace-native-provider-lifecycle-smoke",
        test: "tests/integration/native-provider-lifecycle-smoke.test.ts",
        startedAt: new Date().toISOString(),
        phases: [],
      };

      const configuration = parseRuntimeProviderConfiguration(input.configuration);
      const entry = selectedNativeEntry(configuration.providers, input.provider);
      evidence.provider = entry.provider;
      evidence.directTransportKind = entry.transport.kind;
      evidence.providerVersion = entry.protocol.providerVersion;
      evidence.protocolFingerprint = entry.protocol.protocolFingerprint;

      temporaryRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-native-provider-smoke-"));
      chmodSync(temporaryRoot, 0o700);
      const workspaceDirectory = path.join(temporaryRoot, "workspace");
      const runtimeDataDirectory = path.join(temporaryRoot, "runtime-data");
      mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(runtimeDataDirectory, { recursive: true, mode: 0o700 });

      const profile = profileFor(entry, input.model);
      const bindingId = `native_smoke_${randomUUID()}`;
      const baseRequest: BindingRequest = {
        bindingId,
        bindingRevision: 1,
        executionProfile: profile,
        workspace: { workspaceId: `workspace_smoke_${randomUUID()}`, cwd: workspaceDirectory },
        bootstrap: {
          purpose: "task_worker",
          agentCardId: "agent_card_native_smoke",
          systemPrompt: "Complete only the bounded native lifecycle smoke request.",
          capabilityRefs: [],
        },
      };

      firstPort = composeSelectedPort(entry, runtimeDataDirectory);
      const firstCapabilities = await firstPort.describeCapabilities(profile);
      evidence.capabilityReport = summarizeCapabilities(firstCapabilities);
      requireCondition(firstCapabilities.available, "native_smoke_provider_unavailable");
      requireCondition(CORE_CAPABILITIES.every((capability) => firstCapabilities.capabilities.includes(capability)), "native_smoke_core_capability_missing");

      const createEffect = await firstPort.ensureBinding({
        ...baseRequest,
        disposition: "create",
        idempotencyKey: `create:${bindingId}:1`,
      });
      requireCondition(createEffect.acceptance === "accepted", "native_smoke_binding_create_rejected");
      evidence.phases.push({ name: "create", acceptance: createEffect.acceptance });

      // Use the same `input_<uuid>` identity Runtime creates in production.
      // Codex's native client correlation requires the UUID payload.
      const firstInputSubmissionId = `input_${randomUUID()}`;
      const deliveryEffect = await firstPort.submitDelivery({
        ...baseRequest,
        inputSubmissionId: firstInputSubmissionId,
        invocationId: `invocation_smoke_${randomUUID()}`,
        idempotencyKey: `delivery:${bindingId}:1`,
        content: input.prompt,
      });
      requireCondition(deliveryEffect.acceptance === "accepted", "native_smoke_delivery_rejected");

      currentPhase = "delivery_and_reconcile";
      const initialFacts = await waitForFacts({
        port: firstPort,
        request: baseRequest,
        timeoutMs: input.timeoutMs,
        ready: (facts) => nativeBindingRefFrom(facts) !== undefined
          && hasInputReceipt(facts, firstInputSubmissionId)
          && hasAssistantFinal(facts, firstInputSubmissionId)
          && hasCompletedTurn(facts, firstInputSubmissionId),
      });
      const nativeBindingRef = nativeBindingRefFrom(initialFacts);
      requireCondition(nativeBindingRef !== undefined, "native_smoke_binding_fact_missing");
      activeRequest = { ...baseRequest, nativeBindingRef };
      evidence.phases.push({
        name: "delivery_and_reconcile",
        acceptance: deliveryEffect.acceptance,
        factKinds: countFactKinds(initialFacts),
        nativeBindingRefHash: hashIdentifier(nativeBindingRef),
        inputObserved: hasInputReceipt(initialFacts, firstInputSubmissionId),
        finalObserved: hasAssistantFinal(initialFacts, firstInputSubmissionId),
        terminalObserved: hasCompletedTurn(initialFacts, firstInputSubmissionId),
      });

      // OpenCode has no safe release operation: deleting a native Session is
      // intentionally outside this smoke. The two child-process bridges own
      // only local children, so release is required before reconstructing them.
      if (entry.provider !== "opencode") {
        await firstPort.releaseBinding(activeRequest);
        firstPort = undefined;
      }

      resumedPort = composeSelectedPort(entry, runtimeDataDirectory);
      const resumedCapabilities = await resumedPort.describeCapabilities(profile);
      requireCondition(resumedCapabilities.available, "native_smoke_resumed_provider_unavailable");
      const resumeEffect = await resumedPort.ensureBinding({
        ...activeRequest,
        disposition: "resume",
        idempotencyKey: `resume:${bindingId}:1`,
      });
      requireCondition(resumeEffect.acceptance === "accepted", "native_smoke_binding_resume_rejected");

      // Claude Code validates the resumed session only after it emits stream
      // init. Its second, bounded input is the native proof; Codex and
      // OpenCode validate resume directly through their native resume routes.
      let resumeFacts: readonly ProviderFact[];
      currentPhase = "restart_and_resume";
      if (entry.provider === "claude-code") {
        const resumedInputSubmissionId = `input_${randomUUID()}`;
        const resumedDelivery = await resumedPort.submitDelivery({
          ...activeRequest,
          inputSubmissionId: resumedInputSubmissionId,
          invocationId: `invocation_resume_smoke_${randomUUID()}`,
          idempotencyKey: `resume_delivery:${bindingId}:1`,
          content: input.prompt,
        });
        requireCondition(resumedDelivery.acceptance === "accepted", "native_smoke_resumed_delivery_rejected");
        resumeFacts = await waitForFacts({
          port: resumedPort,
          request: activeRequest,
          timeoutMs: input.timeoutMs,
          ready: (facts) => hasInputReceipt(facts, resumedInputSubmissionId)
            && hasAssistantFinal(facts, resumedInputSubmissionId)
            && hasCompletedTurn(facts, resumedInputSubmissionId),
        });
      } else {
        resumeFacts = await waitForFacts({
          port: resumedPort,
          request: activeRequest,
          timeoutMs: input.timeoutMs,
          ready: (facts) => nativeBindingRefFrom(facts) === nativeBindingRef
            && hasInputReceipt(facts, firstInputSubmissionId)
            && hasAssistantFinal(facts, firstInputSubmissionId)
            && hasCompletedTurn(facts, firstInputSubmissionId),
        });
      }
      evidence.phases.push({
        name: "restart_and_resume",
        acceptance: resumeEffect.acceptance,
        factKinds: countFactKinds(resumeFacts),
        nativeBindingRefHash: hashIdentifier(nativeBindingRef),
        finalObserved: entry.provider === "claude-code"
          ? hasAnyAssistantFinal(resumeFacts)
          : hasAssistantFinal(resumeFacts, firstInputSubmissionId),
        terminalObserved: hasAnyCompletedTurn(resumeFacts),
      });

      if (input.exerciseInterrupt) {
        currentPhase = "interrupt";
        const interruptInputSubmissionId = `input_${randomUUID()}`;
        const interruptDelivery = await resumedPort.submitDelivery({
          ...activeRequest,
          inputSubmissionId: interruptInputSubmissionId,
          invocationId: `invocation_interrupt_smoke_${randomUUID()}`,
          idempotencyKey: `interrupt_delivery:${bindingId}:1`,
          content: INTERRUPT_PROMPT,
        });
        requireCondition(interruptDelivery.acceptance === "accepted", "native_smoke_interrupt_delivery_rejected");
        // An abort sent before the Provider has accepted the native message is
        // a distinct pre-turn race, not evidence about terminal interruption.
        // First prove this delivery reached the native continuation; a turn
        // that has already completed before Stop is likewise not an interrupt
        // scenario and must fail explicitly rather than create a false pass.
        const activeFacts = await waitForFacts({
          port: resumedPort,
          request: activeRequest,
          timeoutMs: input.timeoutMs,
          ready: (facts) => hasInputReceipt(facts, interruptInputSubmissionId),
        });
        requireCondition(
          !hasCompletedTurn(activeFacts, interruptInputSubmissionId),
          "native_smoke_interrupt_turn_completed_before_interrupt",
        );
        const interruptEffect = await resumedPort.requestInterrupt({
          ...activeRequest,
          idempotencyKey: `interrupt:${bindingId}:1`,
        });
        requireCondition(interruptEffect.acceptance === "accepted", "native_smoke_interrupt_rejected");
        const interruptFacts = await waitForFacts({
          port: resumedPort,
          request: activeRequest,
          timeoutMs: input.timeoutMs,
          ready: (facts) => hasInterruptConfirmation(facts, interruptInputSubmissionId),
        });
        evidence.phases.push({
          name: "interrupt",
          acceptance: interruptEffect.acceptance,
          factKinds: countFactKinds(interruptFacts),
          interruptConfirmed: hasInterruptConfirmation(interruptFacts, interruptInputSubmissionId),
        });
      }

      evidence.outcome = "passed";
      evidence.residualRisk = input.exerciseInterrupt
        ? "This proves one bounded ProviderPort lifecycle. It does not prove attention, native child, presentation, or full Runtime Task/Run recovery semantics."
        : "Interrupt was intentionally not exercised; accepted transport effects are never treated as an interrupt confirmation. Attention, native child, presentation, and full Runtime Task/Run recovery remain outside this smoke.";
    } catch (error) {
      failureClass ??= evidence ? "lifecycle" : "configuration";
      if (evidence) {
        if (error instanceof NativeFactTimeoutError) {
          evidence.phases.push({
            name: `${currentPhase}_timeout`,
            factKinds: countFactKinds(error.facts),
            interruptConfirmed: currentPhase === "interrupt" ? false : undefined,
          });
        }
        evidence.outcome = "failed";
        evidence.failureClass = failureClass;
        evidence.failure = safeFailureIdentity(error);
        evidence.residualRisk = "The required native observation was not obtained in the bounded phase. Raw Provider facts, transcripts, identifiers, and diagnostics are intentionally omitted from this report.";
      }
    } finally {
      const releaseRequest = activeRequest;
      try {
        if (resumedPort && releaseRequest && releaseRequest.executionProfile.provider !== "opencode") {
          await resumedPort.releaseBinding(releaseRequest);
        }
      } catch {
        failureClass ??= "cleanup";
        if (evidence?.outcome === "passed") {
          evidence.outcome = "failed";
          evidence.failureClass = "cleanup";
        }
      }
      try {
        if (firstPort && releaseRequest && releaseRequest.executionProfile.provider !== "opencode") {
          await firstPort.releaseBinding(releaseRequest);
        }
      } catch {
        failureClass ??= "cleanup";
        if (evidence?.outcome === "passed") {
          evidence.outcome = "failed";
          evidence.failureClass = "cleanup";
        }
      }

      try {
        if (temporaryRoot) rmSync(temporaryRoot, { force: true, recursive: true });
      } catch {
        failureClass ??= "cleanup";
        if (evidence?.outcome === "passed") {
          evidence.outcome = "failed";
          evidence.failureClass = "cleanup";
        }
      }
      if (evidence && input) {
        evidence.finishedAt = new Date().toISOString();
        if (failureClass && evidence.outcome !== "passed") evidence.failureClass = failureClass;
        try {
          writeEvidence(input.evidencePath, evidence);
        } catch {
          failureClass = "evidence";
        }
      }
    }

    if (failureClass) {
      throw new Error("native_provider_lifecycle_smoke_failed; inspect the configured redacted evidence report");
    }
  }, 270_000);
});

type BindingRequest = Readonly<{
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly nativeBindingRef?: string;
  readonly executionProfile: ExecutionProfileDefinition;
  readonly workspace: Readonly<{ readonly workspaceId: string; readonly cwd: string }>;
  readonly bootstrap: ProviderSessionBootstrap;
}>;

function readInput(): SmokeInput {
  const provider = process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_PROVIDER;
  const model = process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_MODEL;
  const configuration = process.env.AGENT_WORKSPACE_PROVIDER_CONFIG;
  const evidencePath = process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_EVIDENCE_PATH;
  if (provider !== "opencode" && provider !== "codex" && provider !== "claude-code") {
    throw new Error("native_smoke_provider_invalid");
  }
  if (!model?.trim() || !configuration?.trim() || !evidencePath?.trim() || !path.isAbsolute(evidencePath)) {
    throw new Error("native_smoke_required_input_missing");
  }
  const prompt = process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_PROMPT ?? DEFAULT_PROMPT;
  if (!prompt.trim()) throw new Error("native_smoke_prompt_invalid");
  return Object.freeze({
    provider,
    model,
    prompt,
    configuration,
    evidencePath,
    timeoutMs: parseTimeout(process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_TIMEOUT_MS),
    exerciseInterrupt: process.env.AGENT_WORKSPACE_NATIVE_PROVIDER_SMOKE_INTERRUPT === "1",
  });
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === "") return 120_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 240_000) {
    throw new Error("native_smoke_timeout_invalid");
  }
  return parsed;
}

function selectedNativeEntry(
  entries: readonly RuntimeProviderConfigurationEntry[],
  provider: ProviderKind,
): RuntimeProviderConfigurationEntry {
  const entry = entries.find((candidate) => candidate.provider === provider);
  if (!entry || entry.transport.kind !== DIRECT_TRANSPORT_FOR_PROVIDER[provider]) {
    throw new Error("native_smoke_direct_transport_required");
  }
  return entry;
}

function composeSelectedPort(entry: RuntimeProviderConfigurationEntry, runtimeDataDirectory: string): ProviderPort {
  const ports = createRuntimeProviderPorts({ schemaVersion: 1, providers: [entry] }, {
    environment: process.env,
    runtimeDataDirectory,
  });
  const port = ports[0];
  if (!port || port.provider !== entry.provider) throw new Error("native_smoke_provider_composition_failed");
  return port;
}

function profileFor(entry: RuntimeProviderConfigurationEntry, model: string): ExecutionProfileDefinition {
  return Object.freeze({
    executionProfileId: `profile_native_smoke_${randomUUID()}`,
    provider: entry.provider,
    model,
    providerVersion: entry.protocol.providerVersion,
    protocolFingerprint: entry.protocol.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: CORE_CAPABILITIES,
      allowedTools: [],
      // Codex's direct bridge is intentionally read-only/untrusted and rejects
      // a profile that promises any approval surface. The other direct bridges
      // are at least as restrictive for this smoke.
      permissionMode: "deny" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  });
}

async function waitForFacts(input: Readonly<{
  readonly port: ProviderPort;
  readonly request: BindingRequest;
  readonly timeoutMs: number;
  readonly ready: (facts: readonly ProviderFact[]) => boolean;
}>): Promise<readonly ProviderFact[]> {
  const facts = new Map<string, ProviderFact>();
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const observed = await input.port.reconcileBinding(input.request);
    for (const fact of observed) facts.set(fact.providerFactId, fact);
    const current = Object.freeze([...facts.values()]);
    if (input.ready(current)) return current;
    await delay(500);
  }
  throw new NativeFactTimeoutError(Object.freeze([...facts.values()]));
}

function nativeBindingRefFrom(facts: readonly ProviderFact[]): string | undefined {
  for (const fact of facts) {
    if (fact.kind !== "binding_observed") continue;
    const payload = fact.payload as Record<string, unknown>;
    if (typeof payload.nativeBindingRef === "string" && payload.nativeBindingRef) return payload.nativeBindingRef;
  }
  return undefined;
}

function hasInputReceipt(facts: readonly ProviderFact[], inputSubmissionId: string): boolean {
  return facts.some((fact) => fact.kind === "input_received"
    && fact.correlation.inputSubmissionId === inputSubmissionId
    && Boolean(fact.correlation.nativeMessageId || fact.correlation.nativeTurnId));
}

function hasCompletedTurn(facts: readonly ProviderFact[], inputSubmissionId: string): boolean {
  return facts.some((fact) => fact.kind === "turn_completed" && fact.correlation.inputSubmissionId === inputSubmissionId);
}

function hasAssistantFinal(facts: readonly ProviderFact[], inputSubmissionId: string): boolean {
  return facts.some((fact) => fact.kind === "assistant_final"
    && fact.correlation.inputSubmissionId === inputSubmissionId
    && typeof fact.payload.content === "string"
    && fact.payload.content.trim().length > 0);
}

function hasAnyAssistantFinal(facts: readonly ProviderFact[]): boolean {
  return facts.some((fact) => fact.kind === "assistant_final"
    && typeof fact.payload.content === "string"
    && fact.payload.content.trim().length > 0);
}

function hasAnyCompletedTurn(facts: readonly ProviderFact[]): boolean {
  return facts.some((fact) => fact.kind === "turn_completed");
}

function hasInterruptConfirmation(facts: readonly ProviderFact[], inputSubmissionId: string): boolean {
  return facts.some((fact) => fact.kind === "interrupt_confirmed" && fact.correlation.inputSubmissionId === inputSubmissionId);
}

function countFactKinds(facts: readonly ProviderFact[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const fact of facts) counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
  return Object.freeze(counts);
}

function summarizeCapabilities(value: Awaited<ReturnType<ProviderPort["describeCapabilities"]>>): SmokeEvidence["capabilityReport"] {
  return Object.freeze({
    available: value.available,
    capabilities: Object.freeze([...value.capabilities].sort()),
    unavailableReasons: Object.freeze([...value.unavailableReasons].sort()),
  });
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function safeFailureIdentity(error: unknown): Readonly<{ readonly name: string; readonly code?: string }> {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(error.name)
    ? error.name
    : "UnknownError";
  const candidate = safeFailureCode(error);
  // Code is opt-in and tightly allowlisted: never serialize a server-provided
  // message, URL, native identifier, or arbitrary JSON-RPC diagnostic.
  const code = typeof candidate === "string"
    && /^(?:codex|opencode|claude|native_smoke|provider)_[a-z0-9_:-]{1,180}$/.test(candidate)
    ? candidate
    : undefined;
  return Object.freeze({ name, ...(code ? { code } : {}) });
}

function safeFailureCode(error: unknown): unknown {
  let current = error;
  let wrapperCode: unknown;
  // ProviderTransportError intentionally hides its cause in user-visible text.
  // A bounded walk retains only a known local code for an operator report.
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string") {
      if (!record.code.startsWith("provider_")) return record.code;
      wrapperCode ??= record.code;
    }
    current = record.cause;
  }
  return wrapperCode;
}

function writeEvidence(evidencePath: string, evidence: SmokeEvidence): void {
  mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(evidencePath, 0o600);
}

function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
