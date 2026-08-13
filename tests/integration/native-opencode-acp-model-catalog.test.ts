import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcpRuntimeHostPrivateAuthority } from "../../apps/runtime-host/src/acp-runtime-host-private-authority.js";
import { createOpenCodeAcpProductionTaskNativeFactory } from "../../apps/runtime-host/src/session-id-acp-production-composition.js";

const OPT_IN = "AGENT_WORKSPACE_RUN_NATIVE_OPENCODE_ACP_MODEL_CATALOG";
const COMMAND = "AGENT_WORKSPACE_NATIVE_OPENCODE_COMMAND";
const SEARCH_PATH = "AGENT_WORKSPACE_NATIVE_OPENCODE_SEARCH_PATH";
const AUTH = "AGENT_WORKSPACE_NATIVE_OPENCODE_AUTH_FILE";
const liveIt = process.env[OPT_IN] === "1" ? it : it.skip;

liveIt("reads the current OpenCode ACP model catalog without a Template Profile or model prompt", async () => {
  const root = await realpath(await mkdtemp(
    path.join(os.tmpdir(), "agent-workspace-opencode-model-catalog-"),
  ));
  const runtimeDataDirectory = path.join(root, "runtime-data");
  await mkdir(runtimeDataDirectory, { mode: 0o700 });
  await Promise.all([chmod(root, 0o700), chmod(runtimeDataDirectory, 0o700)]);
  const { publicKey } = generateKeyPairSync("ed25519");
  const authority = createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory,
    environment: {
      AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_native_opencode_model_catalog",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64url"),
    },
  });
  const factory = createOpenCodeAcpProductionTaskNativeFactory();
  let primaryFailure: unknown;
  try {
    const result = await withDeadline(factory.readModelCatalog({
      hostInputs: {
        commandReference: requiredAbsolutePath(process.env[COMMAND], "native_opencode_command_required"),
        executableSearchPath: requiredValue(process.env[SEARCH_PATH], "native_opencode_search_path_required"),
        authFile: requiredAbsolutePath(process.env[AUTH], "native_opencode_auth_required"),
      },
      privateRootAuthority: authority.taskPrivateRootAuthority,
      identityVaultResolver: authority.taskIdentityVaults,
      signal: new AbortController().signal,
    }), 120_000, "native_opencode_model_catalog_timeout");
    expect(result.available, result.unavailableReasons.join(",")).toBe(true);
    expect(result.modelCatalog.length).toBeGreaterThan(0);
    expect(new Set(result.modelCatalog.map(({ modelId }) => modelId)).size)
      .toBe(result.modelCatalog.length);
    expect(JSON.stringify(result)).not.toMatch(/configId|sessionId|bindingHandle|auth\.json/u);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await factory.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw cleanupError;
  }
  if (primaryFailure) throw primaryFailure;
}, 150_000);

function requiredAbsolutePath(value: string | undefined, code: string): string {
  const selected = requiredValue(value, code);
  if (!path.isAbsolute(selected)) throw new Error(code);
  return path.normalize(selected);
}

function requiredValue(value: string | undefined, code: string): string {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(code);
  return value;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
