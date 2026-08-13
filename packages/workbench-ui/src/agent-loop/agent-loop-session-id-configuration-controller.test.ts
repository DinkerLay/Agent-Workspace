import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  serializeTemplatePackageYaml,
  validateTemplateDefinition,
  type createId,
  type TemplatePackage,
} from "@agent-workspace/runtime-contracts";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "@agent-workspace/runtime-application";
import { createAgentLoopTemplateDraftEditor } from "./agent-loop-template-studio-controller";
import {
  createAgentLoopSessionIdConfigurationControllers,
  type AgentLoopSessionIdConfigurationCommand,
  type AgentLoopSessionIdConfigurationReadResult,
  type AgentLoopSessionIdConfigurationRuntimePort,
} from "./agent-loop-session-id-configuration-controller";

const NOW = "2026-08-11T12:00:00.000Z";

describe("Session-ID configuration controller", () => {
  it("derives a ledger-safe default uiIntentId without nesting the command prefix", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    let sequence = 0;
    const controller = createAgentLoopSessionIdConfigurationControllers({
      client: port(async (command) => {
        commands.push(command);
        return { taskSetupDraft: { taskSetupDraftId: "task_setup_default-intent" } as never };
      }),
      ownerId: "local-user",
      now: () => NOW,
      createRuntimeId: ((kind: string) => `${kind}_default-${++sequence}`) as typeof createId,
    });
    await controller.configuration.createTaskSetupDraft({
      templateVersionId: "template_version_one",
      workspaceId: "workspace_one",
      title: "Default intent",
      goal: "Remain ledger-safe",
    });
    expect(commands).toEqual([expect.objectContaining({
      commandId: "command_default-1",
      uiIntentId: "ui_intent_default-2",
    })]);
  });

  it("reuses uiIntentId and commandId after an ambiguous typed-bridge outcome", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    let attempt = 0;
    const client = port(async (command) => {
      commands.push(command);
      if (attempt++ === 0) throw new Error("bridge_ambiguous");
      return { taskSetupDraft: { taskSetupDraftId: "task_setup_one" } as never };
    });
    const traces: unknown[] = [];
    const controller = createControllers(client, traces);
    const input = {
      templateVersionId: "template_version_one",
      workspaceId: "workspace_one",
      title: "Deep Search",
      goal: "Write a reviewed report",
    };

    await expect(controller.configuration.createTaskSetupDraft(input)).rejects.toThrow("bridge_ambiguous");
    await expect(controller.configuration.createTaskSetupDraft(input)).resolves.toBe("task_setup_one");

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      type: "task_setup.create_draft",
      commandId: "command_1",
      uiIntentId: "ui_intent_1",
    });
    expect(JSON.stringify(commands)).not.toContain("scenario");
    expect(JSON.stringify(commands)).not.toContain("checkpoint");
    expect(traces).toEqual([
      expect.objectContaining({ commandId: "command_1", uiIntentId: "ui_intent_1" }),
      expect.objectContaining({ commandId: "command_1", uiIntentId: "ui_intent_1" }),
    ]);
  });

  it("sends Template create/save/publish through the same narrow configuration port", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    let revision = 0;
    const client = port(async (command) => {
      commands.push(command);
      if (command.type === "template.create_draft" || command.type === "template.save_draft") {
        revision += 1;
        return {
          templateDraft: {
            templateDraftId: "template_draft_one",
            revision,
            status: "editing",
            ownerId: "local-user",
            metadata: command.metadata,
            definition: command.type === "template.create_draft" ? command.initialDefinition : command.definition,
            createdAt: NOW,
            updatedAt: NOW,
          } as never,
        };
      }
      return {};
    });
    const controller = createControllers(client);
    expect(controller.templates.supportsAcpTemplateV3).toBe(true);
    const created = await controller.templates.createDraft(createAgentLoopTemplateDraftEditor({
      title: "Deep Search",
      slug: "deep-search",
      definition: legacyTemplateDefinition(),
    }));
    await expect(controller.templates.publishDraft({ ...created, description: "Unsaved" }))
      .rejects.toThrow("agent_loop_template_draft_unsaved_changes");
    await controller.templates.publishDraft(created);

    expect(commands.map((command) => command.type)).toEqual([
      "template.create_draft",
      "template.publish_draft",
    ]);
    expect(commands.every((command) => Boolean(command.uiIntentId && command.commandId))).toBe(true);
  });

  it("strictly accepts a portable ACP v3 definition through the production controller", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    const client = port(async (command) => {
      commands.push(command);
      if (command.type !== "template.create_draft") return {};
      return {
        templateDraft: {
          templateDraftId: "template_draft_acp-v3",
          revision: 1,
          status: "editing",
          ownerId: "local-user",
          metadata: command.metadata,
          definition: command.initialDefinition,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
      };
    });
    const controller = createControllers(client);
    const definition = BUILT_IN_ACP_STARTER_PACKAGES[0]!.package.definition;

    await controller.templates.createDraft(createAgentLoopTemplateDraftEditor({
      title: "Codex Luna ACP",
      slug: "codex-luna-acp",
      definition,
    }));

    expect(commands).toEqual([expect.objectContaining({
      type: "template.create_draft",
      initialDefinition: expect.objectContaining({ schemaVersion: 3 }),
    })]);
  });

  it("submits task.create without a Renderer-chosen Task identity and returns the Runtime result", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    const client = port(async (command) => {
      commands.push(command);
      return { task: { taskId: "task_runtime_owned" } };
    });
    vi.mocked(client.readConfiguration).mockResolvedValue({
      kind: "task_setup",
      model: {
        draft: {
          taskSetupDraftId: "task_setup_runtime-owned",
          state: "draft",
          revision: 4,
          workspaceId: "workspace_runtime-owned",
          schemaFields: [],
        },
      } as never,
    });
    const controller = createControllers(client);

    await expect(controller.configuration.taskSetup("task_setup_runtime-owned").createTask({
      taskSetupDraftId: "task_setup_runtime-owned",
      expectedRevision: 4,
    })).resolves.toBe("task_runtime_owned");
    expect(commands).toEqual([expect.objectContaining({
      type: "task.create",
      ownerId: "local-user",
      workspaceId: "workspace_runtime-owned",
      taskSetupDraftId: "task_setup_runtime-owned",
      expectedTaskSetupRevision: 4,
    })]);
    expect(commands[0]).not.toHaveProperty("taskId");
  });

  it("reads cached Provider settings and uses one stable explicit probe command", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    const model = {
      generatedAt: NOW,
      providers: [{
        providerFamily: "codex" as const,
        displayName: "Codex",
        configured: true,
        status: "available" as const,
        reasons: [],
        models: [{ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
        configurationSource: "environment" as const,
        installation: { status: "not_scanned" as const, components: [] },
      }],
    };
    const client = port(async (command) => {
      commands.push(command);
      return { providerSettings: model };
    });
    vi.mocked(client.readConfiguration).mockResolvedValue({ kind: "provider_settings", model });
    const controller = createControllers(client);

    await expect(controller.providerSettings.load()).resolves.toEqual(model);
    await expect(controller.providerSettings.refreshModels("codex")).resolves.toEqual(model);
    expect(commands).toEqual([expect.objectContaining({
      type: "provider.probe_models",
      providerFamily: "codex",
      commandId: "command_1",
      uiIntentId: "ui_intent_1",
    })]);
    expect(JSON.stringify(commands)).not.toContain("auth");
    expect(JSON.stringify(commands)).not.toContain("path");
  });

  it("previews and imports v2 packages, exports immutable Versions, and archives identities through target commands", async () => {
    const commands: AgentLoopSessionIdConfigurationCommand[] = [];
    const definition = legacyTemplateDefinition();
    const templatePackage: TemplatePackage = {
      schemaVersion: 2,
      kind: "agent-workspace/template",
      template: {
        templateId: "template_portable-target",
        version: 1,
        slug: "portable-target",
        title: "Portable target",
        definitionHash: hashDefinition(definition as never),
      },
      definition,
    };
    const client = port(async (command) => {
      commands.push(command);
      return command.type === "template.export" ? { templatePackage } : {};
    });
    vi.mocked(client.readConfiguration).mockImplementation(async (request) => request.kind === "template_studio"
      ? {
        kind: "template_studio",
        model: {
          generatedAt: NOW,
          templates: [{ templateId: "template_existing", title: "Existing", slug: "existing", revision: 3 }],
          drafts: [],
        },
      }
      : request.kind === "task_setup"
        ? { kind: "task_setup", model: {} as never }
        : { kind: "meta", model: { profileOptions: [], proposals: [] } });
    const controller = createControllers(client);
    const preview = await controller.templates.previewImport!({
      fileName: "portable.agent-template.yaml",
      bytes: new TextEncoder().encode(serializeTemplatePackageYaml(templatePackage)),
    });
    expect(preview.availableModes).toEqual(["create"]);
    await controller.templates.importPreview!(preview.importId, "create");
    const exported = await controller.templates.exportVersion!("template_version_portable-target-v1");
    await controller.templates.archiveTemplate!("template_existing", 3);

    expect(exported).toMatchObject({ format: "yaml", fileName: "portable-target-v1.agent-template.yaml" });
    expect(commands.map((command) => command.type)).toEqual([
      "template.import", "template.export", "template.archive",
    ]);
    expect(commands[0]).toMatchObject({ type: "template.import", mode: "create", package: { schemaVersion: 2 } });
    expect(commands[2]).toMatchObject({ type: "template.archive", templateId: "template_existing", expectedRevision: 3 });
  });
});

function createControllers(client: AgentLoopSessionIdConfigurationRuntimePort, traces: unknown[] = []) {
  let commandId = 0;
  let uiIntentId = 0;
  return createAgentLoopSessionIdConfigurationControllers({
    client,
    ownerId: "local-user",
    now: () => NOW,
    createRuntimeId: ((kind: string) => `${kind}_${++commandId}`) as typeof createId,
    createUiIntentId: () => `ui_intent_${++uiIntentId}`,
    onCommandTrace: (trace) => traces.push(trace),
  });
}

function port(
  command: AgentLoopSessionIdConfigurationRuntimePort["command"],
): AgentLoopSessionIdConfigurationRuntimePort {
  return {
    readConfiguration: vi.fn(async (request): Promise<AgentLoopSessionIdConfigurationReadResult> => request.kind === "template_studio"
      ? { kind: "template_studio", model: { generatedAt: NOW, templates: [], drafts: [] } }
      : request.kind === "task_setup"
        ? { kind: "task_setup", model: {} as never }
        : { kind: "meta", model: { profileOptions: [], proposals: [] } }),
    command,
    subscribeConfiguration: vi.fn(async () => () => undefined),
  };
}

function legacyTemplateDefinition() {
  return validateTemplateDefinition({
    schemaVersion: 2,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_default",
      systemPrompt: "Coordinate evidence.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: "profile_default",
      systemPrompt: "Complete bounded work.",
      capabilityRefs: [],
      dispatchProfile: { title: "Scoped work", description: "One bounded assignment." },
    }],
    executionProfiles: [{
      executionProfileId: "profile_default",
      provider: "codex",
      model: "gpt-5.6-codex",
      providerVersion: "0.146.0",
      protocolFingerprint: "codex-app-server/0.146.0",
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "artifacts/result.md", ownerAgentCardId: "agent_card_worker" }],
  });
}
