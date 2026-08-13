import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AcpMetaAgentTurnRequest,
  MetaAgentTurnReconciliation,
} from "@agent-workspace/provider-port";
import {
  validateAcpProfileReadinessObservation,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpMetaProviderComposition,
  AcpMetaProfileRegistration,
} from "./acp-meta-provider-composition.js";
import {
  createAcpProductionHostInputs,
  parseAcpProductionConfiguration,
} from "./acp-production-configuration.js";
import { createAcpRuntimeHostPrivateAuthority } from "./acp-runtime-host-private-authority.js";
import { createAcpProductionMetaOwner } from "./session-id-acp-production-composition.js";

const OPEN_CODE_META: MetaProfileDefinitionV3 = Object.freeze({
  metaProfileId: "meta_profile_opencode-production",
  profileRevisionId: "profile_revision_meta-opencode-production-v1",
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  protocolMajor: 1,
  role: "meta",
  model: "opencode/current-meta",
  configIntent: Object.freeze({}),
  requiredExtensions: Object.freeze([]),
  capabilityPolicy: Object.freeze({
    requiredCapabilities: Object.freeze([
      "create_binding",
      "resume_binding",
      "input_correlation",
      "provider_receipt",
      "reconcile",
      "interrupt",
    ] as const),
    allowedTools: Object.freeze([]),
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  }),
});

const CODEX_META: MetaProfileDefinitionV3 = Object.freeze({
  ...OPEN_CODE_META,
  metaProfileId: "meta_profile_codex-production",
  profileRevisionId: "profile_revision_meta-codex-production-v1",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  model: "openai/current-meta",
  configIntent: Object.freeze({ reasoningEffort: "high" }),
});

const CLAUDE_CODE_META: MetaProfileDefinitionV3 = Object.freeze({
  ...OPEN_CODE_META,
  metaProfileId: "meta_profile_claude-code-production",
  profileRevisionId: "profile_revision_meta-claude-code-production-v1",
  providerFamily: "claude-code",
  acpAgentKind: "claude_agent_acp",
  model: "claude-opus-5[1M]",
});

describe("ACP production Meta owner", () => {
  it("builds independent Meta registrations from current-install Host inputs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "acp-production-meta-owner-"));
    chmodSync(root, 0o700);
    const authority = privateAuthority(root);
    const configuration = productionConfiguration();
    const hostInputs = createAcpProductionHostInputs(configuration, hostEnvironment());
    let captured: Readonly<{
      profiles: readonly AcpMetaProfileRegistration[];
      privateRootParent: string;
      processFactoryOptions: Readonly<{ identityVaultResolver: unknown }>;
    }> | undefined;
    const provider = controlledProvider(configuration.metaProfiles.map((entry) => ({
      metaProfileOptionId: entry.metaProfileOptionId,
      title: entry.title,
      profile: entry.profile,
    })));

    try {
      const owner = createAcpProductionMetaOwner({
        configuration,
        hostInputs,
        privateAuthority: authority,
        controlledCreateComposition(input) {
          captured = input;
          return provider;
        },
      });

      expect(captured?.profiles).toHaveLength(3);
      expect(captured?.profiles.map((entry) => entry.descriptor.descriptorId)).toEqual([
        "opencode-acp-current-install-v1",
        "codex-acp-current-install-v1",
        "claude-acp-current-install-v1",
      ]);
      expect(captured?.profiles[1]?.sessionConfiguration).toEqual({
        model: "openai/current-meta",
        options: [{
          configId: "reasoning_effort",
          category: "thought_level",
          type: "select",
          value: "high",
        }],
      });
      expect(captured?.profiles[2]?.sessionConfiguration).toEqual({
        model: "claude-opus-5[1M]",
        options: [{
          configId: "mode",
          category: "mode",
          type: "select",
          value: "dontAsk",
        }],
      });
      expect(captured?.profiles.every((entry) => (
        typeof entry.createConnection === "function"
        && typeof entry.beginCredentialAcquisition === "function"
        && entry.profile.capabilityPolicy.allowedTools.length === 0
      ))).toBe(true);
      expect(captured?.processFactoryOptions.identityVaultResolver)
        .toBe(authority.metaIdentityVaults);
      expect(captured?.processFactoryOptions.identityVaultResolver)
        .not.toBe(authority.taskIdentityVaults);
      expect(captured?.privateRootParent).toBe(path.join(
        realpathSync(root),
        "acp-meta-provider-runtime",
        "session-cwd",
      ));
      expect(captured?.privateRootParent).not.toContain("acp-task-provider-runtime");
      expect(owner.registrations).toHaveLength(3);

      const port = owner.registrations[0]!.port;
      await expect(port.checkMetaProfileReadiness(
        "meta_profile_option_opencode-production",
      )).resolves.toMatchObject({ status: "available", role: "meta" });
      await expect(port.openMetaSession({
        metaSessionId: "meta_session_production_create",
        metaProfileOptionId: "meta_profile_option_opencode-production",
        disposition: "create",
      })).resolves.toMatchObject({ available: true });
      await expect(port.openMetaSession({
        metaSessionId: "meta_session_production_resume",
        metaProfileOptionId: "meta_profile_option_opencode-production",
        disposition: "resume",
      })).resolves.toMatchObject({ available: true });
      expect(provider.openedDispositions).toEqual(["create", "resume"]);
      const projection = JSON.stringify(owner);
      expect(projection).toBe('{"kind":"acp_production_meta_owner","profileCount":3}');
      expect(projection).not.toContain(root);
      expect(projection).not.toContain("/private/");
      await owner.close();
    } finally {
      authority.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps Meta cleanup failure sticky", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "acp-production-meta-sticky-"));
    chmodSync(root, 0o700);
    const authority = privateAuthority(root);
    const configuration = productionConfiguration();
    const close = vi.fn(async () => { throw new Error("controlled cleanup failure"); });
    const provider = controlledProvider(configuration.metaProfiles.map((entry) => ({
      metaProfileOptionId: entry.metaProfileOptionId,
      title: entry.title,
      profile: entry.profile,
    })), close);
    try {
      const owner = createAcpProductionMetaOwner({
        configuration,
        hostInputs: createAcpProductionHostInputs(configuration, hostEnvironment()),
        privateAuthority: authority,
        controlledCreateComposition: () => provider,
      });
      const first = owner.close();
      expect(owner.close()).toBe(first);
      await expect(first).rejects.toThrow("acp_production_meta_cleanup_unconfirmed");
      await expect(owner.close()).rejects.toThrow("acp_production_meta_cleanup_unconfirmed");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      authority.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function controlledProvider(
  options: readonly Omit<MetaProfileOptionDefinitionV3, "readiness">[],
  close: () => Promise<void> = async () => undefined,
): AcpMetaProviderComposition & Readonly<{ openedDispositions: string[] }> {
  const openedDispositions: string[] = [];
  const projected = options.map((option) => Object.freeze({
    ...option,
    readiness: readiness(option.profile),
  }));
  return Object.freeze({
    openedDispositions,
    listMetaProfileOptions: () => Object.freeze(projected),
    readMetaProfileOption: (id) => projected.find((entry) => entry.metaProfileOptionId === id),
    async checkMetaProfileReadiness(id) {
      return projected.find((entry) => entry.metaProfileOptionId === id)!.readiness;
    },
    async checkMetaProfileQualificationReport() {
      throw new Error("controlled_meta_qualification_report_not_available");
    },
    async openMetaSession(input) {
      openedDispositions.push(input.disposition);
      const option = projected.find((entry) => entry.metaProfileOptionId === input.metaProfileOptionId)!;
      return Object.freeze({
        available: true as const,
        session: Object.freeze({
          metaSessionId: input.metaSessionId,
          metaProfileOptionId: input.metaProfileOptionId,
          profileRevisionId: option.profile.profileRevisionId,
          providerFamily: option.profile.providerFamily,
          acpAgentKind: option.profile.acpAgentKind,
          role: "meta" as const,
          model: option.profile.model,
          status: "ready" as const,
        }),
        readiness: option.readiness,
      });
    },
    async startMetaTurn(_request: AcpMetaAgentTurnRequest) { return "accepted" as const; },
    async reconcileMetaTurn(
      _request: AcpMetaAgentTurnRequest,
    ): Promise<MetaAgentTurnReconciliation> { return { state: "absent" }; },
    async closeMetaSession() {},
    close,
  });
}

function readiness(profile: MetaProfileDefinitionV3) {
  return validateAcpProfileReadinessObservation({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role: "meta",
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: profile.model,
    observedProtocolMajor: 1,
    observedAgent: { name: `${profile.providerFamily}-acp`, version: "current" },
  });
}

function productionConfiguration() {
  return parseAcpProductionConfiguration(JSON.stringify({
    schemaVersion: 1,
    agents: {
      opencode: {
        kind: "opencode-acp-current-install",
        command: { env: "TEST_OPENCODE_COMMAND" },
        executableSearchPath: { env: "TEST_ACP_SEARCH_PATH" },
        authFile: { env: "TEST_OPENCODE_AUTH" },
      },
      codex: {
        kind: "codex-acp-current-install",
        wrapperCommand: { env: "TEST_CODEX_WRAPPER" },
        codexCommand: { env: "TEST_CODEX_COMMAND" },
        nodeCommand: { env: "TEST_NODE_COMMAND" },
        executableSearchPath: { env: "TEST_ACP_SEARCH_PATH" },
        authFile: { env: "TEST_CODEX_AUTH" },
      },
      claudeCode: {
        kind: "claude-agent-acp-current-install",
        wrapperCommand: { env: "TEST_CLAUDE_ACP_WRAPPER" },
        claudeCommand: { env: "TEST_CLAUDE_COMMAND" },
        nodeCommand: { env: "TEST_NODE_COMMAND" },
        executableSearchPath: { env: "TEST_ACP_SEARCH_PATH" },
        settingsFile: { env: "TEST_CLAUDE_SETTINGS" },
      },
    },
    metaProfiles: [
      {
        metaProfileOptionId: "meta_profile_option_opencode-production",
        title: "OpenCode Meta",
        profile: OPEN_CODE_META,
      },
      {
        metaProfileOptionId: "meta_profile_option_codex-production",
        title: "Codex Meta",
        profile: CODEX_META,
      },
      {
        metaProfileOptionId: "meta_profile_option_claude-code-production",
        title: "Claude Code Meta",
        profile: CLAUDE_CODE_META,
      },
    ],
  }));
}

function hostEnvironment() {
  return {
    TEST_OPENCODE_COMMAND: "/private/install/opencode",
    TEST_OPENCODE_AUTH: "/private/auth/opencode.json",
    TEST_CODEX_WRAPPER: "/private/install/codex-acp",
    TEST_CODEX_COMMAND: "/private/install/codex",
    TEST_NODE_COMMAND: "/private/install/node",
    TEST_CODEX_AUTH: "/private/auth/codex.json",
    TEST_CLAUDE_ACP_WRAPPER: "/private/install/claude-agent-acp",
    TEST_CLAUDE_COMMAND: "/private/install/claude",
    TEST_CLAUDE_SETTINGS: "/private/auth/claude-settings.json",
    TEST_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
  };
}

function privateAuthority(runtimeDataDirectory: string) {
  const { publicKey } = generateKeyPairSync("ed25519");
  return createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory,
    environment: {
      AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_production_meta_owner",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        type: "spki",
        format: "der",
      }).toString("base64url"),
    },
  });
}
