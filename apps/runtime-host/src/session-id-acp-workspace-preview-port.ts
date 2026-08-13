import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  createSessionIdAcpWorkspacePreviewOwner,
  type SessionIdAcpWorkspacePreviewCapabilities,
  type SessionIdAcpWorkspacePreviewFileState,
  type SessionIdAcpWorkspacePreviewRevalidateInput,
} from "@agent-workspace/runtime-application";
import {
  createRuntimeRepositories,
  createSessionIdCanonicalStore,
  type SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

export type NodeSessionIdAcpWorkspacePreviewPortOptions = Readonly<{
  maxBytes?: number;
  allowedExtensions?: readonly string[];
}>;

const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_CONFIGURABLE_BYTES = DEFAULT_MAX_BYTES;
const DEFAULT_EXTENSIONS = Object.freeze([".css", ".csv", ".html", ".json", ".md", ".txt"]);

export type NodeSessionIdAcpWorkspacePreviewOwnerOptions = NodeSessionIdAcpWorkspacePreviewPortOptions & Readonly<{
  /** The factory derives every read/write capability from this one connection. */
  sqlite: SqliteRuntimeStore;
  now?: () => string;
  createId?: (kind: "workspace_file_observation") => string;
}>;

/**
 * Production injection helper. It intentionally accepts one SQLite connection
 * rather than independently supplied repositories, so Task/Architecture,
 * canonical Workspace authorization, observations and replay receipts cannot
 * come from different stores.
 */
export function createNodeSessionIdAcpWorkspacePreviewOwner(
  options: NodeSessionIdAcpWorkspacePreviewOwnerOptions,
) {
  if (!options || typeof options.sqlite?.transaction !== "function") {
    throw new Error("acp_workspace_preview_host_options_invalid");
  }
  const repositories = createRuntimeRepositories(options.sqlite);
  const canonical = createSessionIdCanonicalStore(options.sqlite);
  const owners: SessionIdAcpWorkspacePreviewCapabilities = Object.freeze({
    templateTask: repositories.templateTask,
    authorizations: repositories.workspace,
    workspace: canonical.workspace,
    commandReceipts: canonical.reliability,
  });
  const revalidator = createNodeSessionIdAcpWorkspacePreviewPort({
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.allowedExtensions === undefined ? {} : { allowedExtensions: options.allowedExtensions }),
  });
  const transact = <T>(work: (capabilities: SessionIdAcpWorkspacePreviewCapabilities) => T): T =>
    options.sqlite.transaction(() => work(owners));
  return createSessionIdAcpWorkspacePreviewOwner({
    now: options.now ?? (() => new Date().toISOString()),
    createId: options.createId ?? (() => `workspace_file_observation_${randomUUID()}`),
    transaction: Object.freeze({ read: transact, run: transact }),
    revalidator,
  });
}

/**
 * Runtime Host filesystem boundary for ACP Workspace Preview.
 *
 * Every call re-realpaths the persisted authorization, recomputes the v3
 * grant seal, rejects every symlink component, opens the final file with
 * O_NOFOLLOW, and performs a bounded UTF-8 read. Absolute paths remain inside
 * this module and are never returned to the application or Renderer.
 */
export function createNodeSessionIdAcpWorkspacePreviewPort(
  options: NodeSessionIdAcpWorkspacePreviewPortOptions = {},
) {
  const maxBytes = exactMaxBytes(options.maxBytes ?? DEFAULT_MAX_BYTES);
  const allowedExtensions = exactExtensions(options.allowedExtensions ?? DEFAULT_EXTENSIONS);
  const resolver = createNodeWorkspaceDirectoryResolver();

  return Object.freeze({ revalidate });

  async function revalidate(input: SessionIdAcpWorkspacePreviewRevalidateInput): Promise<SessionIdAcpWorkspacePreviewFileState> {
    exactInput(input);
    if (input.workspace.workspaceId !== input.authorization.workspaceId) {
      throw new Error("acp_workspace_preview_workspace_scope_mismatch");
    }
    const resolved = await resolver.canonicalizeDirectory(input.authorization.canonicalDirectory);
    if (resolved.canonicalDirectory !== input.authorization.canonicalDirectory) {
      throw new Error("acp_workspace_preview_authorization_stale");
    }
    const grantDigest = resolver.digestGrant(Object.freeze({
      schemaVersion: 1 as const,
      workspaceId: input.authorization.workspaceId,
      canonicalDirectory: input.authorization.canonicalDirectory,
      authorizedAt: input.authorization.authorizedAt,
    }));
    if (grantDigest !== input.workspace.grantDigest) throw new Error("acp_workspace_preview_grant_mismatch");

    const workspaceRelativePath = exactRelativePath(input.workspaceRelativePath);
    const segments = workspaceRelativePath.split("/");
    const root = resolved.canonicalDirectory;
    const target = path.join(root, ...segments);
    assertSyntacticContainment(root, target);
    const inspected = await inspectNoSymlinkPath(root, segments);
    if (inspected.kind === "missing") return Object.freeze({ state: "missing" as const });
    if (inspected.kind === "unsupported") return Object.freeze({ state: "unsupported" as const });
    const initial = inspected.stat;
    if (!initial.isFile()) return Object.freeze({ state: "unsupported" as const });
    const extension = path.posix.extname(workspaceRelativePath).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      return Object.freeze({ state: "unsupported" as const, byteLength: initial.size });
    }
    const canonicalTarget = await exactCanonicalTarget(root, target);
    if (canonicalTarget !== target) throw new Error("acp_workspace_preview_symlink_forbidden");
    if (initial.size > maxBytes) {
      return Object.freeze({ state: "too_large" as const, byteLength: initial.size });
    }

    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      assertSameFile(initial, opened);
      if (!opened.isFile()) return Object.freeze({ state: "unsupported" as const });
      if (opened.size > maxBytes) {
        return Object.freeze({ state: "too_large" as const, byteLength: opened.size });
      }
      bytes = await readBounded(handle, maxBytes);
      const after = await handle.stat();
      assertSameFile(opened, after);
      if (after.size > maxBytes || bytes.byteLength > maxBytes) {
        return Object.freeze({
          state: "too_large" as const,
          byteLength: Math.max(after.size, bytes.byteLength),
        });
      }
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
        throw new Error("acp_workspace_preview_file_changed_during_read");
      }
    } finally {
      await handle.close();
    }

    const post = await inspectNoSymlinkPath(root, segments);
    if (post.kind !== "file") throw new Error("acp_workspace_preview_file_changed_during_read");
    assertSameFile(initial, post.stat);
    if (await exactCanonicalTarget(root, target) !== target) {
      throw new Error("acp_workspace_preview_symlink_forbidden");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return Object.freeze({ state: "unsupported" as const, byteLength: bytes.byteLength });
    }
    return Object.freeze({
      state: "available" as const,
      contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.byteLength,
      content,
    });
  }
}

type InspectedPath =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "file"; stat: Stats }>;

async function inspectNoSymlinkPath(root: string, segments: readonly string[]): Promise<InspectedPath> {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let information: Stats;
    try {
      information = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ kind: "missing" as const });
      throw error;
    }
    if (information.isSymbolicLink()) throw new Error("acp_workspace_preview_symlink_forbidden");
    if (index < segments.length - 1 && !information.isDirectory()) {
      return Object.freeze({ kind: "unsupported" as const });
    }
    if (index === segments.length - 1) return Object.freeze({ kind: "file" as const, stat: information });
  }
  return Object.freeze({ kind: "unsupported" as const });
}

async function exactCanonicalTarget(root: string, target: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("acp_workspace_preview_file_changed_during_read");
    throw error;
  }
  const relative = path.relative(root, canonical);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("acp_workspace_preview_path_outside_root");
  }
  return canonical;
}

function assertSyntacticContainment(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("acp_workspace_preview_path_outside_root");
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function assertSameFile(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("acp_workspace_preview_file_changed_during_read");
  }
}

function exactInput(input: SessionIdAcpWorkspacePreviewRevalidateInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("acp_workspace_preview_input_invalid");
  }
  const keys = Object.keys(input).sort();
  if (keys.join("\u0000") !== ["authorization", "workspace", "workspaceRelativePath"].sort().join("\u0000")) {
    throw new Error("acp_workspace_preview_input_invalid");
  }
  if (!input.workspace || typeof input.workspace.workspaceId !== "string"
    || !input.workspace.workspaceId.startsWith("workspace_")
    || !/^sha256:[a-f0-9]{64}$/u.test(input.workspace.grantDigest)
    || !input.authorization || typeof input.authorization.workspaceId !== "string"
    || typeof input.authorization.canonicalDirectory !== "string"
    || typeof input.authorization.authorizedAt !== "string") {
    throw new Error("acp_workspace_preview_input_invalid");
  }
}

function exactRelativePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || value !== value.trim() || value !== value.normalize("NFC")
    || path.posix.isAbsolute(value) || /^[a-zA-Z]:\//u.test(value) || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("acp_workspace_preview_path_invalid");
  }
  return value;
}

function exactMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURABLE_BYTES) {
    throw new Error("acp_workspace_preview_max_bytes_invalid");
  }
  return value;
}

function exactExtensions(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
    throw new Error("acp_workspace_preview_extensions_invalid");
  }
  const normalized = values.map((value) => value.toLowerCase());
  if (normalized.some((value) => !/^\.[a-z0-9]{1,16}$/u.test(value))
    || new Set(normalized).size !== normalized.length) {
    throw new Error("acp_workspace_preview_extensions_invalid");
  }
  return new Set(normalized);
}
