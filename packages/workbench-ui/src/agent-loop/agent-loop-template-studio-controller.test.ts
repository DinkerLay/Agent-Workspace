import { describe, expect, it, vi } from "vitest";
import {
  decodeTemplateArchive,
  encodeTemplateArchive,
  encodeTemplateAssetTransports,
  serializeTemplatePackageYaml,
  validateTemplateDefinition,
  type RuntimeCommand,
  type RuntimeReadModel,
  type TemplateDefinition,
  type TemplatePackage,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient } from "@agent-workspace/runtime-client";
import {
  createAgentLoopTemplateDraftEditor,
  createAgentLoopTemplateStudioController,
  toAgentLoopTemplateStudioViewModel,
} from "./agent-loop-template-studio-controller";

const definition = validateTemplateDefinition({
  schemaVersion: 2,
  conductor: {
    agentCardId: "agent_card_conductor",
    kind: "conductor",
    title: "Conductor",
    executionProfileId: "profile_default",
    systemPrompt: "Coordinate durable evidence.",
    capabilityRefs: [],
  },
  agentCards: [{
    agentCardId: "agent_card_worker",
    kind: "general",
    title: "Worker",
    executionProfileId: "profile_default",
    systemPrompt: "Complete the bounded objective.",
    capabilityRefs: [],
    dispatchProfile: { title: "Scoped work", description: "Complete one bounded assignment." },
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

describe("AgentLoop Template Studio controller", () => {
  it("loads focused immutable Version history and anchors a new Draft to the selected Version", async () => {
    const commands: RuntimeCommand[] = [];
    let drafts: RuntimeReadModel["templateLibrary"]["drafts"] = [];
    const read = vi.fn(async (request?: { templateId?: string }) => readModel({
      drafts,
      ...(request?.templateId ? { template: selectedTemplate() } : {}),
    }));
    const client: RuntimeClient = {
      read,
      command: async (command) => {
        commands.push(command);
        if (command.type === "template.create_draft") {
          drafts = [{
            templateDraftId: "template_draft_from_v1",
            templateId: command.templateId,
            baseTemplateVersionId: command.baseTemplateVersionId,
            metadata: command.metadata,
            definition: command.initialDefinition,
            status: "editing",
            revision: 1,
            ownerId: command.ownerId,
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z",
          }];
        }
        return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" } };
      },
      subscribe: vi.fn(async () => () => undefined),
    };
    const controller = createAgentLoopTemplateStudioController({
      client,
      ownerId: "local-user",
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    const view = await controller.load("template_research");
    expect(read).toHaveBeenCalledWith({ templateId: "template_research" });
    expect(view.selectedTemplate?.versions.map((version) => version.version)).toEqual([1, 2]);

    const source = view.selectedTemplate!.versions[0]!;
    const draft = await controller.createDraft(createAgentLoopTemplateDraftEditor({
      templateId: "template_research",
      baseTemplateVersionId: source.templateVersionId,
      title: "Research team",
      slug: "research-team",
      definitionText: source.definitionText,
    }));
    expect(commands[0]).toMatchObject({
      type: "template.create_draft",
      templateId: "template_research",
      baseTemplateVersionId: "template_version_research_v1",
      initialDefinition: definition,
    });
    expect(draft).toMatchObject({
      templateDraftId: "template_draft_from_v1",
      baseTemplateVersionId: "template_version_research_v1",
    });
  });

  it("projects current Version facts and only the current owner's editable Drafts", () => {
    const model = readModel({
      drafts: [
        draft("template_draft_mine", "local-user", "editing"),
        draft("template_draft_other", "another-user", "editing"),
        draft("template_draft_published", "local-user", "published"),
      ],
    });

    const view = toAgentLoopTemplateStudioViewModel(model, "local-user");

    expect(view.templates[0]).toMatchObject({
      templateId: "template_research",
      slug: "research-team",
      currentVersion: {
        templateVersionId: "template_version_research_v1",
        version: 1,
        definitionHash: "definition-hash-v1",
      },
    });
    expect(view.drafts).toHaveLength(1);
    expect(view.drafts[0]).toMatchObject({ templateDraftId: "template_draft_mine", revision: 1, slug: "research-team-next" });
    expect(JSON.stringify(view)).not.toContain("native-session");
  });

  it("creates, revision-saves, then publishes a v2 Draft through RuntimeClient only", async () => {
    const commands: RuntimeCommand[] = [];
    let drafts: RuntimeReadModel["templateLibrary"]["drafts"] = [];
    const client = clientFor({
      read: () => readModel({ drafts }),
      command: async (command) => {
        commands.push(command);
        if (command.type === "template.create_draft") {
          drafts = [{
            templateDraftId: "template_draft_research",
            ...(command.templateId ? { templateId: command.templateId } : {}),
            metadata: command.metadata,
            definition: command.initialDefinition,
            status: "editing",
            revision: 1,
            ownerId: command.ownerId,
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z",
          }];
        }
        if (command.type === "template.save_draft") {
          drafts = drafts.map((current) => current.templateDraftId === command.templateDraftId ? {
            ...current,
            metadata: command.metadata,
            definition: command.definition,
            revision: current.revision + 1,
            updatedAt: "2026-08-06T00:01:00.000Z",
          } : current);
        }
        return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" } };
      },
    });
    const controller = createAgentLoopTemplateStudioController({
      client,
      ownerId: "local-user",
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });
    const editor = createAgentLoopTemplateDraftEditor({
      templateId: "template_research",
      title: "Research team",
      slug: "research-team",
      description: "Review the direct Runtime cutover.",
      definition,
    });

    const durableDraft = await controller.createDraft(editor);
    await controller.publishDraft(durableDraft);

    expect(commands.map((command) => command.type)).toEqual([
      "template.create_draft",
      "template.save_draft",
      "template.publish_draft",
    ]);
    expect(commands[0]).toMatchObject({
      type: "template.create_draft",
      templateId: "template_research",
      ownerId: "local-user",
      initialDefinition: { schemaVersion: 2 },
    });
    expect(commands[1]).toMatchObject({
      type: "template.save_draft",
      templateDraftId: "template_draft_research",
      expectedRevision: 1,
      definition: { schemaVersion: 2 },
    });
    expect(commands[2]).toMatchObject({
      type: "template.publish_draft",
      templateDraftId: "template_draft_research",
      expectedRevision: 2,
      slug: "research-team",
    });
    expect(JSON.stringify(commands)).not.toContain("native-session");
  });

  it("previews a v2 package before an explicit import and exports the current immutable Version", async () => {
    const portablePackage = packageFor("template_portable", "portable-team", 1);
    const assets = [{ path: "references/brief.txt", bytes: new TextEncoder().encode("Durable evidence only."), contentType: "text/plain" }];
    const archive = encodeTemplateArchive({ package: portablePackage, assets });
    const commands: RuntimeCommand[] = [];
    const client = clientFor({
      read: () => readModel({ templates: [] }),
      command: async (command) => {
        commands.push(command);
        if (command.type === "template.export") {
          return {
            receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" },
            templatePackage: portablePackage,
            templateAssets: encodeTemplateAssetTransports(assets),
          };
        }
        return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" } };
      },
    });
    const controller = createAgentLoopTemplateStudioController({ client, ownerId: "local-user", createRuntimeId: deterministicIds() });

    const preview = await controller.previewImport({ fileName: "portable.agent-template.zip", bytes: archive });
    expect(commands).toHaveLength(0);
    expect(preview).toMatchObject({ templateId: "template_portable", version: 1, assetCount: 1, availableModes: ["create"] });

    await controller.importPreview(preview.importId, "create");
    expect(commands[0]).toMatchObject({ type: "template.import", mode: "create", package: { schemaVersion: 2 } });

    const exported = await controller.exportVersion("template_version_portable_v1");
    expect(exported).toMatchObject({ format: "zip", fileName: "portable-team-v1.agent-template.zip" });
    const decoded = decodeTemplateArchive(exported.bytes);
    expect(decoded.package.template).toMatchObject({ templateId: "template_portable", slug: "portable-team" });
    expect(Array.from(decoded.assets[0]?.bytes ?? [])).toEqual(Array.from(assets[0].bytes));
  });

  it("rejects non-v2 packages at preview time without issuing an import command", async () => {
    const commands: RuntimeCommand[] = [];
    const client = clientFor({
      read: () => readModel(),
      command: async (command) => {
        commands.push(command);
        return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" } };
      },
    });
    const controller = createAgentLoopTemplateStudioController({ client, ownerId: "local-user" });

    await expect(controller.previewImport({
      fileName: "legacy.agent-template.yaml",
      bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: "agent-workspace/template", template: {}, definition: {} })),
    })).rejects.toThrow(/unsupported template schema version/i);
    expect(commands).toHaveLength(0);
  });
});

function readModel(input: Partial<Pick<RuntimeReadModel["templateLibrary"], "templates" | "drafts">> & Pick<RuntimeReadModel, "template"> = {}): RuntimeReadModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    configuration: { metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [], metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [] },
    workspaceLibrary: { authorizations: [] },
    templateLibrary: {
      templates: input.templates ?? [{
        template: {
          templateId: "template_research",
          slug: "research-team",
          title: "Research team",
          description: "Evidence-first research.",
          activeVersionId: "template_version_research_v1",
          revision: 2,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        activeVersion: {
          templateVersionId: "template_version_research_v1",
          templateId: "template_research",
          version: 1,
          definition,
          definitionHash: "definition-hash-v1",
          createdAt: "2026-08-06T00:00:00.000Z",
          publishedAt: "2026-08-06T00:00:00.000Z",
        },
      }],
      drafts: input.drafts ?? [],
    },
    ...(input.template ? { template: input.template } : {}),
    taskLibrary: { tasks: [] },
  };
}

function selectedTemplate(): NonNullable<RuntimeReadModel["template"]> {
  return {
    template: {
      templateId: "template_research",
      slug: "research-team",
      title: "Research team",
      activeVersionId: "template_version_research_v2",
      revision: 3,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    },
    versions: [{
      templateVersionId: "template_version_research_v1",
      templateId: "template_research",
      version: 1,
      definition,
      definitionHash: "definition-hash-v1",
      createdAt: "2026-08-06T00:00:00.000Z",
      publishedAt: "2026-08-06T00:00:00.000Z",
    }, {
      templateVersionId: "template_version_research_v2",
      templateId: "template_research",
      version: 2,
      definition: { ...definition, routingPolicy: { ...definition.routingPolicy, maxDispatchesPerDecision: 2 } },
      definitionHash: "definition-hash-v2",
      createdAt: "2026-08-06T01:00:00.000Z",
      publishedAt: "2026-08-06T01:00:00.000Z",
    }],
  };
}

function draft(templateDraftId: string, ownerId: string, status: "editing" | "published") {
  return {
    templateDraftId,
    templateId: "template_research",
    metadata: { title: "Research team Draft", slug: "research-team-next", description: "Draft description" },
    definition,
    status,
    revision: 1,
    ownerId,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  } as const;
}

function packageFor(templateId: string, slug: string, version: number): TemplatePackage {
  return {
    schemaVersion: 2,
    kind: "agent-workspace/template",
    template: { templateId, version, slug, title: "Portable team" },
    definition,
  };
}

function clientFor(input: Readonly<{
  read: () => RuntimeReadModel | Promise<RuntimeReadModel>;
  command: RuntimeClient["command"];
}>): RuntimeClient {
  return {
    read: vi.fn(async () => input.read()),
    command: input.command,
    subscribe: vi.fn(async () => () => undefined),
  };
}

function deterministicIds(): typeof import("@agent-workspace/runtime-contracts").createId {
  let sequence = 0;
  return (prefix) => `${prefix}_${++sequence}`;
}
