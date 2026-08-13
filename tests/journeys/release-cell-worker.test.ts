import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseCellEnvironment } from "./release-cell-runner.js";
import {
  childEnvironmentForIssuer,
  createCanonicalPrivateTempRoot,
  finalizeCleanupFencedReleaseEvidence,
  fetchLoopbackJson,
  runReleaseCellWorker,
  spawnBounded,
  stopChild,
  validateControlledJ09OldGenerationRejection,
} from "./release-cell-worker.js";
import { createFreshReleaseIdentity, createRequiredJourneyReleaseMatrix } from "./release-verifier.js";
import type { JourneyReleaseCellDeclaration, JourneyReleaseMatrix } from "./evidence-issuers.js";
import { controlledUiBranchScenario } from "./full-journey.scenario.js";
import { productionArtifactIdentityBytes } from "../../scripts/production-release-artifact.mjs";
import { productionReleaseNonBuildIdentityInputBytes } from "../../scripts/production-release-inputs.mjs";

const roots: string[] = [];
const TEST_RUNNER_SHA256 = `sha256:${"a".repeat(64)}`;
const TEST_WORKER_SHA256 = `sha256:${"b".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("audited clean-cell release worker", () => {
  it("canonicalizes the OS temporary alias before any launcher receives a private state root", async () => {
    const root = await createCanonicalPrivateTempRoot("agent-workspace-worker-canonical-");
    roots.push(root);
    expect(root).toBe(await realpath(root));
    const metadata = await lstat(root);
    expect(metadata.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(metadata.mode & 0o777).toBe(0o700);
      expect(metadata.uid).toBe(process.getuid?.());
    }
  });
  it("bounds loopback evidence reads with an AbortSignal and a safe timeout code", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_loopback_address_missing");
    const startedAt = Date.now();
    try {
      await expect(fetchLoopbackJson(
        `http://127.0.0.1:${address.port}/evidence`,
        "journey_release_test_loopback_unavailable",
        undefined,
        { timeoutMs: 40 },
      )).rejects.toThrow("journey_release_test_loopback_unavailable:timeout");
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      const shutdown = new AbortController();
      const pending = fetchLoopbackJson(
        `http://127.0.0.1:${address.port}/evidence`,
        "journey_release_test_loopback_unavailable",
        undefined,
        { signal: shutdown.signal, timeoutMs: 10_000 },
      );
      setTimeout(() => shutdown.abort(new Error("raw termination detail")), 40);
      await expect(pending).rejects.toThrow("journey_release_worker_terminated");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("escalates a bounded child that ignores SIGTERM and always resolves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-worker-timeout-tree-"));
    roots.push(root);
    const grandchildPidFile = path.join(root, "grandchild.pid");
    const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const startedAt = Date.now();
    const result = await spawnBounded(process.execPath, [
      "-e",
      parentSource,
    ], {
      cwd: path.resolve("."),
      environment: {},
      timeoutMs: 300,
      terminationGraceMs: 50,
    });
    expect(result.exitCode).toBe(1);
    expect(result.diagnostic).toBe("child_process_timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expectProcessGone(Number(await readFile(grandchildPidFile, "utf8")));
  });

  it("does not accept hard-kill or nonzero launcher exits as confirmed cleanup", async () => {
    const ignoring = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      const onExit = () => reject(new Error("test_launcher_exited_before_ready"));
      ignoring.once("exit", onExit);
      ignoring.stdout.once("data", () => {
        ignoring.off("exit", onExit);
        resolve();
      });
    });
    await expect(stopChild(ignoring, { terminationGraceMs: 40 }))
      .rejects.toThrow("journey_release_launcher_forced_termination");
    if (ignoring.pid) await expectProcessGone(ignoring.pid);

    const nonzero = spawn(process.execPath, ["-e", "process.exit(7);"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => nonzero.once("exit", () => resolve()));
    await expect(stopChild(nonzero, { terminationGraceMs: 40 }))
      .rejects.toThrow("journey_release_launcher_exit_invalid");
  });

  it("closes and confirms the launcher before reading final evidence and emitting a candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-worker-finalize-"));
    roots.push(root);
    const order: string[] = [];
    await finalizeCleanupFencedReleaseEvidence({
      stateRoot: root,
      async closeLauncher() { order.push("close"); },
      async readFinalEvidence() { order.push("read-final"); return Object.freeze({ schemaVersion: 2 }); },
      async writeLedgers() { order.push("write-ledgers"); return Object.freeze(["runtime-host.json"]); },
      async emitCandidate() { order.push("candidate"); },
    });
    expect(order).toEqual(["close", "read-final", "write-ledgers", "candidate"]);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the exact state root and emits no candidate when launcher cleanup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-worker-retained-"));
    roots.push(root);
    let candidateEmitted = false;
    await expect(finalizeCleanupFencedReleaseEvidence({
      stateRoot: root,
      async closeLauncher() { throw new Error("journey_release_launcher_cleanup_unconfirmed"); },
      async readFinalEvidence() { throw new Error("must_not_read"); },
      async writeLedgers() { throw new Error("must_not_write"); },
      async emitCandidate() { candidateEmitted = true; },
    })).rejects.toThrow("journey_release_launcher_cleanup_unconfirmed");
    expect(candidateEmitted).toBe(false);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it("requires one ordered J-09 old-generation rejection with the exact safe Runtime code", () => {
    const operations = [
      {
        kind: "conductor_tool_result", checkpoint: "J-05", toolName: "invoke_agent",
        agentCardId: "agent_card_researcher", resultStatus: "session_created",
        sessionId: "logical_session_researcher_g1", sequence: 1,
      },
      {
        kind: "conductor_tool_result", checkpoint: "J-09", toolName: "close_session",
        resultStatus: "closed", sessionId: "logical_session_researcher_g1", sequence: 2,
      },
      {
        kind: "conductor_tool_result", checkpoint: "J-09", toolName: "invoke_agent",
        agentCardId: "agent_card_researcher", resultStatus: "session_created",
        sessionId: "logical_session_researcher_g2", sequence: 3,
      },
      {
        kind: "conductor_tool_result", checkpoint: "J-09", toolName: "send_to_session",
        resultStatus: "rejected", rejectionCode: "orchestration_session_not_current",
        sessionId: "logical_session_researcher_g1", sequence: 4,
      },
    ] as const;
    expect(() => validateControlledJ09OldGenerationRejection(operations)).not.toThrow();
    expect(() => validateControlledJ09OldGenerationRejection(operations.map((entry) =>
      entry.toolName === "send_to_session" ? { ...entry, rejectionCode: "unclassified" } : entry)))
      .toThrow("journey_release_j09_old_generation_rejection_missing");
    expect(() => validateControlledJ09OldGenerationRejection(operations.map((entry) =>
      entry.toolName === "send_to_session" ? { ...entry, sequence: 2.5 } : entry)))
      .toThrow("journey_release_j09_old_generation_rejection_order_invalid");
  });

  it("runs all eight Bridge cells in independent fresh fixtures and emits unsigned PASS candidates", async () => {
    const harness = await createHarness();
    const bridgeCells = harness.matrix.cells.filter(({ bundleCellId }) => bundleCellId.startsWith("cell_bridge-fake-"));
    expect(bridgeCells).toHaveLength(8);
    const isolationAliases = new Set<string>();
    for (const cell of bridgeCells) {
      const output = await harness.output(cell);
      await runReleaseCellWorker(harness.input(cell, output));
      const candidate = await json(path.join(output, "candidate.json"));
      const ledger = await json(path.join(output, "runtime-host.json"));
      expect(candidate).toMatchObject({
        schemaVersion: 1,
        releaseRunId: harness.matrix.releaseRunId,
        nonce: harness.matrix.nonce,
        bundleCellId: cell.bundleCellId,
        scenarioId: cell.scenarioId,
        lineage: cell.lineage,
        streams: [{ issuer: "runtime_host", outcome: "PASS", ledgerFile: "runtime-host.json" }],
      });
      expect(JSON.stringify(candidate)).not.toMatch(/evidenceClass|surface|status/u);
      expect(ledger).toMatchObject({
        runtimeInstanceId: cell.lineage.runtimeInstanceId,
        isolationAlias: expect.stringMatching(/^alias_cell_root_[a-f0-9]{20}$/u),
      });
      isolationAliases.add(ledger.isolationAlias as string);
      const expected = cell.streamRequirements[0]!.checkpoints;
      expect(new Set((ledger.checkpointFacts as Array<{ checkpoint: string }>).map(({ checkpoint }) => checkpoint)))
        .toEqual(new Set(expected));
      expect(JSON.stringify(ledger)).not.toMatch(/\/(?:Users|private|tmp|home)\//u);
    }
    expect(isolationAliases.size).toBe(bridgeCells.length);
  }, 20_000);

  it("rejects undeclared cells, scenario substitution, cross-cell lineage reuse and optional/N-A matrices", async () => {
    const harness = await createHarness();
    const first = harness.matrix.cells[0]!;
    const undeclaredOutput = path.join(harness.root, "cell_not-declared");
    await mkdir(undeclaredOutput, { mode: 0o700 });
    await expect(runReleaseCellWorker({
      ...harness.input(first, undeclaredOutput),
      cellId: "cell_not-declared",
    })).rejects.toThrow("journey_release_worker_cell_not_allowed");

    const scenarioHarness = await createHarness();
    const scenarioCell = scenarioHarness.matrix.cells[0]!;
    await expect(runReleaseCellWorker({
      ...scenarioHarness.input(scenarioCell, await scenarioHarness.output(scenarioCell)),
      scenarioId: "scenario_bridge-fake-j08-unknown",
      environment: environment(scenarioHarness.matrix, {
        ...scenarioCell,
        scenarioId: "scenario_bridge-fake-j08-unknown",
      }),
    })).rejects.toThrow("journey_release_worker_cell_scenario_mismatch");

    const reusedHarness = await createHarness();
    const reusedSource = clone(reusedHarness.matrix);
    const reused = {
      ...reusedSource,
      cells: reusedSource.cells.map((cell, index) => index === 1
        ? { ...cell, lineage: clone(reusedSource.cells[0]!.lineage) }
        : cell),
    } as JourneyReleaseMatrix;
    await reusedHarness.replaceMatrix(reused);
    const reusedFirst = reused.cells[0]!;
    await expect(runReleaseCellWorker(reusedHarness.input(reusedFirst, await reusedHarness.output(reusedFirst))))
      .rejects.toThrow("journey_release_worker_cross_cell_lineage_reused");

    const optionalHarness = await createHarness();
    const optionalSource = clone(optionalHarness.matrix);
    const optional = {
      ...optionalSource,
      cells: optionalSource.cells.map((cell, index) => index === 0 ? { ...cell, required: false } : cell),
    } as JourneyReleaseMatrix;
    await optionalHarness.replaceMatrix(optional);
    const optionalCell = optional.cells[0]!;
    await expect(runReleaseCellWorker(optionalHarness.input(optionalCell, await optionalHarness.output(optionalCell))))
      .rejects.toThrow("journey_release_worker_cell_declaration_invalid");
  });

  it("rejects relative, wrong-cell and symlink output paths before executing a fixture", async () => {
    const harness = await createHarness();
    const cell = harness.matrix.cells[0]!;
    await expect(runReleaseCellWorker({
      ...harness.input(cell, "relative-output"),
      outputDirectory: "relative-output",
    })).rejects.toThrow("journey_release_worker_output_path_invalid");

    const wrong = path.join(harness.root, "wrong-cell");
    await mkdir(wrong, { mode: 0o700 });
    await expect(runReleaseCellWorker(harness.input(cell, wrong)))
      .rejects.toThrow("journey_release_worker_output_path_invalid");

    const target = path.join(harness.root, "symlink-target");
    await mkdir(target, { mode: 0o700 });
    const linked = path.join(harness.root, cell.bundleCellId);
    await symlink(target, linked, "dir");
    await expect(runReleaseCellWorker(harness.input(cell, linked)))
      .rejects.toThrow("journey_release_worker_output_path_invalid");
  });

  it("registers all three ACP cells and requires only their exact preflight-owned Host envelope", async () => {
    const harness = await createHarness();
    for (const [cellId, code] of [
      ["cell_opencode-acp-task", "acp_release_opencode_task_host_environment_missing"],
      ["cell_codex-acp-task", "acp_release_codex_task_host_environment_missing"],
      ["cell_acp-meta", "acp_release_meta_host_environment_missing"],
    ] as const) {
      const cell = harness.matrix.cells.find(({ bundleCellId }) => bundleCellId === cellId)!;
      const output = await harness.output(cell);
      await expect(runReleaseCellWorker(harness.input(cell, output)))
        .rejects.toMatchObject({
          name: "Error",
          message: code,
        });
      expect(await readdir(output)).toEqual([]);
    }
  });

  it("keeps ambient Provider inputs out of parent and all three ACP issuer children", () => {
    const source = {
      PATH: "/bin",
      HOME: "/Users/private",
      OPENAI_API_KEY: "ambient-openai",
      AGENT_WORKSPACE_ACP_CONFIG: "private-config",
      AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/opencode",
      AGENT_WORKSPACE_CODEX_ACP_WRAPPER: "/private/codex-acp",
      AGENT_WORKSPACE_JOURNEY_BROWSER_URL: "http://127.0.0.1:4173",
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: "read-only-token",
      AGENT_WORKSPACE_RELEASE_LAUNCH_MANIFEST: "/isolated/manifest.json",
      AGENT_WORKSPACE_RELEASE_OPENCODE_ACP_TASK_HOST_ENVIRONMENT: "/isolated/opencode-task.json",
      AGENT_WORKSPACE_RELEASE_CODEX_ACP_TASK_HOST_ENVIRONMENT: "/isolated/codex-task.json",
      AGENT_WORKSPACE_RELEASE_ACP_META_HOST_ENVIRONMENT: "/isolated/meta.json",
    } satisfies NodeJS.ProcessEnv;
    const browser = releaseCellEnvironment({
      bundleCellId: "cell_browser-controlled-main",
      scenarioId: "scenario_browser-controlled-main",
    }, undefined, source);
    expect(browser).toEqual({
      PATH: "/bin",
      AGENT_WORKSPACE_RELEASE_LAUNCH_MANIFEST: "/isolated/manifest.json",
    });
    for (const [bundleCellId, environmentKey, environmentPath] of [
      ["cell_opencode-acp-task", "AGENT_WORKSPACE_RELEASE_OPENCODE_ACP_TASK_HOST_ENVIRONMENT", "/isolated/opencode-task.json"],
      ["cell_codex-acp-task", "AGENT_WORKSPACE_RELEASE_CODEX_ACP_TASK_HOST_ENVIRONMENT", "/isolated/codex-task.json"],
      ["cell_acp-meta", "AGENT_WORKSPACE_RELEASE_ACP_META_HOST_ENVIRONMENT", "/isolated/meta.json"],
    ] as const) {
      expect(releaseCellEnvironment({
        bundleCellId,
        scenarioId: bundleCellId.replace("cell_", "scenario_"),
      }, undefined, source)).toEqual({ PATH: "/bin", [environmentKey]: environmentPath });
    }
    expect(() => releaseCellEnvironment({
      bundleCellId: "cell_opencode-acp-task",
      scenarioId: "scenario_opencode-acp-task",
    }, { AGENT_WORKSPACE_ACP_CONFIG: "private-config" }, source))
      .toThrow("journey_release_cell_runner_environment_addition_forbidden");
    for (const issuer of [
      "opencode_acp_task_attestor",
      "codex_acp_task_attestor",
      "acp_meta_attestor",
    ] as const) {
      expect(childEnvironmentForIssuer(issuer, source)).toEqual({ PATH: "/bin" });
    }
  });

});

async function createHarness(): Promise<Readonly<{
  root: string;
  matrix: JourneyReleaseMatrix;
  matrixFile: string;
  output(cell: JourneyReleaseCellDeclaration): Promise<string>;
  input(cell: JourneyReleaseCellDeclaration, output: string): Parameters<typeof runReleaseCellWorker>[0];
  replaceMatrix(matrix: JourneyReleaseMatrix): Promise<void>;
}>> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-release-cell-worker-"));
  roots.push(root);
  await chmod(root, 0o700);
  const identityInputs = await productionReleaseNonBuildIdentityInputBytes(path.resolve("."), {
    runnerSha256: TEST_RUNNER_SHA256,
    workerSha256: TEST_WORKER_SHA256,
  });
  const release = createFreshReleaseIdentity({
    ...identityInputs,
    build: await productionArtifactIdentityBytes(path.resolve(".")),
  });
  const matrix = clone(createRequiredJourneyReleaseMatrix(release)) as JourneyReleaseMatrix;
  const matrixFile = path.join(root, "matrix.json");
  await writePrivate(matrixFile, matrix);
  return Object.freeze({
    root,
    matrix,
    matrixFile,
    async output(cell) {
      const output = path.join(root, cell.bundleCellId);
      await mkdir(output, { mode: 0o700 });
      await chmod(output, 0o700);
      return output;
    },
    input(cell, output) {
      return { matrixFile, cellId: cell.bundleCellId, scenarioId: cell.scenarioId, outputDirectory: output, environment: environment(matrix, cell) };
    },
    async replaceMatrix(value) { await writePrivate(matrixFile, value, true); },
  });
}

function environment(matrix: JourneyReleaseMatrix, cell: Pick<JourneyReleaseCellDeclaration, "bundleCellId" | "scenarioId">): NodeJS.ProcessEnv {
  return {
    AGENT_WORKSPACE_RELEASE_RUN_ID: matrix.releaseRunId,
    AGENT_WORKSPACE_RELEASE_NONCE: matrix.nonce,
    AGENT_WORKSPACE_RELEASE_CELL_ID: cell.bundleCellId,
    AGENT_WORKSPACE_RELEASE_SCENARIO_ID: cell.scenarioId,
    AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256: TEST_RUNNER_SHA256,
    AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256: TEST_WORKER_SHA256,
  };
}

async function writePrivate(file: string, value: unknown, replace = false): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: replace ? "w" : "wx" });
  await chmod(file, 0o600);
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function expectProcessGone(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("test_child_process_tree_survived");
}
