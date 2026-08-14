import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
  BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
  BUILT_IN_TEMPLATE_PACKAGES,
} from "@agent-workspace/runtime-application";
import type {
  AcpProfileReadinessObservation,
  MetaProfileDefinitionV3,
  MetaProfileOptionDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpMetaAgentTurnRequest,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import { SqliteRuntimeStore } from "@agent-workspace/runtime-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionIdUnifiedRuntimeHost,
  type SessionIdUnifiedAcpProviderFactoryInput,
  type SessionIdUnifiedAcpProviderOwner,
} from "./session-id-unified-runtime-host.js";

const NOW = "2026-08-12T00:00:00.000Z";
const CONTROLLED_META_PROFILE: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_unified-close",
  profileRevisionId: "profile_revision_unified-close-v3",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "controlled-meta",
  configIntent: Object.freeze({ reasoningEffort: "high" }),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: Object.freeze([]),
    allowedTools: Object.freeze([]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});
const CONTROLLED_META_READINESS: AcpProfileReadinessObservation = Object.freeze({
  profileRevisionId: CONTROLLED_META_PROFILE.profileRevisionId,
  providerFamily: CONTROLLED_META_PROFILE.providerFamily,
  acpAgentKind: CONTROLLED_META_PROFILE.acpAgentKind,
  role: "meta",
  status: "available",
  reasons: Object.freeze([]),
  missingCapabilities: Object.freeze([]),
  missingExtensions: Object.freeze([]),
  model: CONTROLLED_META_PROFILE.model,
  observedProtocolMajor: 1,
  observedAgent: Object.freeze({ name: "controlled-meta", version: "current" }),
});
const CONTROLLED_META_OPTION: MetaProfileOptionDefinitionV3 = Object.freeze({
  metaProfileOptionId: "meta_profile_option_unified-close",
  title: "Controlled Meta close",
  profile: CONTROLLED_META_PROFILE,
  readiness: CONTROLLED_META_READINESS,
});
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID unified ACP Runtime Host", () => {
  it("contains only the ACP v3 production graph and command surface", () => {
    const source = readFileSync(new URL("./session-id-unified-runtime-host.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/ProviderPort|createProviderRegistry|projectSessionIdObservedLineage|session-id-task-runtime|session-id-attention/u);
    expect(source).not.toMatch(/nativeBindingRef|respond_attention|providerPorts|profileVersion|\bcwd\b/u);
    expect(source).toContain("createSessionIdAcpApplicationAssembly");
    expect(source).toContain("createSessionIdAcpTaskReadProjector");
    expect(source).toContain("createNodeSessionIdAcpWorkspacePreviewOwner");
    expect(source).toContain("attachRuntime");
  });

  it("requires the explicit provider owner seam and rejects legacy root options", async () => {
    const root = temporaryRoot("session-id-unified-options-");
    await expect(createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_options",
      providerPorts: [],
    } as never)).rejects.toThrow("session_id_unified_host_options_invalid");
  });

  it("attaches the production owner only after ACP Ready and lifecycle exist", async () => {
    const root = temporaryRoot("session-id-unified-attach-");
    const events: string[] = [];
    const provider = controlledProviderOwner({
      onAttach(input) {
        events.push("attach");
        expect(input.acpApplication.createRunApplication).toBeTypeOf("function");
        expect(input.onBindingReady).toBeTypeOf("function");
        expect(input.onRuntimeInvalidated).toBeTypeOf("function");
      },
    });
    const now = () => NOW;
    const createId = stableIds();
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_attach",
      authorizeRetiringBindingRecovery: () => false,
      createId,
      now,
      createProviderOwner(input) {
        events.push("factory");
        expect(input.runtimeInstanceId).toMatch(/^runtime_instance_/u);
        expect(input.now).toBe(now);
        expect(input.createId).toBe(createId);
        expect(input.taskBindingContext.repositories.binding.getCurrentBinding).toBeTypeOf("function");
        expect(input.taskBindingContext.repositories.sessionRuntime.getRuntimeForSession).toBeTypeOf("function");
        expect(input.taskBindingContext.workspaceDirectoryResolver.canonicalizeDirectory).toBeTypeOf("function");
        expect(provider.executeProviderEffect).not.toHaveBeenCalled();
        expect(provider.retireBinding).not.toHaveBeenCalled();
        return provider.owner;
      },
    });

    expect(events).toEqual(["factory", "attach"]);
    expect(Object.keys(host).sort()).toEqual([
      "authenticatedUserId",
      "close",
      "command",
      "drainMetaTurns",
      "drainRun",
      "readCommandEvidence",
      "readConfiguration",
      "readObservedLineage",
      "readTask",
      "readWorkspace",
      "runtimeInstanceId",
      "subscribe",
    ]);
    expect(host.readObservedLineage()).toMatchObject({
      runtimeInstanceId: host.runtimeInstanceId,
      taskIds: [],
      runIds: [],
      bindingIds: [],
      canonicalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    await host.close();
    expect(provider.close).toHaveBeenCalledTimes(1);
  });

  it("keeps Provider model discovery explicit and projects only the cached ACP catalog", async () => {
    const root = temporaryRoot("session-id-unified-provider-settings-");
    const provider = controlledProviderOwner({
      configuredProviderFamilies: ["codex"],
      modelCatalog: Object.freeze([
        Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
        Object.freeze({ modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" }),
      ]),
      readiness(input) {
        return Object.freeze({
          profileRevisionId: input.profile.profileRevisionId,
          providerFamily: input.profile.providerFamily,
          acpAgentKind: input.profile.acpAgentKind,
          role: input.role,
          status: "available" as const,
          reasons: Object.freeze([]),
          missingCapabilities: Object.freeze([]),
          missingExtensions: Object.freeze([]),
          model: input.profile.model,
          modelCatalog: Object.freeze([
            Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
            Object.freeze({ modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" }),
          ]),
        });
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_provider_settings",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });

    expect(provider.checkProfileReadiness).not.toHaveBeenCalled();
    await expect(host.readConfiguration({ kind: "provider_settings" } as never)).resolves.toMatchObject({
      kind: "provider_settings",
      model: {
        providers: [
          { providerFamily: "opencode", configured: false, status: "not_configured", models: [] },
          { providerFamily: "codex", configured: true, status: "not_checked", models: [] },
          { providerFamily: "claude-code", configured: false, status: "not_configured", models: [] },
        ],
      },
    });

    const result = await host.command({
      type: "provider.probe_models",
      commandId: "command_probe-codex",
      uiIntentId: "ui_intent_probe-codex",
      issuedAt: NOW,
      providerFamily: "codex",
    } as never, {
      authenticatedUserId: "user_provider_settings",
      source: "authenticated_runtime_bridge",
    });

    expect(provider.inspectProviderModelCatalog).toHaveBeenCalledTimes(1);
    expect(provider.checkProfileReadiness).not.toHaveBeenCalled();
    if (!("providerSettings" in result)) throw new Error("test_provider_settings_missing");
    expect(result.providerSettings.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerFamily: "codex", configured: true, status: "not_checked", models: [
        { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      ] }),
    ]));
    await host.close();
  });

  it("routes device installation discovery, private configuration and observed default selection through the Provider owner", async () => {
    const root = temporaryRoot("session-id-unified-provider-setup-");
    const provider = controlledProviderOwner({
      configuredProviderFamilies: ["codex"],
      modelCatalog: Object.freeze([
        Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
      ]),
      providerSetup: () => Object.freeze({
        configurationSource: "local" as const,
        installation: Object.freeze({
          status: "ready" as const,
          components: Object.freeze([
            Object.freeze({ kind: "provider_cli" as const, label: "Codex CLI", status: "found" as const, displayPath: "/opt/bin/codex" }),
          ]),
        }),
        modelCatalog: Object.freeze([Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" })]),
        enabledChatModelIds: Object.freeze([]),
      }),
      readiness(input) {
        return Object.freeze({
          profileRevisionId: input.profile.profileRevisionId,
          providerFamily: "codex" as const,
          acpAgentKind: "codex_acp" as const,
          role: input.role,
          status: "available" as const,
          reasons: Object.freeze([]),
          missingCapabilities: Object.freeze([]),
          missingExtensions: Object.freeze([]),
          model: input.profile.model,
          modelCatalog: Object.freeze([Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" })]),
        });
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_provider_setup",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });
    const authentication = { authenticatedUserId: "user_provider_setup", source: "authenticated_runtime_bridge" as const };

    await host.command({
      type: "provider.discover_installation",
      commandId: "command_discover-codex",
      uiIntentId: "ui_intent_discover-codex",
      issuedAt: NOW,
      providerFamily: "codex",
    }, authentication);
    expect(provider.discoverProviderInstallation).toHaveBeenCalledWith("codex");

    const installation = Object.freeze({
      kind: "codex" as const,
      wrapperPath: "/opt/bin/codex-acp",
      codexPath: "/opt/bin/codex",
      nodePath: "/opt/bin/node",
      authFilePath: "/private/auth.json",
    });
    await host.command({
      type: "provider.configure_installation",
      commandId: "command_configure-codex",
      uiIntentId: "ui_intent_configure-codex",
      issuedAt: NOW,
      providerFamily: "codex",
      installation,
    }, authentication);
    expect(provider.configureProviderInstallation).toHaveBeenCalledWith("codex", installation);

    await host.command({
      type: "provider.probe_models",
      commandId: "command_probe-codex-setup",
      uiIntentId: "ui_intent_probe-codex-setup",
      issuedAt: NOW,
      providerFamily: "codex",
    }, authentication);
    await host.command({
      type: "provider.configure_chat_models",
      commandId: "command_default-codex",
      uiIntentId: "ui_intent_default-codex",
      issuedAt: NOW,
      providerFamily: "codex",
      modelIds: Object.freeze(["gpt-5.6-luna"]),
      defaultModelId: "gpt-5.6-luna",
    }, authentication);
    expect(provider.configureProviderChatModels).toHaveBeenCalledWith("codex", ["gpt-5.6-luna"], "gpt-5.6-luna");
    await expect(host.command({
      type: "provider.configure_chat_models",
      commandId: "command_default-invented",
      uiIntentId: "ui_intent_default-invented",
      issuedAt: NOW,
      providerFamily: "codex",
      modelIds: Object.freeze(["invented-model"]),
      defaultModelId: "invented-model",
    }, authentication)).rejects.toThrow("session_id_acp_provider_model_not_observed");

    await host.close();
  });

  it("keeps startup cleanup failure sticky and leaves SQLite open for late owner receipts", async () => {
    const root = temporaryRoot("session-id-unified-startup-cleanup-");
    const sqliteClose = vi.spyOn(SqliteRuntimeStore.prototype, "close");
    let ownerInput: SessionIdUnifiedAcpProviderFactoryInput | undefined;
    const provider = controlledProviderOwner({
      onAttach() {
        throw new Error("controlled_attach_failed");
      },
      async close() {
        throw new Error("controlled_cleanup_unconfirmed");
      },
    });
    try {
      await expect(createSessionIdUnifiedRuntimeHost({
        databasePath: path.join(root, "runtime.sqlite"),
        authenticatedUserId: "user_startup_cleanup",
        authorizeRetiringBindingRecovery: () => false,
        createProviderOwner(input) {
          ownerInput = input;
          return provider.owner;
        },
        createId: stableIds(),
        now: () => NOW,
      })).rejects.toThrow("session_id_acp_application_cleanup_unconfirmed");
      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(sqliteClose).not.toHaveBeenCalled();
      expect(ownerInput?.repositories.sessionRuntime.getRuntimeForSession("logical_session_late_receipt"))
        .toBeUndefined();
    } finally {
      sqliteClose.mockRestore();
    }
  });

  it("replays normal cleanup failure without closing SQLite ahead of late receipts", async () => {
    const root = temporaryRoot("session-id-unified-close-cleanup-");
    const provider = controlledProviderOwner({
      async close() {
        throw new Error("controlled_cleanup_unconfirmed");
      },
    });
    let ownerInput: SessionIdUnifiedAcpProviderFactoryInput | undefined;
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_close_cleanup",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner(input) {
        ownerInput = input;
        return provider.owner;
      },
      createId: stableIds(),
      now: () => NOW,
    });
    const sqliteClose = vi.spyOn(SqliteRuntimeStore.prototype, "close");
    try {
      await expect(host.close()).rejects.toThrow("session_id_acp_application_cleanup_unconfirmed");
      await expect(host.close()).rejects.toThrow("session_id_acp_application_cleanup_unconfirmed");
      expect(provider.close).toHaveBeenCalledTimes(1);
      expect(sqliteClose).not.toHaveBeenCalled();
      expect(ownerInput?.repositories.sessionRuntime.getRuntimeForSession("logical_session_late_receipt"))
        .toBeUndefined();
    } finally {
      sqliteClose.mockRestore();
    }
  });

  it("settles lifecycle-owned Meta drains before closing the ACP application", async () => {
    const root = temporaryRoot("session-id-unified-close-order-");
    const events: string[] = [];
    let startMetaTurn!: () => void;
    const metaTurnStarted = new Promise<void>((resolve) => {
      startMetaTurn = resolve;
    });
    const provider = controlledProviderOwner({
      metaAgentRegistrations: [Object.freeze({
        option: CONTROLLED_META_OPTION,
        port: Object.freeze({
          async checkMetaProfileReadiness() {
            return CONTROLLED_META_READINESS;
          },
          async openMetaSession() {
            return { available: true as const, readiness: CONTROLLED_META_READINESS };
          },
          async startMetaTurn() {
            startMetaTurn();
            return await new Promise<"accepted">(() => undefined);
          },
          async reconcileMetaTurn() {
            return { state: "unknown" as const };
          },
        }),
      })],
      async close() {
        events.push("provider-close");
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_local",
      authorizeRetiringBindingRecovery: () => false,
      workspaceBootstrapGrants: [{
        commandId: "command_workspace-close-order",
        workspaceId: "workspace_close-order",
        directory: root,
      }],
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });
    const authentication = {
      authenticatedUserId: "user_local",
      source: "authenticated_runtime_bridge" as const,
    };
    const draftResult = await host.command({
      type: "task_setup.create_draft",
      commandId: "command_setup-close-order",
      uiIntentId: "ui_setup-close-order",
      issuedAt: NOW,
      ownerId: "user_local",
      templateVersionId: BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
      workspaceId: "workspace_close-order",
      title: "Close order",
      goal: "Keep one Meta drain pending during close.",
      taskInputValues: [],
    }, authentication);
    if (!("taskSetupDraft" in draftResult) || !draftResult.taskSetupDraft) {
      throw new Error("test_task_setup_missing");
    }
    const metaResult = await host.command({
      type: "meta.create_session",
      commandId: "command_meta-close-order",
      uiIntentId: "ui_meta-close-order",
      issuedAt: NOW,
      ownerId: "user_local",
      metaProfileOptionId: CONTROLLED_META_OPTION.metaProfileOptionId,
      target: {
        kind: "task_setup_draft",
        taskSetupDraftId: draftResult.taskSetupDraft.taskSetupDraftId,
      },
    }, authentication);
    if (!("metaSession" in metaResult) || !metaResult.metaSession) throw new Error("test_meta_session_missing");
    await host.command({
      type: "meta.send_message",
      commandId: "command_meta-send-close-order",
      uiIntentId: "ui_meta-send-close-order",
      issuedAt: NOW,
      ownerId: "user_local",
      metaSessionId: metaResult.metaSession.metaSessionId,
      expectedSessionRevision: metaResult.metaSession.revision,
      expectedTargetRevision: draftResult.taskSetupDraft.revision,
      idempotencyKey: "meta-send-close-order",
      content: "Wait until the lifecycle closes.",
    }, authentication);
    const drain = host.drainMetaTurns().finally(() => events.push("meta-drain-settled"));
    await metaTurnStarted;

    await host.close();
    await drain;

    expect(events).toEqual(["meta-drain-settled", "provider-close"]);
  });

  it("automatically drains a persisted MetaTurn and publishes its typed proposal", async () => {
    const root = temporaryRoot("session-id-unified-meta-pump-");
    let reconcileCalls = 0;
    const provider = controlledProviderOwner({
      metaAgentRegistrations: [Object.freeze({
        option: CONTROLLED_META_OPTION,
        port: Object.freeze({
          async checkMetaProfileReadiness() {
            return CONTROLLED_META_READINESS;
          },
          async openMetaSession() {
            return { available: true as const, readiness: CONTROLLED_META_READINESS };
          },
          async startMetaTurn(
            _request: AcpMetaAgentTurnRequest,
            tools?: ProviderScopedToolTurnContext,
          ) {
            if (!tools) throw new Error("test_template_tools_missing");
            const calls = [
              {
                name: "template_draft_update_metadata",
                arguments: { field: "title", value: "Meta reviewed Luna flow" },
              },
              {
                name: "template_draft_create_card",
                arguments: {
                  proposalRef: "search_2",
                  cardKind: "researcher",
                  title: "Search Agent 2",
                  executionProfileId: "profile_deepsearch-researcher",
                  systemPrompt: "Research one independent evidence branch.",
                  dispatchProfile: { title: "Independent search 2", description: "Use for a second parallel search branch." },
                },
              },
              {
                name: "template_draft_reorder_cards",
                arguments: {
                  cardRefs: [
                    "agent_card_deepsearch-researcher",
                    "search_2",
                    "agent_card_deepsearch-reviewer",
                    "agent_card_deepsearch-publisher",
                  ],
                },
              },
              {
                name: "template_draft_edit_prompt",
                arguments: {
                  target: { kind: "card", agentCardId: "agent_card_deepsearch-reviewer" },
                  oldText: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons.",
                  newText: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons and cite every unresolved gap.",
                },
              },
            ];
            for (const [index, call] of calls.entries()) {
              await tools.handleCall({
                providerCallId: `provider_call_meta-pump-${index}`,
                name: call.name,
                arguments: call.arguments,
                lease: tools.lease,
              });
            }
            return "accepted" as const;
          },
          async reconcileMetaTurn() {
            reconcileCalls += 1;
            return {
              state: "returned" as const,
              observedAt: NOW,
              finalText: JSON.stringify({
                assistantMessage: "Prepared one title change and one independently reviewable search card.",
                proposal: {
                  summary: "Rename the template and add a search card",
                  rationale: "The requested title is more specific and the new branch remains independently reviewable.",
                  operations: [
                    { kind: "template_metadata_set", field: "title", value: "Meta reviewed Luna flow" },
                    {
                      kind: "template_card_create",
                      proposalRef: "search_2",
                      cardKind: "researcher",
                      title: "Search Agent 2",
                      executionProfileId: "profile_deepsearch-researcher",
                      systemPrompt: "Research one independent evidence branch.",
                      dispatchProfile: { title: "Independent search 2", description: "Use for a second parallel search branch." },
                    },
                    {
                      kind: "template_card_reorder",
                      cardRefs: [
                        "agent_card_deepsearch-researcher",
                        "search_2",
                        "agent_card_deepsearch-reviewer",
                        "agent_card_deepsearch-publisher",
                      ],
                    },
                    {
                      kind: "template_card_prompt_edit",
                      agentCardId: "agent_card_deepsearch-reviewer",
                      oldText: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons.",
                      newText: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons and cite every unresolved gap.",
                    },
                  ],
                  validationIssues: [],
                },
              }),
            };
          },
        }),
      })],
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_meta_pump",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      dispatchIntervalMs: 25,
      now: () => NOW,
    });
    const authentication = {
      authenticatedUserId: "user_meta_pump",
      source: "authenticated_runtime_bridge" as const,
    };
    const draftResult = await host.command({
      type: "template.create_draft",
      commandId: "command_meta-pump-draft",
      uiIntentId: "ui_meta-pump-draft",
      issuedAt: NOW,
      ownerId: "user_meta_pump",
      baseTemplateVersionId: BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
      metadata: { title: "Before Meta", slug: "before-meta" },
      initialDefinition: BUILT_IN_TEMPLATE_PACKAGES[0]!.package.definition,
    }, authentication);
    if (!("templateDraft" in draftResult) || !draftResult.templateDraft) throw new Error("test_template_draft_missing");
    const draft = draftResult.templateDraft;
    const sessionResult = await host.command({
      type: "meta.create_session",
      commandId: "command_meta-pump-session",
      uiIntentId: "ui_meta-pump-session",
      issuedAt: NOW,
      ownerId: "user_meta_pump",
      metaProfileOptionId: CONTROLLED_META_OPTION.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: draft.templateDraftId },
    }, authentication);
    if (!("metaSession" in sessionResult) || !sessionResult.metaSession) throw new Error("test_meta_session_missing");
    await host.command({
      type: "meta.send_message",
      commandId: "command_meta-pump-send",
      uiIntentId: "ui_meta-pump-send",
      issuedAt: NOW,
      ownerId: "user_meta_pump",
      metaSessionId: sessionResult.metaSession.metaSessionId,
      expectedSessionRevision: sessionResult.metaSession.revision,
      expectedTargetRevision: draft.revision,
      idempotencyKey: "meta-pump-send",
      content: "Change only the title.",
    }, authentication);

    await expect.poll(async () => {
      const read = await host.readConfiguration({
        kind: "meta",
        scope: { kind: "template_design", draftId: draft.templateDraftId, draftRevision: draft.revision },
      });
      if (read.kind !== "meta") return 0;
      return Array.isArray(read.model.proposals) ? read.model.proposals.length : 0;
    }, { timeout: 2_000 }).toBe(1);
    const metaRead = await host.readConfiguration({
      kind: "meta",
      scope: { kind: "template_design", draftId: draft.templateDraftId, draftRevision: draft.revision },
    });
    if (metaRead.kind !== "meta") throw new Error("test_meta_read_missing");
    if (!Array.isArray(metaRead.model.proposals)) throw new Error("test_meta_proposals_missing");
    expect(metaRead.model.profileOptions).toEqual([expect.objectContaining({
      schemaVersion: 3,
      metaProfileOptionId: CONTROLLED_META_OPTION.metaProfileOptionId,
      providerFamily: "codex",
      model: "controlled-meta",
      configIntent: { reasoningEffort: "high" },
    })]);
    const proposal = metaRead.model.proposals[0] as {
      proposalId: string;
      fieldDiffs: readonly Readonly<{ path: string; operation: string; before?: string; after?: string }>[];
    };
    expect(proposal.fieldDiffs).toHaveLength(4);
    expect(proposal.fieldDiffs[0]).toEqual({
      path: "metadata.title",
      operation: "replace",
      before: "Before Meta",
      after: "Meta reviewed Luna flow",
    });
    expect(proposal.fieldDiffs[1]).toMatchObject({
      path: "definition.agentCards[Search Agent 2]",
      operation: "add",
    });
    expect(proposal.fieldDiffs[1]?.after).toContain('"title": "Search Agent 2"');
    expect(proposal.fieldDiffs[2]).toMatchObject({
      path: "definition.agentCards.order",
      operation: "replace",
    });
    expect(proposal.fieldDiffs[3]).toEqual({
      path: "definition.agentCards[agent_card_deepsearch-reviewer].systemPrompt",
      operation: "replace",
      before: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons.",
      after: "Return a clear pass, revise, or insufficient-evidence decision with exact reasons and cite every unresolved gap.",
    });

    await host.command({
      type: "meta.apply_patch",
      commandId: "command_meta-pump-apply",
      uiIntentId: "ui_meta-pump-apply",
      issuedAt: NOW,
      ownerId: "user_meta_pump",
      metaSessionId: sessionResult.metaSession.metaSessionId,
      metaPatchProposalId: proposal.proposalId,
      expectedTargetRevision: draft.revision,
    }, authentication);
    const studio = await host.readConfiguration({ kind: "template_studio" });
    if (studio.kind !== "template_studio") throw new Error("test_template_studio_read_missing");
    const appliedDraft = (studio.model.drafts as readonly Readonly<{
      templateDraftId: string;
      revision: number;
      definitionText: string;
    }>[]).find((candidate) => candidate.templateDraftId === draft.templateDraftId);
    expect(appliedDraft?.revision).toBe(draft.revision + 1);
    const appliedDefinition = JSON.parse(appliedDraft!.definitionText) as { agentCards: readonly Readonly<{ agentCardId: string; title: string; capabilityRefs: readonly unknown[] }>[] };
    expect(appliedDefinition.agentCards.map(({ agentCardId, title, capabilityRefs }) => ({ agentCardId, title, capabilityRefs }))).toEqual([
      { agentCardId: "agent_card_deepsearch-researcher", title: "Researcher", capabilityRefs: [] },
      { agentCardId: "agent_card_test-1", title: "Search Agent 2", capabilityRefs: [] },
      { agentCardId: "agent_card_deepsearch-reviewer", title: "Reviewer", capabilityRefs: [] },
      { agentCardId: "agent_card_deepsearch-publisher", title: "Publisher", capabilityRefs: [] },
    ]);
    expect(reconcileCalls).toBe(1);
    await host.close();
  });

  it("projects cached v3 readiness from full frozen Profile plus role without Provider effects", async () => {
    const root = temporaryRoot("session-id-unified-readiness-");
    const provider = controlledProviderOwner({
      readiness({ profile, role }) {
        return Object.freeze({
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
          acpAgentKind: profile.acpAgentKind,
          role,
          status: "available" as const,
          reasons: Object.freeze([]),
          missingCapabilities: Object.freeze([]),
          missingExtensions: Object.freeze([]),
          model: profile.model,
          observedProtocolMajor: 1,
          observedAgent: Object.freeze({ name: "controlled-current-acp", version: "current" }),
        });
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_readiness",
      authorizeRetiringBindingRecovery: () => false,
      workspaceBootstrapGrants: [{
        commandId: "command_workspace-readiness",
        workspaceId: "workspace_readiness",
        directory: root,
        displayName: "Readiness Workspace",
      }],
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });
    const authentication = {
      authenticatedUserId: "user_readiness",
      source: "authenticated_runtime_bridge" as const,
    };
    const created = await host.command({
      type: "task_setup.create_draft",
      commandId: "command_setup-readiness",
      uiIntentId: "ui_setup-readiness",
      issuedAt: NOW,
      ownerId: "user_readiness",
      templateVersionId: BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
      workspaceId: "workspace_readiness",
      title: "ACP readiness",
      goal: "Render only cached current-install observations.",
      taskInputValues: [],
    }, authentication);
    if (!("taskSetupDraft" in created) || !created.taskSetupDraft) throw new Error("test_task_setup_missing");

    const read = await host.readConfiguration({
      kind: "task_setup",
      taskSetupDraftId: created.taskSetupDraft.taskSetupDraftId,
    });
    if (read.kind !== "task_setup") throw new Error("test_task_setup_read_missing");
    const profileOptions = read.model.profileOptions;
    expect(Array.isArray(profileOptions)).toBe(true);
    expect((profileOptions as readonly unknown[]).slice(0, 2)).toMatchObject([
        {
          schemaVersion: 3,
          permissionMode: "preapproved",
          allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
          requiredExtensions: [],
          readiness: { status: "available", role: "conductor", observedProtocolMajor: 1 },
        },
        {
          schemaVersion: 3,
          permissionMode: "preapproved",
          allowedTools: [],
          requiredExtensions: [],
          readiness: { status: "available", role: "researcher", observedProtocolMajor: 1 },
        },
      ]);
    expect(provider.readiness).toHaveBeenCalledTimes(4);
    expect(provider.executeProviderEffect).not.toHaveBeenCalled();
    expect(provider.retireBinding).not.toHaveBeenCalled();
    expect(host.readCommandEvidence()).toEqual([expect.objectContaining({
      uiIntentId: "ui_setup-readiness",
      commandId: "command_setup-readiness",
      intentKind: "task_setup.create_draft",
    })]);
    await host.close();
  });

  it("projects the complete role-scoped Deepsearch Provider and model catalog without Provider effects", async () => {
    const root = temporaryRoot("session-id-unified-template-options-");
    const provider = controlledProviderOwner({
      readiness({ profile, role }) {
        return Object.freeze({
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
          acpAgentKind: profile.acpAgentKind,
          role,
          status: "available" as const,
          reasons: Object.freeze([]),
          missingCapabilities: Object.freeze([]),
          missingExtensions: Object.freeze([]),
          model: profile.model,
          observedProtocolMajor: 1,
          observedAgent: Object.freeze({ name: "codex-acp", version: "current" }),
        });
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_template_options",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });

    const read = await host.readConfiguration({
      kind: "template_studio",
      templateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
    });
    if (read.kind !== "template_studio") throw new Error("test_template_studio_read_missing");
    const profileOptions = read.model.profileOptions;
    expect(Array.isArray(profileOptions)).toBe(true);
    expect((profileOptions as readonly Record<string, unknown>[])).toHaveLength(12);
    expect((profileOptions as readonly Record<string, unknown>[]).map((option) => ({
      sourceTemplateId: option.sourceTemplateId,
      role: option.role,
      providerFamily: option.providerFamily,
      model: option.model,
      readiness: option.readiness,
    }))).toMatchObject([
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "conductor", providerFamily: "codex", model: "gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "publisher", providerFamily: "codex", model: "gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "reviewer", providerFamily: "codex", model: "gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "researcher", providerFamily: "codex", model: "gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "conductor", providerFamily: "claude-code", model: "claude-opus-5[1M]", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "publisher", providerFamily: "claude-code", model: "claude-opus-5[1M]", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "reviewer", providerFamily: "claude-code", model: "claude-opus-5[1M]", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "researcher", providerFamily: "claude-code", model: "claude-opus-5[1M]", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "conductor", providerFamily: "opencode", model: "opencode-go/gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "publisher", providerFamily: "opencode", model: "opencode-go/gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "reviewer", providerFamily: "opencode", model: "opencode-go/gpt-5.6-luna", readiness: { status: "available" } },
      { sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID, role: "researcher", providerFamily: "opencode", model: "opencode-go/gpt-5.6-luna", readiness: { status: "available" } },
    ]);
    expect(provider.readiness).toHaveBeenCalledTimes(12);
    expect(provider.executeProviderEffect).not.toHaveBeenCalled();
    await host.close();
  });

  it("expands only settings-enabled Codex models into distinct Host-issued Effort profiles", async () => {
    const root = temporaryRoot("session-id-unified-template-effort-options-");
    const provider = controlledProviderOwner({
      providerSetup(providerFamily) {
        return Object.freeze({
          configurationSource: "local" as const,
          installation: Object.freeze({ status: "ready" as const, components: Object.freeze([]) }),
          modelCatalog: providerFamily === "codex"
            ? Object.freeze([
                Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
                Object.freeze({ modelId: "gpt-5.7-hidden", label: "GPT-5.7 Hidden" }),
              ])
            : Object.freeze([]),
          enabledChatModelIds: providerFamily === "codex"
            ? Object.freeze(["gpt-5.6-luna"])
            : Object.freeze([]),
          ...(providerFamily === "codex" ? { defaultModelId: "gpt-5.6-luna" } : {}),
        });
      },
    });
    const host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(root, "runtime.sqlite"),
      authenticatedUserId: "user_template_effort_options",
      authorizeRetiringBindingRecovery: () => false,
      createProviderOwner: () => provider.owner,
      createId: stableIds(),
      now: () => NOW,
    });

    const read = await host.readConfiguration({
      kind: "template_studio",
      templateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
    });
    if (read.kind !== "template_studio") throw new Error("test_template_studio_read_missing");
    const codexConductor = (read.model.profileOptions as readonly Readonly<{
      role: string;
      providerFamily: string;
      model: string;
      profileRevisionId: string;
      configIntent: Readonly<Record<string, unknown>>;
    }>[]).filter((option) => option.role === "conductor" && option.providerFamily === "codex");
    expect(codexConductor).toHaveLength(5);
    expect(codexConductor.map(({ configIntent }) => JSON.stringify(configIntent)).sort()).toEqual([
      JSON.stringify({}),
      JSON.stringify({ reasoningEffort: "low" }),
      JSON.stringify({ reasoningEffort: "medium" }),
      JSON.stringify({ reasoningEffort: "high" }),
      JSON.stringify({ reasoningEffort: "xhigh" }),
    ].sort());
    expect(new Set(codexConductor.map(({ profileRevisionId }) => profileRevisionId)).size).toBe(5);
    expect(JSON.stringify(read.model.profileOptions)).not.toContain("gpt-5.7-hidden");
    expect(provider.executeProviderEffect).not.toHaveBeenCalled();
    await host.close();
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function controlledProviderOwner(options: Readonly<{
  onAttach?: (input: Parameters<SessionIdUnifiedAcpProviderOwner["attachRuntime"]>[0]) => void;
  readiness?: SessionIdUnifiedAcpProviderOwner["readCachedProfileReadiness"];
  metaAgentRegistrations?: SessionIdUnifiedAcpProviderOwner["metaAgentRegistrations"];
  configuredProviderFamilies?: SessionIdUnifiedAcpProviderOwner["configuredProviderFamilies"];
  providerSetup?: SessionIdUnifiedAcpProviderOwner["readProviderSetup"];
  modelCatalog?: readonly Readonly<{ modelId: string; label: string }>[];
  close?: () => Promise<void>;
}> = {}) {
  const executeProviderEffect = vi.fn(async () => {
    throw new Error("controlled_provider_effect_not_expected");
  });
  const retireBinding = vi.fn(async () => {
    throw new Error("controlled_binding_retirement_not_expected");
  });
  const retireBindingForClose = vi.fn(async () => {
    throw new Error("controlled_close_retirement_not_expected");
  });
  const close = vi.fn(options.close ?? (async () => undefined));
  const attachRuntime = vi.fn(async (input: Parameters<SessionIdUnifiedAcpProviderOwner["attachRuntime"]>[0]) => {
    options.onAttach?.(input);
  });
  const readiness = vi.fn(options.readiness ?? (() => undefined));
  const checkProfileReadiness = vi.fn(async (input: Parameters<
    SessionIdUnifiedAcpProviderOwner["checkProfileReadiness"]
  >[0]) => readiness(input) ?? Object.freeze({
    profileRevisionId: input.profile.profileRevisionId,
    providerFamily: input.profile.providerFamily,
    acpAgentKind: input.profile.acpAgentKind,
    role: input.role,
    status: "unavailable" as const,
    reasons: Object.freeze(["controlled_readiness_unavailable"]),
    missingCapabilities: Object.freeze([]),
    missingExtensions: Object.freeze([]),
    model: input.profile.model,
  }));
  const defaultProviderSetup = () => Object.freeze({
    configurationSource: "environment" as const,
    installation: Object.freeze({ status: "not_scanned" as const, components: Object.freeze([]) }),
    modelCatalog: Object.freeze([]),
    enabledChatModelIds: Object.freeze([]),
  });
  const readProviderSetup = vi.fn(options.providerSetup ?? defaultProviderSetup);
  const discoverProviderInstallation = vi.fn(options.providerSetup ?? defaultProviderSetup);
  const configureProviderInstallation = vi.fn(options.providerSetup ?? defaultProviderSetup);
  const recordProviderModelCatalog = vi.fn(options.providerSetup ?? defaultProviderSetup);
  const configureProviderChatModels = vi.fn(options.providerSetup ?? defaultProviderSetup);
  const inspectProviderModelCatalog = vi.fn(async () => Object.freeze([
    ...(options.modelCatalog ?? []),
  ]));
  const owner: SessionIdUnifiedAcpProviderOwner = Object.freeze({
    provider: Object.freeze({
      executeProviderEffect,
      retireBinding,
      retireBindingForClose,
    }) as SessionIdUnifiedAcpProviderOwner["provider"],
    metaAgentRegistrations: Object.freeze(options.metaAgentRegistrations ?? []),
    configuredProviderFamilies: Object.freeze(options.configuredProviderFamilies ?? (["opencode", "codex", "claude-code"] as const)),
    readProviderSetup,
    discoverProviderInstallation,
    configureProviderInstallation,
    recordProviderModelCatalog,
    configureProviderChatModels,
    syncMetaAgentRegistrations: () => owner.metaAgentRegistrations,
    readActiveMetaAgentRegistrations: () => owner.metaAgentRegistrations,
    inspectProviderModelCatalog,
    readCachedProfileReadiness: readiness,
    checkProfileReadiness,
    attachRuntime,
    close,
  });
  return {
    owner,
    executeProviderEffect,
    retireBinding,
    close,
    attachRuntime,
    readiness,
    checkProfileReadiness,
    discoverProviderInstallation,
    configureProviderInstallation,
    recordProviderModelCatalog,
    configureProviderChatModels,
    inspectProviderModelCatalog,
  };
}

function stableIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_test-${next}`;
  };
}
