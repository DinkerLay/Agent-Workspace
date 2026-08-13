import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID } from "@agent-workspace/runtime-application";
import {
  createAgentLoopTemplateDraftEditor,
  createAgentLoopSessionIdRootController,
} from "@agent-workspace/workbench-ui";
import { startSessionIdProductionRuntimeHost } from "../../apps/runtime-host/src/index.js";
import { createAgentLoopSessionIdBrowserPort } from "../../apps/workbench/src/runtime.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_CODEX_ACP_COMPLETE_FLOW";
const WRAPPER = "AGENT_WORKSPACE_NATIVE_CODEX_ACP_WRAPPER";
const CODEX = "AGENT_WORKSPACE_NATIVE_CODEX_COMMAND";
const NODE = "AGENT_WORKSPACE_NATIVE_CODEX_NODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_CODEX_SEARCH_PATH";
const AUTH = "AGENT_WORKSPACE_NATIVE_CODEX_AUTH_FILE";
const MODEL = "AGENT_WORKSPACE_NATIVE_CODEX_MODEL";
const TASK_ONLY = "AGENT_WORKSPACE_NATIVE_CODEX_ACP_COMPLETE_FLOW_TASK_ONLY";
const OWNER_ID = "user_native_codex_complete_flow";
const WORKSPACE_ID = "workspace_native_codex_complete_flow";
const META_OPTION_ID = "meta_profile_option_codex-luna-complete-flow";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;

/**
 * Opt-in development acceptance for one real product lineage. This is not a
 * release attestation: it uses the production Host/Bridge/owners and real
 * Codex ACP, while the ordinary suite remains model-effect free.
 */
liveIt("runs Template Meta -> Publish -> Task Setup -> Create -> Start through real Codex ACP", async () => {
  const inputs = liveInputs(process.env);
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-codex-complete-flow-"));
  await chmod(createdRoot, 0o700);
  const root = await realpath(createdRoot);
  const runtimeData = path.join(root, "runtime-data");
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(runtimeData, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
  ]);
  const rendererToken = `renderer_${randomBytes(24).toString("base64url")}`;
  const evidenceToken = `evidence_${randomBytes(24).toString("base64url")}`;
  const { publicKey } = generateKeyPairSync("ed25519");
  const environment: NodeJS.ProcessEnv = {
    AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeData,
    AGENT_WORKSPACE_OWNER_ID: OWNER_ID,
    AGENT_WORKSPACE_RUNTIME_TOKEN: rendererToken,
    AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: evidenceToken,
    AGENT_WORKSPACE_RUNTIME_PORT: "0",
    AGENT_WORKSPACE_WORKSPACE_CONFIG: JSON.stringify({
      schemaVersion: 1,
      grants: [{ workspaceId: WORKSPACE_ID, directory: workspace, displayName: "Codex complete flow" }],
    }),
    AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_codex_complete_${randomBytes(18).toString("base64url")}`,
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
      format: "der",
      type: "spki",
    }).toString("base64url"),
    AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(acpConfiguration(inputs.model)),
    AGENT_WORKSPACE_CODEX_ACP_WRAPPER: inputs.wrapper,
    AGENT_WORKSPACE_CODEX_COMMAND: inputs.codex,
    AGENT_WORKSPACE_NODE_COMMAND: inputs.node,
    AGENT_WORKSPACE_ACP_SEARCH_PATH: inputs.searchPath,
    AGENT_WORKSPACE_CODEX_AUTH: inputs.auth,
  };

  let runtime: Awaited<ReturnType<typeof startSessionIdProductionRuntimeHost>> | undefined;
  const humanOnlyDiagnostics: Array<Readonly<{
    kind: "agent_message_chunk" | "tool_status";
    status?: "pending" | "in_progress" | "completed" | "failed";
  }>> = [];
  const hostDiagnostics: Array<Readonly<{
    code: string;
    error?: string;
    role?: string;
    stage?: string;
  }>> = [];
  try {
    runtime = await startSessionIdProductionRuntimeHost(environment, {
      onHumanOnlyDiagnostic(value) {
        humanOnlyDiagnostics.push(Object.freeze({
          kind: value.kind,
          ...(value.kind === "tool_status" && value.status ? { status: value.status } : {}),
        }));
      },
      onDiagnostic(value) {
        hostDiagnostics.push(Object.freeze({ ...value }));
      },
    });
    const client = createAgentLoopSessionIdBrowserPort({
      baseUrl: runtime.url,
      authorization: rendererToken,
    });
    const rootController = createAgentLoopSessionIdRootController({
      client,
      ownerId: OWNER_ID,
    });
    const configuration = rootController.configuration.configuration;
    const templates = rootController.configuration.templates;

    const studio = await templates.load(BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID);
    const source = studio.selectedTemplate?.versions.at(-1);
    if (!source) throw new Error("native_complete_flow_codex_starter_missing");
    let selectedTemplateVersionId = source.templateVersionId;
    if (process.env[TASK_ONLY] !== "1") {
      const draft = await templates.createDraft(createAgentLoopTemplateDraftEditor({
        templateId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID,
        baseTemplateVersionId: source.templateVersionId,
        title: "Codex Luna complete flow",
        slug: "codex-luna-complete-flow",
        description: "A real ACP flow refined by configuration-only Meta.",
        definitionText: source.definitionText,
      }));
      if (!draft.templateDraftId || draft.revision === undefined) throw new Error("native_complete_flow_draft_missing");

      const templateScope = {
        kind: "template_design" as const,
        draftId: draft.templateDraftId,
        draftRevision: draft.revision,
      };
      await createMetaSessionOrExplain(configuration.meta, templateScope);
      const templateMeta = await configuration.meta.load(templateScope);
      if (!templateMeta.session) throw new Error("native_complete_flow_template_meta_session_missing");
      await configuration.meta.sendMessage({
        scope: templateScope,
        metaSessionId: templateMeta.session.metaSessionId,
        expectedSessionRevision: templateMeta.session.revision,
        content: "Return exactly one template_conductor_prompt_set operation. Set its value exactly to: Return one concise final acknowledgement that this durable ACP Task is live. Do not delegate and do not modify files. Leave every other field unchanged.",
      });
      const templateProposal = await eventually(async () => {
        const model = await configuration.meta.load(templateScope);
        if (model.session?.status === "failed") throw new FatalFlowError("native_complete_flow_template_meta_failed");
        return model.proposals.find(({ status }) => status === "pending");
      }, 420_000, "native_complete_flow_template_meta_timeout");
      await configuration.meta.applyPatch({
        scope: templateScope,
        proposalId: templateProposal.proposalId,
        expectedDraftRevision: templateScope.draftRevision,
      });

      const afterTemplateMeta = await templates.load(BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID);
      const appliedDraft = afterTemplateMeta.drafts.find(({ templateDraftId }) => templateDraftId === draft.templateDraftId);
      if (!appliedDraft) throw new Error("native_complete_flow_applied_draft_missing");
      expect(appliedDraft.definitionText).toContain(
        "Return one concise final acknowledgement that this durable ACP Task is live. Do not delegate and do not modify files.",
      );
      await templates.publishDraft({
        mode: "edit",
        templateId: appliedDraft.templateId,
        baseTemplateVersionId: appliedDraft.baseTemplateVersionId,
        templateDraftId: appliedDraft.templateDraftId,
        revision: appliedDraft.revision,
        title: appliedDraft.title,
        slug: appliedDraft.slug,
        description: appliedDraft.description ?? "",
        definitionText: appliedDraft.definitionText,
      });

      const publishedStudio = await templates.load(BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID);
      const publishedVersion = publishedStudio.templates
        .find(({ templateId }) => templateId === BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID)
        ?.currentVersion;
      if (!publishedVersion) throw new Error("native_complete_flow_published_version_missing");
      selectedTemplateVersionId = publishedVersion.templateVersionId;
    }
    const taskSetupDraftId = await configuration.createTaskSetupDraft({
      templateVersionId: selectedTemplateVersionId,
      workspaceId: WORKSPACE_ID,
      title: "Codex Luna Task · Meta designed",
      goal: "Return a concise acknowledgement that the complete ACP Task flow is live. Do not create or modify files.",
    });
    const setupController = configuration.taskSetup(taskSetupDraftId);
    let setupAfterMeta = await setupController.load();
    if (process.env[TASK_ONLY] !== "1") {
      const taskSetupScope = {
        kind: "task_setup" as const,
        draftId: taskSetupDraftId,
        draftRevision: setupAfterMeta.draft.revision,
      };
      await createMetaSessionOrExplain(configuration.meta, taskSetupScope);
      const taskSetupMeta = await configuration.meta.load(taskSetupScope);
      if (!taskSetupMeta.session) throw new Error("native_complete_flow_task_setup_meta_session_missing");
      await configuration.meta.sendMessage({
        scope: taskSetupScope,
        metaSessionId: taskSetupMeta.session.metaSessionId,
        expectedSessionRevision: taskSetupMeta.session.revision,
        content: "Return exactly one task_setup_goal_set operation. Set its value exactly to: Acknowledge in one concise final that the complete Template, Meta, Task Setup, and Codex ACP flow is live. Do not delegate and do not modify files.",
      });
      const taskSetupProposal = await eventually(async () => {
        const model = await configuration.meta.load(taskSetupScope);
        if (model.session?.status === "failed") {
          throw new FatalFlowError("native_complete_flow_task_setup_meta_failed");
        }
        return model.proposals.find(({ status }) => status === "pending");
      }, 420_000, "native_complete_flow_task_setup_meta_timeout");
      await configuration.meta.applyPatch({
        scope: taskSetupScope,
        proposalId: taskSetupProposal.proposalId,
        expectedDraftRevision: taskSetupScope.draftRevision,
      });
      setupAfterMeta = await setupController.load();
      expect(setupAfterMeta.draft.goal).toBe(
        "Acknowledge in one concise final that the complete Template, Meta, Task Setup, and Codex ACP flow is live. Do not delegate and do not modify files.",
      );
    }
    expect(setupAfterMeta.draft.title).toBe("Codex Luna Task · Meta designed");
    const taskId = await setupController.createTask({
      taskSetupDraftId,
      expectedRevision: setupAfterMeta.draft.revision,
    });
    const queued = (await rootController.loadWorkspace()).tasks.find((task) => task.taskId === taskId);
    if (!queued) throw new Error("native_complete_flow_task_missing");
    expect(queued.status).toBe("queued");
    const taskController = rootController.task(taskId);
    const respondedInteractionIds = new Set<string>();
    const respondToPendingInteractions = async (
      task: Awaited<ReturnType<typeof client.readTask>>,
    ): Promise<void> => {
      for (const session of task.sessions) {
        for (const interaction of session.interactions) {
          if (respondedInteractionIds.has(interaction.interactionId)) continue;
          const allowOnce = interaction.choices.find(({ label }) => label.trim().toLowerCase() === "allow once");
          if (!allowOnce) {
            throw new FatalFlowError(`native_complete_flow_allow_once_missing:${JSON.stringify({
              labels: interaction.choices.map(({ label }) => label),
            })}`);
          }
          await taskController.respondInteraction(
            session.logicalSessionId,
            interaction.interactionId,
            allowOnce.choiceId,
            `ui_intent_native_complete_interaction_${respondedInteractionIds.size + 1}`,
          );
          respondedInteractionIds.add(interaction.interactionId);
        }
      }
    };
    let startFinished = false;
    let startFailure: unknown;
    let startResult: Awaited<ReturnType<typeof rootController.startTask>> | undefined;
    const startPromise = rootController.startTask(
      taskId,
      queued.revision,
      "ui_intent_native_complete_start",
    ).then((result) => {
      startResult = result;
      startFinished = true;
    }, (error: unknown) => {
      startFailure = error;
      startFinished = true;
    });
    while (!startFinished) {
      const duringStart = await client.readTask({ taskId });
      await respondToPendingInteractions(duringStart);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await startPromise;
    if (startFailure) throw startFailure;
    if (!startResult) throw new Error("native_complete_flow_start_result_missing");
    const started = startResult;
    expect(started.run?.status).toMatch(/starting|running/u);

    const liveTask = await eventually(async () => {
      const task = await client.readTask({ taskId });
      const conductor = task.sessions.find(({ kind }) => kind === "conductor");
      await respondToPendingInteractions(task);
      if (!conductor?.binding
        || !conductor.hasReceivedFirstInstruction
        || !conductor.executionGroups.some(({ status }) => status === "completed")) {
        throw new Error(JSON.stringify({
          runStatus: task.runStatus,
          conductorLifecycle: conductor?.lifecycle,
          bindingStatus: conductor?.binding?.status,
          hasReceivedFirstInstruction: conductor?.hasReceivedFirstInstruction,
          executionGroupStatuses: conductor?.executionGroups.map(({ status }) => status),
          interactionCount: task.sessions.reduce((total, session) => total + session.interactions.length, 0),
          respondedInteractionCount: respondedInteractionIds.size,
          humanOnlyDiagnostics: humanOnlyDiagnostics.slice(-32),
          hostDiagnostics: hostDiagnostics.slice(-32),
        }));
      }
      return task;
    }, 600_000, "native_complete_flow_task_delivery_timeout");
    const conductor = liveTask.sessions.find(({ kind }) => kind === "conductor");
    expect(conductor).toMatchObject({
      lifecycle: "current",
      hasReceivedFirstInstruction: true,
      profile: {
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: inputs.model,
        role: "conductor",
        allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      },
      binding: { status: "active", recoverable: true },
    });
    expect(conductor?.executionGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed" }),
    ]));
    expect(conductor?.executionGroups).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ambiguous" }),
    ]));
    expect(JSON.stringify(liveTask)).not.toMatch(/nativeBindingRef|nativeRequestId|acpSessionId|\/Users\/dinker/u);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 1_500_000);

function acpConfiguration(model: string) {
  return {
    schemaVersion: 1,
    agents: {
      codex: {
        kind: "codex-acp-current-install",
        wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
        codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" },
        nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" },
      },
    },
    metaProfiles: [{
      metaProfileOptionId: META_OPTION_ID,
      title: "Codex gpt-5.6-luna Meta",
      profile: {
        metaProfileId: "meta_profile_codex-luna-complete-flow",
        profileRevisionId: "profile_revision_meta-codex-luna-complete-flow-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        role: "meta",
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
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
    }],
  } as const;
}

function liveInputs(environment: NodeJS.ProcessEnv): Readonly<{
  wrapper: string;
  codex: string;
  node: string;
  searchPath: string;
  auth: string;
  model: string;
}> {
  return Object.freeze({
    wrapper: requiredAbsoluteEnvironment(environment, WRAPPER),
    codex: requiredAbsoluteEnvironment(environment, CODEX),
    node: requiredAbsoluteEnvironment(environment, NODE),
    searchPath: requiredEnvironment(environment, SEARCH_PATH),
    auth: requiredAbsoluteEnvironment(environment, AUTH),
    model: requiredEnvironment(environment, MODEL),
  });
}

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      if (error instanceof FatalFlowError) throw error;
      lastFailure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${code}${lastFailure instanceof Error ? `:${lastFailure.message}` : ""}`);
}

class FatalFlowError extends Error {}

async function createMetaSessionOrExplain(
  meta: ReturnType<typeof createAgentLoopSessionIdRootController>["configuration"]["configuration"]["meta"],
  scope: Readonly<{ kind: "template_design" | "task_setup"; draftId: string; draftRevision: number }>,
): Promise<void> {
  try {
    await meta.createSession({ scope, metaProfileOptionId: META_OPTION_ID });
  } catch (error) {
    const model = await meta.load(scope);
    const readiness = model.profileOptions.find(({ metaProfileOptionId }) =>
      metaProfileOptionId === META_OPTION_ID)?.readiness;
    throw new Error(`native_complete_flow_meta_unavailable:${JSON.stringify(readiness)}:${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function requiredAbsoluteEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnvironment(environment, name);
  if (!path.isAbsolute(value)) throw new Error(`${name}_must_be_absolute`);
  return path.normalize(value);
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(`${name}_required`);
  return value;
}
