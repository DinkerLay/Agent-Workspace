import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const configPath = path.join(root, "vitest.expected-red.config.ts");

class ExpectedRedFailure extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const groups = Object.freeze({});

await main().catch((error) => {
  if (error instanceof ExpectedRedFailure) {
    const suffix = error.detail ? `: ${error.detail}` : "";
    process.stderr.write(`${error.code}${suffix}\n`);
  } else {
    process.stderr.write(`expected_red_runner_unhandled: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});

async function main() {
  const selectedGroups = parseGroups(process.argv.slice(2));
  const selectedExpectations = selectedGroups.flatMap((group) => groups[group]);
  const selectedFiles = [...new Set(selectedExpectations.map(({ file }) => file))];
  if (selectedExpectations.length === 0) {
    process.stdout.write(`${JSON.stringify({
      type: "expected_red_verified",
      groups: [],
      files: [],
      assertionCount: 0,
      state: "all_promoted",
    })}\n`);
    return;
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-workspace-expected-red-"));
  const reportPath = path.join(temporaryDirectory, "vitest-report.json");

  try {
    const result = spawnSync(process.execPath, [
      vitestEntry,
      "run",
      "--config",
      configPath,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_WORKSPACE_EXPECTED_RED_FILES: JSON.stringify(selectedFiles),
      },
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.error) fail("expected_red_vitest_launch_failed", result.error.message);
    if (result.signal) fail("expected_red_vitest_signalled", result.signal);
    if (result.status !== 1) {
      fail("expected_red_vitest_exit_unexpected", JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    }

    let report;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch (error) {
      fail("expected_red_report_invalid", error instanceof Error ? error.message : String(error));
    }
    verifyReport(report, selectedExpectations, selectedFiles);

    process.stdout.write(`${JSON.stringify({
      type: "expected_red_verified",
      groups: selectedGroups,
      files: selectedFiles,
      assertionCount: selectedExpectations.length,
    })}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function expected(file, title, failureCode) {
  return Object.freeze({ file, title, failureCode });
}

function parseGroups(args) {
  if (args.length === 0 || (args.length === 2 && args[0] === "--groups" && args[1] === "none")) return [];
  if (args.length !== 2 || args[0] !== "--groups" || typeof args[1] !== "string") {
    fail("expected_red_groups_argument_required", "all RED groups are promoted; omit --groups");
  }
  const parsed = args[1].split(",").filter(Boolean);
  if (
    parsed.length === 0
    || new Set(parsed).size !== parsed.length
    || parsed.some((group) => !Object.prototype.hasOwnProperty.call(groups, group))
  ) {
    fail("expected_red_groups_invalid", args[1]);
  }
  return parsed;
}

function verifyReport(report, expectations, selectedFiles) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    fail("expected_red_report_shape_invalid");
  }

  const expectedByIdentity = new Map(expectations.map((entry) => [identity(entry.file, entry.title), entry]));
  const observedIdentities = new Set();
  const observedFiles = new Set();

  for (const testResult of report.testResults) {
    const file = reportFile(testResult?.name);
    if (!selectedFiles.includes(file)) fail("expected_red_unlisted_file_ran", file);
    observedFiles.add(file);
    if (!Array.isArray(testResult.assertionResults)) fail("expected_red_assertions_missing", file);

    for (const assertion of testResult.assertionResults) {
      const title = typeof assertion?.title === "string" ? assertion.title : "";
      const key = identity(file, title);
      const expectation = expectedByIdentity.get(key);
      if (!expectation) fail("expected_red_unlisted_assertion_ran", key);
      if (observedIdentities.has(key)) fail("expected_red_assertion_duplicate", key);
      observedIdentities.add(key);
      if (assertion.status !== "failed") {
        fail("expected_red_assertion_did_not_fail", JSON.stringify({ key, status: assertion.status }));
      }
      const failureText = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.join("\n") : "";
      if (!failureText.includes(expectation.failureCode)) {
        fail("expected_red_failure_reason_unexpected", JSON.stringify({ key, expected: expectation.failureCode, failureText }));
      }
    }
  }

  for (const file of selectedFiles) {
    if (!observedFiles.has(file)) fail("expected_red_file_not_run", file);
  }
  for (const key of expectedByIdentity.keys()) {
    if (!observedIdentities.has(key)) fail("expected_red_assertion_not_run", key);
  }
  if (report.numFailedTests !== expectations.length || report.numPassedTests !== 0 || report.numPendingTests !== 0) {
    fail("expected_red_totals_unexpected", JSON.stringify({
      failed: report.numFailedTests,
      passed: report.numPassedTests,
      pending: report.numPendingTests,
      expectedFailed: expectations.length,
    }));
  }
}

function reportFile(value) {
  if (typeof value !== "string") fail("expected_red_report_file_missing");
  const relative = path.relative(root, path.resolve(value)).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    fail("expected_red_report_file_outside_root", value);
  }
  return relative;
}

function identity(file, title) {
  return `${file}::${title}`;
}

function fail(code, detail = "") {
  throw new ExpectedRedFailure(code, detail);
}
