import { hashDefinition, type TemplatePackage } from "@agent-workspace/runtime-contracts";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "@agent-workspace/runtime-application";
import { templateDefinitionFixture } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionIdUnifiedRuntimeBridgeServer,
  SESSION_ID_UNIFIED_RUNTIME_PATHS,
  type SessionIdUnifiedRuntimeBridgeServer,
} from "./session-id-unified-runtime-bridge.js";
import type { SessionIdUnifiedRendererCommand, SessionIdUnifiedRuntimeHost } from "./session-id-unified-runtime-host.js";

const TOKEN = "renderer-template-library-token";
const EVIDENCE_TOKEN = "evidence-template-library-token";
const NOW = "2026-08-11T05:00:00.000Z";
const servers: SessionIdUnifiedRuntimeBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Session-ID unified Template Library bridge", () => {
  it("admits only the exact explicit v2-Version to validated-v3-Draft migration envelope", async () => {
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host: fakeHost(commands),
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();
    const definition = BUILT_IN_ACP_STARTER_PACKAGES.find(
      ({ package: candidate }) => candidate.template.slug === "opencode-acp-starter",
    )!.package.definition;
    const command = {
      type: "template.migrate_v2_to_v3_draft",
      commandId: "command_migrate_explicit_v3",
      uiIntentId: "ui_intent_migrate_explicit_v3",
      issuedAt: NOW,
      ownerId: "user_bridge",
      sourceTemplateVersionId: "template_version_bridge_source_v2",
      expectedSourceDefinitionHash: "fnv1a64:source-v2",
      metadata: { title: "Validated ACP v3 Draft", slug: "validated-acp-v3-draft" },
      definition,
    } as const;

    expect((await post(url, command)).status).toBe(200);
    expect(commands).toEqual([command]);
    expect((await post(url, { ...command, commandId: "command_migrate_extra", readiness: "forged" })).status)
      .toBe(400);
    expect((await post(url, {
      ...command,
      commandId: "command_migrate_v2_definition",
      definition: templateDefinitionFixture(),
    })).status).toBe(400);
    expect(commands).toHaveLength(1);
  });

  it("admits only the typed archive/import/export payloads", async () => {
    const definition = templateDefinitionFixture();
    const templatePackage: TemplatePackage = {
      schemaVersion: 2,
      kind: "agent-workspace/template",
      template: {
        templateId: "template_bridge-portable",
        version: 1,
        slug: "bridge-portable",
        title: "Bridge portable",
        definitionHash: hashDefinition(definition as never),
      },
      definition,
    };
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const host = fakeHost(commands);
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host,
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();

    expect((await post(url, {
      type: "template.import", commandId: "command_import", uiIntentId: "ui_intent_import", issuedAt: NOW,
      package: templatePackage, mode: "create",
    })).status).toBe(200);
    expect((await post(url, {
      type: "template.export", commandId: "command_export", uiIntentId: "ui_intent_export", issuedAt: NOW,
      templateVersionId: "template_version_bridge-portable-v1",
    })).status).toBe(200);
    expect((await post(url, {
      type: "template.archive", commandId: "command_archive", uiIntentId: "ui_intent_archive", issuedAt: NOW,
      templateId: "template_bridge-portable", expectedRevision: 1,
    })).status).toBe(200);
    expect(commands.map((command) => command.type)).toEqual([
      "template.import", "template.export", "template.archive",
    ]);

    expect((await post(url, {
      type: "template.import", commandId: "command_bad_mode", uiIntentId: "ui_intent_bad_mode", issuedAt: NOW,
      package: templatePackage, mode: "overwrite",
    })).status).toBe(400);
    expect((await post(url, {
      type: "template.import", commandId: "command_bad_asset", uiIntentId: "ui_intent_bad_asset", issuedAt: NOW,
      package: templatePackage, mode: "create", assets: [{ path: "../secret", base64: "AA==" }],
    })).status).toBe(400);
    expect(commands).toHaveLength(3);
  });

  it("admits the four exact Task retention envelopes and rejects Renderer-supplied delete scope", async () => {
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host: fakeHost(commands),
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();
    const retentionTypes = [
      "task.archive",
      "task.restore",
      "task.preview_permanent_delete",
      "task.permanently_delete",
    ];

    for (const [index, type] of retentionTypes.entries()) {
      expect((await post(url, {
        type,
        commandId: `command_retention_${index}`,
        uiIntentId: `ui_intent_retention_${index}`,
        issuedAt: NOW,
        taskId: "task_retention",
        expectedRevision: index + 1,
      })).status).toBe(200);
    }
    expect(commands.map((command) => command.type)).toEqual(retentionTypes);

    const forbiddenFields = [
      { artifactIds: ["artifact_renderer_owned"] },
      { directory: "/renderer/chosen/path" },
      { authority: { lease: "forged" } },
      { scenarioId: "forged", checkpointId: "forged" },
    ];
    for (const [index, type] of retentionTypes.entries()) {
      expect((await post(url, {
        type,
        commandId: `command_retention_forbidden_${index}`,
        uiIntentId: `ui_intent_retention_forbidden_${index}`,
        issuedAt: NOW,
        taskId: "task_retention",
        expectedRevision: index + 1,
        ...forbiddenFields[index],
      })).status).toBe(400);
    }
    expect((await post(url, {
      type: "task.archive",
      commandId: "command_retention_missing_revision",
      uiIntentId: "ui_intent_retention_missing_revision",
      issuedAt: NOW,
      taskId: "task_retention",
    })).status).toBe(400);
    expect(commands).toHaveLength(4);
  });

  it("accepts Runtime-owned task creation and rejects a Renderer-supplied Task identity", async () => {
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host: fakeHost(commands),
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();
    const base = {
      type: "task.create",
      commandId: "command_task_create",
      uiIntentId: "ui_intent_task_create",
      issuedAt: NOW,
      ownerId: "user_bridge-template",
      workspaceId: "workspace_bridge-template",
      taskSetupDraftId: "task_setup_draft_bridge-template",
      expectedTaskSetupRevision: 1,
    };

    expect((await post(url, base)).status).toBe(200);
    expect((await post(url, { ...base, commandId: "command_task_create_forged", taskId: "task_forged" })).status).toBe(400);
    expect(commands).toEqual([expect.objectContaining({ type: "task.create" })]);
    expect(commands[0]).not.toHaveProperty("taskId");
  });

  it("admits only the choice-based interaction response and rejects the legacy free-text Attention alias", async () => {
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host: fakeHost(commands),
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();
    const command = {
      type: "session.respond_interaction",
      commandId: "command_interaction_choice",
      uiIntentId: "ui_intent_interaction_choice",
      issuedAt: NOW,
      taskId: "task_interaction",
      runId: "run_interaction",
      expectedRevision: 7,
      targetLogicalSessionId: "logical_session_interaction",
      interactionId: "interaction_permission",
      expectedInteractionRevision: 3,
      choiceId: "choice_allow_once",
    } as const;

    expect((await post(url, command)).status).toBe(200);
    expect(commands).toEqual([command]);
    expect((await post(url, { ...command, commandId: "command_interaction_label", label: "Allow once" })).status)
      .toBe(400);
    expect((await post(url, {
      type: "session.respond_attention",
      commandId: "command_attention_legacy",
      uiIntentId: "ui_intent_attention_legacy",
      issuedAt: NOW,
      taskId: "task_interaction",
      runId: "run_interaction",
      expectedRevision: 7,
      targetLogicalSessionId: "logical_session_interaction",
      attentionId: "attention_raw",
      response: "Allow once",
    })).status).toBe(400);
    expect(commands).toHaveLength(1);
  });

  it("admits only the exact Host-owned Provider settings commands", async () => {
    const commands: SessionIdUnifiedRendererCommand[] = [];
    const readConfiguration = vi.fn(async () => ({
      kind: "provider_settings" as const,
      model: { generatedAt: NOW, providers: [] },
    }));
    const server = createSessionIdUnifiedRuntimeBridgeServer({
      host: { ...fakeHost(commands), readConfiguration } as SessionIdUnifiedRuntimeHost,
      rendererToken: TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      authorizeTask: () => true,
      authorizeCommand: () => true,
    });
    servers.push(server);
    const { url } = await server.listen();

    expect((await postPath(url, SESSION_ID_UNIFIED_RUNTIME_PATHS.configurationRead, {
      kind: "provider_settings",
    })).status).toBe(200);
    expect((await postPath(url, SESSION_ID_UNIFIED_RUNTIME_PATHS.configurationRead, {
      kind: "provider_settings",
      commandPath: "/private/provider",
    })).status).toBe(400);
    const probe = {
      type: "provider.probe_models",
      commandId: "command_probe-codex",
      uiIntentId: "ui_intent_probe-codex",
      issuedAt: NOW,
      providerFamily: "codex",
    } as const;
    expect((await post(url, probe)).status).toBe(200);
    expect((await post(url, { ...probe, commandId: "command_probe-extra", authFile: "/private/auth" })).status).toBe(400);
    expect((await post(url, { ...probe, commandId: "command_probe-family", providerFamily: "direct-codex" })).status).toBe(400);
    const discover = {
      type: "provider.discover_installation",
      commandId: "command_discover-codex",
      uiIntentId: "ui_intent_discover-codex",
      issuedAt: NOW,
      providerFamily: "codex",
    } as const;
    expect((await post(url, discover)).status).toBe(200);
    const configure = {
      type: "provider.configure_installation",
      commandId: "command_configure-codex",
      uiIntentId: "ui_intent_configure-codex",
      issuedAt: NOW,
      providerFamily: "codex",
      installation: {
        kind: "codex",
        codexPath: "/private/bin/codex",
        nodePath: "/private/bin/node",
        authFilePath: "/private/auth.json",
      },
    } as const;
    expect((await post(url, configure)).status).toBe(200);
    expect((await post(url, {
      ...configure,
      commandId: "command_configure-cross-provider",
      providerFamily: "claude-code",
    })).status).toBe(400);
    expect((await post(url, {
      ...configure,
      commandId: "command_configure-extra",
      installation: { ...configure.installation, rawAcpId: "raw" },
    })).status).toBe(400);
    const configureChatModels = {
      type: "provider.configure_chat_models",
      commandId: "command_default-codex",
      uiIntentId: "ui_intent_default-codex",
      issuedAt: NOW,
      providerFamily: "codex",
      modelIds: ["gpt-5.6-luna"],
      defaultModelId: "gpt-5.6-luna",
    } as const;
    expect((await post(url, configureChatModels)).status).toBe(200);
    expect(readConfiguration).toHaveBeenCalledTimes(1);
    expect(commands).toEqual([probe, discover, configure, configureChatModels]);
  });
});

function fakeHost(commands: SessionIdUnifiedRendererCommand[]): SessionIdUnifiedRuntimeHost {
  return {
    runtimeInstanceId: "runtime_instance_bridge-template",
    authenticatedUserId: "user_bridge-template",
    readWorkspace: vi.fn(() => ({ generatedAt: NOW, tasks: [], taskSetupOptions: { templates: [], workspaces: [] } })),
    readTask: vi.fn(() => { throw new Error("not_used"); }),
    readConfiguration: vi.fn(async () => ({ kind: "template_studio" as const, model: {} })),
    command: vi.fn(async (command) => {
      commands.push(command);
      return { receipt: { commandId: command.commandId, acceptedAt: NOW } };
    }),
    subscribe: vi.fn(() => () => undefined),
    drainRun: vi.fn(async () => undefined),
    drainMetaTurns: vi.fn(async () => 0),
    readObservedLineage: vi.fn(() => { throw new Error("not_used"); }),
    readCommandEvidence: vi.fn(() => []),
    close: vi.fn(async () => undefined),
  };
}

function post(url: string, body: Record<string, unknown>): Promise<Response> {
  return postPath(url, SESSION_ID_UNIFIED_RUNTIME_PATHS.command, body);
}

function postPath(url: string, route: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
