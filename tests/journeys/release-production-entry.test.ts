import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

describe("release journey production entry", () => {
  it.each([
    "scripts/launch-controlled-journey.mjs",
    "tests/journeys/support/acp-release-cell-launcher.ts",
  ])("uses only the formal production renderer and Electron entry in %s", (relativePath) => {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");

    expect(source).toContain("dist\", \"workbench\", \"index.html");
    expect(source).toContain("apps\", \"desktop\", \"main.cjs");
    expect(source).not.toMatch(/vite\.session-id-candidate|workbench-session-id-candidate|session-id-root-launch-candidate/u);
    expect(source).not.toContain("AGENT_WORKSPACE_EXPECTED_TASK_ID");
    expect(source).toContain("productionArtifactDigest");
    expect(source).toContain("startProductionWorkbenchServer");
    expect(source).not.toContain("const viteChild =");
    expect(source).toContain("buildDigest");
  });

  it("keeps the controlled build launcher on the production Vite configuration", () => {
    const source = readFileSync(path.join(repositoryRoot, "scripts/launch-controlled-journey.mjs"), "utf8");
    expect(source).toContain("vite.runtime.config.ts");
  });

  it("allows only the formal production build and Electron entry in the cell worker", () => {
    const source = readFileSync(path.join(repositoryRoot, "tests/journeys/release-cell-worker.ts"), "utf8");

    expect(source).toContain("dist\", \"workbench\", \"index.html");
    expect(source).toContain("apps\", \"desktop\", \"main.cjs");
    expect(source).not.toMatch(/workbench-session-id-candidate|session-id-root-launch-candidate/u);
    expect(source).not.toContain("AGENT_WORKSPACE_EXPECTED_TASK_ID");
    expect(source).toContain("productionArtifactDigest");
    expect(source).toContain('"--skip-build"');
    expect(source).toContain("matrix.digests.buildDigest");
    expect(source).toContain("assertProductionReleaseNonBuildDigests");
    expect(source).toContain("AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256");
  });

  it("uses the fixed ACP parent aggregate and retains typed exit-2 capability classification", () => {
    const source = readFileSync(path.join(repositoryRoot, "tests/journeys/run-release.ts"), "utf8");
    const aggregate = readFileSync(path.join(
      repositoryRoot,
      "tests/journeys/acp-release-parent-aggregate.ts",
    ), "utf8");

    expect(source).toContain("runAcpReleaseParentProduction");
    expect(source).toContain('outcome: "BLOCKED_CAPABILITY"');
    expect(source).toContain("process.exitCode = 2");
    expect(source).toContain("safeParentFailureCode(error)");
    expect(source).toContain("AcpReleaseParentQualificationCleanupError");
    expect(source).toContain("qualificationCleanup: error.observation");
    expect(source).toContain('"acp_release_parent_failed"');
    expect(source).not.toContain("createAcpReleaseParentQualificationSealWithExecutorsForTest");
    expect(aggregate).toContain("createAcpReleaseParentInputSeal");
    expect(aggregate).toContain("createAcpReleaseParentProductionQualificationSeal");
    expect(aggregate).toContain("runReleasePreparation");
    expect(aggregate).toContain("createRequiredJourneyReleaseMatrix");
    expect(aggregate).toContain("runAndAttestReleaseCells");
    expect(aggregate).toContain("verifyReleaseBundle");
    expect(aggregate).not.toContain("WithExecutorsForTest");
    expect(aggregate).not.toMatch(/controlledCreateAdapter|controlledResolveCurrent/u);
  });
});
