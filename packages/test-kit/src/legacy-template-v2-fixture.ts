import {
  hashDefinition,
  type JsonValue,
  type TemplateAssetRecord,
  type TemplatePackage,
  type TemplateRecord,
  type TemplateVersionRecord,
} from "@agent-workspace/runtime-contracts";
import { templatePackageFixture } from "./fixtures.js";

export const LEGACY_CODEX_STARTER_TEMPLATE_ID = "template_builtin-codex-starter";
export const LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID = "template_version_builtin-codex-starter-v1";

type LegacyTemplateFixtureStore = Readonly<{
  importPackage(
    template: TemplateRecord,
    version: TemplateVersionRecord,
    packageValue: TemplatePackage,
    assets: readonly TemplateAssetRecord[],
  ): unknown;
}>;

/** Test-only historical row used to prove v2 read/migrate behavior. */
export function installLegacyTemplateV2Fixture(
  store: LegacyTemplateFixtureStore,
  now: string,
): TemplateVersionRecord {
  const base = templatePackageFixture();
  const packageValue: TemplatePackage = {
    ...base,
    template: {
      ...base.template,
      templateId: LEGACY_CODEX_STARTER_TEMPLATE_ID,
      slug: "legacy-codex-starter",
      title: "Legacy Codex Starter",
    },
  };
  const template: TemplateRecord = {
    templateId: packageValue.template.templateId,
    slug: packageValue.template.slug,
    title: packageValue.template.title,
    activeVersionId: LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const version: TemplateVersionRecord = {
    templateVersionId: LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
    templateId: template.templateId,
    version: packageValue.template.version,
    definition: packageValue.definition,
    definitionHash: hashDefinition(packageValue.definition as unknown as JsonValue),
    createdAt: now,
    publishedAt: now,
  };
  store.importPackage(template, version, packageValue, []);
  return version;
}
