import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerOwnedEvidenceContext, verifyTrustedAttestations, type JourneyReleaseMatrix } from "./evidence-issuers.js";
import {
  ACP_RELEASE_CELL_TIMEOUT_MS,
  CONTROLLED_RELEASE_CELL_TIMEOUT_MS,
  ReleaseCellBlockedError,
  releaseCellRunnerTimeoutMs,
  runAndAttestReleaseCells,
  spawnCellRunner,
} from "./release-cell-runner.js";
import { createFreshReleaseIdentity, createRequiredJourneyReleaseMatrix, verifyReleaseBundle } from "./release-verifier.js";

const roots: string[] = [];

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted release cell runner boundary", () => {
  it("keeps controlled and each independent ACP cell timeout bounded", () => {
    expect(releaseCellRunnerTimeoutMs("cell_browser-controlled-main"))
      .toBe(CONTROLLED_RELEASE_CELL_TIMEOUT_MS);
    for (const cell of ["cell_opencode-acp-task", "cell_codex-acp-task", "cell_acp-meta"]) {
      expect(releaseCellRunnerTimeoutMs(cell)).toBe(ACP_RELEASE_CELL_TIMEOUT_MS);
    }
    expect(CONTROLLED_RELEASE_CELL_TIMEOUT_MS).toBe(300_000);
    expect(ACP_RELEASE_CELL_TIMEOUT_MS).toBe(1_800_000);
  });

  it("hard-stops an exact runner process group after the graceful timeout and always resolves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-release-runner-timeout-"));
    roots.push(root);
    const executable = path.join(root, "ignore-sigterm.cjs");
    const grandchildPidFile = path.join(root, "grandchild.pid");
    const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(executable, 0o700);
    const matrix = oneCellMatrix();
    const cell = matrix.cells[0]!;
    const startedAt = Date.now();
    const result = await spawnCellRunner(
      executable,
      matrix,
      path.join(root, "matrix.json"),
      cell,
      path.join(root, "output"),
      undefined,
      { timeoutMs: 2_000, terminationGraceMs: 100 },
    );
    expect(result).toEqual({ exitCode: 1, failureCode: "journey_release_cell_runner_timeout" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expectProcessGone(Number(await readFile(grandchildPidFile, "utf8")));
  });

  it("runs an exact-digest executable without issuer keys, validates its private ledger, then signs in the parent", async () => {
    const matrix = oneCellMatrix();
    const fixture = await fixtureRunner(matrix, false);
    const context = createRunnerOwnedEvidenceContext(matrix);
    let releaseSealChecks = 0;
    const attestations = await runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: context,
      verifyReleaseInputs: async () => { releaseSealChecks += 1; },
    });
    expect(releaseSealChecks).toBe(4);
    expect(attestations).toHaveLength(1);
    expect(() => verifyTrustedAttestations(matrix, attestations, context.verifier)).not.toThrow();
    expect(attestations[0]?.payload.result).toMatchObject({
      issuer: "runtime_host",
      evidenceClass: "deterministic_fake",
      surface: "runtime-host",
      outcome: "PASS",
    });
    const childLedger = JSON.parse(await readFile(path.join(
      fixture.evidenceRoot,
      "cells",
      "cell_runner-contract",
      "runner-contract-runtime-host.json",
    ), "utf8")) as { environmentKeys: string[] };
    expect(childLedger.environmentKeys).toEqual(expect.arrayContaining([
      "AGENT_WORKSPACE_RELEASE_RUN_ID",
      "AGENT_WORKSPACE_RELEASE_NONCE",
      "AGENT_WORKSPACE_RELEASE_CELL_ID",
      "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
    ]));
    expect(childLedger.environmentKeys).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/(?:API|CODEX|CREDENTIAL|EVIDENCE|SECRET|TOKEN)/u),
    ]));
  });

  it("requires an exact constructor shape and a callable parent release-input verifier before root access", async () => {
    const matrix = oneCellMatrix();
    const fixture = await fixtureRunner(matrix, false);
    const base = {
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
    };
    await expect(runAndAttestReleaseCells(base as never))
      .rejects.toThrow("journey_release_cell_runner_input_invalid");
    await expect(runAndAttestReleaseCells({
      ...base,
      verifyReleaseInputs: "not-callable",
    } as never)).rejects.toThrow("journey_release_cell_runner_input_invalid");
    await expect(runAndAttestReleaseCells({
      ...base,
      verifyReleaseInputs: testReleaseInputVerifier(),
      unexpected: true,
    } as never)).rejects.toThrow("journey_release_cell_runner_input_invalid");
    expect(await readdir(fixture.evidenceRoot)).toEqual([]);
  });

  it("rejects a missing, relative, non-0700, nonempty, or symlink evidence root after the first parent seal check", async () => {
    for (const mutation of ["missing", "relative", "permissive", "special-mode", "nonempty", "symlink"] as const) {
      const matrix = oneCellMatrix();
      const fixture = await fixtureRunner(matrix, false);
      let evidenceRoot = fixture.evidenceRoot;
      if (mutation === "missing") evidenceRoot = path.join(path.dirname(evidenceRoot), "missing-evidence");
      if (mutation === "relative") evidenceRoot = path.relative(process.cwd(), evidenceRoot);
      if (mutation === "permissive") await chmod(evidenceRoot, 0o755);
      if (mutation === "special-mode") await chmod(evidenceRoot, 0o1700);
      if (mutation === "nonempty") await writeFile(path.join(evidenceRoot, "unexpected"), "x", { mode: 0o600 });
      if (mutation === "symlink") {
        evidenceRoot = path.join(path.dirname(fixture.evidenceRoot), "evidence-link");
        await symlink(fixture.evidenceRoot, evidenceRoot);
      }
      let checks = 0;
      await expect(runAndAttestReleaseCells({
        matrix,
        matrixFile: fixture.matrixFile,
        evidenceRoot,
        runnerExecutable: fixture.runner,
        runnerSha256: fixture.digest,
        issuerContext: createRunnerOwnedEvidenceContext(matrix),
        verifyReleaseInputs: async () => { checks += 1; },
      })).rejects.toThrow("journey_release_evidence_root_invalid");
      expect(checks).toBe(1);
      expect(await readdir(fixture.evidenceRoot)).not.toContain("cells");
    }
  });

  it("rejects evidence-root inode replacement and unexpected cell roots at release boundaries", async () => {
    const matrix = oneCellMatrix();
    const replaced = await fixtureRunner(matrix, false);
    let replacementChecks = 0;
    await expect(runAndAttestReleaseCells({
      matrix,
      matrixFile: replaced.matrixFile,
      evidenceRoot: replaced.evidenceRoot,
      runnerExecutable: replaced.runner,
      runnerSha256: replaced.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
      verifyReleaseInputs: async () => {
        replacementChecks += 1;
        if (replacementChecks !== 2) return;
        await rename(replaced.evidenceRoot, `${replaced.evidenceRoot}-displaced`);
        await mkdir(replaced.evidenceRoot, { mode: 0o700 });
        await mkdir(path.join(replaced.evidenceRoot, "cells"), { mode: 0o700 });
      },
    })).rejects.toThrow("journey_release_evidence_root_identity_changed");

    const extra = await fixtureRunner(matrix, false);
    let extraChecks = 0;
    await expect(runAndAttestReleaseCells({
      matrix,
      matrixFile: extra.matrixFile,
      evidenceRoot: extra.evidenceRoot,
      runnerExecutable: extra.runner,
      runnerSha256: extra.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
      verifyReleaseInputs: async () => {
        extraChecks += 1;
        if (extraChecks === 3) await mkdir(path.join(extra.evidenceRoot, "cells", "unexpected"), { mode: 0o700 });
      },
    })).rejects.toThrow("journey_release_evidence_root_contents_changed");
  });

  it("rejects digest substitution and runner attempts to self-declare evidence class", async () => {
    const matrix = oneCellMatrix();
    const fixture = await fixtureRunner(matrix, false);
    const context = createRunnerOwnedEvidenceContext(matrix);
    await expect(runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: `sha256:${"0".repeat(64)}`,
      issuerContext: context,
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.not.toBeInstanceOf(ReleaseCellBlockedError);

    const forged = await fixtureRunner(matrix, true);
    const forgedContext = createRunnerOwnedEvidenceContext(matrix);
    await expect(runAndAttestReleaseCells({
      matrix,
      matrixFile: forged.matrixFile,
      evidenceRoot: forged.evidenceRoot,
      runnerExecutable: forged.runner,
      runnerSha256: forged.digest,
      issuerContext: forgedContext,
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_release_candidate_authority_field_forbidden");
  });

  it("keeps parent source drift as an ordinary safety failure without creating cell roots", async () => {
    const matrix = oneCellMatrix();
    const fixture = await fixtureRunner(matrix, false);
    const failure = await runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
      verifyReleaseInputs: async () => { throw new Error("journey_release_source_drift"); },
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ReleaseCellBlockedError);
    expect((failure as Error).message).toBe("journey_release_source_drift");
    expect(await readdir(fixture.evidenceRoot)).toEqual([]);
  });

  it("propagates only the worker's safelisted structured failure code", async () => {
    const matrix = oneCellMatrix();
    const fixture = await fixtureRunner(matrix, false, "safe-runner-failure");
    const failure = await runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "journey_release_cell_runner_failed:cell_runner-contract:1:codex_scoped_tool_probe_incomplete:calls_0:elicitations_0",
    );
    expect((failure as Error).message).not.toContain("operator");
  });

  it("can collect, sign and verify every required cell to the reachable exit-0 condition", async () => {
    const release = createFreshReleaseIdentity({ source: "s", build: "b", schema: "x", providerPolicy: "p", policy: "y" });
    const matrix = createRequiredJourneyReleaseMatrix(release);
    const fixture = await fixtureRunner(matrix, false);
    const context = createRunnerOwnedEvidenceContext(matrix);
    let releaseSealChecks = 0;
    const attestations = await runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: context,
      verifyReleaseInputs: async () => { releaseSealChecks += 1; },
    });
    expect(releaseSealChecks).toBe((matrix.cells.length * 2) + 2);
    expect(() => verifyReleaseBundle({ matrix, attestations, verifier: context.verifier })).not.toThrow();
  }, 20_000);

  it("rejects missing, extra, fallback, unknown-reference and cross-cell reused observed lineage", async () => {
    for (const mutation of ["missing", "extra", "fallback", "unknown-reference"] as const) {
      const matrix = oneCellMatrix();
      const fixture = await fixtureRunner(matrix, false, mutation);
      await expect(runAndAttestReleaseCells({
        matrix,
        matrixFile: fixture.matrixFile,
        evidenceRoot: fixture.evidenceRoot,
        runnerExecutable: fixture.runner,
        runnerSha256: fixture.digest,
        issuerContext: createRunnerOwnedEvidenceContext(matrix),
        verifyReleaseInputs: testReleaseInputVerifier(),
      })).rejects.toThrow(mutation === "unknown-reference"
        ? "journey_release_candidate_observed_lineage_reference_unknown"
        : "journey_release_candidate_observed_lineage_invalid");
    }

    const acpRelease = createFreshReleaseIdentity({ source: "s", build: "b", schema: "x", providerPolicy: "p", policy: "y" });
    const acpMatrixAll = createRequiredJourneyReleaseMatrix(acpRelease);
    const acpCell = acpMatrixAll.cells.find(({ bundleCellId }) => bundleCellId === "cell_codex-acp-task")!;
    const acpMatrix = { ...acpMatrixAll, cells: [acpCell] };
    const missingLifecycle = await fixtureRunner(acpMatrix, false, "missing-acp-lifecycle");
    await expect(runAndAttestReleaseCells({
      matrix: acpMatrix,
      matrixFile: missingLifecycle.matrixFile,
      evidenceRoot: missingLifecycle.evidenceRoot,
      runnerExecutable: missingLifecycle.runner,
      runnerSha256: missingLifecycle.digest,
      issuerContext: createRunnerOwnedEvidenceContext(acpMatrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_acp_attestation_role_coverage_invalid");

    const missingSemanticFact = await fixtureRunner(acpMatrix, false, "missing-acp-semantic-fact");
    await expect(runAndAttestReleaseCells({
      matrix: acpMatrix,
      matrixFile: missingSemanticFact.matrixFile,
      evidenceRoot: missingSemanticFact.evidenceRoot,
      runnerExecutable: missingSemanticFact.runner,
      runnerSha256: missingSemanticFact.digest,
      issuerContext: createRunnerOwnedEvidenceContext(acpMatrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_acp_attestation_fact_coverage_invalid");

    const laneMismatch = await fixtureRunner(acpMatrix, false, "acp-lane-mismatch");
    await expect(runAndAttestReleaseCells({
      matrix: acpMatrix,
      matrixFile: laneMismatch.matrixFile,
      evidenceRoot: laneMismatch.evidenceRoot,
      runnerExecutable: laneMismatch.runner,
      runnerSha256: laneMismatch.digest,
      issuerContext: createRunnerOwnedEvidenceContext(acpMatrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_acp_attestation_lane_mismatch");

    const reusedQualification = await fixtureRunner(acpMatrix, false, "acp-qualification-reuse");
    await expect(runAndAttestReleaseCells({
      matrix: acpMatrix,
      matrixFile: reusedQualification.matrixFile,
      evidenceRoot: reusedQualification.evidenceRoot,
      runnerExecutable: reusedQualification.runner,
      runnerSha256: reusedQualification.digest,
      issuerContext: createRunnerOwnedEvidenceContext(acpMatrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_acp_attestation_profile_observation_reused");

    const crossProfileMatrix = {
      ...acpMatrixAll,
      cells: acpMatrixAll.cells.filter(({ bundleCellId }) =>
        bundleCellId === "cell_opencode-acp-task" || bundleCellId === "cell_codex-acp-task"),
    };
    const crossProfileReuse = await fixtureRunner(crossProfileMatrix, false, "cross-acp-qualification-reuse");
    await expect(runAndAttestReleaseCells({
      matrix: crossProfileMatrix,
      matrixFile: crossProfileReuse.matrixFile,
      evidenceRoot: crossProfileReuse.evidenceRoot,
      runnerExecutable: crossProfileReuse.runner,
      runnerSha256: crossProfileReuse.digest,
      issuerContext: createRunnerOwnedEvidenceContext(crossProfileMatrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_release_acp_cross_cell_qualification_reused");

    const release = createFreshReleaseIdentity({ source: "s", build: "b", schema: "x", providerPolicy: "p", policy: "y" });
    const full = createRequiredJourneyReleaseMatrix(release);
    const matrix = { ...full, cells: full.cells.slice(0, 2) };
    const fixture = await fixtureRunner(matrix, false, "cross-cell-reuse");
    await expect(runAndAttestReleaseCells({
      matrix,
      matrixFile: fixture.matrixFile,
      evidenceRoot: fixture.evidenceRoot,
      runnerExecutable: fixture.runner,
      runnerSha256: fixture.digest,
      issuerContext: createRunnerOwnedEvidenceContext(matrix),
      verifyReleaseInputs: testReleaseInputVerifier(),
    })).rejects.toThrow("journey_release_observed_lineage_cross_cell_reused");
  });
});

function oneCellMatrix(): JourneyReleaseMatrix {
  const release = createFreshReleaseIdentity({ source: "s", build: "b", schema: "x", providerPolicy: "p", policy: "y" });
  return {
    ...release,
    cells: [{
      bundleCellId: "cell_runner-contract",
      scenarioId: "scenario_runner-contract",
      lineage: { runtimeInstanceId: "runtime_instance_runner-contract" },
      required: true,
      streamRequirements: [{
        issuer: "runtime_host",
        evidenceClass: "deterministic_fake",
        surface: "runtime-host",
        checkpoints: ["J-04"],
      }],
    }],
  };
}

async function fixtureRunner(
  matrix: JourneyReleaseMatrix,
  forgeAuthority: boolean,
  mutation?: "missing" | "extra" | "fallback" | "unknown-reference" | "cross-cell-reuse"
    | "missing-acp-lifecycle" | "missing-acp-semantic-fact" | "acp-lane-mismatch" | "acp-qualification-reuse"
    | "cross-acp-qualification-reuse" | "safe-runner-failure",
): Promise<Readonly<{
  runner: string;
  digest: string;
  evidenceRoot: string;
  matrixFile: string;
}>> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-workspace-cell-runner-")));
  roots.push(root);
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { mode: 0o700 });
  const matrixFile = path.join(root, "matrix.json");
  await writeFile(matrixFile, `${JSON.stringify(matrix)}\n`, { mode: 0o600 });
  const runner = path.join(root, "runner.mjs");
  const fixtureModule = new URL("./support/acp-release-cell-candidate-fixture.mjs", import.meta.url).href;
  await writeFile(runner, [
    "#!/usr/bin/env node",
    `import { runAcpReleaseCellCandidateFixture } from ${JSON.stringify(fixtureModule)};`,
    `await runAcpReleaseCellCandidateFixture(${JSON.stringify(mutation ?? "")}, ${JSON.stringify(forgeAuthority)});`,
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(runner, 0o700);
  return {
    runner,
    digest: `sha256:${createHash("sha256").update(await readFile(runner)).digest("hex")}`,
    evidenceRoot,
    matrixFile,
  };
}

function testReleaseInputVerifier(): () => Promise<void> {
  const frozenSeal = Object.freeze({
    schemaVersion: 1,
    digest: `sha256:${createHash("sha256").update("release-cell-runner-test-seal").digest("hex")}`,
  });
  return async () => {
    if (!Object.isFrozen(frozenSeal) || !/^sha256:[a-f0-9]{64}$/u.test(frozenSeal.digest)) {
      throw new Error("test_release_input_seal_invalid");
    }
  };
}
