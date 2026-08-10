import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpRuntimeClient } from "../../../packages/runtime-client/src/http.js";
import { createRuntimeBridgeServer } from "./runtime-bridge.js";
import { createRuntimeHost } from "./runtime-host.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("Runtime Bridge", () => {
  it("returns fixed safe readiness errors that the Browser client preserves", async () => {
    const cases = [
      ["execution_profile_unavailable:profile_opencode_free:provider_version_mismatch,token=host-secret", "provider_version_mismatch"],
      ["execution_profile_unavailable:profile_opencode_free:protocol_fingerprint_mismatch,token=host-secret", "protocol_fingerprint_mismatch"],
      ["execution_profile_unavailable:profile_opencode_free:capability_interrupt_unavailable,token=host-secret", "capability_missing"],
      ["execution_profile_unavailable:profile_opencode_free:provider_unavailable,token=host-secret", "provider_unavailable"],
      ["execution_profile_unavailable:profile_opencode_free:provider_probe_failed,token=host-secret", "execution_profile_unavailable"],
      ["provider_unavailable:opencode", "provider_unavailable"],
    ] as const;
    const diagnostics = new Map(cases.map(([diagnostic], index) => [`command_readiness_${index}`, diagnostic]));
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      host: {
        read: () => ({
          generatedAt: "2026-08-09T00:00:00.000Z",
          configuration: {
            metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [],
            metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [],
          },
          workspaceLibrary: { authorizations: [] },
          templateLibrary: { templates: [], drafts: [] },
          taskLibrary: { tasks: [] },
        }),
        command: async (command: { commandId: string }) => {
          throw new Error(diagnostics.get(command.commandId) ?? "token=unexpected-secret");
        },
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const client = createHttpRuntimeClient({ baseUrl: address.url, authorization: "bridge-token" });
      for (const [index, [, code]] of cases.entries()) {
        const command = { type: "task.start", commandId: `command_readiness_${index}` } as never;
        const response = await fetch(`${address.url}/runtime/command`, {
          method: "POST",
          headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
          body: JSON.stringify(command),
        });
        const body = await response.text();
        expect(response.status).toBe(400);
        expect(JSON.parse(body)).toEqual({ error: { code } });
        expect(body).not.toContain("profile_opencode_free");
        expect(body).not.toContain("host-secret");
        expect(body).not.toContain("opencode");
        await expect(client.command(command)).rejects.toMatchObject({ message: code });
      }
    } finally {
      await bridge.close();
    }
  });

  it("maps unknown Runtime diagnostics to a fixed command failure code", async () => {
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      host: {
        read: () => { throw new Error("token=host-secret account=private@example.test"); },
        command: async () => { throw new Error("token=host-secret account=private@example.test"); },
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const response = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: { code: "runtime_command_failed" } });
      expect(body).not.toContain("host-secret");
      expect(body).not.toContain("private@example.test");
    } finally {
      await bridge.close();
    }
  });

  it("preserves the fixed stale-revision code from a real Runtime Host domain failure", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-bridge-stale-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    const bridge = createRuntimeBridgeServer({
      host,
      token: "bridge-token",
      scope: { actor: "user", userId: "user_1", workspaceIds: ["workspace_1"] },
    });
    const address = await bridge.listen();
    const client = createHttpRuntimeClient({ baseUrl: address.url, authorization: "bridge-token" });
    const issuedAt = "2026-08-09T00:00:00.000Z";
    try {
      await client.command({
        type: "template.create_draft", commandId: "command_stale_draft", issuedAt,
        ownerId: "user_1", metadata: { title: "Stale test" }, initialDefinition: templateDefinition(),
      });
      const draft = (await client.read()).templateLibrary.drafts[0]!;
      await client.command({
        type: "template.publish_draft", commandId: "command_stale_publish", issuedAt,
        templateDraftId: draft.templateDraftId, expectedRevision: draft.revision, slug: "stale-test", title: "Stale test",
      });
      const versionId = (await client.read()).templateLibrary.templates[0]!.template.activeVersionId!;
      await client.command({
        type: "workspace.authorize", commandId: "command_stale_workspace", issuedAt,
        workspaceId: "workspace_1", directory,
      });
      const setup = await client.command({
        type: "task_setup.create_draft", commandId: "command_stale_setup", issuedAt,
        ownerId: "user_1", templateVersionId: versionId, workspaceId: "workspace_1",
        title: "Stale test", goal: "Exercise the real DomainInvariantError.", taskInputValues: [],
      });
      const created = await client.command({
        type: "task.create", commandId: "command_stale_create", issuedAt,
        taskId: "task_stale", ownerId: "user_1", workspaceId: "workspace_1",
        taskSetupDraftId: setup.taskSetupDraft!.taskSetupDraftId,
        expectedTaskSetupRevision: setup.taskSetupDraft!.revision,
      });
      const staleRevision = created.task!.revision + 1;
      const staleResponse = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task.achieve", commandId: "command_stale_direct", issuedAt,
          taskId: "task_stale", expectedRevision: staleRevision, acceptedArtifactIds: [],
        }),
      });
      const body = await staleResponse.text();
      expect(JSON.parse(body)).toEqual({ error: { code: "expected_revision_stale" } });
      expect(body).not.toContain("expected revision");
      expect(body).not.toContain(`found ${created.task!.revision}`);

      await expect(client.command({
        type: "task.achieve", commandId: "command_stale_browser", issuedAt,
        taskId: "task_stale", expectedRevision: staleRevision, acceptedArtifactIds: [],
      })).rejects.toMatchObject({ message: "expected_revision_stale" });
    } finally {
      await bridge.close();
      await host.close();
    }
  });

  it("maps Meta availability failures to fixed Browser-safe codes without profile or reason detail", async () => {
    const cases = [
      ["meta_profile_option_unavailable:token=host-secret", "meta_profile_option_unavailable"],
      ["meta_agent_unavailable:codex", "meta_agent_provider_not_composed"],
      ["meta_agent_profile_unavailable:meta_profile_secret:meta_agent_provider_not_composed", "meta_agent_provider_not_composed"],
      ["meta_agent_profile_unavailable:meta_profile_secret:meta_profile_protocol_mismatch", "meta_profile_protocol_mismatch"],
      ["meta_agent_profile_unavailable:meta_profile_secret:meta_agent_capability_unavailable", "meta_agent_capability_unavailable"],
      ["meta_agent_profile_unavailable:meta_profile_secret:meta_agent_capability_probe_failed", "meta_agent_capability_probe_failed"],
      ["meta_agent_profile_unavailable:meta_profile_secret:token=raw-reason", "meta_agent_profile_unavailable"],
    ] as const;
    const diagnostics = new Map(cases.map(([diagnostic], index) => [`command_meta_${index}`, diagnostic]));
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      host: {
        read: () => ({
          generatedAt: "2026-08-09T00:00:00.000Z",
          configuration: {
            metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [],
            metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [],
          },
          workspaceLibrary: { authorizations: [] }, templateLibrary: { templates: [], drafts: [] }, taskLibrary: { tasks: [] },
        }),
        command: async (command: { commandId: string }) => {
          throw new Error(diagnostics.get(command.commandId) ?? "token=unexpected-secret");
        },
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    const client = createHttpRuntimeClient({ baseUrl: address.url, authorization: "bridge-token" });
    try {
      for (const [index, [diagnostic, code]] of cases.entries()) {
        const command = { type: "meta.send_message", commandId: `command_meta_${index}` } as never;
        const response = await fetch(`${address.url}/runtime/command`, {
          method: "POST",
          headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
          body: JSON.stringify(command),
        });
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: { code } });
        expect(body).not.toContain("meta_profile_secret");
        expect(body).not.toContain("host-secret");
        expect(body).not.toContain("raw-reason");
        expect(body).not.toBe(JSON.stringify({ error: diagnostic }));
        await expect(client.command(command)).rejects.toMatchObject({ message: code });
      }
    } finally {
      await bridge.close();
    }
  });

  it("forwards a focused Template history read without widening the bridge surface", async () => {
    const reads: unknown[] = [];
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      host: {
        read: (request: unknown) => {
          reads.push(request);
          return {
            generatedAt: "2026-08-06T00:00:00.000Z",
            workspaceLibrary: { authorizations: [] },
            templateLibrary: { templates: [], drafts: [] },
            taskLibrary: { tasks: [] },
          };
        },
        command: async () => ({ receipt: { commandId: "command_unused", acceptedAt: "2026-08-06T00:00:00.000Z" } }),
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const response = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({ templateId: "template_history", ignored: "never forwarded" }),
      });
      expect(response.status).toBe(200);
      expect(reads).toEqual([{ templateId: "template_history" }]);
    } finally {
      await bridge.close();
    }
  });

  it("allows only authenticated typed calls and forwards semantic invalidations over WebSocket", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-bridge-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    const bridge = createRuntimeBridgeServer({ host, token: "bridge-token", scope: { userId: "user_1", workspaceIds: ["workspace_1"] } });
    const address = await bridge.listen();
    try {
      const unauthorized = await fetch(`${address.url}/runtime/read`, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);

      const socket = new WebSocket(`${address.url.replace("http", "ws")}/runtime/subscribe`, ["agent-workspace-runtime", "bridge-token"]);
      await waitForOpen(socket);
      const message = waitForMessage(socket);
      const response = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "template.create_draft", commandId: "command_1", issuedAt: "2026-08-06T00:00:00.000Z",
          ownerId: "user_1", metadata: { title: "New Template" }, initialDefinition: templateDefinition(),
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ receipt: { commandId: "command_1" } });
      expect(await message).toMatchObject({ type: "runtime.invalidated", invalidation: { reasons: ["template_changed"] } });
      socket.close();

      const denied = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "template.create_draft", commandId: "command_2", issuedAt: "2026-08-06T00:00:01.000Z",
          ownerId: "other", metadata: { title: "Denied" }, initialDefinition: templateDefinition(),
        }),
      });
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });

      const workspaceDenied = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "workspace.authorize", commandId: "command_workspace_denied", issuedAt: "2026-08-06T00:00:02.000Z",
          workspaceId: "workspace_other", directory,
        }),
      });
      expect(workspaceDenied.status).toBe(400);
      expect(await workspaceDenied.json()).toEqual({ error: { code: "runtime_bridge_workspace_scope_denied" } });

      const setupOwnerDenied = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task_setup.create_draft", commandId: "command_setup_owner_denied", issuedAt: "2026-08-06T00:00:03.000Z",
          ownerId: "other", templateVersionId: "template_version_unknown", workspaceId: "workspace_1",
          title: "Denied", goal: "Must not cross owner scope.", taskInputValues: [],
        }),
      });
      expect(setupOwnerDenied.status).toBe(400);
      expect(await setupOwnerDenied.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });

      const setupWorkspaceDenied = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task_setup.create_draft", commandId: "command_setup_workspace_denied", issuedAt: "2026-08-06T00:00:04.000Z",
          ownerId: "user_1", templateVersionId: "template_version_unknown", workspaceId: "workspace_other",
          title: "Denied", goal: "Must not cross workspace scope.", taskInputValues: [],
        }),
      });
      expect(setupWorkspaceDenied.status).toBe(400);
      expect(await setupWorkspaceDenied.json()).toEqual({ error: { code: "runtime_bridge_workspace_scope_denied" } });

      const createOwnerDenied = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task.create", commandId: "command_task_owner_denied", issuedAt: "2026-08-06T00:00:05.000Z",
          taskId: "task_denied", ownerId: "other", workspaceId: "workspace_1",
          taskSetupDraftId: "task_setup_draft_unknown", expectedTaskSetupRevision: 1,
        }),
      });
      expect(createOwnerDenied.status).toBe(400);
      expect(await createOwnerDenied.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });

    } finally {
      await bridge.close();
      await host.close();
    }
  });

  it("isolates owner/workspace state before serving focused Tasks while published Templates stay shared", async () => {
    const reads: unknown[] = [];
    const commands: unknown[] = [];
    let publishInvalidation: ((invalidation: never) => void) | undefined;
    let subscriptionCount = 0;
    const tasks = [
      { taskId: "task_user_1", title: "Allowed Task" },
      { taskId: "task_user_2", title: "Other owner's Task" },
      { taskId: "task_other_workspace", title: "Other workspace Task" },
    ];
    const templates = [
      { template: { templateId: "template_user_1", title: "Allowed Template" }, activeVersion: { templateVersionId: "version_user_1" } },
      { template: { templateId: "template_user_2", title: "Shared published Template" }, activeVersion: { templateVersionId: "version_user_2" } },
    ];
    const modelFor = (request: { taskId?: string; templateId?: string } = {}) => ({
      generatedAt: "2026-08-09T00:00:00.000Z",
      configuration: {
        metaProfileOptions: [{ metaProfileOptionId: "shared_meta_option" }],
        executionProfileReadiness: [{ templateVersionId: "version_shared", executionProfileId: "profile_shared", status: "available" }],
        taskSetupDrafts: [
          { taskSetupDraftId: "setup_user_1", ownerId: "user_1", workspaceId: "workspace_1", createdTaskId: "task_user_1" },
          { taskSetupDraftId: "setup_user_2", ownerId: "user_2", workspaceId: "workspace_1", createdTaskId: "task_user_2" },
          { taskSetupDraftId: "setup_other_workspace", ownerId: "user_1", workspaceId: "workspace_2", createdTaskId: "task_other_workspace" },
        ],
        metaSessions: [
          { metaSessionId: "meta_session_user_1", ownerId: "user_1", mode: "task_setup", target: { kind: "task_setup_draft", taskSetupDraftId: "setup_user_1" } },
          { metaSessionId: "meta_session_user_2", ownerId: "user_2", mode: "task_setup", target: { kind: "task_setup_draft", taskSetupDraftId: "setup_user_2" } },
          { metaSessionId: "meta_session_other_workspace", ownerId: "user_1", mode: "task_setup", target: { kind: "task_setup_draft", taskSetupDraftId: "setup_other_workspace" } },
        ],
        metaMessages: [
          { metaMessageId: "meta_message_user_1", metaSessionId: "meta_session_user_1", ownerId: "user_1", content: "allowed" },
          { metaMessageId: "meta_message_user_2", metaSessionId: "meta_session_user_2", ownerId: "user_2", content: "owner secret" },
          { metaMessageId: "meta_message_other_workspace", metaSessionId: "meta_session_other_workspace", ownerId: "user_1", content: "workspace secret" },
        ],
        metaPatchProposals: [
          { metaPatchProposalId: "meta_patch_user_1", metaSessionId: "meta_session_user_1", ownerId: "user_1" },
          { metaPatchProposalId: "meta_patch_user_2", metaSessionId: "meta_session_user_2", ownerId: "user_2" },
          { metaPatchProposalId: "meta_patch_other_workspace", metaSessionId: "meta_session_other_workspace", ownerId: "user_1" },
        ],
        metaTurns: [
          { metaTurnId: "meta_turn_user_1", metaSessionId: "meta_session_user_1", userMetaMessageId: "meta_message_user_1", assistantMetaMessageId: "meta_message_user_1", metaPatchProposalId: "meta_patch_user_1" },
          { metaTurnId: "meta_turn_user_2", metaSessionId: "meta_session_user_2", userMetaMessageId: "meta_message_user_2", assistantMetaMessageId: "meta_message_user_2", metaPatchProposalId: "meta_patch_user_2" },
          { metaTurnId: "meta_turn_other_workspace", metaSessionId: "meta_session_other_workspace", userMetaMessageId: "meta_message_other_workspace", assistantMetaMessageId: "meta_message_other_workspace", metaPatchProposalId: "meta_patch_other_workspace" },
        ],
      },
      workspaceId: "workspace_2",
      workspaceLibrary: { authorizations: [
        { workspaceId: "workspace_1", displayName: "Allowed" },
        { workspaceId: "workspace_2", displayName: "Denied" },
      ] },
      templateLibrary: {
        templates,
        drafts: [
          { templateDraftId: "template_draft_user_1", templateId: "template_user_1", ownerId: "user_1" },
          { templateDraftId: "template_draft_user_2", templateId: "template_user_2", ownerId: "user_2" },
        ],
      },
      ...(request.templateId ? { template: {
        template: templates.find((entry) => entry.template.templateId === request.templateId)?.template,
        versions: [],
      } } : {}),
      taskLibrary: { tasks },
      ...(request.taskId ? { task: {
        task: tasks.find((task) => task.taskId === request.taskId),
        logicalSessions: [], bindings: [], inputs: [], invocations: [], sessionTurns: [], messages: [], relayBlocks: [],
        messageForwards: [], messageForwardBatches: [], humanInterventions: [], inboxItems: [], attentions: [],
        providerActivities: [], artifacts: [], presentations: [], timeline: [],
      } } : {}),
    });
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      scope: { actor: "user", userId: "user_1", workspaceIds: ["workspace_1"] },
      host: {
        read: (request: { taskId?: string; templateId?: string } = {}) => {
          reads.push(request);
          return modelFor(request);
        },
        command: async (command: unknown) => {
          commands.push(command);
          return { receipt: { commandId: "unused", acceptedAt: "2026-08-09T00:00:00.000Z" } };
        },
        subscribe: (listener: (invalidation: never) => void) => {
          subscriptionCount += 1;
          publishInvalidation = listener;
          return () => undefined;
        },
      } as never,
    });
    const address = await bridge.listen();
    const read = (body: unknown) => fetch(`${address.url}/runtime/read`, {
      method: "POST",
      headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      const libraryResponse = await read({});
      expect(libraryResponse.status).toBe(200);
      const library = await libraryResponse.json();
      expect(library.workspaceId).toBeUndefined();
      expect(library.workspaceLibrary.authorizations.map(({ workspaceId }: { workspaceId: string }) => workspaceId)).toEqual(["workspace_1"]);
      expect(library.templateLibrary.templates.map(({ template }: { template: { templateId: string } }) => template.templateId)).toEqual(["template_user_1", "template_user_2"]);
      expect(library.templateLibrary.drafts.map(({ templateDraftId }: { templateDraftId: string }) => templateDraftId)).toEqual(["template_draft_user_1"]);
      expect(library.taskLibrary.tasks.map(({ taskId }: { taskId: string }) => taskId)).toEqual(["task_user_1"]);
      expect(library.configuration.taskSetupDrafts.map(({ taskSetupDraftId }: { taskSetupDraftId: string }) => taskSetupDraftId)).toEqual(["setup_user_1"]);
      expect(library.configuration.metaSessions.map(({ metaSessionId }: { metaSessionId: string }) => metaSessionId)).toEqual(["meta_session_user_1"]);
      expect(library.configuration.metaMessages.map(({ metaMessageId }: { metaMessageId: string }) => metaMessageId)).toEqual(["meta_message_user_1"]);
      expect(library.configuration.metaPatchProposals.map(({ metaPatchProposalId }: { metaPatchProposalId: string }) => metaPatchProposalId)).toEqual(["meta_patch_user_1"]);
      expect(library.configuration.metaTurns.map(({ metaTurnId }: { metaTurnId: string }) => metaTurnId)).toEqual(["meta_turn_user_1"]);
      expect(library.configuration.executionProfileReadiness).toEqual(modelFor().configuration.executionProfileReadiness);
      expect(JSON.stringify(library)).not.toContain("owner secret");
      expect(JSON.stringify(library)).not.toContain("workspace secret");

      reads.length = 0;
      const crossTask = await read({ taskId: "task_user_2" });
      expect(crossTask.status).toBe(400);
      expect(await crossTask.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });
      expect(reads).toEqual([{}]);

      const crossTaskCommand = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task.achieve", commandId: "command_cross_owner", issuedAt: "2026-08-09T00:00:00.000Z",
          taskId: "task_user_2", expectedRevision: 1, acceptedArtifactIds: [],
        }),
      });
      expect(crossTaskCommand.status).toBe(400);
      expect(await crossTaskCommand.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });
      expect(commands).toEqual([]);

      reads.length = 0;
      const crossTemplate = await read({ templateId: "template_user_2" });
      expect(crossTemplate.status).toBe(200);
      expect((await crossTemplate.json()).template.template.templateId).toBe("template_user_2");
      expect(reads).toEqual([{ templateId: "template_user_2" }]);

      reads.length = 0;
      const allowedTask = await read({ taskId: "task_user_1" });
      expect(allowedTask.status).toBe(200);
      expect((await allowedTask.json()).task.task.taskId).toBe("task_user_1");
      expect(reads).toEqual([{}, { taskId: "task_user_1" }]);

      const socket = new WebSocket(`${address.url.replace("http", "ws")}/runtime/subscribe`, ["agent-workspace-runtime", "bridge-token"]);
      await waitForOpen(socket);
      const messages = waitForMessages(socket, 2);
      publishInvalidation?.({
        type: "runtime.invalidated", sequence: 1, occurredAt: "2026-08-09T00:00:01.000Z", reasons: ["task_changed"],
        taskId: "task_user_2", runId: "run_user_2", commandId: "command_owner_secret",
      } as never);
      publishInvalidation?.({
        type: "runtime.invalidated", sequence: 2, occurredAt: "2026-08-09T00:00:02.000Z", reasons: ["configuration_changed"],
        commandId: "command_global_secret",
      } as never);
      publishInvalidation?.({
        type: "runtime.invalidated", sequence: 3, occurredAt: "2026-08-09T00:00:03.000Z", reasons: ["task_changed"],
        taskId: "task_user_1", runId: "run_user_1", commandId: "command_allowed_but_private",
      } as never);
      const received = await messages;
      expect(received).toEqual([
        { type: "runtime.invalidated", invalidation: {
          type: "runtime.invalidated", sequence: 2, occurredAt: "2026-08-09T00:00:02.000Z", reasons: ["configuration_changed"],
        } },
        { type: "runtime.invalidated", invalidation: {
          type: "runtime.invalidated", sequence: 3, occurredAt: "2026-08-09T00:00:03.000Z", reasons: ["task_changed"],
          taskId: "task_user_1", runId: "run_user_1",
        } },
      ]);
      expect(JSON.stringify(received)).not.toMatch(/owner_secret|global_secret|allowed_but_private|task_user_2|run_user_2/);
      socket.close();

      const deniedSocket = new WebSocket(
        `${address.url.replace("http", "ws")}/runtime/subscribe?taskId=task_user_2`,
        ["agent-workspace-runtime", "bridge-token"],
      );
      expect(await waitForClose(deniedSocket)).toBe(1008);
      expect(subscriptionCount).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it("rejects a user credential without a stable user identity before reading the Host", async () => {
    let reads = 0;
    const bridge = createRuntimeBridgeServer({
      token: "bridge-token",
      scope: { actor: "user", workspaceIds: ["workspace_1"] },
      host: {
        read: () => {
          reads += 1;
          throw new Error("must_not_read");
        },
        command: async () => ({ receipt: { commandId: "unused", acceptedAt: "2026-08-09T00:00:00.000Z" } }),
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const response = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "runtime_bridge_owner_scope_denied" } });
      expect(reads).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("accepts a bounded archive-sized command envelope without widening read bodies", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-bridge-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    const bridge = createRuntimeBridgeServer({ host, token: "bridge-token" });
    const address = await bridge.listen();
    try {
      const oversizedRead = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_000_001) }),
      });
      expect(oversizedRead.status).toBe(400);
      expect(await oversizedRead.json()).toEqual({ error: { code: "runtime_bridge_payload_too_large" } });

      // The previous 1 MiB shared limit rejected this valid command before it
      // reached typed command handling. Archive import needs this headroom.
      const archiveSizedCommand = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer bridge-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "template.create_draft", commandId: "command_archive_sized", issuedAt: "2026-08-06T00:00:00.000Z",
          ownerId: "user_1", metadata: { title: "Archive Sized" }, initialDefinition: templateDefinition(),
          padding: "x".repeat(1_100_000),
        }),
      });
      expect(archiveSizedCommand.status).toBe(200);
      expect(await archiveSizedCommand.json()).toMatchObject({ receipt: { commandId: "command_archive_sized" } });
    } finally {
      await bridge.close();
      await host.close();
    }
  });

  it("rejects user-lifecycle commands from a Conductor-scoped bridge credential", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-bridge-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    const bridge = createRuntimeBridgeServer({
      host,
      token: "conductor-token",
      scope: { actor: "conductor", taskId: "task_1", runId: "run_1", conductorLogicalSessionId: "logical_session_1" },
    });
    const address = await bridge.listen();
    try {
      const achieve = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "task.achieve", commandId: "command_conductor_achieve", issuedAt: "2026-08-06T00:00:00.000Z",
          taskId: "task_1", expectedRevision: 1, acceptedArtifactIds: [],
        }),
      });
      expect(achieve.status).toBe(400);
      expect(await achieve.json()).toEqual({ error: { code: "runtime_bridge_conductor_command_denied" } });

      const crossScope = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "invocation.invoke_agent", commandId: "command_conductor_wrong_scope", issuedAt: "2026-08-06T00:00:00.000Z",
          taskId: "task_other", expectedRevision: 1, runId: "run_1", sourceLogicalSessionId: "logical_session_1",
          decidedBySessionTurnId: "session_turn_1", idempotencyKey: "invoke:1",
          invocationId: "invocation_1", agentCardId: "agent_card_worker", instruction: "No cross-task dispatch.", messageSelections: [], acceptanceCriteria: ["No dispatch."],
        }),
      });
      expect(crossScope.status).toBe(400);
      expect(await crossScope.json()).toEqual({ error: { code: "runtime_bridge_conductor_scope_denied" } });

      const unscopedInterrupt = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "session.request_interrupt", commandId: "command_conductor_interrupt", issuedAt: "2026-08-06T00:00:00.000Z",
          taskId: "task_1", expectedRevision: 1, runId: "run_1", idempotencyKey: "interrupt:1",
          targetLogicalSessionId: "logical_session_worker", sessionTurnId: "session_turn_worker",
        }),
      });
      expect(unscopedInterrupt.status).toBe(400);
      expect(await unscopedInterrupt.json()).toEqual({ error: { code: "runtime_bridge_conductor_command_denied" } });
    } finally {
      await bridge.close();
      await host.close();
    }
  });

  it("limits a Conductor read to its exact Task Run and removes all configuration history", async () => {
    const reads: unknown[] = [];
    const bridge = createRuntimeBridgeServer({
      token: "conductor-token",
      scope: { actor: "conductor", taskId: "task_1", runId: "run_1", conductorLogicalSessionId: "logical_session_1" },
      host: {
        read: (request: unknown) => {
          reads.push(request);
          return {
            generatedAt: "2026-08-09T00:00:00.000Z",
            configuration: {
              metaProfileOptions: [{ metaProfileOptionId: "secret_option" }],
              executionProfileReadiness: [],
              taskSetupDrafts: [{ taskSetupDraftId: "secret_setup" }],
              metaSessions: [{ metaSessionId: "secret_session" }],
              metaMessages: [{ metaMessageId: "secret_message", content: "configuration secret" }],
              metaPatchProposals: [{ metaPatchProposalId: "secret_patch" }],
              metaTurns: [{ metaTurnId: "secret_turn" }],
            },
            workspaceId: "workspace_secret",
            workspaceLibrary: { authorizations: [{ workspaceId: "workspace_secret" }] },
            templateLibrary: { templates: [{ template: { templateId: "template_secret" } }], drafts: [{ templateDraftId: "draft_secret" }] },
            template: { template: { templateId: "template_secret" }, versions: [] },
            taskLibrary: { tasks: [{ taskId: "task_1" }, { taskId: "task_other" }] },
            task: {
              task: { taskId: "task_1" },
              activeRun: { runId: "run_1", conductorLogicalSessionId: "logical_session_1" },
              messages: [{ messageId: "message_task_scoped", content: "task-scoped content" }],
            },
          };
        },
        command: async () => ({ receipt: { commandId: "unused", acceptedAt: "2026-08-09T00:00:00.000Z" } }),
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const response = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({ taskId: "task_1" }),
      });
      expect(response.status).toBe(200);
      const model = await response.json();

      expect(reads).toEqual([{ taskId: "task_1", taskRunId: "run_1" }]);
      expect(model.configuration).toEqual({
        metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [], metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [],
      });
      expect(model.workspaceLibrary).toEqual({ authorizations: [] });
      expect(model.templateLibrary).toEqual({ templates: [], drafts: [] });
      expect(model).not.toHaveProperty("template");
      expect(model).not.toHaveProperty("workspaceId");
      expect(model.taskLibrary.tasks).toEqual([{ taskId: "task_1" }]);
      expect(JSON.stringify(model)).not.toContain("configuration secret");

      const crossTask = await fetch(`${address.url}/runtime/read`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({ taskId: "task_other" }),
      });
      expect(crossTask.status).toBe(400);
      expect(await crossTask.json()).toEqual({ error: { code: "runtime_bridge_conductor_scope_denied" } });
    } finally {
      await bridge.close();
    }
  });

  it("allows only a scoped requested-Artifact verification claim through a Conductor credential", async () => {
    const commands: unknown[] = [];
    const bridge = createRuntimeBridgeServer({
      token: "conductor-token",
      scope: { actor: "conductor", taskId: "task_1", runId: "run_1", conductorLogicalSessionId: "logical_session_1" },
      host: {
        read: () => ({
          generatedAt: "2026-08-06T00:00:00.000Z",
          workspaceLibrary: { authorizations: [] },
          templateLibrary: { templates: [], drafts: [] },
          taskLibrary: { tasks: [] },
        }),
        command: async (command: unknown) => {
          commands.push(command);
          return {
            receipt: { commandId: "command_register", acceptedAt: "2026-08-06T00:00:01.000Z" },
            artifactId: "artifact_runtime_derived",
          };
        },
        subscribe: () => () => undefined,
      } as never,
    });
    const address = await bridge.listen();
    try {
      const response = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "artifact.verify_requested",
          commandId: "command_register",
          issuedAt: "2026-08-06T00:00:01.000Z",
          taskId: "task_1",
          expectedRevision: 7,
          runId: "run_1",
          sourceLogicalSessionId: "logical_session_1",
          decidedBySessionTurnId: "session_turn_conductor",
          idempotencyKey: "command_register",
          sourceInvocationId: "invocation_worker",
          workspaceRelativePath: "reports/deepsearch.html",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        receipt: { commandId: "command_register", acceptedAt: "2026-08-06T00:00:01.000Z" },
        artifactId: "artifact_runtime_derived",
      });
      expect(commands).toEqual([expect.objectContaining({
        type: "artifact.verify_requested",
        taskId: "task_1",
        runId: "run_1",
        sourceLogicalSessionId: "logical_session_1",
        sourceInvocationId: "invocation_worker",
        workspaceRelativePath: "reports/deepsearch.html",
      })]);

      const crossScope = await fetch(`${address.url}/runtime/command`, {
        method: "POST",
        headers: { authorization: "Bearer conductor-token", "content-type": "application/json" },
        body: JSON.stringify({
          type: "artifact.verify_requested",
          commandId: "command_register_other",
          issuedAt: "2026-08-06T00:00:02.000Z",
          taskId: "task_1",
          expectedRevision: 7,
          runId: "run_other",
          sourceLogicalSessionId: "logical_session_1",
          decidedBySessionTurnId: "session_turn_conductor",
          idempotencyKey: "command_register_other",
          sourceInvocationId: "invocation_worker",
          workspaceRelativePath: "reports/deepsearch.html",
        }),
      });
      expect(crossScope.status).toBe(400);
      expect(await crossScope.json()).toEqual({ error: { code: "runtime_bridge_conductor_scope_denied" } });
      expect(commands).toHaveLength(1);
    } finally {
      await bridge.close();
    }
  });
});

function templateDefinition() {
  return {
    schemaVersion: 2,
    conductor: { agentCardId: "agent_card_conductor", kind: "conductor", title: "Conductor", executionProfileId: "profile_conductor", systemPrompt: "Decide durable work.", capabilityRefs: [] },
    agentCards: [{ agentCardId: "agent_card_worker", kind: "researcher", title: "Worker", executionProfileId: "profile_worker", systemPrompt: "Return evidence.", capabilityRefs: [], dispatchProfile: { title: "Evidence", description: "Return a bounded evidence report." } }],
    executionProfiles: [
      profile("profile_conductor"),
      profile("profile_worker"),
    ],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "result.md", ownerAgentCardId: "agent_card_worker" }],
  } as const;
}

function profile(executionProfileId: string) {
  return {
    executionProfileId,
    provider: "opencode",
    model: "test",
    providerVersion: "test-v1",
    protocolFingerprint: "test-schema-v1",
    capabilityPolicy: { requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"], allowedTools: [], permissionMode: "ask", maxConcurrentTurns: 1, maxNativeChildren: 0 },
  } as const;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (value) => resolve(JSON.parse(String(value))));
    socket.once("error", reject);
  });
}

function waitForMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const onMessage = (value: RawData) => {
      messages.push(JSON.parse(String(value)));
      if (messages.length !== count) return;
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(messages);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}
