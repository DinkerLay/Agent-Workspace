import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExecutionProfileDefinition,
  MetaProfileDefinition,
  MetaProfileOptionDefinition,
  ProviderCapabilities,
  ProviderEffect,
  ProviderFact,
  ProviderKind,
} from "@agent-workspace/runtime-contracts";
import type { MetaAgentPort, MetaAgentTurnRequest, ProviderPort } from "@agent-workspace/provider-port";
import {
  BUILT_IN_CODEX_STARTER_TEMPLATE_ID,
  BUILT_IN_CODEX_STARTER_TEMPLATE_VERSION_ID,
} from "@agent-workspace/runtime-application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeHost } from "./runtime-host.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("Runtime Host dispatcher", () => {
  it("refreshes frozen Task Profile readiness without creating a native Session", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-readiness-"));
    paths.push(directory);
    const provider = new HostProvider("codex");
    const host = createRuntimeHost({
      databasePath: path.join(directory, "runtime.sqlite"),
      providerPorts: [provider],
      dispatchIntervalMs: 10,
    });
    try {
      expect(host.read().configuration.executionProfileReadiness).toEqual([
        expect.objectContaining({ status: "checking", unavailableReasons: ["provider_probe_pending"] }),
      ]);
      const invalidations: string[][] = [];
      const unsubscribe = host.subscribe((event) => invalidations.push([...event.reasons]));
      host.startDispatcher();
      await waitFor(() => host.read().configuration.executionProfileReadiness[0]?.status === "available");
      unsubscribe();
      expect(provider.probes).toBe(1);
      expect(invalidations).toContainEqual(["configuration_changed"]);
    } finally {
      await host.close();
    }
  });

  it("probes Meta readiness before exposing an available option through the dispatcher", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-meta-"));
    paths.push(directory);
    const metaAgent = new HostMetaAgent();
    const host = createRuntimeHost({
      databasePath: path.join(directory, "runtime.sqlite"),
      metaAgentPorts: [metaAgent],
      metaProfileOptions: [metaProfileOption],
      dispatchIntervalMs: 10,
    });
    try {
      expect(host.read().configuration.metaProfileOptions[0]).toMatchObject({
        availability: "unavailable",
        unavailableReason: "meta_agent_profile_probe_pending",
      });
      const invalidations: string[][] = [];
      const unsubscribe = host.subscribe((event) => invalidations.push([...event.reasons]));
      host.startDispatcher();
      await waitFor(() => host.read().configuration.metaProfileOptions[0]?.availability === "available");
      unsubscribe();
      expect(metaAgent.probes).toBe(1);
      expect(invalidations).toContainEqual(["configuration_changed"]);
    } finally {
      await host.close();
    }
  });

  it("does not let a hung background readiness refresh starve durable dispatch", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-readiness-hung-"));
    paths.push(directory);
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite"), dispatchIntervalMs: 10 });
    const never = new Promise<boolean>(() => undefined);
    vi.spyOn(host.application, "refreshProviderReadiness").mockImplementation(() => never);
    const drain = vi.spyOn(host.application, "drainOutbox").mockResolvedValue(0);
    const stop = host.startDispatcher();
    try {
      await waitFor(() => drain.mock.calls.length > 0 && vi.mocked(host.application.refreshProviderReadiness).mock.calls.length > 0);
      expect(host.application.refreshProviderReadiness).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      await host.close();
    }
  });

  it("contains a synchronous Provider probe failure as typed readiness without breaking the tick", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-readiness-sync-"));
    paths.push(directory);
    const provider = new HostProvider("codex");
    provider.syncProbeFailure = new Error("token:supersecret");
    const diagnostics: Array<{ readonly code: string; readonly error?: string }> = [];
    const host = createRuntimeHost({
      databasePath: path.join(directory, "runtime.sqlite"),
      providerPorts: [provider],
      dispatchIntervalMs: 10,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const drain = vi.spyOn(host.application, "drainOutbox");
    host.startDispatcher();
    try {
      await waitFor(() => host.read().configuration.executionProfileReadiness[0]?.status === "unavailable");
      expect(host.read().configuration.executionProfileReadiness[0]).toMatchObject({
        unavailableReasons: ["provider_probe_failed"],
      });
      expect(drain).toHaveBeenCalled();
      expect(diagnostics.map((entry) => entry.code)).not.toContain("runtime_dispatch_failed");
      expect(JSON.stringify({ diagnostics, read: host.read().configuration.executionProfileReadiness })).not.toContain("supersecret");
    } finally {
      await host.close();
    }
  });

  it("installs one immutable Codex Starter and can run it through a matching Codex port", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-"));
    paths.push(directory);
    const host = createRuntimeHost({
      databasePath: path.join(directory, "runtime.sqlite"),
      providerPorts: [new HostProvider("codex")],
      dispatchIntervalMs: 10,
    });
    try {
      const starter = host.read().templateLibrary.templates.find(({ template }) =>
        template.templateId === BUILT_IN_CODEX_STARTER_TEMPLATE_ID,
      );
      expect(starter?.template).toMatchObject({
        activeVersionId: BUILT_IN_CODEX_STARTER_TEMPLATE_VERSION_ID,
        slug: "codex-starter",
      });
      expect(starter?.activeVersion?.definition.executionProfiles).toEqual([
        expect.objectContaining({
          provider: "codex",
          capabilityPolicy: expect.objectContaining({ permissionMode: "deny" }),
        }),
      ]);

      await host.command({
        type: "workspace.authorize", commandId: "command_starter_workspace", issuedAt: now(),
        workspaceId: "workspace_starter", directory,
      });
      const setup = await host.command({
        type: "task_setup.create_draft", commandId: "command_starter_setup", issuedAt: now(), ownerId: "user_1",
        templateVersionId: starter!.template.activeVersionId!, workspaceId: "workspace_starter",
        title: "Run the built-in starter", goal: "Summarize the current workspace.", taskInputValues: [],
      });
      const created = await host.command({
        type: "task.create", commandId: "command_starter_task", issuedAt: now(), taskId: "task_starter",
        ownerId: "user_1", workspaceId: "workspace_starter", taskSetupDraftId: setup.taskSetupDraft!.taskSetupDraftId,
        expectedTaskSetupRevision: setup.taskSetupDraft!.revision,
      });
      await host.command({
        type: "task.start", commandId: "command_starter_start", issuedAt: now(), taskId: "task_starter", expectedRevision: created.task!.revision,
      });
      host.startDispatcher();
      await waitFor(() => host.read({ taskId: "task_starter" }).task?.activeRun?.status === "running");
      expect(host.read({ taskId: "task_starter" }).task?.bindings[0]).toMatchObject({ provider: "codex", status: "active" });
    } finally {
      await host.close();
    }

    const reopened = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite") });
    try {
      const starters = reopened.read().templateLibrary.templates.filter(({ template }) =>
        template.templateId === BUILT_IN_CODEX_STARTER_TEMPLATE_ID,
      );
      expect(starters).toHaveLength(1);
      expect(starters[0]?.template.activeVersionId).toBe(BUILT_IN_CODEX_STARTER_TEMPLATE_VERSION_ID);
    } finally {
      await reopened.close();
    }
  });

  it("consumes a Provider binding fact and projects a running Task without a renderer", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-"));
    paths.push(directory);
    const host = createRuntimeHost({
      databasePath: path.join(directory, "runtime.sqlite"),
      providerPorts: [new HostProvider()],
      dispatchIntervalMs: 10,
    });
    try {
      await host.command({
        type: "template.create_draft", commandId: "command_draft", issuedAt: now(), ownerId: "user_1",
        metadata: { title: "Host template", slug: "host-template" }, initialDefinition: definition(),
      });
      const draft = host.read().templateLibrary.drafts[0]!;
      await host.command({
        type: "template.publish_draft", commandId: "command_publish", issuedAt: now(), templateDraftId: draft.templateDraftId,
        expectedRevision: draft.revision, slug: "host-template", title: "Host template",
      });
      const versionId = host.read().templateLibrary.templates.find(({ template }) => template.slug === "host-template")!.template.activeVersionId!;
      await host.command({
        type: "workspace.authorize", commandId: "command_host_workspace", issuedAt: now(),
        workspaceId: "workspace_host", directory,
      });
      const setup = await host.command({
        type: "task_setup.create_draft", commandId: "command_host_setup", issuedAt: now(), ownerId: "user_1",
        templateVersionId: versionId, workspaceId: "workspace_host", title: "Host task", goal: "Verify host facts.", taskInputValues: [],
      });
      const created = await host.command({
        type: "task.create", commandId: "command_task", issuedAt: now(), taskId: "task_host",
        ownerId: "user_1", workspaceId: "workspace_host", taskSetupDraftId: setup.taskSetupDraft!.taskSetupDraftId,
        expectedTaskSetupRevision: setup.taskSetupDraft!.revision,
      });
      await host.command({ type: "task.start", commandId: "command_start", issuedAt: now(), taskId: "task_host", expectedRevision: created.task!.revision });

      host.startDispatcher();
      await waitFor(() => host.read({ taskId: "task_host" }).task?.activeRun?.status === "running");
      const projection = host.read({ taskId: "task_host" }).task!;
      expect(projection.bindings[0]).toMatchObject({ status: "active", nativeBindingRef: "native-binding" });
      expect(projection.logicalSessions[0]).toMatchObject({ status: "active" });
    } finally {
      await host.close();
    }
  });

  it("closes Provider-owned persistent resources during Host shutdown without changing runtime truth", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-"));
    paths.push(directory);
    const provider = new HostProvider();
    let closes = 0;
    provider.close = async () => { closes += 1; };
    const host = createRuntimeHost({ databasePath: path.join(directory, "runtime.sqlite"), providerPorts: [provider] });

    await Promise.all([host.close(), host.close()]);

    expect(closes).toBe(1);
    expect(() => host.read()).toThrow("database is not open");
    await expect(host.command({ type: "template.create_draft", commandId: "after_close", issuedAt: now(), ownerId: "user_1", metadata: { title: "Nope", slug: "nope" }, initialDefinition: definition() }))
      .rejects.toThrow("runtime_host_closed");
  });
});

class HostProvider implements ProviderPort {
  probes = 0;
  syncProbeFailure: Error | undefined;
  constructor(readonly provider: ProviderKind = "opencode") {}

  describeCapabilities(profile: ExecutionProfileDefinition): Promise<ProviderCapabilities> {
    this.probes += 1;
    if (this.syncProbeFailure) throw this.syncProbeFailure;
    return Promise.resolve({
      provider: this.provider,
      available: true,
      providerVersion: profile.providerVersion,
      protocolFingerprint: profile.protocolFingerprint,
      capabilities: [...profile.capabilityPolicy.requiredCapabilities],
      unavailableReasons: [],
    });
  }

  async ensureBinding(request: Parameters<ProviderPort["ensureBinding"]>[0]): Promise<ProviderEffect> {
    return effect(this.provider, "ensure_binding", request);
  }

  async submitDelivery(request: Parameters<ProviderPort["submitDelivery"]>[0]): Promise<ProviderEffect> {
    return effect(this.provider, "submit_delivery", request);
  }

  async *observeBinding(): AsyncIterable<ProviderFact> {}

  async reconcileBinding(request: Parameters<ProviderPort["reconcileBinding"]>[0]): Promise<readonly ProviderFact[]> {
    return [{
      providerFactId: `provider_fact_${request.bindingId}`,
      provider: this.provider,
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
      kind: "binding_observed",
      deduplication: { providerEventId: `binding-observed:${request.bindingId}` },
      correlation: {},
      payload: { nativeBindingRef: "native-binding" },
      observedAt: now(),
    }];
  }

  async requestInterrupt(request: Parameters<ProviderPort["requestInterrupt"]>[0]): Promise<ProviderEffect> {
    return effect(this.provider, "request_interrupt", request);
  }

  async releaseBinding(): Promise<void> {}

  close?: () => Promise<void>;
}

const metaProfile: MetaProfileDefinition = {
  metaProfileId: "meta_profile_host",
  provider: "codex",
  model: "gpt-5.6",
  providerVersion: "0.146.0",
  protocolFingerprint: "sha256:host-meta",
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

const metaProfileOption: MetaProfileOptionDefinition = {
  metaProfileOptionId: "meta_profile_option_host",
  title: "Host Meta",
  availability: "available",
  profile: metaProfile,
};

class HostMetaAgent implements MetaAgentPort {
  readonly provider = "codex" as const;
  probes = 0;

  async describeMetaCapabilities(profile: MetaProfileDefinition) {
    this.probes += 1;
    return {
      provider: this.provider,
      available: true,
      providerVersion: profile.providerVersion,
      protocolFingerprint: profile.protocolFingerprint,
      unavailableReasons: [],
    };
  }

  async startMetaTurn(_request: MetaAgentTurnRequest) {
    return "accepted" as const;
  }

  async reconcileMetaTurn(_request: MetaAgentTurnRequest) {
    return { state: "absent" as const };
  }
}

function effect(provider: ProviderKind, kind: ProviderEffect["kind"], request: { bindingId: string; inputSubmissionId?: string; invocationId?: string }): ProviderEffect {
  return {
    effectId: `effect_${kind}_${request.bindingId}`,
    kind,
    provider,
    bindingId: request.bindingId,
    ...(request.inputSubmissionId ? { inputSubmissionId: request.inputSubmissionId } : {}),
    ...(request.invocationId ? { invocationId: request.invocationId } : {}),
    acceptance: "accepted",
    acceptedAt: now(),
  };
}

function definition() {
  return {
    schemaVersion: 2,
    conductor: { agentCardId: "agent_card_conductor", kind: "conductor", title: "Conductor", executionProfileId: "profile_host", systemPrompt: "Run the host test.", capabilityRefs: [] },
    agentCards: [{ agentCardId: "agent_card_worker", kind: "general", title: "Worker", executionProfileId: "profile_host", systemPrompt: "Do bounded work.", capabilityRefs: [], dispatchProfile: { title: "Bounded work", description: "Complete one bounded host test assignment." } }],
    executionProfiles: [{
      executionProfileId: "profile_host", provider: "opencode", model: "host-test", providerVersion: "host-v1", protocolFingerprint: "host-protocol-v1",
      capabilityPolicy: { requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"], allowedTools: [], permissionMode: "ask", maxConcurrentTurns: 1, maxNativeChildren: 0 },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "result.md", ownerAgentCardId: "agent_card_worker" }],
  } as const;
}

function now(): string {
  return new Date().toISOString();
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("runtime_host_test_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
