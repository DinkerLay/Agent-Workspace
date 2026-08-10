import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { templateDefinitionFixture } from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeBridgeServer } from "../../apps/runtime-host/src/runtime-bridge.js";
import { createRuntimeHost } from "../../apps/runtime-host/src/runtime-host.js";
import { createHttpRuntimeClient } from "../../packages/runtime-client/src/http.js";

const paths: string[] = [];
const TOKEN = "e2e-bridge-token";
const NOW = "2026-08-06T00:00:00.000Z";

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("new Runtime end-to-end", () => {
  it("uses RuntimeClient through the authenticated Host bridge to record a direct user Achieve and read it back", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-e2e-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    const bridge = createRuntimeBridgeServer({
      host,
      token: TOKEN,
      scope: { userId: "user_e2e", workspaceIds: ["workspace_e2e"] },
    });
    const address = await bridge.listen();
    const client = createHttpRuntimeClient({ baseUrl: address.url, authorization: TOKEN });

    try {
      await client.command({
        type: "template.create_draft",
        commandId: "command_e2e_draft",
        issuedAt: NOW,
        ownerId: "user_e2e",
        metadata: { title: "E2E template", slug: "e2e-template" },
        initialDefinition: templateDefinitionFixture(),
      });
      const draft = (await client.read()).templateLibrary.drafts[0]!;

      await client.command({
        type: "template.publish_draft",
        commandId: "command_e2e_publish",
        issuedAt: NOW,
        templateDraftId: draft.templateDraftId,
        expectedRevision: draft.revision,
        slug: "e2e-template",
        title: "E2E template",
      });
      const publishedTemplate = (await client.read()).templateLibrary.templates
        .find(({ template }) => template.slug === "e2e-template")!;
      const templateVersionId = publishedTemplate.template.activeVersionId!;
      const selectedTemplate = (await client.read({ templateId: publishedTemplate.template.templateId })).template;
      expect(selectedTemplate).toMatchObject({
        template: { templateId: publishedTemplate.template.templateId, activeVersionId: templateVersionId },
        versions: [expect.objectContaining({
          templateVersionId,
          version: 1,
          definition: expect.objectContaining({ schemaVersion: 2 }),
        })],
      });
      expect(JSON.stringify(selectedTemplate)).not.toMatch(/nativeBindingRef|credential|workspaceRelativePath/i);

      await client.command({
        type: "workspace.authorize",
        commandId: "command_e2e_workspace",
        issuedAt: NOW,
        workspaceId: "workspace_e2e",
        directory,
      });
      expect((await client.read()).workspaceLibrary.authorizations).toEqual([
        expect.objectContaining({ workspaceId: "workspace_e2e", displayName: path.basename(directory) }),
      ]);

      const setup = await client.command({
        type: "task_setup.create_draft",
        commandId: "command_e2e_setup",
        issuedAt: NOW,
        ownerId: "user_e2e",
        templateVersionId,
        workspaceId: "workspace_e2e",
        title: "Direct user acceptance",
        goal: "Verify the user may Achieve before a Run exists.",
        taskInputValues: [],
      });
      const created = await client.command({
        type: "task.create",
        commandId: "command_e2e_task",
        issuedAt: NOW,
        taskId: "task_e2e_direct_achieve",
        ownerId: "user_e2e",
        workspaceId: "workspace_e2e",
        taskSetupDraftId: setup.taskSetupDraft!.taskSetupDraftId,
        expectedTaskSetupRevision: setup.taskSetupDraft!.revision,
      });
      const achieved = await client.command({
        type: "task.achieve",
        commandId: "command_e2e_achieve",
        issuedAt: NOW,
        taskId: "task_e2e_direct_achieve",
        expectedRevision: created.task!.revision,
        acceptedArtifactIds: [],
        acceptanceNote: "The user decided this Task is achieved.",
      });

      expect(achieved.task).toMatchObject({
        taskId: "task_e2e_direct_achieve",
        status: "queued",
        achievement: {
          acceptedArtifactIds: [],
          acceptanceNote: "The user decided this Task is achieved.",
        },
      });
      expect((await client.read({ taskId: "task_e2e_direct_achieve" })).task?.task).toMatchObject({
        status: "queued",
        achievement: {
          acceptedArtifactIds: [],
          acceptanceNote: "The user decided this Task is achieved.",
        },
      });
    } finally {
      await bridge.close();
      await host.close();
    }
  });
});
