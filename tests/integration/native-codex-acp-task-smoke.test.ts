import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { createCodexAcpTaskProfileAdapter } from "../../apps/runtime-host/src/acp-codex-task-profile.js";
import { createSessionIdAcpProductionTaskProbePolicy } from "../../apps/runtime-host/src/session-id-acp-production-policy.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_CODEX_ACP_TASK_SMOKE";
const WRAPPER = "AGENT_WORKSPACE_NATIVE_CODEX_ACP_WRAPPER";
const CODEX = "AGENT_WORKSPACE_NATIVE_CODEX_COMMAND";
const NODE = "AGENT_WORKSPACE_NATIVE_CODEX_NODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_CODEX_SEARCH_PATH";
const AUTH = "AGENT_WORKSPACE_NATIVE_CODEX_AUTH_FILE";
const MODEL = "AGENT_WORKSPACE_NATIVE_CODEX_MODEL";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;

liveIt("qualifies the unified Codex ACP Conductor with scoped tools and allow_once", async () => {
  const wrapperCommandReference = requiredAbsolutePath(
    process.env[WRAPPER],
    "native_codex_acp_wrapper_required",
  );
  const codexCommandReference = requiredAbsolutePath(
    process.env[CODEX],
    "native_codex_command_required",
  );
  const nodeCommandReference = requiredAbsolutePath(
    process.env[NODE],
    "native_codex_node_required",
  );
  const executableSearchPath = requiredValue(
    process.env[SEARCH_PATH],
    "native_codex_search_path_required",
  );
  const authSourcePath = requiredAbsolutePath(
    process.env[AUTH],
    "native_codex_auth_required",
  );
  const model = requiredValue(process.env[MODEL], "native_codex_model_required");
  const profile = conductorProfile(model);
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "agent-workspace-native-codex-acp-"),
  ));
  const workspaceDirectory = path.join(root, "workspace");
  const runtimePrivateRoot = path.join(root, "private");
  await Promise.all([
    mkdir(workspaceDirectory, { mode: 0o700 }),
    mkdir(runtimePrivateRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(root, 0o700),
    chmod(workspaceDirectory, 0o700),
    chmod(runtimePrivateRoot, 0o700),
  ]);
  const probe = createSessionIdAcpProductionTaskProbePolicy()
    .createReadinessProbe({ profile, role: "conductor" });
  const attemptedQualificationTools: string[] = [];
  const acceptedQualificationTools: string[] = [];
  const finalCandidates: string[] = [];
  const qualificationTurnContext = probe.turnContext
    ? Object.freeze({
        capabilityClass: probe.turnContext.capabilityClass,
        lease: probe.turnContext.lease,
        async handleCall(call: Parameters<typeof probe.turnContext.handleCall>[0]) {
          attemptedQualificationTools.push(call.name);
          const result = await probe.turnContext!.handleCall(call);
          acceptedQualificationTools.push(call.name);
          return result;
        },
      })
    : undefined;
  const adapter = createCodexAcpTaskProfileAdapter({
    profile,
    role: "conductor",
    workspaceDirectory,
    bindingDisposition: "create",
    currentInstall: {
      wrapperCommandReference,
      codexCommandReference,
      nodeCommandReference,
      executableSearchPath,
    },
    credentialAcquisition: { runtimePrivateRoot, authSourcePath },
    sessionConfiguration: Object.freeze({
      model,
      options: Object.freeze([Object.freeze({
        configId: "reasoning_effort",
        category: "thought_level",
        type: "select" as const,
        value: "high",
      })]),
    }),
    createQualificationProbe: () => Object.freeze({
      attemptId: probe.attemptId,
      content: probe.content,
      interactionRevision: probe.interactionRevision,
      ...(qualificationTurnContext ? { turnContext: qualificationTurnContext } : {}),
      ...(probe.qualificationExpectedFinalCandidate === undefined
        ? {}
        : { expectedFinalCandidate: probe.qualificationExpectedFinalCandidate }),
      ...(probe.additionalSteps === undefined
        ? {}
        : { additionalSteps: probe.additionalSteps }),
    }),
    onObservation(observation) {
      if (observation.kind === "final_candidate" && observation.attemptId === probe.attemptId) {
        finalCandidates.push(observation.text.slice(0, 300));
      }
    },
  });

  let primaryFailure: unknown;
  try {
    const opened = await withDeadline(
      adapter.openBinding({ bindingHandle: "binding_handle_native_codex_conductor" }),
      360_000,
      "native_codex_acp_open_timeout",
    );
    if (!opened.available) {
      throw new Error([
        `native_codex_acp_unavailable:${opened.report.unavailableReasons.join(",")}`,
        `attempted_tools=${attemptedQualificationTools.join("|") || "none"}`,
        `accepted_tools=${acceptedQualificationTools.join("|") || "none"}`,
        `final=${finalCandidates.join("|") || "none"}`,
      ].join(";"));
    }
    expect(opened.runtime.safeObservation()).toMatchObject({
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      role: "conductor",
      available: true,
    });
    expect(adapter.safeObservation()).toMatchObject({
      processOpenEffectCount: 1,
      qualificationPromptEffectCount: 4,
      businessPromptEffectCount: 0,
    });
    await opened.runtime.releaseBinding();
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw cleanupError;
  }
  if (primaryFailure) throw primaryFailure;
}, 420_000);

function conductorProfile(model: string): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "profile_native_codex_conductor",
    profileRevisionId: "profile_revision_native_codex_conductor_v1",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    model,
    configIntent: { reasoningEffort: "high" },
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ],
      allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function requiredAbsolutePath(value: string | undefined, code: string): string {
  const selected = requiredValue(value, code);
  if (!path.isAbsolute(selected)) throw new Error(code);
  return path.normalize(selected);
}

function requiredValue(value: string | undefined, code: string): string {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(code);
  return value;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
