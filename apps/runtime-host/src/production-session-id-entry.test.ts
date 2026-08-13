import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSessionIdProductionRuntimeEnvironment,
  startSessionIdProductionRuntimeHost,
} from "./index.js";

const hostRoot = path.dirname(fileURLToPath(import.meta.url));

describe("production Session-ID Runtime Host entry", () => {
  it("starts and exports only the unified Host and Bridge graph", () => {
    const entry = readFileSync(path.join(hostRoot, "index.ts"), "utf8");

    expect(entry).toContain("createSessionIdUnifiedRuntimeHost");
    expect(entry).toContain("createSessionIdUnifiedRuntimeBridgeServer");
    expect(entry).toContain('export * from "./session-id-unified-runtime-host.js"');
    expect(entry).toContain('export * from "./session-id-unified-runtime-bridge.js"');
    expect(entry).not.toMatch(/createRuntimeHost|createRuntimeBridgeServer/u);
    expect(entry).not.toMatch(/export \* from "\.\/(?:runtime-host|runtime-bridge|managed-artifact-service)\.js"/u);
    expect(entry).not.toMatch(/AGENT_WORKSPACE_(?:RUNTIME|PROTOCOL)_MODE|legacy|session-id[^"'\n]*candidate/u);
  });

  it("keeps authentication, workspace authorization, and ACP current-install ownership Host-only", () => {
    const entry = readFileSync(path.join(hostRoot, "index.ts"), "utf8");

    expect(entry).toContain("AGENT_WORKSPACE_RUNTIME_TOKEN");
    expect(entry).toContain("AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN");
    expect(entry).toContain("AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN");
    expect(entry).toContain("AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS");
    expect(entry).toContain("AGENT_WORKSPACE_WORKSPACE_CONFIG");
    expect(entry).toContain("loadAcpProductionConfigurationFromEnvironment");
    expect(entry).toContain("createAcpProductionHostInputs");
    expect(entry).toContain("createAcpRuntimeHostPrivateAuthority");
    expect(entry).toContain("assertAcpHostEpochSupervisorEnvironmentConfigured");
    expect(entry).not.toMatch(/loadRuntimeProviderPortsFromEnvironment|loadRuntimeMetaAgentPortsFromEnvironment/u);
    expect(entry).not.toMatch(/providerPorts|metaAgentPorts|nativeBindingRef|nativeRequestId/u);
    expect(entry).not.toMatch(/FakeProvider|ControlledProvider|\.agent-workspace["']/u);
    expect(entry).not.toMatch(/(?:codex-app-server|opencode-server|meta-provider-composition|provider-composition)\.js/u);
    expect(entry).not.toContain("void close().finally(() => process.exit(0))");
    expect(entry).toContain("void close().then(");
  });

  it("parses strict class-scoped auth, origin and Workspace bootstrap configuration", () => {
    const environment = loadSessionIdProductionRuntimeEnvironment({
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: "/tmp/agent-workspace-production-entry",
      AGENT_WORKSPACE_OWNER_ID: "user_local",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5188"]),
      AGENT_WORKSPACE_WORKSPACE_CONFIG: JSON.stringify({
        schemaVersion: 1,
        grants: [{ workspaceId: "workspace_one", directory: "/tmp/workspace-one", displayName: "Workspace One" }],
      }),
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
    });
    expect(environment).toMatchObject({
      authenticatedUserId: "user_local",
      rendererToken: "browser-token-0123456789",
      desktopRendererToken: "desktop-token-0123456789",
      evidenceToken: "evidence-token-0123456789",
      allowedOrigins: ["http://127.0.0.1:5188"],
      port: 0,
    });
    expect(environment.workspaceBootstrapGrants).toEqual([
      expect.objectContaining({
        commandId: expect.stringMatching(/^command_workspace_bootstrap_/u),
        workspaceId: "workspace_one",
        directory: "/tmp/workspace-one",
        displayName: "Workspace One",
      }),
    ]);
    expect(() => loadSessionIdProductionRuntimeEnvironment({
      AGENT_WORKSPACE_RUNTIME_TOKEN: "shared-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "shared-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
    })).toThrow("bridge tokens must be distinct");
    expect(() => loadSessionIdProductionRuntimeEnvironment({
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5188/path"]),
    })).toThrow("invalid origin");
    expect(() => loadSessionIdProductionRuntimeEnvironment({
      AGENT_WORKSPACE_OWNER_ID: "local-user",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
    })).toThrow("AGENT_WORKSPACE_OWNER_ID is invalid");
    expect(() => loadSessionIdProductionRuntimeEnvironment({
      AGENT_WORKSPACE_OWNER_ID: "user_local:other",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
    })).toThrow("AGENT_WORKSPACE_OWNER_ID is invalid");
  });

  it("boots the default unified Host and serves the authenticated workspace read", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-production-host-"));
    const { publicKey } = generateKeyPairSync("ed25519");
    const host = await startSessionIdProductionRuntimeHost({
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: directory,
      AGENT_WORKSPACE_OWNER_ID: "user_local",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5188"]),
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_entry_test",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64url"),
    });
    try {
      const response = await fetch(`${host.url}/runtime/session-id/workspace/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "browser-token-0123456789",
          origin: "http://127.0.0.1:5188",
        },
        body: "{}",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ tasks: [], taskSetupOptions: { workspaces: [] } });
    } finally {
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates or safely migrates only an owned regular Runtime root to mode 0700", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-workspace-production-root-"));
    const runtimeRoot = path.join(parent, "runtime");
    const target = path.join(parent, "target");
    try {
      const { publicKey } = generateKeyPairSync("ed25519");
      const base = {
        AGENT_WORKSPACE_OWNER_ID: "user_local",
        AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
        AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
        AGENT_WORKSPACE_RUNTIME_PORT: "0",
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
          format: "der" as const,
          type: "spki" as const,
        }).toString("base64url"),
      };
      const first = await startSessionIdProductionRuntimeHost({
        ...base,
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeRoot,
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_root_mode",
      });
      await first.close();
      expect(lstatSync(runtimeRoot).mode & 0o777).toBe(0o700);

      chmodSync(runtimeRoot, 0o755);
      const second = await startSessionIdProductionRuntimeHost({
        ...base,
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeRoot,
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_root_migration",
      });
      await second.close();
      expect(lstatSync(runtimeRoot).mode & 0o777).toBe(0o700);

      rmSync(runtimeRoot, { recursive: true, force: true });
      symlinkSync(target, runtimeRoot);
      await expect(startSessionIdProductionRuntimeHost({
        ...base,
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeRoot,
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_root_symlink",
      })).rejects.toThrow("AGENT_WORKSPACE_RUNTIME_DATA_DIR is unsafe");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails missing ACP launch authority or Host input references before filesystem effects", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "agent-workspace-production-preflight-"));
    const runtimeRoot = path.join(parent, "runtime");
    const { publicKey } = generateKeyPairSync("ed25519");
    const base = {
      AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeRoot,
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
      AGENT_WORKSPACE_RUNTIME_PORT: "0",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der" as const,
        type: "spki" as const,
      }).toString("base64url"),
    };
    try {
      await expect(startSessionIdProductionRuntimeHost(base))
        .rejects.toThrow("acp_new_host_epoch_invalid");
      expect(existsSync(runtimeRoot)).toBe(false);

      await expect(startSessionIdProductionRuntimeHost({
        ...base,
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_missing_input",
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify({
          schemaVersion: 1,
          agents: {
            opencode: {
              kind: "opencode-acp-current-install",
              command: { env: "MISSING_OPENCODE_COMMAND" },
              executableSearchPath: { env: "MISSING_OPENCODE_PATH" },
              authFile: { env: "MISSING_OPENCODE_AUTH" },
            },
          },
          metaProfiles: [],
        }),
      })).rejects.toThrow("acp_production_environment_reference_missing");
      expect(existsSync(runtimeRoot)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("boots configured current-install factories without probing or launching before a Task effect", async () => {
    const runtimeRoot = mkdtempSync(path.join(tmpdir(), "agent-workspace-production-configured-"));
    const { publicKey } = generateKeyPairSync("ed25519");
    const acpConfiguration = {
      schemaVersion: 1,
      agents: {
        opencode: {
          kind: "opencode-acp-current-install",
          command: { env: "TEST_OPENCODE_COMMAND" },
          executableSearchPath: { env: "TEST_EXECUTABLE_PATH" },
          authFile: { env: "TEST_OPENCODE_AUTH" },
        },
        codex: {
          kind: "codex-acp-current-install",
          wrapperCommand: { env: "TEST_CODEX_WRAPPER" },
          codexCommand: { env: "TEST_CODEX_COMMAND" },
          nodeCommand: { env: "TEST_NODE_COMMAND" },
          executableSearchPath: { env: "TEST_EXECUTABLE_PATH" },
          authFile: { env: "TEST_CODEX_AUTH" },
        },
      },
      metaProfiles: [],
    } as const;
    try {
      const host = await startSessionIdProductionRuntimeHost({
        AGENT_WORKSPACE_RUNTIME_DATA_DIR: runtimeRoot,
        AGENT_WORKSPACE_RUNTIME_TOKEN: "browser-token-0123456789",
        AGENT_WORKSPACE_RUNTIME_EVIDENCE_TOKEN: "evidence-token-0123456789",
        AGENT_WORKSPACE_RUNTIME_PORT: "0",
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_configured",
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
          format: "der",
          type: "spki",
        }).toString("base64url"),
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(acpConfiguration),
        TEST_OPENCODE_COMMAND: "/not-observed/opencode",
        TEST_OPENCODE_AUTH: "/not-opened/opencode-auth.json",
        TEST_CODEX_WRAPPER: "/not-observed/codex-acp",
        TEST_CODEX_COMMAND: "/not-observed/codex",
        TEST_NODE_COMMAND: "/not-observed/node",
        TEST_CODEX_AUTH: "/not-opened/codex-auth.json",
        TEST_EXECUTABLE_PATH: "/not-observed/bin",
      });
      const configuration = await fetch(`${host.url}/runtime/session-id/configuration/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "browser-token-0123456789",
        },
        body: JSON.stringify({ kind: "template_studio" }),
      });
      expect(configuration.status).toBe(200);
      const close = host.close();
      expect(host.close()).toBe(close);
      await close;
      expect(existsSync(path.join(runtimeRoot, ".acp-host-epoch.lease"))).toBe(false);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
