import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type {
  ExecutionProfileDefinitionV3,
  ProviderCapability,
} from "@agent-workspace/runtime-contracts";
import { CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS } from "@agent-workspace/runtime-contracts";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolRegistration,
} from "@agent-workspace/provider-port";
import {
  createAcpAgentProcessFactory,
  type AcpAgentProcessLease,
  type AcpAgentProcessOpenOperation,
} from "../../apps/runtime-host/src/acp-agent-process.js";
import {
  beginCodexAcpCredentialAcquisition,
  createCodexAcpCurrentInstallDescriptor,
} from "../../apps/runtime-host/src/acp-codex-resolution.js";
import { createAcpProfileResolutionRegistry } from "../../apps/runtime-host/src/acp-profile-resolution.js";
import { createOfficialAcpV1StdioConnection } from "../../apps/runtime-host/src/acp-sdk-stdio-connection.js";
import {
  createProviderScopedMcpBridge,
  type ProviderScopedMcpBridge,
  type ProviderScopedMcpRoute,
} from "../../apps/runtime-host/src/provider-scoped-mcp-bridge.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_CODEX_ACP_WRAPPER_PROBE";
const WRAPPER = "AGENT_WORKSPACE_NATIVE_CODEX_ACP_WRAPPER";
const CODEX = "AGENT_WORKSPACE_NATIVE_CODEX_COMMAND";
const NODE = "AGENT_WORKSPACE_NATIVE_CODEX_NODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_CODEX_SEARCH_PATH";
const AUTH = "AGENT_WORKSPACE_NATIVE_CODEX_AUTH_FILE";
const MODEL = "AGENT_WORKSPACE_NATIVE_CODEX_MODEL";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;
const STEP_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 600_000;

const BASE_CAPABILITIES = Object.freeze([
  "session_new",
  "session_prompt",
  "session_cancel",
  "session_update",
] as const satisfies readonly AcpV1Capability[]);
const PORTABLE_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);
const CONDUCTOR_REGISTRATION: ProviderScopedToolRegistration = Object.freeze({
  capabilityClass: "runtime_orchestration",
  tools: CONDUCTOR_ORCHESTRATION_TOOL_DEFINITIONS,
});

describe("native Codex ACP wrapper boundary probe (explicit opt-in)", () => {
  it("requires the wrapper, upstream, credential, and model inputs explicitly", () => {
    expect(() => probeInputs({})).toThrowError(expect.objectContaining({
      code: "native_codex_wrapper_probe_wrapper_required",
    }));
    expect(() => probeInputs({
      [WRAPPER]: "/sealed/codex-acp.js",
      [CODEX]: "/sealed/codex",
      [NODE]: "/sealed/node",
      [SEARCH_PATH]: "/sealed/bin:/usr/bin",
      [AUTH]: "/sealed/auth.json",
      [MODEL]: "safe-model",
    })).not.toThrow();
  });

  liveIt("isolates bare close, MCP startup, and one MCP tool prompt in fresh generations", async () => {
    const report = await runWrapperBoundaryProbe(probeInputs(process.env));
    expect(report).toEqual({
      bareSession: {
        initialize: "available",
        binding: "ready",
        toolDiscovery: "not_requested",
        prompt: "not_requested",
        permissionRequests: 0,
        permissionResponses: 0,
        toolCalls: 0,
        resultConsumed: false,
        sessionClose: "confirmed",
        processCleanup: "confirmed",
      },
      mcpSession: {
        initialize: "available",
        binding: "ready",
        toolDiscovery: "observed",
        prompt: "not_requested",
        permissionRequests: 0,
        permissionResponses: 0,
        toolCalls: 0,
        resultConsumed: false,
        sessionClose: "confirmed",
        processCleanup: "confirmed",
      },
      mcpPrompt: {
        initialize: "available",
        binding: "ready",
        toolDiscovery: "observed",
        prompt: "settled",
        permissionRequests: 1,
        permissionResponses: 1,
        toolCalls: 1,
        resultConsumed: true,
        sessionClose: "confirmed",
        processCleanup: "confirmed",
      },
    });
  }, TEST_TIMEOUT_MS);
});

type ProbeInputs = Readonly<{
  wrapperEntry: string;
  codexEntry: string;
  nodeEntry: string;
  searchPath: string;
  authSource: string;
  model: string;
}>;

type StageName = "bare_session" | "mcp_session" | "mcp_prompt";
type StageReport = Readonly<{
  initialize: "available" | "unavailable" | "failed";
  binding: "ready" | "not_reached" | "failed";
  toolDiscovery: "not_requested" | "observed" | "timeout" | "failed";
  prompt: "not_requested" | "settled" | "timeout" | "failed";
  permissionRequests: number;
  permissionResponses: number;
  toolCalls: number;
  resultConsumed: boolean;
  sessionClose: "confirmed" | "not_reached" | "timeout" | "failed";
  processCleanup: "confirmed" | "unconfirmed";
  diagnosticCode?: string;
}>;

async function runWrapperBoundaryProbe(inputs: ProbeInputs): Promise<Readonly<{
  bareSession: StageReport;
  mcpSession: StageReport;
  mcpPrompt: StageReport;
}>> {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-codex-wrapper-probe-"));
  await chmod(privateRoot, 0o700);
  const root = await realpath(privateRoot);
  try {
    return Object.freeze({
      bareSession: await runStage({ inputs, root, stage: "bare_session" }),
      mcpSession: await runStage({ inputs, root, stage: "mcp_session" }),
      mcpPrompt: await runStage({ inputs, root, stage: "mcp_prompt" }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runStage(input: Readonly<{
  inputs: ProbeInputs;
  root: string;
  stage: StageName;
}>): Promise<StageReport> {
  const needsMcp = input.stage !== "bare_session";
  const needsPrompt = input.stage === "mcp_prompt";
  const stageRoot = await privateChild(input.root, input.stage);
  const credentialRoot = await privateChild(stageRoot, "credential-leases");
  const workspace = await privateChild(stageRoot, "workspace");
  const descriptor = createCodexAcpCurrentInstallDescriptor({
    wrapperCommandReference: input.inputs.wrapperEntry,
    codexCommandReference: input.inputs.codexEntry,
    nodeCommandReference: input.inputs.nodeEntry,
    executableSearchPath: input.inputs.searchPath,
  });
  const profile = probeProfile(input.inputs, input.stage, needsMcp);
  const resolution = await createAcpProfileResolutionRegistry().resolve(profile, descriptor);
  const credentialOperation = beginCodexAcpCredentialAcquisition({
    runtimePrivateRoot: credentialRoot,
    authSourcePath: input.inputs.authSource,
  });
  const credentialLease = await credentialOperation.lease;
  const processFactory = createAcpAgentProcessFactory();
  const bindingHandle = `binding_handle_codex_wrapper_probe_${input.stage}`;
  const attemptId = `session_execution_attempt_codex_wrapper_probe_${input.stage}`;
  const token = `CODEX_WRAPPER_PROBE_${randomUUID().replaceAll("-", "")}`;
  const finalCandidates: string[] = [];
  let permissionRequests = 0;
  let permissionResponses = 0;
  let toolCalls = 0;
  let bridge: ProviderScopedMcpBridge | undefined;
  let route: ProviderScopedMcpRoute | undefined;
  let operation: AcpAgentProcessOpenOperation | undefined;
  let lease: AcpAgentProcessLease | undefined;
  let initialize: StageReport["initialize"] = "failed";
  let binding: StageReport["binding"] = "not_reached";
  let toolDiscovery: StageReport["toolDiscovery"] = needsMcp ? "failed" : "not_requested";
  let prompt: StageReport["prompt"] = needsPrompt ? "failed" : "not_requested";
  let sessionClose: StageReport["sessionClose"] = "not_reached";
  let processCleanup: StageReport["processCleanup"] = "unconfirmed";
  let diagnosticCode: string | undefined;

  try {
    let mcpServers: readonly unknown[] = Object.freeze([]);
    if (needsMcp) {
      bridge = createProviderScopedMcpBridge();
      await bridge.listen();
      route = bridge.registerRoute({ bindingId: bindingHandle, registration: CONDUCTOR_REGISTRATION });
      route.activate(Object.freeze({
        capabilityClass: "runtime_orchestration" as const,
        lease: null,
        async handleCall(call: ProviderScopedToolCall) {
          toolCalls += 1;
          return Object.freeze({
            providerCallId: call.providerCallId,
            result: Object.freeze({ probeToken: token }),
          });
        },
      }));
      mcpServers = Object.freeze([Object.freeze({
        type: "http",
        name: `agent_workspace_${input.stage}`,
        url: route.url,
        headers: Object.freeze([]),
      })]);
    }

    operation = processFactory.beginOpen({
      bindingHandle,
      resolution,
      workspaceDirectory: workspace,
      credentialLease,
      createConnection: createOfficialAcpV1StdioConnection,
      managedClientOptions: Object.freeze({
        async onObservation(observation: AcpSessionObservation) {
          if (observation.kind === "final_candidate" && observation.attemptId === attemptId) {
            finalCandidates.push(observation.text);
          }
          if (observation.kind === "interaction_requested" && observation.attemptId === attemptId) {
            permissionRequests += 1;
            const allowOnce = observation.choices.find((choice) => choice.kind === "allow_once");
            if (!allowOnce || !lease) {
              throw probeError("native_codex_wrapper_probe_allow_once_unavailable");
            }
            await lease.client.respondToInteraction({
              bindingHandle,
              attemptId,
              interactionId: observation.interactionId,
              choiceId: allowOnce.choiceId,
            });
            permissionResponses += 1;
          }
        },
      }),
    });
    const opened = await bounded(operation.lease, STEP_TIMEOUT_MS);
    if (opened.status !== "fulfilled") {
      diagnosticCode = opened.status === "timeout"
        ? "native_codex_wrapper_probe_process_open_timeout"
        : safeCode(opened.reason, "native_codex_wrapper_probe_process_open_failed");
      throw probeError(diagnosticCode);
    }
    lease = opened.value;
    const qualification = await bounded(lease.client.initialize({
      protocolMajor: 1,
      requiredCapabilities: BASE_CAPABILITIES,
      requiredExtensions: profile.requiredExtensions,
    }), STEP_TIMEOUT_MS);
    if (qualification.status === "timeout") {
      diagnosticCode = "native_codex_wrapper_probe_initialize_timeout";
      throw probeError(diagnosticCode);
    }
    if (qualification.status === "rejected") {
      diagnosticCode = safeCode(qualification.reason, "native_codex_wrapper_probe_initialize_failed");
      throw probeError(diagnosticCode);
    }
    initialize = qualification.value.available ? "available" : "unavailable";
    if (!qualification.value.available) {
      diagnosticCode = qualification.value.unavailableReasons[0]
        ?? "native_codex_wrapper_probe_initialize_unavailable";
      throw probeError(diagnosticCode);
    }

    const bindingResult = await bounded(lease.client.ensureBinding({
      bindingHandle,
      disposition: "create",
      workspaceDirectory: workspace,
      mcpServers,
      configuration: Object.freeze({ model: input.inputs.model, options: Object.freeze([]) }),
    }), STEP_TIMEOUT_MS);
    if (bindingResult.status === "timeout") {
      binding = "failed";
      diagnosticCode = "native_codex_wrapper_probe_binding_timeout";
      throw probeError(diagnosticCode);
    }
    if (bindingResult.status === "rejected") {
      binding = "failed";
      diagnosticCode = safeCode(bindingResult.reason, "native_codex_wrapper_probe_binding_failed");
      throw probeError(diagnosticCode);
    }
    binding = "ready";

    if (route) {
      const discovery = await bounded(route.waitForToolDiscovery(), STEP_TIMEOUT_MS);
      toolDiscovery = discovery.status === "fulfilled"
        ? "observed"
        : discovery.status === "timeout"
          ? "timeout"
          : "failed";
      if (discovery.status === "rejected") {
        diagnosticCode = safeCode(discovery.reason, "native_codex_wrapper_probe_tool_discovery_failed");
      }
    }

    if (needsPrompt) {
      const submitted = await bounded(lease.client.submitPrompt({
        bindingHandle,
        attemptId,
        content: [
          "Call invoke_agent exactly once with {\"agentCardId\":\"agent_card_probe\"}.",
          "Do not simulate or describe the call.",
          `After reading probeToken from the tool result, reply exactly ${token}.`,
        ].join("\n"),
      }), PROMPT_TIMEOUT_MS);
      if (submitted.status === "fulfilled") {
        prompt = "settled";
      } else if (submitted.status === "timeout") {
        prompt = "timeout";
        diagnosticCode = "native_codex_wrapper_probe_prompt_timeout";
      } else {
        prompt = "failed";
        diagnosticCode = safeCode(submitted.reason, "native_codex_wrapper_probe_prompt_failed");
      }
    }

    const released = await bounded(lease.client.releaseBinding({ bindingHandle }), STEP_TIMEOUT_MS);
    sessionClose = released.status === "fulfilled"
      ? "confirmed"
      : released.status === "timeout"
        ? "timeout"
        : "failed";
    if (released.status === "timeout") {
      diagnosticCode ??= "native_codex_wrapper_probe_session_close_timeout";
    } else if (released.status === "rejected") {
      diagnosticCode ??= safeCode(released.reason, "native_codex_wrapper_probe_session_close_failed");
    }
  } catch (error) {
    diagnosticCode ??= safeCode(error, "native_codex_wrapper_probe_stage_failed");
  } finally {
    try {
      route?.close();
      await bridge?.close();
    } catch {
      diagnosticCode ??= "native_codex_wrapper_probe_mcp_cleanup_unconfirmed";
    }
    try {
      if (lease) {
        await lease.close();
        const closed = await lease.closed;
        if (closed.exitConfirmed
          && closed.credentialCleanupConfirmed
          && closed.capabilityCleanupConfirmed) {
          processCleanup = "confirmed";
        }
      } else if (operation) {
        const closed = await operation.cancelAndWait();
        if (closed.processCleanupConfirmed
          && closed.credentialCleanupConfirmed
          && closed.capabilityCleanupConfirmed) {
          processCleanup = "confirmed";
        }
      } else {
        await credentialOperation.cancelAndWait();
        processCleanup = "confirmed";
      }
      await processFactory.close();
    } catch {
      diagnosticCode = "native_codex_wrapper_probe_process_cleanup_unconfirmed";
    }
  }

  return report();

  function report(): StageReport {
    const resultConsumed = finalCandidates.some((candidate) => candidate.trim() === token);
    return Object.freeze({
      initialize,
      binding,
      toolDiscovery,
      prompt,
      permissionRequests,
      permissionResponses,
      toolCalls,
      resultConsumed,
      sessionClose,
      processCleanup,
      ...(diagnosticCode ? { diagnosticCode } : {}),
    });
  }
}

function probeProfile(
  inputs: ProbeInputs,
  stage: StageName,
  needsMcp: boolean,
): ExecutionProfileDefinitionV3 {
  return Object.freeze({
    executionProfileId: `execution_profile_codex_wrapper_probe_${stage}` as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: `profile_revision_codex_wrapper_probe_${stage}`,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    model: inputs.model,
    configIntent: {},
    requiredExtensions: Object.freeze(["session/close", ...(needsMcp ? ["mcp/http"] : [])]),
    capabilityPolicy: Object.freeze({
      requiredCapabilities: PORTABLE_CAPABILITIES,
      allowedTools: Object.freeze(needsMcp
        ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
        : []),
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    }),
  });
}

async function privateChild(root: string, name: string): Promise<string> {
  const target = path.join(root, name);
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700);
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw probeError("native_codex_wrapper_probe_private_directory_invalid");
  }
  return realpath(target);
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<
  | Readonly<{ status: "fulfilled"; value: T }>
  | Readonly<{ status: "rejected"; reason: unknown }>
  | Readonly<{ status: "timeout" }>
> {
  let timer: NodeJS.Timeout | undefined;
  const settled = promise.then(
    (value) => Object.freeze({ status: "fulfilled" as const, value }),
    (reason) => Object.freeze({ status: "rejected" as const, reason }),
  );
  const timeout = new Promise<Readonly<{ status: "timeout" }>>((resolve) => {
    timer = setTimeout(() => resolve(Object.freeze({ status: "timeout" as const })), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probeInputs(environment: NodeJS.ProcessEnv): ProbeInputs {
  return Object.freeze({
    wrapperEntry: requiredAbsolute(
      environment[WRAPPER],
      "native_codex_wrapper_probe_wrapper_required",
    ),
    codexEntry: requiredAbsolute(
      environment[CODEX],
      "native_codex_wrapper_probe_codex_required",
    ),
    nodeEntry: requiredAbsolute(
      environment[NODE],
      "native_codex_wrapper_probe_node_required",
    ),
    searchPath: requiredSearchPath(environment[SEARCH_PATH]),
    authSource: requiredAbsolute(
      environment[AUTH],
      "native_codex_wrapper_probe_auth_required",
    ),
    model: requiredSafeValue(
      environment[MODEL],
      "native_codex_wrapper_probe_model_required",
    ),
  });
}

function requiredAbsolute(value: unknown, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw probeError(code);
  }
  return path.normalize(value);
}

function requiredSearchPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw probeError("native_codex_wrapper_probe_search_path_required");
  }
  const entries = value.split(path.delimiter);
  if (entries.some((entry) => !entry || !path.isAbsolute(entry))) {
    throw probeError("native_codex_wrapper_probe_search_path_invalid");
  }
  return entries.map((entry) => path.normalize(entry)).join(path.delimiter);
}

function requiredSafeValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,159}$/u.test(value)) {
    throw probeError(code);
  }
  return value;
}

function safeCode(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    for (const candidate of [
      "diagnosticCode" in value ? value.diagnosticCode : undefined,
      "code" in value ? value.code : undefined,
    ]) {
      if (typeof candidate === "string" && /^[a-z][a-z0-9_-]{0,191}$/u.test(candidate)) {
        return candidate;
      }
    }
  }
  return fallback;
}

function probeError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
