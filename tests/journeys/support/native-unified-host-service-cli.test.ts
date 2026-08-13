import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeUnifiedHostStartupFailureEnvelope,
  runNativeUnifiedHostServiceCli,
} from "./native-unified-host-service-cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Unified ACP-only service CLI boundary", () => {
  it("contains no legacy direct Provider environment or diagnostic-ledger fallback", async () => {
    const source = await readFile(
      path.resolve("tests/journeys/support/native-unified-host-service-cli.ts"),
      "utf8",
    );
    for (const forbidden of [
      "NATIVE_OPENCODE_COMMAND",
      "NATIVE_OPENCODE_AUTH_FILE",
      "NATIVE_CODEX_COMMAND",
      "NATIVE_OPENCODE_META_URL",
      "NATIVE_PROVIDER_HOME",
      "NATIVE_CODEX_HOME",
      "native-host-operations.jsonl",
      "managed_core",
      "scoped_tools",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("AGENT_WORKSPACE_NATIVE_RENDERER_TOKEN");
    expect(source).toContain("authenticatedUserId: CANONICAL_AUTHENTICATED_USER_ID");
  });

  it("rejects verifier-time lineage claims in the startup identity before Host construction", async () => {
    const root = await privateRoot();
    const identityFile = path.join(root, "identity.json");
    await writePrivateJson(identityFile, {
      ...identity(),
      observedLineageDigest: `sha256:${"a".repeat(64)}`,
    });

    await expect(runNativeUnifiedHostServiceCli(argumentsFor(root, identityFile), {}))
      .rejects.toThrow("native_host_identity_file_invalid");
  });

  it("requires the canonical opaque authenticated user", async () => {
    const root = await privateRoot();
    const identityFile = path.join(root, "identity.json");
    await writePrivateJson(identityFile, identity());

    await expect(runNativeUnifiedHostServiceCli(argumentsFor(root, identityFile), {
      AGENT_WORKSPACE_OWNER_ID: "user_someone_else",
    })).rejects.toThrow("native_host_authenticated_user_invalid");
  });

  it("rejects a workspace input for the Meta child before Host construction", async () => {
    const root = await privateRoot();
    const identityFile = path.join(root, "identity.json");
    await writePrivateJson(identityFile, {
      ...identity(),
      bundleCellId: "cell_acp-meta",
      scenarioId: "scenario_acp-meta",
      issuer: "acp_meta_attestor",
    });
    await expect(runNativeUnifiedHostServiceCli(argumentsFor(root, identityFile), {
      AGENT_WORKSPACE_RELEASE_TASK_WORKSPACE_DIRECTORY: path.join(root, "must-not-propagate"),
    })).rejects.toThrow("native_host_meta_workspace_forbidden");
  });

  it("redacts arbitrary startup failures without inspecting Provider/model ledgers", () => {
    expect(nativeUnifiedHostStartupFailureEnvelope(
      new Error("raw secret /Users/operator/launcher-token"),
    )).toEqual({
      type: "native_unified_host_failure",
      outcome: "FAIL",
      stage: "service_start",
      code: "native_host_start_failed",
    });
  });

  it("emits only the four-field safe envelope at the CLI process boundary", async () => {
    const root = await privateRoot();
    const child = spawn(process.execPath, [
      "--no-warnings",
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("tests/journeys/support/native-unified-host-service-cli.ts"),
      ...argumentsFor(root, path.join(root, "missing-identity.json")),
    ], {
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await collect(child);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({
        type: "native_unified_host_failure",
        outcome: "FAIL",
        stage: "service_start",
        code: "native_host_start_failed",
      })}\n`,
    });
  });
});

function argumentsFor(root: string, identityFile: string): string[] {
  return [
    "--state-root", root,
    "--runtime-data", path.join(root, "runtime-data"),
    "--bridge-port", "41991",
    "--service-port", "41992",
    "--generation", "1",
    "--allowed-origin", "http://127.0.0.1:41990",
    "--identity", identityFile,
  ];
}

function identity(): Readonly<Record<string, string>> {
  return Object.freeze({
    releaseRunId: "release_run_test",
    nonce: "nonce_test",
    bundleCellId: "cell_opencode-acp-task",
    scenarioId: "scenario_opencode-acp-task",
    runtimeInstanceId: "runtime_instance_native_cli_test",
    issuer: "opencode_acp_task_attestor",
  });
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "native-host-cli-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function collect(child: ReturnType<typeof spawn>): Promise<Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error("native_host_cli_test_signaled"));
      resolve(Object.freeze({ exitCode: code ?? 1, stdout, stderr }));
    });
  });
}
