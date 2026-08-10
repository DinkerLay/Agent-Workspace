import {
  hashDefinition,
  type TemplateDefinition,
  type TemplateDraftRecord,
  type TemplateDraftMetadata,
  type TemplateId,
  type TemplatePackage,
  type TemplateRecord,
  type TemplateVersionId,
  type TemplateVersionRecord,
  validateTemplateDefinition,
} from "../../runtime-contracts/src";
import { assertExpectedRevision, invariant } from "./errors";

export interface CreateTemplateDraftInput {
  readonly templateDraftId: string;
  readonly templateId?: TemplateId;
  readonly baseTemplateVersionId?: TemplateVersionId;
  readonly metadata: TemplateDraftMetadata;
  readonly definition: TemplateDefinition;
  readonly ownerId: string;
  readonly now: string;
}

export function createTemplateDraft(input: CreateTemplateDraftInput): TemplateDraftRecord {
  validateTemplateDefinition(input.definition);
  validateDraftMetadata(input.metadata);
  invariant(input.templateDraftId.startsWith("template_draft_"), "template_draft_id_invalid");
  invariant(Boolean(input.ownerId.trim()), "template_draft_owner_required");
  return {
    templateDraftId: input.templateDraftId,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.baseTemplateVersionId ? { baseTemplateVersionId: input.baseTemplateVersionId } : {}),
    metadata: input.metadata,
    definition: input.definition,
    status: "editing",
    revision: 1,
    ownerId: input.ownerId,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function saveTemplateDraft(
  draft: TemplateDraftRecord,
  expectedRevision: number,
  metadata: TemplateDraftMetadata,
  definition: TemplateDefinition,
  now: string,
): TemplateDraftRecord {
  invariant(draft.status === "editing", "template_draft_not_editable");
  assertExpectedRevision(draft.revision, expectedRevision);
  validateDraftMetadata(metadata);
  validateTemplateDefinition(definition);
  return { ...draft, metadata, definition, revision: draft.revision + 1, updatedAt: now };
}

export function discardTemplateDraft(draft: TemplateDraftRecord, expectedRevision: number, now: string): TemplateDraftRecord {
  invariant(draft.status === "editing", "template_draft_not_discardable");
  assertExpectedRevision(draft.revision, expectedRevision);
  return { ...draft, status: "discarded", revision: draft.revision + 1, updatedAt: now };
}

export interface CreateTemplateIdentityInput {
  readonly templateId: TemplateId;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly now: string;
}

export function createTemplateIdentity(input: CreateTemplateIdentityInput): TemplateRecord {
  invariant(input.templateId.startsWith("template_"), "template_id_invalid");
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug), "template_slug_invalid");
  invariant(Boolean(input.title.trim()), "template_title_required");
  return {
    templateId: input.templateId,
    slug: input.slug,
    title: input.title.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface PublishTemplateDraftInput {
  readonly draft: TemplateDraftRecord;
  readonly template: TemplateRecord;
  readonly expectedDraftRevision: number;
  readonly existingVersions: readonly TemplateVersionRecord[];
  readonly templateVersionId: string;
  readonly now: string;
}

export interface PublishTemplateDraftResult {
  readonly template: TemplateRecord;
  readonly version: TemplateVersionRecord;
  readonly draft: TemplateDraftRecord;
}

/** Publishing creates a new immutable Version; it never changes an old one. */
export function publishTemplateDraft(input: PublishTemplateDraftInput): PublishTemplateDraftResult {
  const { draft, template } = input;
  invariant(draft.status === "editing", "template_draft_not_publishable");
  assertExpectedRevision(draft.revision, input.expectedDraftRevision);
  invariant(!template.archivedAt, "template_archived");
  invariant(!draft.templateId || draft.templateId === template.templateId, "template_draft_identity_mismatch");
  invariant(input.templateVersionId.startsWith("template_version_"), "template_version_id_invalid");
  validateTemplateDefinition(draft.definition);
  const existing = input.existingVersions.filter((version) => version.templateId === template.templateId);
  const versionNumber = Math.max(0, ...existing.map((version) => version.version)) + 1;
  const definitionHash = hashDefinition(draft.definition as unknown as import("../../runtime-contracts/src").JsonValue);
  const version: TemplateVersionRecord = {
    templateVersionId: input.templateVersionId,
    templateId: template.templateId,
    version: versionNumber,
    definition: draft.definition,
    definitionHash,
    createdAt: input.now,
    publishedAt: input.now,
  };
  return {
    template: {
      ...template,
      title: draft.metadata.title,
      ...(draft.metadata.slug ? { slug: draft.metadata.slug } : {}),
      ...(draft.metadata.description ? { description: draft.metadata.description } : {}),
      activeVersionId: version.templateVersionId,
      revision: template.revision + 1,
      updatedAt: input.now,
    },
    version,
    draft: { ...draft, status: "published", revision: draft.revision + 1, updatedAt: input.now },
  };
}

function validateDraftMetadata(metadata: TemplateDraftMetadata): void {
  invariant(Boolean(metadata.title?.trim()), "template_draft_title_required");
  if (metadata.slug !== undefined) invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.slug), "template_draft_slug_invalid");
}

export function archiveTemplate(template: TemplateRecord, expectedRevision: number, now: string): TemplateRecord {
  assertExpectedRevision(template.revision, expectedRevision);
  invariant(!template.archivedAt, "template_already_archived");
  return { ...template, archivedAt: now, revision: template.revision + 1, updatedAt: now };
}

export function templateVersionToPackage(template: TemplateRecord, version: TemplateVersionRecord): TemplatePackage {
  invariant(version.templateId === template.templateId, "template_version_identity_mismatch");
  return {
    schemaVersion: 2,
    kind: "agent-workspace/template",
    template: {
      templateId: template.templateId,
      version: version.version,
      slug: template.slug,
      title: template.title,
      ...(template.description ? { description: template.description } : {}),
      definitionHash: version.definitionHash,
    },
    definition: version.definition,
  };
}
