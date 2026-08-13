import { describe, expect, it } from "vitest";
import { validateTemplatePackageV3 } from "@agent-workspace/runtime-contracts";
import { createRuntimeRepositories, SqliteRuntimeStore } from "@agent-workspace/runtime-store";
import {
  installLegacyTemplateV2Fixture,
  LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
} from "@agent-workspace/test-kit";
import {
  BUILT_IN_ACP_STARTER_PACKAGES,
  BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
  BUILT_IN_TEMPLATE_PROFILE_OPTIONS,
  BUILT_IN_TEMPLATE_PACKAGES,
  installBuiltInTemplates,
} from "./built-in-templates.js";

const NOW = "2026-08-12T00:00:00.000Z";

describe("built-in Templates", () => {
  it("ships one complete Deepsearch workflow with every Session on Codex gpt-5.6-luna", () => {
    const packages = BUILT_IN_TEMPLATE_PACKAGES.map((entry) => validateTemplatePackageV3(entry.package));

    expect(packages).toHaveLength(1);
    expect(packages[0]?.template).toMatchObject({
      templateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
      slug: "deepsearch",
      title: "Deepsearch",
    });
    const definition = packages[0]!.definition;
    expect(definition.agentCards.map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: "researcher", title: "Researcher" },
      { kind: "reviewer", title: "Reviewer" },
      { kind: "publisher", title: "Publisher" },
    ]);
    expect(definition.executionProfiles.map(({ providerFamily, acpAgentKind, model }) => ({
      providerFamily,
      acpAgentKind,
      model,
    }))).toEqual(Array.from({ length: 4 }, () => ({
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      model: "gpt-5.6-luna",
    })));
    expect(definition.executionProfiles[0]?.capabilityPolicy.allowedTools).toEqual([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]);
    expect(definition.executionProfiles.slice(1).map(({ capabilityPolicy }) => capabilityPolicy.allowedTools)).toEqual([
      [], [], [],
    ]);
    expect(definition.executionProfiles.every(({ capabilityPolicy }) =>
      capabilityPolicy.permissionMode === "preapproved")).toBe(true);
    expect(definition.taskInputSchema?.fields.map(({ fieldId }) => fieldId)).toEqual([
      "research-question",
      "scope-and-constraints",
      "report-language",
    ]);
    expect(definition.deliverables).toEqual([expect.objectContaining({
      artifactPath: "reports/deepsearch-report.md",
      ownerAgentCardId: "agent_card_deepsearch-publisher",
    })]);
  });

  it("offers every Deepsearch role through the Host-owned Codex, Claude Code, and OpenCode catalog", () => {
    expect(BUILT_IN_TEMPLATE_PROFILE_OPTIONS).toHaveLength(12);
    expect(BUILT_IN_TEMPLATE_PROFILE_OPTIONS.map(({ role, profile }) => ({
      role,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      model: profile.model,
      permissionMode: profile.capabilityPolicy.permissionMode,
      allowedTools: profile.capabilityPolicy.allowedTools,
    }))).toEqual([
      ...["conductor", "researcher", "reviewer", "publisher"].map((role) => ({
        role,
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        model: "gpt-5.6-luna",
        permissionMode: "preapproved",
        allowedTools: role === "conductor"
          ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
          : [],
      })),
      ...["conductor", "researcher", "reviewer", "publisher"].map((role) => ({
        role,
        providerFamily: "claude-code",
        acpAgentKind: "claude_agent_acp",
        model: "claude-opus-5[1M]",
        permissionMode: "preapproved",
        allowedTools: role === "conductor"
          ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
          : [],
      })),
      ...["conductor", "researcher", "reviewer", "publisher"].map((role) => ({
        role,
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        model: "opencode-go/gpt-5.6-luna",
        permissionMode: "preapproved",
        allowedTools: role === "conductor"
          ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
          : [],
      })),
    ]);
    expect(BUILT_IN_TEMPLATE_PROFILE_OPTIONS.every(({ sourceTemplateId, sourceTemplateVersionId }) =>
      sourceTemplateId === BUILT_IN_DEEPSEARCH_TEMPLATE_ID
      && sourceTemplateVersionId === "template_version_builtin-deepsearch-v1")).toBe(true);
  });

  it("never pins Host-local resolution, artifact versions, paths, hashes, or credentials", () => {
    for (const entry of [...BUILT_IN_TEMPLATE_PACKAGES, ...BUILT_IN_ACP_STARTER_PACKAGES]) {
      const json = JSON.stringify(validateTemplatePackageV3(entry.package));
      expect(json).not.toMatch(/providerVersion|protocolFingerprint|launcher|resolution|credential|digest|binaryHash|\/Users\//u);
    }
  });

  it("installs and reads each immutable v3 Version through strict Store dispatch", () => {
    const store = new SqliteRuntimeStore({ path: ":memory:", now: () => NOW });
    const repositories = createRuntimeRepositories(store);
    installBuiltInTemplates(repositories, NOW);

    for (const source of BUILT_IN_TEMPLATE_PACKAGES) {
      const version = repositories.templateTask.getTemplateVersion(source.templateVersionId);
      expect(version?.definition).toEqual(validateTemplatePackageV3(source.package).definition);
      expect(version?.definition.schemaVersion).toBe(3);
      expect(store.one<{ schema_version: number }>(
        "SELECT schema_version FROM template_versions WHERE template_version_id = ?",
        source.templateVersionId,
      )?.schema_version).toBe(3);
    }
    expect(store.many<{ schema_version: number }>(
      "SELECT schema_version FROM template_versions ORDER BY template_version_id",
    )).toEqual(BUILT_IN_TEMPLATE_PACKAGES.map(() => ({ schema_version: 3 })));
    expect(repositories.templateTask.listTemplateLibrary().map(({ template }) => template.title)).toEqual([
      "Deepsearch",
    ]);
    store.close();
  });

  it("preserves pre-existing v2 bytes while installing only fresh v3 built-ins", () => {
    const store = new SqliteRuntimeStore({ path: ":memory:", now: () => NOW });
    const repositories = createRuntimeRepositories(store);
    installLegacyTemplateV2Fixture(repositories.templateTask, NOW);
    const before = store.one<{ definition_json: string; definition_hash: string; schema_version: number }>(
      `SELECT definition_json, definition_hash, schema_version
       FROM template_versions WHERE template_version_id = ?`,
      LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
    );

    installBuiltInTemplates(repositories, "2026-08-12T00:00:01.000Z");

    expect(store.one(
      `SELECT definition_json, definition_hash, schema_version
       FROM template_versions WHERE template_version_id = ?`,
      LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
    )).toEqual(before);
    expect(repositories.templateTask.getTemplateVersion(
      LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
    )?.definition.schemaVersion).toBe(2);
    expect(store.many<{ schema_version: number }>(
      "SELECT schema_version FROM template_versions ORDER BY template_version_id",
    ).map(({ schema_version }) => schema_version)).toEqual([2, 3]);
    store.close();
  });
});
