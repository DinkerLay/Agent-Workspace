import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BUILT_IN_DEEPSEARCH_TEMPLATE_ID } from "@agent-workspace/runtime-application";
import {
  createAgentLoopSessionIdRootController,
  createAgentLoopTemplateDraftEditor,
} from "@agent-workspace/workbench-ui";
import { startSessionIdProductionRuntimeHost } from "../../apps/runtime-host/src/index.js";
import { createAgentLoopSessionIdBrowserPort } from "../../apps/workbench/src/runtime.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_CODEX_ACP_META_PROPOSAL";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;
const META_OPTION_ID = "meta_profile_option_codex-luna-meta-proposal";

/**
 * Opt-in product acceptance for the exact Template Meta behavior used by the
 * workbench. It deliberately stops before Apply: a successful run proves the
 * real ACP turn produced a durable, reviewable Proposal while the Draft stayed
 * unchanged.
 */
liveIt("returns a reviewable localized Template patch through real Codex ACP", async () => {
  const inputs = readInputs(process.env);
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-codex-meta-proposal-"));
  await chmod(createdRoot, 0o700);
  const root = await realpath(createdRoot);
  const runtimeData = path.join(root, "runtime-data");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(runtimeData, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 })]);
  const rendererToken = `renderer_${randomBytes(24).toString("base64url")}`;
  const evidenceToken = `evidence_${randomBytes(24).toString("base64url")}`;
  const { publicKey } = generateKeyPairSync("ed25519");
  const diagnostics: Array<Readonly<{ code: string; stage?: string }>> = [];
  let runtime: Awaited<ReturnType<typeof startSessionIdProductionRuntimeHost>> | undefined;

  try {
    runtime = await startSessionIdProductionRuntimeHost({
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeData,
      AGENT_WORKSPACE_OWNER_ID: "user_native_codex_meta_proposal",
      AGENT_WORKSPACE_RUNTIME_TOKEN: rendererToken,
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: evidenceToken,
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_WORKSPACE_CONFIG: JSON.stringify({
        schemaVersion: 1,
        grants: [{
          workspaceId: "workspace_native_codex_meta_proposal",
          directory: workspace,
          displayName: "Codex Meta proposal proof",
        }],
      }),
      AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_meta_proposal_${randomBytes(18).toString("base64url")}`,
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64url"),
      AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration(inputs.model)),
      AGENT_WORKSPACE_CODEX_ACP_WRAPPER: inputs.wrapper,
      AGENT_WORKSPACE_CODEX_COMMAND: inputs.codex,
      AGENT_WORKSPACE_NODE_COMMAND: inputs.node,
      AGENT_WORKSPACE_ACP_SEARCH_PATH: inputs.searchPath,
      AGENT_WORKSPACE_CODEX_AUTH: inputs.auth,
    }, {
      onDiagnostic(value) {
        diagnostics.push(Object.freeze({ code: value.code, ...(value.stage ? { stage: value.stage } : {}) }));
      },
    });
    const client = createAgentLoopSessionIdBrowserPort({
      baseUrl: runtime.url,
      authorization: rendererToken,
    });
    const controller = createAgentLoopSessionIdRootController({
      client,
      ownerId: "user_native_codex_meta_proposal",
    });
    const studio = await controller.configuration.templates.load(BUILT_IN_DEEPSEARCH_TEMPLATE_ID);
    const source = studio.selectedTemplate?.versions.at(-1);
    if (!source) throw new Error("native_meta_proposal_source_missing");
    const draft = await controller.configuration.templates.createDraft(createAgentLoopTemplateDraftEditor({
      templateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
      baseTemplateVersionId: source.templateVersionId,
      title: "Codex Meta proposal proof",
      slug: "codex-meta-proposal-proof",
      description: "Real ACP Proposal acceptance.",
      definitionText: source.definitionText,
    }));
    if (!draft.templateDraftId || draft.revision === undefined) {
      throw new Error("native_meta_proposal_draft_missing");
    }
    const originalDefinition = draft.definitionText;
    const scope = {
      kind: "template_design" as const,
      draftId: draft.templateDraftId,
      draftRevision: draft.revision,
    };
    await controller.configuration.configuration.meta.createSession({
      scope,
      metaProfileOptionId: META_OPTION_ID,
    });
    const opened = await controller.configuration.configuration.meta.load(scope);
    if (!opened.session) throw new Error("native_meta_proposal_session_missing");
    await controller.configuration.configuration.meta.sendMessage({
      scope,
      metaSessionId: opened.session.metaSessionId,
      expectedSessionRevision: opened.session.revision,
      content: "帮我把所有的prompt改成中文",
    });

    const result = await eventually(async () => {
      const model = await controller.configuration.configuration.meta.load(scope);
      const proposal = model.proposals.find(({ status }) => status === "pending");
      if (proposal) return { model, proposal };
      if (model.session?.status === "ambiguous" || model.session?.status === "failed") {
        throw new Error(`native_meta_proposal_terminal_failure:${model.session.status}:${JSON.stringify(diagnostics)}`);
      }
      return undefined;
    }, 300_000, () => JSON.stringify(diagnostics));
    expect(result.proposal.fieldDiffs).toHaveLength(4);
    expect(result.proposal.fieldDiffs.every(({ path, operation }) => (
      operation === "replace" && path.endsWith(".systemPrompt")
    ))).toBe(true);
    const after = await controller.configuration.templates.load(BUILT_IN_DEEPSEARCH_TEMPLATE_ID);
    expect(after.drafts.find(({ templateDraftId }) => templateDraftId === draft.templateDraftId)?.definitionText)
      .toBe(originalDefinition);
    expect(result.model.session?.messages.some(({ role }) => role === "assistant")).toBe(true);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);

function configuration(model: string) {
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
      title: "Codex gpt-5.6-luna Meta proposal proof",
      profile: {
        metaProfileId: "meta_profile_codex-luna-meta-proposal",
        profileRevisionId: "profile_revision_meta-codex-luna-meta-proposal-v1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        role: "meta",
        model,
        configIntent: { reasoningEffort: "low" },
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

function readInputs(environment: NodeJS.ProcessEnv) {
  return Object.freeze({
    wrapper: requiredAbsolute(environment, "AGENT_WORKSPACE_NATIVE_CODEX_ACP_WRAPPER"),
    codex: requiredAbsolute(environment, "AGENT_WORKSPACE_NATIVE_CODEX_COMMAND"),
    node: requiredAbsolute(environment, "AGENT_WORKSPACE_NATIVE_CODEX_NODE_COMMAND"),
    searchPath: required(environment, "AGENT_WORKSPACE_NATIVE_CODEX_SEARCH_PATH"),
    auth: requiredAbsolute(environment, "AGENT_WORKSPACE_NATIVE_CODEX_AUTH_FILE"),
    model: required(environment, "AGENT_WORKSPACE_NATIVE_CODEX_MODEL"),
  });
}

function requiredAbsolute(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!path.isAbsolute(value)) throw new Error(`${name}_must_be_absolute`);
  return path.normalize(value);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(`${name}_required`);
  return value;
}

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  diagnostic: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`native_meta_proposal_timeout:${diagnostic()}`);
}
