import { inflateSync, zipSync } from "fflate";
import type { JsonObject, JsonValue } from "./json";
import {
  parseYamlDocument,
  serializeYamlDocument,
  type TemplateAssetTransport,
  type TemplatePackage,
  validateTemplatePackage,
} from "./templates";
import { hashDefinition } from "./json";

export const TEMPLATE_ARCHIVE_EXTENSION = ".agent-template.zip";
export const TEMPLATE_ARCHIVE_MANIFEST_PATH = "manifest.yaml";
export const TEMPLATE_ARCHIVE_ASSET_PREFIX = "assets/";
export const TEMPLATE_ARCHIVE_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_ARCHIVE_KIND = "agent-workspace/template-archive" as const;
/** FNV-1a hash of the canonical empty asset manifest `[]`. */
export const EMPTY_TEMPLATE_ASSET_MANIFEST_HASH = "fnv1a64:09612b07b5ecb5a5";

/** Conservative limits are checked before decompression. */
export const TEMPLATE_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxAssets: 64,
  maxAssetBytes: 4 * 1024 * 1024,
  maxTotalUncompressedBytes: 16 * 1024 * 1024,
  maxEntryPathBytes: 512,
});

export interface TemplateArchiveAsset {
  /** Path below `assets/`; it is never an absolute filesystem path. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

export interface TemplateArchiveAssetManifest {
  readonly path: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly contentType?: string;
}

/** `manifest.yaml` payload. JSON-compatible YAML is used to avoid executable YAML features. */
export interface TemplateArchiveManifest {
  readonly schemaVersion: typeof TEMPLATE_ARCHIVE_SCHEMA_VERSION;
  readonly kind: typeof TEMPLATE_ARCHIVE_KIND;
  readonly package: TemplatePackage;
  readonly assets: readonly TemplateArchiveAssetManifest[];
}

export interface EncodeTemplateArchiveInput {
  readonly package: TemplatePackage;
  readonly assets?: readonly TemplateArchiveAsset[];
}

export interface DecodedTemplateArchive {
  readonly package: TemplatePackage;
  readonly assets: readonly TemplateArchiveAsset[];
  readonly manifest: TemplateArchiveManifest;
  readonly assetManifestHash: string;
}

/** The normalized form used by ZIP decode and Runtime import before persistence. */
export interface ValidatedTemplateArchivePayload {
  readonly package: TemplatePackage;
  readonly assets: readonly TemplateArchiveAsset[];
  readonly manifest: TemplateArchiveManifest;
  readonly assetManifestHash: string;
}

export class TemplateArchiveError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "TemplateArchiveError";
    this.code = code;
  }
}

/**
 * Creates a shareable `.agent-template.zip`. The exact TemplatePackage
 * validator remains the authority for template content; assets are opaque
 * binary attachments and cannot add credentials, cwd or native sessions.
 */
export function encodeTemplateArchive(input: EncodeTemplateArchiveInput): Uint8Array {
  const prepared = validateTemplateArchivePayload(input);
  const files: Record<string, Uint8Array> = {
    [TEMPLATE_ARCHIVE_MANIFEST_PATH]: encodeUtf8(serializeTemplateArchiveManifestYaml(prepared.manifest)),
  };
  for (const asset of prepared.assets) files[`${TEMPLATE_ARCHIVE_ASSET_PREFIX}${asset.path}`] = asset.bytes;
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new TemplateArchiveError("template_archive_too_large");
  }
  return Uint8Array.from(archive);
}

/** Decodes only the safe archive grammar; no path is ever materialized to disk. */
export function decodeTemplateArchive(input: Uint8Array): DecodedTemplateArchive {
  if (!(input instanceof Uint8Array)) throw new TemplateArchiveError("template_archive_bytes_required");
  if (input.byteLength === 0) throw new TemplateArchiveError("template_archive_empty");
  if (input.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxArchiveBytes) throw new TemplateArchiveError("template_archive_too_large");

  const entries = inspectZip(input);
  const unzipped = extractZipEntries(input, entries);
  assertExactUnzippedEntries(entries, unzipped);
  const manifestBytes = unzipped[TEMPLATE_ARCHIVE_MANIFEST_PATH];
  if (!manifestBytes) throw new TemplateArchiveError("template_archive_manifest_missing");
  if (manifestBytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxManifestBytes) {
    throw new TemplateArchiveError("template_archive_manifest_too_large");
  }
  let rawManifest: JsonValue;
  try {
    rawManifest = parseYamlDocument(decodeUtf8(manifestBytes));
  } catch (error) {
    if (error instanceof TemplateArchiveError) throw error;
    throw new TemplateArchiveError("template_archive_manifest_invalid", error instanceof Error ? error.message : undefined);
  }
  const manifest = validateTemplateArchiveManifest(rawManifest);
  const archiveAssetNames = new Set(
    [...entries.keys()].filter((name) => name.startsWith(TEMPLATE_ARCHIVE_ASSET_PREFIX)).map((name) => name.slice(TEMPLATE_ARCHIVE_ASSET_PREFIX.length)),
  );
  const manifestAssetNames = new Set(manifest.assets.map((asset) => asset.path));
  if (archiveAssetNames.size !== manifestAssetNames.size || [...archiveAssetNames].some((name) => !manifestAssetNames.has(name))) {
    throw new TemplateArchiveError("template_archive_asset_manifest_mismatch");
  }

  const assets: TemplateArchiveAsset[] = manifest.assets.map((asset) => {
    const bytes = unzipped[`${TEMPLATE_ARCHIVE_ASSET_PREFIX}${asset.path}`];
    if (!bytes) throw new TemplateArchiveError("template_archive_asset_missing");
    if (bytes.byteLength !== asset.byteLength) throw new TemplateArchiveError("template_archive_asset_length_mismatch");
    if (hashArchiveBytes(bytes) !== asset.contentDigest) throw new TemplateArchiveError("template_archive_asset_digest_mismatch");
    return {
      path: asset.path,
      bytes: Uint8Array.from(bytes),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    };
  });
  return { package: manifest.package, assets, manifest, assetManifestHash: templateAssetManifestHash(manifest.assets) };
}

/**
 * Validates an in-memory package/asset payload without creating a ZIP. Runtime
 * import calls this after base64 decode and before opening a store transaction.
 */
export function validateTemplateArchivePayload(input: EncodeTemplateArchiveInput): ValidatedTemplateArchivePayload {
  const prepared = prepareArchive(input);
  return {
    package: prepared.manifest.package,
    assets: prepared.assets.map((asset) => ({
      path: asset.path,
      bytes: Uint8Array.from(asset.bytes),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    })),
    manifest: prepared.manifest,
    assetManifestHash: templateAssetManifestHash(prepared.manifest.assets),
  };
}

/** Decode JSON-safe bridge assets; archive validation still validates path/size/content type. */
export function decodeTemplateAssetTransports(value: readonly TemplateAssetTransport[] | undefined): readonly TemplateArchiveAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TemplateArchiveError("template_asset_transport_array_invalid");
  if (value.length > TEMPLATE_ARCHIVE_LIMITS.maxAssets) throw new TemplateArchiveError("template_archive_asset_count_exceeded");
  return value.map((asset, index) => {
    const record = asRecord(asset, `assets[${index}]`);
    assertExactKeys(record, ["path", "contentType", "base64"], `assets[${index}]`, ["contentType"]);
    if (typeof record.path !== "string") throw new TemplateArchiveError("template_asset_transport_path_invalid");
    if (record.contentType !== undefined && typeof record.contentType !== "string") {
      throw new TemplateArchiveError("template_asset_transport_content_type_invalid");
    }
    if (typeof record.base64 !== "string") throw new TemplateArchiveError("template_asset_transport_base64_invalid");
    return {
      path: record.path,
      bytes: decodeBase64(record.base64),
      ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
    };
  });
}

/** Encode immutable bytes for JSON-only RuntimeCommandResult transport. */
export function encodeTemplateAssetTransports(value: readonly TemplateArchiveAsset[]): readonly TemplateAssetTransport[] {
  if (!Array.isArray(value)) throw new TemplateArchiveError("template_asset_transport_array_invalid");
  if (value.length > TEMPLATE_ARCHIVE_LIMITS.maxAssets) throw new TemplateArchiveError("template_archive_asset_count_exceeded");
  return value.map((asset, index) => {
    const valid = validateArchiveAsset(asset, `assets[${index}]`);
    return {
      path: valid.path,
      base64: encodeBase64(valid.bytes),
      ...(valid.contentType ? { contentType: valid.contentType } : {}),
    };
  });
}

/** Stable regardless of incoming asset order; part of Template Version identity. */
export function templateAssetManifestHash(assets: readonly TemplateArchiveAssetManifest[]): string {
  if (assets.length === 0) return EMPTY_TEMPLATE_ASSET_MANIFEST_HASH;
  const canonicalAssets = [...assets]
    .map((asset) => ({
      path: asset.path,
      byteLength: asset.byteLength,
      contentDigest: asset.contentDigest,
      contentType: asset.contentType ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return hashDefinition(canonicalAssets as unknown as JsonValue);
}

export function serializeTemplateArchiveManifestYaml(manifest: TemplateArchiveManifest): string {
  const valid = validateTemplateArchiveManifest(manifest as unknown as JsonValue);
  return serializeYamlDocument(valid as unknown as JsonValue);
}

export function parseTemplateArchiveManifestYaml(source: string): TemplateArchiveManifest {
  return validateTemplateArchiveManifest(parseYamlDocument(source));
}

export function validateTemplateArchiveManifest(value: unknown): TemplateArchiveManifest {
  const root = asRecord(value, "template archive manifest");
  assertExactKeys(root, ["schemaVersion", "kind", "package", "assets"], "template archive manifest");
  if (root.schemaVersion !== TEMPLATE_ARCHIVE_SCHEMA_VERSION) {
    throw new TemplateArchiveError("template_archive_schema_unsupported");
  }
  if (root.kind !== TEMPLATE_ARCHIVE_KIND) throw new TemplateArchiveError("template_archive_kind_unsupported");
  // Do not substitute/archive-normalize this validation. Import semantics stay
  // exactly aligned with ordinary YAML TemplatePackage import.
  const templatePackage = validateTemplatePackage(root.package);
  const packageHash = hashDefinition(templatePackage.definition as unknown as JsonValue);
  if (templatePackage.template.definitionHash && templatePackage.template.definitionHash !== packageHash) {
    throw new TemplateArchiveError("template_archive_definition_hash_mismatch");
  }
  if (!Array.isArray(root.assets)) throw new TemplateArchiveError("template_archive_assets_invalid");
  if (root.assets.length > TEMPLATE_ARCHIVE_LIMITS.maxAssets) throw new TemplateArchiveError("template_archive_asset_count_exceeded");
  const assets = root.assets.map((asset, index) => validateAssetManifest(asset, `assets[${index}]`));
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (paths.has(asset.path)) throw new TemplateArchiveError("template_archive_duplicate_asset_path");
    paths.add(asset.path);
    totalBytes += asset.byteLength;
  }
  if (totalBytes + estimateManifestBytes(root) > TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    throw new TemplateArchiveError("template_archive_uncompressed_size_exceeded");
  }
  const assetManifestHash = templateAssetManifestHash(assets);
  if (templatePackage.template.assetManifestHash && templatePackage.template.assetManifestHash !== assetManifestHash) {
    throw new TemplateArchiveError("template_archive_asset_manifest_hash_mismatch");
  }
  const normalizedPackage = assets.length > 0 && !templatePackage.template.assetManifestHash
    ? { ...templatePackage, template: { ...templatePackage.template, assetManifestHash } }
    : templatePackage;
  return {
    schemaVersion: TEMPLATE_ARCHIVE_SCHEMA_VERSION,
    kind: TEMPLATE_ARCHIVE_KIND,
    package: normalizedPackage,
    assets,
  };
}

function prepareArchive(input: EncodeTemplateArchiveInput): { manifest: TemplateArchiveManifest; assets: readonly TemplateArchiveAsset[] } {
  const templatePackage = validateTemplatePackage(input.package);
  const packageHash = hashDefinition(templatePackage.definition as unknown as JsonValue);
  if (templatePackage.template.definitionHash && templatePackage.template.definitionHash !== packageHash) {
    throw new TemplateArchiveError("template_archive_definition_hash_mismatch");
  }
  const assets = (input.assets ?? []).map((asset, index) => validateArchiveAsset(asset, `assets[${index}]`));
  if (assets.length > TEMPLATE_ARCHIVE_LIMITS.maxAssets) throw new TemplateArchiveError("template_archive_asset_count_exceeded");
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (seenPaths.has(asset.path)) throw new TemplateArchiveError("template_archive_duplicate_asset_path");
    seenPaths.add(asset.path);
    totalBytes += asset.bytes.byteLength;
  }
  if (totalBytes > TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes - TEMPLATE_ARCHIVE_LIMITS.maxManifestBytes) {
    throw new TemplateArchiveError("template_archive_uncompressed_size_exceeded");
  }
  const manifest = validateTemplateArchiveManifest({
    schemaVersion: TEMPLATE_ARCHIVE_SCHEMA_VERSION,
    kind: TEMPLATE_ARCHIVE_KIND,
    package: templatePackage,
    assets: assets.map((asset) => ({
      path: asset.path,
      byteLength: asset.bytes.byteLength,
      contentDigest: hashArchiveBytes(asset.bytes),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    })),
  });
  const manifestBytes = encodeUtf8(serializeTemplateArchiveManifestYaml(manifest));
  if (manifestBytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxManifestBytes) {
    throw new TemplateArchiveError("template_archive_manifest_too_large");
  }
  if (totalBytes + manifestBytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    throw new TemplateArchiveError("template_archive_uncompressed_size_exceeded");
  }
  return { manifest, assets };
}

function validateArchiveAsset(value: TemplateArchiveAsset, path: string): TemplateArchiveAsset {
  if (!value || typeof value !== "object") throw new TemplateArchiveError("template_archive_asset_invalid", `${path} must be an object`);
  const assetPath = validateAssetPath(value.path);
  if (!(value.bytes instanceof Uint8Array)) throw new TemplateArchiveError("template_archive_asset_bytes_invalid", `${path}.bytes must be Uint8Array`);
  if (value.bytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes) throw new TemplateArchiveError("template_archive_asset_too_large");
  const contentType = value.contentType === undefined ? undefined : validateContentType(value.contentType);
  return { path: assetPath, bytes: Uint8Array.from(value.bytes), ...(contentType ? { contentType } : {}) };
}

function validateAssetManifest(value: unknown, path: string): TemplateArchiveAssetManifest {
  const asset = asRecord(value, path);
  assertExactKeys(asset, ["path", "byteLength", "contentDigest", "contentType"], path, ["contentType"]);
  const assetPath = validateAssetPath(asset.path);
  if (!Number.isSafeInteger(asset.byteLength) || (asset.byteLength as number) < 0 || (asset.byteLength as number) > TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes) {
    throw new TemplateArchiveError("template_archive_asset_length_invalid");
  }
  if (typeof asset.contentDigest !== "string" || !/^fnv1a64:[0-9a-f]{16}$/.test(asset.contentDigest)) {
    throw new TemplateArchiveError("template_archive_asset_digest_invalid");
  }
  const contentType = asset.contentType === undefined ? undefined : validateContentType(asset.contentType);
  return {
    path: assetPath,
    byteLength: asset.byteLength as number,
    contentDigest: asset.contentDigest,
    ...(contentType ? { contentType } : {}),
  };
}

function validateAssetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 240) throw new TemplateArchiveError("template_archive_asset_path_invalid");
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes(":")) {
    throw new TemplateArchiveError("template_archive_asset_path_unsafe");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TemplateArchiveError("template_archive_asset_path_unsafe");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) throw new TemplateArchiveError("template_archive_asset_path_invalid");
  return value;
}

function validateContentType(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=._+-]+)?$/i.test(value) || value.length > 160) {
    throw new TemplateArchiveError("template_archive_asset_content_type_invalid");
  }
  return value;
}

interface ZipEntryDescriptor {
  readonly name: string;
  readonly compression: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataStart: number;
}

/** Checks central directory metadata before fflate receives compressed bytes. */
function inspectZip(input: Uint8Array): ReadonlyMap<string, ZipEntryDescriptor> {
  const eocdOffset = findEndOfCentralDirectory(input);
  const disk = readU16(input, eocdOffset + 4);
  const centralDisk = readU16(input, eocdOffset + 6);
  const entriesOnDisk = readU16(input, eocdOffset + 8);
  const entryCount = readU16(input, eocdOffset + 10);
  const centralSize = readU32(input, eocdOffset + 12);
  const centralOffset = readU32(input, eocdOffset + 16);
  const commentSize = readU16(input, eocdOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new TemplateArchiveError("template_archive_multidisk_unsupported");
  if (entryCount === 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new TemplateArchiveError("template_archive_zip64_or_empty_unsupported");
  }
  if (entryCount > TEMPLATE_ARCHIVE_LIMITS.maxAssets + 1) throw new TemplateArchiveError("template_archive_entry_count_exceeded");
  if (eocdOffset + 22 + commentSize !== input.byteLength) throw new TemplateArchiveError("template_archive_trailing_data_unsupported");
  if (centralOffset + centralSize > eocdOffset) throw new TemplateArchiveError("template_archive_central_directory_invalid");

  const entries = new Map<string, ZipEntryDescriptor>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(input, offset) !== 0x02014b50) throw new TemplateArchiveError("template_archive_central_entry_invalid");
    const versionMadeBy = readU16(input, offset + 4);
    const flags = readU16(input, offset + 8);
    const compression = readU16(input, offset + 10);
    const crc32 = readU32(input, offset + 16);
    const compressedSize = readU32(input, offset + 20);
    const uncompressedSize = readU32(input, offset + 24);
    const nameSize = readU16(input, offset + 28);
    const extraSize = readU16(input, offset + 30);
    const entryCommentSize = readU16(input, offset + 32);
    const diskStart = readU16(input, offset + 34);
    const externalAttributes = readU32(input, offset + 38);
    const localOffset = readU32(input, offset + 42);
    const end = offset + 46 + nameSize + extraSize + entryCommentSize;
    if (end > centralOffset + centralSize) throw new TemplateArchiveError("template_archive_central_entry_bounds_invalid");
    if ((flags & 0x0001) !== 0) throw new TemplateArchiveError("template_archive_encryption_unsupported");
    if (compression !== 0 && compression !== 8) throw new TemplateArchiveError("template_archive_compression_unsupported");
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new TemplateArchiveError("template_archive_zip64_or_multidisk_unsupported");
    }
    const nameBytes = input.subarray(offset + 46, offset + 46 + nameSize);
    if (nameBytes.byteLength === 0 || nameBytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxEntryPathBytes) {
      throw new TemplateArchiveError("template_archive_entry_path_invalid");
    }
    const name = decodeUtf8(nameBytes);
    assertSafeEntryName(name);
    if (name !== TEMPLATE_ARCHIVE_MANIFEST_PATH && uncompressedSize > TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes) {
      throw new TemplateArchiveError("template_archive_asset_too_large");
    }
    assertRegularZipFile(versionMadeBy, externalAttributes);
    const dataStart = assertLocalHeader(input, localOffset, name, compression, compressedSize);
    if (entries.has(name)) throw new TemplateArchiveError("template_archive_duplicate_entry");
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > TEMPLATE_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
      throw new TemplateArchiveError("template_archive_uncompressed_size_exceeded");
    }
    entries.set(name, { name, compression, crc32, compressedSize, uncompressedSize, dataStart });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new TemplateArchiveError("template_archive_central_directory_size_invalid");
  if (!entries.has(TEMPLATE_ARCHIVE_MANIFEST_PATH)) throw new TemplateArchiveError("template_archive_manifest_missing");
  const manifest = entries.get(TEMPLATE_ARCHIVE_MANIFEST_PATH)!;
  if (manifest.uncompressedSize > TEMPLATE_ARCHIVE_LIMITS.maxManifestBytes) throw new TemplateArchiveError("template_archive_manifest_too_large");
  return entries;
}

function findEndOfCentralDirectory(input: Uint8Array): number {
  const minimum = Math.max(0, input.byteLength - 65_557);
  for (let offset = input.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(input, offset) === 0x06054b50) return offset;
  }
  throw new TemplateArchiveError("template_archive_eocd_missing");
}

function assertSafeEntryName(name: string): void {
  if (name === TEMPLATE_ARCHIVE_MANIFEST_PATH) return;
  if (!name.startsWith(TEMPLATE_ARCHIVE_ASSET_PREFIX)) throw new TemplateArchiveError("template_archive_entry_unsupported");
  validateAssetPath(name.slice(TEMPLATE_ARCHIVE_ASSET_PREFIX.length));
}

function assertRegularZipFile(versionMadeBy: number, externalAttributes: number): void {
  const platform = versionMadeBy >>> 8;
  if (platform !== 3) return;
  const mode = externalAttributes >>> 16;
  const type = mode & 0xf000;
  if (type !== 0 && type !== 0x8000) throw new TemplateArchiveError("template_archive_nonregular_entry_unsupported");
}

function assertLocalHeader(
  input: Uint8Array,
  localOffset: number,
  expectedName: string,
  expectedCompression: number,
  compressedSize: number,
): number {
  if (localOffset + 30 > input.byteLength || readU32(input, localOffset) !== 0x04034b50) {
    throw new TemplateArchiveError("template_archive_local_entry_invalid");
  }
  if (readU16(input, localOffset + 8) !== expectedCompression) {
    throw new TemplateArchiveError("template_archive_local_entry_compression_mismatch");
  }
  const nameSize = readU16(input, localOffset + 26);
  const extraSize = readU16(input, localOffset + 28);
  const dataStart = localOffset + 30 + nameSize + extraSize;
  if (dataStart + compressedSize > input.byteLength) throw new TemplateArchiveError("template_archive_local_entry_bounds_invalid");
  if (decodeUtf8(input.subarray(localOffset + 30, localOffset + 30 + nameSize)) !== expectedName) {
    throw new TemplateArchiveError("template_archive_local_entry_name_mismatch");
  }
  return dataStart;
}

/**
 * Per-entry extraction gives fflate a strictly bounded output buffer. The
 * extra byte detects a central-directory size lie without allocating a zip
 * bomb's advertised expansion.
 */
function extractZipEntries(input: Uint8Array, entries: ReadonlyMap<string, ZipEntryDescriptor>): Record<string, Uint8Array> {
  const output: Record<string, Uint8Array> = {};
  try {
    for (const [name, entry] of entries) {
      const compressed = input.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      let bytes: Uint8Array;
      if (entry.compression === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) {
          throw new TemplateArchiveError("template_archive_stored_entry_size_mismatch");
        }
        bytes = Uint8Array.from(compressed);
      } else {
        const boundedOutput = new Uint8Array(entry.uncompressedSize + 1);
        const inflated = inflateSync(compressed, { out: boundedOutput });
        if (inflated.byteLength !== entry.uncompressedSize) {
          throw new TemplateArchiveError("template_archive_inflated_size_mismatch");
        }
        bytes = Uint8Array.from(inflated);
      }
      if (crc32(bytes) !== entry.crc32) throw new TemplateArchiveError("template_archive_crc_mismatch");
      output[name] = bytes;
    }
  } catch (error) {
    if (error instanceof TemplateArchiveError) throw error;
    throw new TemplateArchiveError("template_archive_malformed_zip", error instanceof Error ? error.message : undefined);
  }
  return output;
}

function assertExactUnzippedEntries(entries: ReadonlyMap<string, ZipEntryDescriptor>, output: Record<string, Uint8Array>): void {
  const outputNames = Object.keys(output);
  if (outputNames.length !== entries.size || outputNames.some((name) => !entries.has(name))) {
    throw new TemplateArchiveError("template_archive_unzip_entry_mismatch");
  }
  for (const [name, entry] of entries) {
    const bytes = output[name];
    if (!bytes || bytes.byteLength !== entry.uncompressedSize) {
      throw new TemplateArchiveError("template_archive_unzip_length_mismatch");
    }
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemplateArchiveError("template_archive_manifest_invalid", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void {
  const allowed = new Set(keys);
  const required = new Set(keys.filter((key) => !optional.includes(key)));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TemplateArchiveError("template_archive_manifest_invalid", `${path}.${key} is unsupported`);
  }
  for (const key of required) {
    if (!(key in value)) throw new TemplateArchiveError("template_archive_manifest_invalid", `${path}.${key} is required`);
  }
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeBase64(bytes: Uint8Array): string {
  const encoder = globalThis.btoa;
  if (typeof encoder !== "function") throw new TemplateArchiveError("template_asset_transport_base64_unavailable");
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  }
  return encoder(binary);
}

function decodeBase64(value: string): Uint8Array {
  const maximumLength = Math.ceil(TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes / 3) * 4;
  if (value.length > maximumLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TemplateArchiveError("template_asset_transport_base64_invalid");
  }
  const decoder = globalThis.atob;
  if (typeof decoder !== "function") throw new TemplateArchiveError("template_asset_transport_base64_unavailable");
  let binary: string;
  try {
    binary = decoder(value);
  } catch (error) {
    throw new TemplateArchiveError("template_asset_transport_base64_invalid", error instanceof Error ? error.message : undefined);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength > TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes || encodeBase64(bytes) !== value) {
    throw new TemplateArchiveError("template_asset_transport_base64_invalid");
  }
  return bytes;
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new TemplateArchiveError("template_archive_utf8_invalid", error instanceof Error ? error.message : undefined);
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new TemplateArchiveError("template_archive_bounds_invalid");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new TemplateArchiveError("template_archive_bounds_invalid");
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function hashArchiveBytes(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function estimateManifestBytes(value: Record<string, unknown>): number {
  // This check is intentionally conservative and only prevents an oversized
  // JSON object from slipping through before the actual manifest byte check.
  return encodeUtf8(JSON.stringify(value)).byteLength;
}
