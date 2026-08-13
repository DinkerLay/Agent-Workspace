import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { createOpenCodeAcpTaskProfileAdapter } from "../../apps/runtime-host/src/acp-opencode-task-profile.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_OPENCODE_ACP_TASK_SMOKE";
const COMMAND = "AGENT_WORKSPACE_NATIVE_OPENCODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_OPENCODE_SEARCH_PATH";
const AUTH = "AGENT_WORKSPACE_NATIVE_OPENCODE_AUTH_FILE";
const MODEL = "AGENT_WORKSPACE_NATIVE_OPENCODE_MODEL";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;

liveIt("qualifies the unified OpenCode ACP Conductor with exact scoped tools", async () => {
  const commandReference = requiredAbsolutePath(
    process.env[COMMAND],
    "native_opencode_command_required",
  );
  const executableSearchPath = requiredValue(
    process.env[SEARCH_PATH],
    "native_opencode_search_path_required",
  );
  const sourceAuthFile = requiredAbsolutePath(
    process.env[AUTH],
    "native_opencode_auth_required",
  );
  const model = requiredValue(process.env[MODEL], "native_opencode_model_required");
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "agent-workspace-native-opencode-acp-"),
  ));
  const workspaceDirectory = path.join(root, "workspace");
  const privateRootParent = path.join(root, "private");
  const inspectionRoot = path.join(root, "inspection");
  const inspectionEnvironment = Object.freeze({
    homeDirectory: path.join(inspectionRoot, "home"),
    configHome: path.join(inspectionRoot, "config"),
    dataHome: path.join(inspectionRoot, "data"),
    cacheHome: path.join(inspectionRoot, "cache"),
    stateHome: path.join(inspectionRoot, "state"),
    temporaryDirectory: path.join(inspectionRoot, "tmp"),
  });
  await Promise.all([
    mkdir(workspaceDirectory, { mode: 0o700 }),
    mkdir(privateRootParent, { mode: 0o700 }),
    ...Object.values(inspectionEnvironment).map((directory) => (
      mkdir(directory, { recursive: true, mode: 0o700 })
    )),
  ]);
  await Promise.all([
    chmod(root, 0o700),
    chmod(workspaceDirectory, 0o700),
    chmod(privateRootParent, 0o700),
  ]);
  let qualificationAttempt = 0;
  const adapter = createOpenCodeAcpTaskProfileAdapter({
    profile: conductorProfile(model),
    role: "conductor",
    workspaceDirectory,
    bindingDisposition: "create",
    currentInstall: {
      commandReference,
      executableSearchPath,
      inspectionEnvironment,
    },
    credentialAcquisition: {
      privateRootParent,
      sourceAuthFile,
    },
    createQualificationAttemptId: () => (
      `session_execution_attempt_native_opencode_qualification_${++qualificationAttempt}`
    ),
  });

  let primaryFailure: unknown;
  try {
    const opened = await withDeadline(
      adapter.openBinding({ bindingHandle: "binding_handle_native_opencode_conductor" }),
      360_000,
      "native_opencode_acp_open_timeout",
    );
    if (!opened.available) {
      throw new Error(`native_opencode_acp_unavailable:${opened.report.unavailableReasons.join(",")}`);
    }
    expect(opened.runtime.safeObservation()).toMatchObject({
      providerFamily: "opencode",
      acpAgentKind: "native_acp",
      role: "conductor",
      available: true,
    });
    expect(adapter.safeObservation()).toMatchObject({
      processOpenEffectCount: 2,
      qualificationPromptEffectCount: 2,
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
    executionProfileId: "execution_profile_native_opencode_conductor",
    profileRevisionId: "profile_revision_native_opencode_conductor_v1",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    protocolMajor: 1,
    model,
    configIntent: {},
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
