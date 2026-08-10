import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { templatePackageFixture } from "../../test-kit/src";
import {
  TEMPLATE_ARCHIVE_KIND,
  TEMPLATE_ARCHIVE_LIMITS,
  TEMPLATE_ARCHIVE_SCHEMA_VERSION,
  EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  decodeTemplateAssetTransports,
  decodeTemplateArchive,
  encodeTemplateAssetTransports,
  encodeTemplateArchive,
  serializeTemplateArchiveManifestYaml,
  validateTemplateArchivePayload,
} from "./index";

describe("template archive codec", () => {
  it("round-trips a TemplatePackage without assets", () => {
    const templatePackage = templatePackageFixture();
    const archive = encodeTemplateArchive({ package: templatePackage });
    const decoded = decodeTemplateArchive(archive);

    expect(decoded.package).toEqual(templatePackage);
    expect(decoded.assets).toEqual([]);
    expect(decoded.manifest.assets).toEqual([]);
    expect(decoded.assetManifestHash).toBe(EMPTY_TEMPLATE_ASSET_MANIFEST_HASH);
  });

  it("round-trips binary assets with a manifest digest and content type", () => {
    const bytes = new Uint8Array([0, 255, 17, 34, 128]);
    const archive = encodeTemplateArchive({
      package: templatePackageFixture(),
      assets: [{ path: "prompts/brief.bin", bytes, contentType: "application/octet-stream" }],
    });
    const decoded = decodeTemplateArchive(archive);

    expect(decoded.assets).toHaveLength(1);
    expect(decoded.assets[0].path).toBe("prompts/brief.bin");
    expect(decoded.assets[0].contentType).toBe("application/octet-stream");
    expect([...decoded.assets[0].bytes]).toEqual([...bytes]);
    expect(decoded.assets[0].bytes).not.toBe(bytes);
  });

  it("round-trips JSON-safe binary transport and binds its manifest hash to the package", () => {
    const bytes = new Uint8Array([0, 255, 17, 34, 128]);
    const transported = encodeTemplateAssetTransports([
      { path: "prompts/brief.bin", bytes, contentType: "application/octet-stream" },
    ]);
    expect(transported).toEqual([
      { path: "prompts/brief.bin", contentType: "application/octet-stream", base64: "AP8RIoA=" },
    ]);
    const decoded = decodeTemplateAssetTransports(transported);
    expect([...decoded[0]!.bytes]).toEqual([...bytes]);

    const validated = validateTemplateArchivePayload({ package: templatePackageFixture(), assets: decoded });
    expect(validated.package.template.assetManifestHash).toBe(validated.assetManifestHash);
    expect(() => validateTemplateArchivePayload({
      package: {
        ...templatePackageFixture(),
        template: { ...templatePackageFixture().template, assetManifestHash: EMPTY_TEMPLATE_ASSET_MANIFEST_HASH },
      },
      assets: decoded,
    })).toThrow("template_archive_asset_manifest_hash_mismatch");
    expect(() => decodeTemplateAssetTransports([
      { path: "prompts/brief.bin", contentType: "application/octet-stream", base64: "not-base64" },
    ])).toThrow("template_asset_transport_base64_invalid");
  });

  it("rejects malformed and unsafe archives before any path can be materialized", () => {
    expect(() => decodeTemplateArchive(new Uint8Array([0x50, 0x4b]))).toThrow("template_archive_eocd_missing");

    const safeManifest = serializeTemplateArchiveManifestYaml({
      schemaVersion: TEMPLATE_ARCHIVE_SCHEMA_VERSION,
      kind: TEMPLATE_ARCHIVE_KIND,
      package: templatePackageFixture(),
      assets: [],
    });
    const traversal = zipSync({
      "manifest.yaml": new TextEncoder().encode(safeManifest),
      "assets/../escape.txt": new Uint8Array([1]),
    });
    expect(() => decodeTemplateArchive(traversal)).toThrow("template_archive_asset_path_unsafe");

    const unsupported = zipSync({
      "manifest.yaml": new TextEncoder().encode(safeManifest),
      "unexpected.txt": new Uint8Array([1]),
    });
    expect(() => decodeTemplateArchive(unsupported)).toThrow("template_archive_entry_unsupported");

    const duplicate = duplicateCentralDirectory(zipSync({ "manifest.yaml": new TextEncoder().encode(safeManifest) }));
    expect(() => decodeTemplateArchive(duplicate)).toThrow("template_archive_duplicate_entry");

    expect(() => encodeTemplateArchive({
      package: templatePackageFixture(),
      assets: [
        { path: "examples/a.txt", bytes: new Uint8Array([1]) },
        { path: "examples/a.txt", bytes: new Uint8Array([2]) },
      ],
    })).toThrow("template_archive_duplicate_asset_path");
    expect(() => encodeTemplateArchive({
      package: templatePackageFixture(),
      assets: [{ path: "large.bin", bytes: new Uint8Array(TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes + 1) }],
    })).toThrow("template_archive_asset_too_large");

    const oversizedEntry = zipSync({
      "manifest.yaml": new TextEncoder().encode(safeManifest),
      "assets/large.bin": new Uint8Array(TEMPLATE_ARCHIVE_LIMITS.maxAssetBytes + 1),
    });
    expect(() => decodeTemplateArchive(oversizedEntry)).toThrow("template_archive_asset_too_large");
  });
});

function duplicateCentralDirectory(archive: Uint8Array): Uint8Array {
  const eocdOffset = archive.byteLength - 22;
  const centralSize = readU32(archive, eocdOffset + 12);
  const centralOffset = readU32(archive, eocdOffset + 16);
  const duplicate = new Uint8Array(archive.byteLength + centralSize);
  duplicate.set(archive.subarray(0, eocdOffset));
  duplicate.set(archive.subarray(centralOffset, eocdOffset), eocdOffset);
  duplicate.set(archive.subarray(eocdOffset), eocdOffset + centralSize);
  const newEocdOffset = eocdOffset + centralSize;
  writeU16(duplicate, newEocdOffset + 8, 2);
  writeU16(duplicate, newEocdOffset + 10, 2);
  writeU32(duplicate, newEocdOffset + 12, centralSize * 2);
  return duplicate;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
