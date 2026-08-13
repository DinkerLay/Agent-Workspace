import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  createClaudeCodeAcpTaskProfileAdapter,
} from "../../apps/runtime-host/src/acp-claude-code-task-profile.js";
import {
  compileClaudeCodeAcpSessionConfiguration,
} from "../../apps/runtime-host/src/session-id-acp-production-composition.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_CLAUDE_CODE_ACP_TASK_SMOKE";
const WRAPPER = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_ACP_WRAPPER";
const CLAUDE = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_COMMAND";
const NODE = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_NODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_SEARCH_PATH";
const SETTINGS = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_SETTINGS";
const MODEL = "AGENT_WORKSPACE_NATIVE_CLAUDE_CODE_MODEL";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;

liveIt("qualifies the production Claude Code ACP Conductor with exact scoped tools", async () => {
  const wrapperCommandReference = requiredAbsolutePath(process.env[WRAPPER], "native_claude_acp_wrapper_required");
  const claudeCommandReference = requiredAbsolutePath(process.env[CLAUDE], "native_claude_command_required");
  const nodeCommandReference = requiredAbsolutePath(process.env[NODE], "native_claude_node_required");
  const executableSearchPath = requiredValue(process.env[SEARCH_PATH], "native_claude_search_path_required");
  const settingsSourcePath = requiredAbsolutePath(process.env[SETTINGS], "native_claude_settings_required");
  const model = requiredValue(process.env[MODEL], "native_claude_model_required");
  const profile = conductorProfile(model);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-workspace-native-claude-acp-")));
  const workspaceDirectory = path.join(root, "workspace");
  const privateRootParent = path.join(root, "private");
  await Promise.all([
    mkdir(workspaceDirectory, { mode: 0o700 }),
    mkdir(privateRootParent, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(root, 0o700), chmod(workspaceDirectory, 0o700), chmod(privateRootParent, 0o700)]);
  let qualificationAttempt = 0;
  const adapter = createClaudeCodeAcpTaskProfileAdapter({
    profile,
    role: "conductor",
    workspaceDirectory,
    bindingDisposition: "create",
    currentInstall: {
      wrapperCommandReference,
      claudeCommandReference,
      nodeCommandReference,
      executableSearchPath,
      settingsSourcePath,
    },
    credentialAcquisition: { privateRootParent, sourceSettingsFile: settingsSourcePath },
    sessionConfiguration: compileClaudeCodeAcpSessionConfiguration(profile),
    createQualificationAttemptId: () => `session_execution_attempt_native_claude_qualification_${++qualificationAttempt}`,
  });

  let primaryFailure: unknown;
  try {
    const opened = await withDeadline(
      adapter.openBinding({ bindingHandle: "binding_handle_native_claude_conductor" }),
      240_000,
      "native_claude_acp_open_timeout",
    );
    if (!opened.available) {
      throw new Error(`native_claude_acp_unavailable:${opened.report.unavailableReasons.join(",")}`);
    }
    expect(opened.runtime.safeObservation()).toMatchObject({
      providerFamily: "claude-code",
      acpAgentKind: "claude_agent_acp",
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
}, 300_000);

function conductorProfile(model: string): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "profile_native_claude_code_conductor",
    profileRevisionId: "profile_revision_native_claude_code_conductor_v1",
    providerFamily: "claude-code",
    acpAgentKind: "claude_agent_acp",
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
      permissionMode: "preapproved",
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
