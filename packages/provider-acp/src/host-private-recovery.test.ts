import { describe, expect, it } from "vitest";
import {
  createHostPrivateBindingIdentityVault,
  createManagedAcpV1ClientWithHostPrivateIdentity,
} from "./host-private.js";
import { FakeAcpV1Agent } from "./fake-agent.js";

const rawSessionId = "raw-session-survives-child-generation";
const configuration = { model: "fake-model", options: [] } as const;

describe("Host-private ACP Binding identity recovery", () => {
  it("rehydrates a new client generation for load without exposing the raw identity", async () => {
    const identityVault = createHostPrivateBindingIdentityVault();
    const first = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_one",
      createOpaqueId: (kind) => `${kind}_first`,
      identityVault,
    });
    await qualify(first);
    await first.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    });
    first.invalidateGeneration();

    const secondAgent = new FakeAcpV1Agent({ rawSessionId });
    const second = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => secondAgent.connect(handlers),
      generationId: "generation_two",
      createOpaqueId: (kind) => `${kind}_second`,
      identityVault,
    });
    await qualify(second);
    const observation = await second.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "load",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    });

    expect(observation).toMatchObject({
      kind: "binding_ready",
      bindingHandle: "binding_handle_recovery",
      disposition: "load",
      recoverable: true,
      model: "fake-model",
      configurationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify({ observation, identityVault })).not.toContain(rawSessionId);
  });

  it("rejects concurrent generation adoption of one Binding", async () => {
    const identityVault = createHostPrivateBindingIdentityVault();
    const first = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_one",
      identityVault,
    });
    await qualify(first);
    await first.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    });

    const second = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_two",
      identityVault,
    });
    await qualify(second);
    await expect(second.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "resume",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_binding_identity_generation_conflict" });
  });

  it("does not leave a reachable local mapping after duplicate create is rejected", async () => {
    const identityVault = createHostPrivateBindingIdentityVault();
    const first = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_one",
      identityVault,
    });
    await qualify(first);
    await first.ensureBinding({
      bindingHandle: "binding_handle_duplicate",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    });

    const duplicate = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId: "raw-orphan" }).connect(handlers),
      generationId: "generation_two",
      identityVault,
    });
    await qualify(duplicate);
    await expect(duplicate.ensureBinding({
      bindingHandle: "binding_handle_duplicate",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_binding_identity_already_exists" });
    await expect(duplicate.submitPrompt({
      bindingHandle: "binding_handle_duplicate",
      attemptId: "session_execution_attempt_after-failed-create",
      content: "must not be reachable",
    })).rejects.toMatchObject({ code: "acp_binding_not_mapped" });
  });

  it("rolls back a failed recovery checkout so the next generation can retry", async () => {
    const identityVault = createHostPrivateBindingIdentityVault();
    const first = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_one",
      identityVault,
    });
    await qualify(first);
    await first.ensureBinding({
      bindingHandle: "binding_handle_retry",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    });
    first.invalidateGeneration();

    const failing = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId, failLoad: true }).connect(handlers),
      generationId: "generation_two",
      identityVault,
    });
    await qualify(failing);
    await expect(failing.ensureBinding({
      bindingHandle: "binding_handle_retry",
      disposition: "load",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    })).rejects.toMatchObject({ code: "acp_binding_effect_failed" });

    const retry = createManagedAcpV1ClientWithHostPrivateIdentity({
      connect: (handlers) => new FakeAcpV1Agent({ rawSessionId }).connect(handlers),
      generationId: "generation_three",
      identityVault,
    });
    await qualify(retry);
    await expect(retry.ensureBinding({
      bindingHandle: "binding_handle_retry",
      disposition: "load",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration,
    })).resolves.toMatchObject({ kind: "binding_ready" });
  });
});

async function qualify(client: {
  initialize(input: {
    protocolMajor: 1;
    requiredCapabilities: readonly ["session_load", "session_resume"];
    requiredExtensions: readonly [];
  }): Promise<unknown>;
}): Promise<void> {
  await client.initialize({
    protocolMajor: 1,
    requiredCapabilities: ["session_load", "session_resume"],
    requiredExtensions: [],
  });
}
