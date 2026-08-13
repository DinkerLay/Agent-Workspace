import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlledUnifiedHostService } from "./controlled-unified-host-service.js";

const ORIGIN = "http://127.0.0.1:43177";
const RENDERER_TOKEN = "controlled-browser-renderer-token";
const DESKTOP_TOKEN = "controlled-desktop-renderer-token";
const EVIDENCE_TOKEN = "controlled-private-evidence-token";
const CONTROL_TOKEN = "controlled-private-control-token";
const roots: string[] = [];
const EXPECTED_LINEAGE = Object.freeze({
  runtimeInstanceId: "runtime_instance_controlled-service",
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlled unified Host service", () => {
  it("composes the unified Host only through the provider-neutral ACP-v3 owner", () => {
    const wrapper = readFileSync(new URL("./controlled-unified-host-service.ts", import.meta.url), "utf8");
    const owner = readFileSync(new URL("./controlled-session-id-acp-owner.ts", import.meta.url), "utf8");
    expect(wrapper).toContain("createProviderOwner: (input) => ports.createProviderOwner(input)");
    expect(wrapper).toContain("authorizeRetiringBindingRecovery: () => false");
    expect(wrapper).not.toMatch(/\bproviderPorts\b/u);
    expect(wrapper).not.toMatch(/\bProviderPort\b/u);
    expect(wrapper).not.toMatch(/\bAttention\b/u);
    expect(wrapper).not.toContain("controlled-session-id-ports");
    expect(owner).toContain("createAcpTaskSessionRuntimeProvider");
    expect(owner).toContain("attachRuntime(value)");
    expect(owner).not.toMatch(/\bProviderPort\b/u);
    expect(owner).not.toContain("nativeBindingRef");
    expect(owner).not.toMatch(/\bProviderFact\b/u);
    expect(owner).not.toContain("controlled-session-id-ports");
  });

  it("serves real HTTP, bootstraps only the Host-owned workspace grant, and reopens the same SQLite lineage", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "controlled-unified-host-service-"));
    roots.push(stateRoot);
    const service = await startControlledUnifiedHostService({
      stateRoot,
      rendererToken: RENDERER_TOKEN,
      desktopRendererToken: DESKTOP_TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      controlToken: CONTROL_TOKEN,
      allowedOrigins: [ORIGIN],
      dispatchIntervalMs: 250,
      expectedLineage: EXPECTED_LINEAGE,
    });
    try {
      const initialHealth = await json(service.healthUrl);
      expect(initialHealth).toMatchObject({
        ready: true,
        runtimeInstanceId: EXPECTED_LINEAGE.runtimeInstanceId,
        lineageId: service.lineageId,
        generation: 1,
      });
      expect(statSync(service.operationLedgerFile).mode & 0o077).toBe(0);
      expect((await fetch(service.hostLedgerUrl)).status).toBe(401);
      expect((await fetch(service.operationLedgerUrl)).status).toBe(401);
      expect((await fetch(service.observedLineageUrl)).status).toBe(401);

      const workspace = await bridgePost(service.runtimeUrl, "/runtime/session-id/workspace/read", {}, RENDERER_TOKEN);
      expect(workspace.taskSetupOptions.workspaces).toEqual([
        expect.objectContaining({ workspaceId: "workspace_journey", displayName: "Journey Workspace" }),
      ]);
      expect(await bridgePost(service.runtimeUrl, "/runtime/session-id/workspace/read", {}, DESKTOP_TOKEN)).toMatchObject({
        taskSetupOptions: { workspaces: [expect.objectContaining({ workspaceId: "workspace_journey" })] },
      });

      const acpTemplate = workspace.taskSetupOptions.templates.find(
        ({ templateId }: { templateId: string }) => templateId === "template_builtin-codex-acp-starter",
      );
      if (!acpTemplate) throw new Error("controlled_service_acp_template_missing");
      const templateVersionId = acpTemplate.versions[0].templateVersionId;
      const setup = await bridgePost(service.runtimeUrl, "/runtime/session-id/command", {
        type: "task_setup.create_draft",
        commandId: "controlled_service_setup_command",
        uiIntentId: "controlled_service_setup_intent",
        issuedAt: "2026-08-11T08:00:00.000Z",
        ownerId: "user_local",
        templateVersionId,
        workspaceId: "workspace_journey",
        title: "Controlled service task",
        goal: "Prove real HTTP and restart continuity.",
        taskInputValues: [],
      }, RENDERER_TOKEN);
      expect(setup).toMatchObject({ taskSetupDraft: { taskSetupDraftId: expect.stringMatching(/^task_setup_draft_/u) } });
      const taskSetupDraftId = setup.taskSetupDraft.taskSetupDraftId as string;
      const setupRead = await bridgePost(service.runtimeUrl, "/runtime/session-id/configuration/read", {
        kind: "task_setup",
        taskSetupDraftId,
      }, RENDERER_TOKEN);
      expect(setupRead.model.profileOptions).toEqual([
        expect.objectContaining({
          schemaVersion: 3,
          readiness: expect.objectContaining({
            providerFamily: "codex",
            status: "unavailable",
            reasons: expect.arrayContaining(["acp_controlled_model_not_frozen"]),
          }),
        }),
        expect.objectContaining({
          schemaVersion: 3,
          readiness: expect.objectContaining({
            providerFamily: "codex",
            status: "unavailable",
            reasons: expect.arrayContaining(["acp_controlled_model_not_frozen"]),
          }),
        }),
      ]);
      const formerlyPredictable = `task_setup_draft_${createHash("sha256")
        .update(EXPECTED_LINEAGE.runtimeInstanceId).digest("hex").slice(0, 20)}-1`;
      expect(taskSetupDraftId).not.toBe(formerlyPredictable);
      expect(await evidenceJson(service.observedLineageUrl)).toMatchObject({
        schemaVersion: 1,
        runtimeInstanceId: EXPECTED_LINEAGE.runtimeInstanceId,
        taskSetupDraftIds: [taskSetupDraftId],
        canonicalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(await evidenceJson(service.hostLedgerUrl)).toEqual([expect.objectContaining({
        runtimeInstanceId: service.runtimeInstanceId,
        commandId: "controlled_service_setup_command",
        uiIntentId: "controlled_service_setup_intent",
        intentKind: "task_setup.create_draft",
        source: "authenticated_runtime_bridge",
      })]);

      expect((await fetch(`${service.serviceUrl}/control/restart`, { method: "POST" })).status).toBe(401);
      const restarted = await control(service.serviceUrl, "/control/restart");
      expect(restarted).toEqual({
        runtimeInstanceId: service.runtimeInstanceId,
        lineageId: service.lineageId,
        generation: 2,
      });
      expect(await json(service.healthUrl)).toMatchObject({ ready: true, generation: 2 });
      expect(await evidenceJson(service.observedLineageUrl)).toMatchObject({
        runtimeInstanceId: EXPECTED_LINEAGE.runtimeInstanceId,
        taskSetupDraftIds: [taskSetupDraftId],
      });
      expect(await evidenceJson(service.hostLedgerUrl)).toEqual([expect.objectContaining({
        commandId: "controlled_service_setup_command",
      })]);
      expect(await evidenceJson(service.operationLedgerUrl)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "host_restart_requested", evidenceClass: "deterministic_fake", nativeClaim: false }),
        expect.objectContaining({ kind: "host_restart_completed", generation: 2 }),
      ]));
    } finally {
      await service.close();
    }
  });

  it("rejects a changed frozen lineage when reopening an existing SQLite cell", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "controlled-unified-host-lineage-"));
    roots.push(stateRoot);
    const options = {
      stateRoot,
      rendererToken: RENDERER_TOKEN,
      desktopRendererToken: DESKTOP_TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      controlToken: CONTROL_TOKEN,
      allowedOrigins: [ORIGIN],
      expectedLineage: EXPECTED_LINEAGE,
    } as const;
    const first = await startControlledUnifiedHostService(options);
    await first.close();
    await expect(startControlledUnifiedHostService({
      ...options,
      expectedLineage: { ...EXPECTED_LINEAGE, runtimeInstanceId: "runtime_instance_different-cell" },
    })).rejects.toThrow("controlled_host_runtime_instance_mismatch");
  });

  it("keeps the Provider barrier control-only, ordered, and replay-safe", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "controlled-unified-host-clock-"));
    roots.push(stateRoot);
    const service = await startControlledUnifiedHostService({
      stateRoot,
      rendererToken: RENDERER_TOKEN,
      desktopRendererToken: DESKTOP_TOKEN,
      evidenceToken: EVIDENCE_TOKEN,
      controlToken: CONTROL_TOKEN,
      allowedOrigins: [ORIGIN],
    });
    try {
      expect((await fetch(`${service.serviceUrl}/control/provider-clock/j05_researcher_waiting_observed`, {
        method: "POST",
      })).status).toBe(401);
      const outOfOrder = await fetch(`${service.serviceUrl}/control/provider-clock/j06_researcher_final_observed`, {
        method: "POST",
        headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
      });
      expect(outOfOrder.status).toBe(500);
      expect(await outOfOrder.json()).toEqual({ error: { code: "controlled_provider_stage_out_of_order" } });
      expect(await control(service.serviceUrl, "/control/provider-clock/j05_researcher_waiting_observed"))
        .toEqual({ status: "released" });
      expect(await control(service.serviceUrl, "/control/provider-clock/j05_researcher_waiting_observed"))
        .toEqual({ status: "replayed" });
      expect(await json(service.healthUrl)).toMatchObject({
        providerClock: {
          releasedStages: ["j05_researcher_waiting_observed"],
          nextStage: "j06_researcher_final_observed",
        },
      });
      expect(await evidenceJson(service.hostLedgerUrl)).toEqual([]);
    } finally {
      await service.close();
    }
  });
});

async function bridgePost(baseUrl: string, pathname: string, body: unknown, token: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { authorization: token, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(JSON.stringify(await response.json()));
  return response.json() as Promise<any>;
}

async function control(serviceUrl: string, pathname: string) {
  const response = await fetch(`${serviceUrl}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  if (!response.ok) throw new Error(JSON.stringify(await response.json()));
  return response.json();
}

async function json(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`controlled_service_http_${response.status}`);
  return response.json() as Promise<any>;
}

async function evidenceJson(url: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${EVIDENCE_TOKEN}` },
  });
  if (!response.ok) throw new Error(`controlled_service_evidence_http_${response.status}`);
  return response.json() as Promise<any>;
}
