import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  hashDefinition,
  type JsonValue,
  type TemplateDefinitionV2,
  type TemplateDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntimeStore } from "./sqlite.js";
import { createAcpTemplateV3DraftMigrationRepository } from "./acp-template-v3-draft-migration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("ACP Template v3 Draft migration repository", () => {
  it("schema-dispatches v2/v3 reads and creates only a new v3 Draft without changing v2 bytes", () => {
    const store = runtimeStore();
    const source = definitionV2();
    const sourceBytes = ` \n${JSON.stringify(source)}\n `;
    const sourceHash = hashDefinition(source as unknown as JsonValue);
    insertTemplate(store);
    insertVersion(store, {
      id: "template_version_source-v2",
      version: 1,
      schemaVersion: 2,
      definitionBytes: sourceBytes,
      definitionHash: sourceHash,
    });
    const targetV3 = definitionV3();
    const targetHash = hashDefinition(targetV3 as unknown as JsonValue);
    insertVersion(store, {
      id: "template_version_existing-v3",
      version: 2,
      schemaVersion: 3,
      definitionBytes: JSON.stringify(targetV3),
      definitionHash: targetHash,
    });
    const repository = createAcpTemplateV3DraftMigrationRepository(store);

    expect(repository.readPublishedVersion("template_version_source-v2")?.schemaVersion).toBe(2);
    expect(repository.readPublishedVersion("template_version_existing-v3")?.schemaVersion).toBe(3);
    const before = store.one<{ definition_json: string; schema_version: number }>(
      "SELECT definition_json, schema_version FROM template_versions WHERE template_version_id = ?",
      "template_version_source-v2",
    );
    const command = {
      sourceTemplateVersionId: "template_version_source-v2",
      expectedSourceDefinitionHash: sourceHash,
      draft: {
        templateDraftId: "template_draft_explicit-v3-migration",
        ownerId: "user_owner",
        metadata: { title: "Explicit ACP v3 candidate" },
        definition: targetV3,
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    } as const;
    expect(repository.createV3DraftFromPublishedV2(command)).toBe("created");
    expect(repository.createV3DraftFromPublishedV2(command)).toBe("idempotent");

    expect(store.one<{ definition_json: string; schema_version: number }>(
      "SELECT definition_json, schema_version FROM template_versions WHERE template_version_id = ?",
      "template_version_source-v2",
    )).toEqual(before);
    const draft = store.one<{
      base_template_version_id: string;
      definition_json: string;
      revision: number;
      status: string;
    }>("SELECT base_template_version_id, definition_json, revision, status FROM template_design_sessions WHERE draft_id = ?", command.draft.templateDraftId);
    expect(draft).toMatchObject({
      base_template_version_id: "template_version_source-v2",
      revision: 1,
      status: "editing",
    });
    expect(JSON.parse(draft!.definition_json)).toEqual(targetV3);
    store.close();
  });

  it("fails before writes for a stale hash, non-v2 source, or v2 candidate", () => {
    const store = runtimeStore();
    const source = definitionV2();
    const sourceHash = hashDefinition(source as unknown as JsonValue);
    insertTemplate(store);
    insertVersion(store, {
      id: "template_version_source-v2-fail",
      version: 1,
      schemaVersion: 2,
      definitionBytes: JSON.stringify(source),
      definitionHash: sourceHash,
    });
    const existingV3 = definitionV3();
    const existingV3Hash = hashDefinition(existingV3 as unknown as JsonValue);
    insertVersion(store, {
      id: "template_version_not-source-v3",
      version: 2,
      schemaVersion: 3,
      definitionBytes: JSON.stringify(existingV3),
      definitionHash: existingV3Hash,
    });
    const repository = createAcpTemplateV3DraftMigrationRepository(store);
    const base = {
      sourceTemplateVersionId: "template_version_source-v2-fail",
      expectedSourceDefinitionHash: sourceHash,
      draft: {
        templateDraftId: "template_draft_fail-first-v3",
        ownerId: "user_owner",
        metadata: { title: "Candidate" },
        definition: definitionV3(),
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    } as const;
    expect(() => repository.createV3DraftFromPublishedV2({
      ...base,
      expectedSourceDefinitionHash: "fnv1a64:0000000000000000",
    })).toThrow("acp_template_migration_source_hash_stale");
    expect(() => repository.createV3DraftFromPublishedV2({
      ...base,
      draft: { ...base.draft, definition: source as unknown as TemplateDefinitionV3 },
    })).toThrow();
    expect(() => repository.createV3DraftFromPublishedV2({
      ...base,
      sourceTemplateVersionId: "template_version_not-source-v3",
      expectedSourceDefinitionHash: existingV3Hash,
    })).toThrow("acp_template_migration_source_not_v2");
    expect(store.one<{ total: number }>("SELECT COUNT(*) AS total FROM template_design_sessions")?.total).toBe(0);
    store.close();
  });

  it("rejects an unknown published schema without decoding or rewriting its bytes", () => {
    const store = runtimeStore();
    insertTemplate(store);
    const opaqueBytes = "not-json-private-version-bytes";
    store.run(
      `INSERT INTO template_versions(
         template_version_id, template_id, version, schema_version, definition_json,
         definition_hash, asset_manifest_hash, created_at, published_at
       ) VALUES ('template_version_unknown-schema', 'template_migration', 1, 99, ?,
         'unknown:preserved', ?, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
      opaqueBytes,
      EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
    );
    const repository = createAcpTemplateV3DraftMigrationRepository(store);
    expect(() => repository.readPublishedVersion("template_version_unknown-schema"))
      .toThrow("acp_template_version_schema_unsupported");
    expect(store.one<{ definition_json: string }>(
      "SELECT definition_json FROM template_versions WHERE template_version_id = 'template_version_unknown-schema'",
    )?.definition_json).toBe(opaqueBytes);
    store.close();
  });
});

function runtimeStore(): SqliteRuntimeStore {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-template-v3-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite") });
}

function insertTemplate(store: SqliteRuntimeStore): void {
  store.run(
    `INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
     VALUES ('template_migration', 'migration', 'Migration', 'active', 1, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
  );
}

function insertVersion(store: SqliteRuntimeStore, input: Readonly<{
  id: string;
  version: number;
  schemaVersion: 2 | 3;
  definitionBytes: string;
  definitionHash: string;
}>): void {
  store.run(
    `INSERT INTO template_versions(
       template_version_id, template_id, version, schema_version, definition_json,
       definition_hash, asset_manifest_hash, created_at, published_at
     ) VALUES (?, 'template_migration', ?, ?, ?, ?, ?, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
    input.id,
    input.version,
    input.schemaVersion,
    input.definitionBytes,
    input.definitionHash,
    EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  );
}

function definitionV2(): TemplateDefinitionV2 {
  const capabilityPolicy = {
    requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"] as const,
    allowedTools: [] as const,
    permissionMode: "deny" as const,
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  };
  return {
    schemaVersion: 2,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_shared",
      systemPrompt: "Coordinate.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: "profile_shared",
      systemPrompt: "Work.",
      capabilityRefs: [],
      dispatchProfile: { title: "Worker", description: "Work." },
    }],
    executionProfiles: [{
      executionProfileId: "profile_shared",
      provider: "codex",
      model: "legacy-model",
      providerVersion: "preserved",
      protocolFingerprint: "preserved",
      capabilityPolicy,
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [],
  };
}

function definitionV3(): TemplateDefinitionV3 {
  const capabilityPolicy = {
    requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"] as const,
    allowedTools: [] as const,
    permissionMode: "ask" as const,
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  };
  return {
    schemaVersion: 3,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_shared",
      systemPrompt: "Coordinate.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: "profile_shared",
      systemPrompt: "Work.",
      capabilityRefs: [],
      dispatchProfile: { title: "Worker", description: "Work." },
    }],
    executionProfiles: [{
      executionProfileId: "profile_shared",
      profileRevisionId: "profile_revision_shared-1",
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      protocolMajor: 1,
      model: "current-model",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy,
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [],
  };
}
