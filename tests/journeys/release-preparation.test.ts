import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  executeReleaseLocalGate,
  executeReleaseProductionBuild,
  createReleaseLocalGateIsolation,
  REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS,
  runReleasePreparation,
  type ReleaseLocalGateInvocation,
} from "./release-preparation.js";

const execFileAsync = promisify(execFile);

describe("aggregate release preparation", () => {
  it("runs the complete local gate set in the release-defined order", () => {
    expect(REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS).toEqual([
      "typecheck",
      "test:vitest",
      "test:desktop",
      "test:integration",
      "test:e2e",
      "test:formal-dev-launcher",
      "verify:session-id-cutover",
      "test:journey:static",
    ]);
    expect(REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS).not.toContain("build");
  });

  it("passes only a narrow, credential-free environment to local gate subprocesses", async () => {
    const releaseRoot = await realpath(await mkdtemp(
      path.join(tmpdir(), "release-local-gate-isolation-"),
    ));
    await chmod(releaseRoot, 0o700);
    const isolation = await createReleaseLocalGateIsolation({ releaseRoot });
    const invocations: ReleaseLocalGateInvocation[] = [];
    const execute = vi.fn(async (invocation: ReleaseLocalGateInvocation) => {
      invocations.push(invocation);
      return 0;
    });
    const sourceEnvironment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp/example",
      LANG: "en_US.UTF-8",
      CI: "1",
      HOME: "/Users/operator",
      AGENT_WORKSPACE_NATIVE_FULL_JOURNEY_READY: "1",
      AGENT_WORKSPACE_CODEX_BIN: "/private/native/codex",
      AGENT_WORKSPACE_CODEX_DATA_DIR: "/private/native/data",
      AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/native/opencode",
      AGENT_WORKSPACE_OPENCODE_AUTH_FILE: "/private/native/opencode-auth.json",
      AGENT_WORKSPACE_CODEX_CREDENTIAL_ENV_REF: "AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY",
      AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY: "isolated-secret-value",
      AGENT_WORKSPACE_NATIVE_FUTURE_INPUT: "future-native-secret",
      OPENAI_API_KEY: "ambient-secret",
    };

    await executeReleaseLocalGate("typecheck", {
      sourceEnvironment,
      isolation,
      platform: "darwin",
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      executable: "npm",
      args: ["run", "typecheck"],
      environment: {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        CI: "1",
        HOME: path.join(releaseRoot, "home"),
        TMPDIR: path.join(releaseRoot, "tmp"),
        TMP: path.join(releaseRoot, "tmp"),
        TEMP: path.join(releaseRoot, "tmp"),
      },
    });
    const invocation = invocations[0]!;
    expect(invocation.environment).not.toHaveProperty("AGENT_WORKSPACE_CODEX_CREDENTIAL_ENV_REF");
    expect(invocation.environment).not.toHaveProperty("AGENT_WORKSPACE_OPENCODE_COMMAND");
    expect(invocation.environment).not.toHaveProperty("AGENT_WORKSPACE_OPENCODE_AUTH_FILE");
    expect(invocation.environment).not.toHaveProperty("AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY");
    expect(Object.values(invocation.environment)).not.toContain("isolated-secret-value");
    expect(Object.keys(invocation.environment)).not.toContain("OPENAI_API_KEY");
    expect(sourceEnvironment.AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY).toBe("isolated-secret-value");
    expect(invocation.environment.HOME).not.toBe(sourceEnvironment.HOME);
    expect(invocation.environment.TMPDIR).not.toBe(sourceEnvironment.TMPDIR);
    await rm(releaseRoot, { recursive: true });
  });

  it("runs the one production build through the same isolated environment", async () => {
    const releaseRoot = await realpath(await mkdtemp(
      path.join(tmpdir(), "release-build-isolation-"),
    ));
    await chmod(releaseRoot, 0o700);
    const isolation = await createReleaseLocalGateIsolation({ releaseRoot });
    const execute = vi.fn(async () => 0);

    await expect(executeReleaseProductionBuild({
      sourceEnvironment: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/operator",
        TMPDIR: "/private/operator-tmp",
        AGENT_WORKSPACE_OPENCODE_AUTH: "/private/auth.json",
        OPENAI_API_KEY: "ambient-secret",
      },
      isolation,
      platform: "darwin",
      execute,
    })).resolves.toBe(0);

    expect(execute).toHaveBeenCalledWith({
      executable: "npm",
      args: ["run", "build"],
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: path.join(releaseRoot, "home"),
        TMPDIR: path.join(releaseRoot, "tmp"),
        TMP: path.join(releaseRoot, "tmp"),
        TEMP: path.join(releaseRoot, "tmp"),
      },
    });
    await rm(releaseRoot, { recursive: true });
  });

  it("requires a minted private isolation and rejects path drift before spawning a gate", async () => {
    const execute = vi.fn(async () => 0);
    await expect(executeReleaseLocalGate("typecheck", {
      sourceEnvironment: { PATH: "/usr/bin:/bin" },
      isolation: Object.freeze({ toJSON: () => ({ kind: "release_local_gate_isolation" as const }) }),
      execute,
    })).rejects.toThrow("release_local_gate_isolation_invalid");
    expect(execute).not.toHaveBeenCalled();

    const releaseRoot = await realpath(await mkdtemp(
      path.join(tmpdir(), "release-local-gate-drift-"),
    ));
    await chmod(releaseRoot, 0o700);
    const isolation = await createReleaseLocalGateIsolation({ releaseRoot });
    await chmod(path.join(releaseRoot, "home"), 0o755);
    await expect(executeReleaseLocalGate("typecheck", {
      sourceEnvironment: { PATH: "/usr/bin:/bin" },
      isolation,
      execute,
    })).rejects.toThrow("release_local_gate_home_drift");
    expect(execute).not.toHaveBeenCalled();
    await rm(releaseRoot, { recursive: true });
  });

  it("preflights before gates, then performs exactly one broad build", async () => {
    const calls: string[] = [];
    await runReleasePreparation({
      preflight: async () => { calls.push("preflight"); return "native-seal"; },
      verifyFrozenPreflight: async (seal) => { calls.push(`verify:${seal}`); },
      prepareLocalGateIsolation: async (seal) => { calls.push(`isolate:${seal}`); return "gate-isolation"; },
      runLocalGate: async (script) => { calls.push(`gate:${script}`); return 0; },
      verifyJourneyLocators: async () => { calls.push("journey-locators"); },
      build: async () => { calls.push("build"); },
    });

    expect(calls).toEqual([
      "preflight",
      "verify:native-seal",
      "isolate:native-seal",
      ...REQUIRED_RELEASE_LOCAL_GATE_SCRIPTS.flatMap((script) => [
        `gate:${script}`,
        "verify:native-seal",
      ]),
      "journey-locators",
      "verify:native-seal",
      "build",
      "verify:native-seal",
    ]);
    expect(calls.filter((call) => call === "build")).toHaveLength(1);
  });

  it("propagates the first failing gate and does not run later gates or build", async () => {
    const calls: string[] = [];
    await expect(runReleasePreparation({
      preflight: async () => { calls.push("preflight"); return "native-seal"; },
      verifyFrozenPreflight: async () => { calls.push("verify"); },
      prepareLocalGateIsolation: async () => { calls.push("isolate"); return "gate-isolation"; },
      runLocalGate: async (script) => {
        calls.push(script);
        return script === "test:integration" ? 9 : 0;
      },
      verifyJourneyLocators: async () => { calls.push("journey-locators"); },
      build: async () => { calls.push("build"); },
    })).rejects.toMatchObject({
      name: "ReleaseLocalGateError",
      script: "test:integration",
      exitCode: 9,
    });
    expect(calls).toEqual([
      "preflight",
      "verify",
      "isolate",
      "typecheck",
      "verify",
      "test:vitest",
      "verify",
      "test:desktop",
      "verify",
      "test:integration",
    ]);
  });

  it("keeps missing native capability zero-side-effect", async () => {
    const missing = new Error("native_release_credential_missing");
    const runLocalGate = vi.fn(async () => 0);
    const verifyFrozenPreflight = vi.fn(async () => undefined);
    const prepareLocalGateIsolation = vi.fn(async () => "gate-isolation");
    const verifyJourneyLocators = vi.fn(async () => undefined);
    const build = vi.fn(async () => undefined);

    await expect(runReleasePreparation({
      preflight: async () => { throw missing; },
      verifyFrozenPreflight,
      prepareLocalGateIsolation,
      runLocalGate,
      verifyJourneyLocators,
      build,
    })).rejects.toBe(missing);
    expect(runLocalGate).not.toHaveBeenCalled();
    expect(verifyFrozenPreflight).not.toHaveBeenCalled();
    expect(prepareLocalGateIsolation).not.toHaveBeenCalled();
    expect(verifyJourneyLocators).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("stops at the first post-gate observation drift and never establishes a new baseline", async () => {
    const calls: string[] = [];
    let verificationCount = 0;
    await expect(runReleasePreparation({
      preflight: async () => { calls.push("preflight"); return Object.freeze({ digest: "sealed" }); },
      verifyFrozenPreflight: async (seal) => {
        calls.push(`verify:${seal.digest}`);
        verificationCount += 1;
        if (verificationCount === 2) throw new Error("native_release_installation_observation_drift");
      },
      prepareLocalGateIsolation: async () => { calls.push("isolate"); return "gate-isolation"; },
      runLocalGate: async (script) => { calls.push(`gate:${script}`); return 0; },
      verifyJourneyLocators: async () => { calls.push("journey-locators"); },
      build: async () => { calls.push("build"); },
    })).rejects.toThrow("native_release_installation_observation_drift");
    expect(calls).toEqual([
      "preflight",
      "verify:sealed",
      "isolate",
      "gate:typecheck",
      "verify:sealed",
    ]);
  });

  it("exits 2 at the ACP parent input seal before gates, build, or evidence", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "release-preflight-test-"));
    const evidenceRoot = path.join(parent, "must-not-exist");
    const entry = path.resolve("tests/journeys/run-release.ts");

    const failure = await execFileAsync(process.execPath, ["--import", "tsx", entry], {
      cwd: path.resolve("."),
      env: {
        PATH: "",
        AGENT_WORKSPACE_NATIVE_FULL_JOURNEY_READY: "1",
        AGENT_WORKSPACE_CODEX_BIN: path.join(parent, "missing-codex"),
        AGENT_WORKSPACE_CODEX_DATA_DIR: path.join(parent, "missing-data"),
        AGENT_WORKSPACE_CODEX_CREDENTIAL_ENV_REF: "AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY",
        AGENT_WORKSPACE_RELEASE_EVIDENCE_ROOT: evidenceRoot,
      },
    }).then(
      () => undefined,
      (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => error,
    );

    expect(failure).toMatchObject({ code: 2 });
    expect(failure?.stderr).toContain('"outcome":"BLOCKED_CAPABILITY"');
    expect(failure?.stderr).toContain('"reason":"acp_release_parent_envelope_missing"');
    expect(failure?.stderr).not.toContain("native_release_credential_missing");
    await expect(access(evidenceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(parent, { recursive: true });
  });

  it("does not let populated legacy direct inputs bypass the ACP parent input seal", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "release-opencode-preflight-test-"));
    const evidenceRoot = path.join(parent, "must-not-exist");
    const entry = path.resolve("tests/journeys/run-release.ts");
    const failure = await execFileAsync(process.execPath, ["--import", "tsx", entry], {
      cwd: path.resolve("."),
      env: {
        PATH: "",
        AGENT_WORKSPACE_NATIVE_FULL_JOURNEY_READY: "1",
        AGENT_WORKSPACE_CODEX_BIN: path.join(parent, "not-observed-codex"),
        AGENT_WORKSPACE_CODEX_DATA_DIR: path.join(parent, "not-observed-data"),
        AGENT_WORKSPACE_CODEX_CREDENTIAL_ENV_REF: "AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY",
        AGENT_WORKSPACE_NATIVE_RELEASE_TEST_KEY: "isolated-test-value",
        AGENT_WORKSPACE_CODEX_MODEL: "current-codex-model",
        AGENT_WORKSPACE_OPENCODE_COMMAND: path.join(parent, "not-observed-opencode"),
        AGENT_WORKSPACE_OPENCODE_AUTH_FILE: path.join(parent, "not-observed-opencode-auth.json"),
        AGENT_WORKSPACE_OPENCODE_META_URL: "http://127.0.0.1:4096",
        AGENT_WORKSPACE_OPENCODE_META_MODEL: "current-opencode/model",
        AGENT_WORKSPACE_RELEASE_EVIDENCE_ROOT: evidenceRoot,
      },
    }).then(
      () => undefined,
      (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => error,
    );
    expect(failure).toMatchObject({ code: 2 });
    expect(failure?.stderr).toContain('"outcome":"BLOCKED_CAPABILITY"');
    expect(failure?.stderr).toContain('"reason":"acp_release_parent_envelope_missing"');
    expect(failure?.stderr).not.toContain("native_release_capability_path_unavailable");
    await expect(access(evidenceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(parent, { recursive: true });
  });
});
