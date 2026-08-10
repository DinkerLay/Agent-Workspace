// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, RuntimeReadModel } from "../../../packages/runtime-contracts/src/index";
import { createAgentLoopControllers, createBrowserRuntimeClient } from "./runtime";

afterEach(() => {
  document.head.innerHTML = "";
  delete window.agentWorkspace;
  vi.unstubAllGlobals();
});

describe("Browser Workbench Runtime bridge", () => {
  it("uses only the authenticated short-lived bridge token injected in page metadata", async () => {
    document.head.innerHTML = `
      <meta name="agent-workspace-runtime-origin" content="https://runtime.example.test" />
      <meta name="agent-workspace-runtime-bridge-token" content="bridge-token-123" />
    `;
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ revision: 1 }) }));
    vi.stubGlobal("fetch", fetch);

    const client = createBrowserRuntimeClient();
    await client.read({ taskId: "task_1" });

    expect(fetch).toHaveBeenCalledWith("https://runtime.example.test/runtime/read", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "bridge-token-123" },
      body: JSON.stringify({ taskId: "task_1" }),
    });
    expect("provider" in client).toBe(false);
    expect("pty" in client).toBe(false);
  });

  it("does not send an unauthenticated Browser Runtime request when bootstrap metadata is absent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(createBrowserRuntimeClient().read()).rejects.toThrow("browser_runtime_bridge_token_missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wires Task Setup and Meta controllers through the same typed desktop Runtime facade", async () => {
    document.head.innerHTML = '<meta name="agent-workspace-runtime-owner-id" content="user_bridge" />';
    const calls: RuntimeCommand[] = [];
    const model: RuntimeReadModel = {
      generatedAt: "2026-08-09T00:00:00.000Z",
      configuration: {
        executionProfileReadiness: [],
        metaProfileOptions: [{
          metaProfileOptionId: "meta_profile_option_bridge",
          title: "Bridge Meta",
          availability: "available",
          profile: { provider: "codex", model: "gpt-5.6", providerVersion: "1.0.0", protocolFingerprint: "codex-v1" },
        }],
        taskSetupDrafts: [],
        metaSessions: [],
        metaMessages: [],
        metaPatchProposals: [],
        metaTurns: [],
      },
      workspaceLibrary: { authorizations: [] },
      templateLibrary: { templates: [], drafts: [] },
      taskLibrary: { tasks: [] },
    };
    window.agentWorkspace = {
      runtime: {
        read: vi.fn(async () => model),
        command: vi.fn(async (command) => {
          calls.push(command);
          return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-09T00:00:00.000Z" } };
        }),
        subscribe: vi.fn(async () => () => undefined),
      },
    };

    const controllers = createAgentLoopControllers();
    const scope = { kind: "template_design" as const, draftId: "template_draft_bridge", draftRevision: 1 };
    const meta = await controllers.configuration.meta.load(scope);
    await controllers.configuration.meta.createSession({
      scope,
      metaProfileOptionId: meta.profileOptions[0]!.metaProfileOptionId,
    });

    expect(meta.profileOptions[0]?.metaProfileOptionId).toBe("meta_profile_option_bridge");
    expect(calls).toEqual([expect.objectContaining({
      type: "meta.create_session",
      ownerId: "user_bridge",
      metaProfileOptionId: "meta_profile_option_bridge",
      target: { kind: "template_draft", templateDraftId: "template_draft_bridge" },
    })]);
    expect(JSON.stringify(calls)).not.toContain("metaProfileId");
  });
});
