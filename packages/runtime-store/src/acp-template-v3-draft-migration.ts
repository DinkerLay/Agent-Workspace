import {
  EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  hashDefinition,
  type JsonValue,
  type TemplateDefinitionV2,
  type TemplateDefinitionV3,
  type TemplateDraftMetadata,
  validateTemplateDefinition,
  validateTemplateDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { decodeJson, encodeJson, type SqliteRuntimeStore } from "./sqlite.js";

type Row = Record<string, unknown>;

export type AcpTemplateVersionRead = Readonly<{
  templateVersionId: string;
  templateId: string;
  version: number;
  definitionHash: string;
  assetManifestHash: string;
  createdAt: string;
  publishedAt: string;
}> & (
  | Readonly<{ schemaVersion: 2; definition: TemplateDefinitionV2 }>
  | Readonly<{ schemaVersion: 3; definition: TemplateDefinitionV3 }>
);

export type AcpV3TemplateDraftCandidate = Readonly<{
  templateDraftId: string;
  ownerId: string;
  metadata: TemplateDraftMetadata;
  definition: TemplateDefinitionV3;
  createdAt: string;
}>;

export type AcpTemplateV3DraftMigrationRepository = Readonly<{
  /** Schema-dispatched, immutable read of a published v2 or v3 Version. */
  readPublishedVersion(templateVersionId: string): AcpTemplateVersionRead | undefined;
  /** Explicitly creates a new v3 Draft from v2; it never updates the source Version. */
  createV3DraftFromPublishedV2(input: Readonly<{
    sourceTemplateVersionId: string;
    expectedSourceDefinitionHash: string;
    draft: AcpV3TemplateDraftCandidate;
  }>): "created" | "idempotent";
}>;

/**
 * Provider/Profile migration seam for the Template owner. v2 stays readable
 * and immutable; only an explicit command may persist a new ACP-only v3 Draft.
 */
export function createAcpTemplateV3DraftMigrationRepository(
  store: SqliteRuntimeStore,
): AcpTemplateV3DraftMigrationRepository {
  const readPublishedVersion = (templateVersionId: string): AcpTemplateVersionRead | undefined => {
    const row = store.one<Row>(
      `SELECT template_version_id, template_id, version, schema_version, definition_json,
              definition_hash, asset_manifest_hash, created_at, published_at
       FROM template_versions WHERE template_version_id = ?`,
      requiredId(templateVersionId, "template_version", "acp_template_version_id_invalid"),
    );
    return row ? versionFromRow(row) : undefined;
  };

  return Object.freeze({
    readPublishedVersion,
    createV3DraftFromPublishedV2(input) {
      const sourceId = requiredId(
        input?.sourceTemplateVersionId,
        "template_version",
        "acp_template_migration_source_invalid",
      );
      const expectedHash = requiredHash(input?.expectedSourceDefinitionHash);
      const candidate = validateDraftCandidate(input?.draft);
      return store.transaction(() => {
        const source = readPublishedVersion(sourceId);
        if (!source) throw new Error("acp_template_migration_source_not_found");
        if (source.schemaVersion !== 2) throw new Error("acp_template_migration_source_not_v2");
        if (source.definitionHash !== expectedHash) throw new Error("acp_template_migration_source_hash_stale");
        if (hashDefinition(source.definition as unknown as JsonValue) !== source.definitionHash) {
          throw new Error("acp_template_migration_source_hash_corrupt");
        }

        const existing = store.one<Row>(
          "SELECT * FROM template_design_sessions WHERE draft_id = ?",
          candidate.templateDraftId,
        );
        if (existing) {
          if (!sameDraft(existing, source, candidate)) throw new Error("acp_template_migration_draft_id_conflict");
          return "idempotent";
        }
        store.run(
          `INSERT INTO template_design_sessions(
             draft_id, template_id, base_template_version_id, metadata_json, definition_json,
             status, owner_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'editing', ?, 1, ?, ?)`,
          candidate.templateDraftId,
          source.templateId,
          source.templateVersionId,
          encodeJson(candidate.metadata),
          encodeJson(candidate.definition),
          candidate.ownerId,
          candidate.createdAt,
          candidate.createdAt,
        );
        return "created";
      });
    },
  });
}

function versionFromRow(row: Row): AcpTemplateVersionRead {
  const schemaVersion = positiveInteger(row.schema_version);
  const common = {
    templateVersionId: text(row.template_version_id),
    templateId: text(row.template_id),
    version: positiveInteger(row.version),
    definitionHash: requiredHash(row.definition_hash),
    assetManifestHash: optionalText(row.asset_manifest_hash) ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
    createdAt: text(row.created_at),
    publishedAt: text(row.published_at),
  };
  if (schemaVersion === 2) {
    return Object.freeze({
      ...common,
      schemaVersion,
      definition: validateTemplateDefinition(decodeJson<unknown>(row.definition_json)),
    });
  }
  if (schemaVersion === 3) {
    return Object.freeze({
      ...common,
      schemaVersion,
      definition: validateTemplateDefinitionV3(decodeJson<unknown>(row.definition_json)),
    });
  }
  throw new Error("acp_template_version_schema_unsupported");
}

function validateDraftCandidate(value: AcpV3TemplateDraftCandidate): AcpV3TemplateDraftCandidate {
  if (!value || typeof value !== "object") throw new Error("acp_template_migration_draft_invalid");
  const templateDraftId = requiredId(value.templateDraftId, "template_draft", "acp_template_migration_draft_invalid");
  if (typeof value.ownerId !== "string" || !value.ownerId.trim()) {
    throw new Error("acp_template_migration_owner_invalid");
  }
  if (!value.metadata || typeof value.metadata.title !== "string" || !value.metadata.title.trim()) {
    throw new Error("acp_template_migration_metadata_invalid");
  }
  if (typeof value.createdAt !== "string" || !value.createdAt) {
    throw new Error("acp_template_migration_created_at_invalid");
  }
  return Object.freeze({
    templateDraftId,
    ownerId: value.ownerId,
    metadata: Object.freeze({ ...value.metadata }),
    definition: validateTemplateDefinitionV3(value.definition),
    createdAt: value.createdAt,
  });
}

function sameDraft(
  row: Row,
  source: AcpTemplateVersionRead,
  candidate: AcpV3TemplateDraftCandidate,
): boolean {
  if (text(row.template_id) !== source.templateId
    || text(row.base_template_version_id) !== source.templateVersionId
    || text(row.status) !== "editing"
    || text(row.owner_id) !== candidate.ownerId
    || positiveInteger(row.revision) !== 1
    || text(row.created_at) !== candidate.createdAt
    || text(row.updated_at) !== candidate.createdAt) return false;
  const metadata = decodeJson<unknown>(row.metadata_json);
  const definition = validateTemplateDefinitionV3(decodeJson<unknown>(row.definition_json));
  return encodeJson(metadata) === encodeJson(candidate.metadata)
    && encodeJson(definition) === encodeJson(candidate.definition);
}

function requiredId(value: unknown, prefix: string, code: string): string {
  if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || value.length > 512) throw new Error(code);
  return value;
}

function requiredHash(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("acp_template_migration_hash_invalid");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("acp_template_version_row_corrupt");
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("acp_template_version_row_corrupt");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}
