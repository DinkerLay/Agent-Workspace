const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function runVerification(input, dependencies = {}) {
  const spawnProcess = dependencies.spawn ?? spawn;
  const startedAt = Date.now();
  const cwd = String(input?.cwd ?? "");
  const runId = String(input?.runId ?? "");
  const command = String(input?.command ?? "").trim();
  const timeoutMs = Number(input?.timeoutMs ?? 120000);

  if (!cwd || !fs.existsSync(cwd)) {
    return Promise.resolve(
      finalizeVerification({
        cwd,
        runId,
        command,
        startedAt,
        stdout: "",
        stderr: `Working directory does not exist: ${cwd}`,
        exitCode: null,
        signal: null,
        error: `Working directory does not exist: ${cwd}`,
      }),
    );
  }

  if (!runId || !isSafeRunId(runId)) {
    return Promise.resolve(
      finalizeVerification({
        cwd,
        runId,
        command,
        startedAt,
        stdout: "",
        stderr: `Invalid run id: ${runId}`,
        exitCode: null,
        signal: null,
        error: `Invalid run id: ${runId}`,
      }),
    );
  }

  if (!command) {
    return Promise.resolve(
      finalizeVerification({
        cwd,
        runId,
        command,
        startedAt,
        stdout: "",
        stderr: "Verification command is required.",
        exitCode: null,
        signal: null,
        error: "Verification command is required.",
      }),
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    const args = ["-lc", command];

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finalizeVerification(result));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      if (child?.kill) child.kill("SIGTERM");
      settle({
        cwd,
        runId,
        command,
        startedAt,
        stdout,
        stderr: appendDiagnostic(stderr, `verification command timed out after ${timeoutMs}ms`),
        exitCode: null,
        signal: "SIGTERM",
        error: "timeout",
      });
    }, timeoutMs);

    try {
      child = spawnProcess("/bin/sh", args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({
        cwd,
        runId,
        command,
        startedAt,
        stdout,
        stderr: error instanceof Error ? error.message : "verification command spawn failed",
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : "verification command spawn failed",
      });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settle({
        cwd,
        runId,
        command,
        startedAt,
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
        signal: null,
        error: error.message,
      });
    });
    child.on("close", (exitCode, signal) => {
      settle({
        cwd,
        runId,
        command,
        startedAt,
        stdout,
        stderr,
        exitCode,
        signal,
        error: exitCode === 0 ? undefined : `verification command failed with exit code ${exitCode}`,
      });
    });
  });
}

function finalizeVerification({ cwd, runId, command, startedAt, stdout, stderr, exitCode, signal, error }) {
  const status = exitCode === 0 ? "passed" : "failed";
  const artifactPath = `.agent-workspace/runs/${runId || "unknown-run"}/verification.json`;
  const logPath = `.agent-workspace/runs/${runId || "unknown-run"}/verification.log`;
  const result = {
    ok: status === "passed",
    command,
    cwd,
    runId,
    status,
    stdout,
    stderr,
    exitCode,
    signal,
    durationMs: Date.now() - startedAt,
    artifactPath,
    logPath,
    error,
  };

  if (cwd && fs.existsSync(cwd)) {
    writeVerificationEvidence(cwd, result);
  }

  return result;
}

function writeVerificationEvidence(cwd, result) {
  const absoluteLogPath = path.join(cwd, result.logPath);
  const absoluteArtifactPath = path.join(cwd, result.artifactPath);
  fs.mkdirSync(path.dirname(absoluteLogPath), { recursive: true });
  fs.writeFileSync(absoluteLogPath, formatVerificationLog(result), "utf8");
  fs.writeFileSync(
    absoluteArtifactPath,
    `${JSON.stringify(
      {
        runId: result.runId,
        command: result.command,
        cwd: result.cwd,
        status: result.status,
        ok: result.ok,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        artifactPath: result.artifactPath,
        logPath: result.logPath,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function formatVerificationLog(result) {
  return [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `runId: ${result.runId}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode}`,
    "",
    "--- stdout ---",
    result.stdout.trimEnd(),
    "",
    "--- stderr ---",
    result.stderr.trimEnd(),
    "",
  ].join("\n");
}

function appendDiagnostic(stderr, message) {
  return [stderr.trimEnd(), message].filter(Boolean).join("\n");
}

function isSafeRunId(value) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

module.exports = {
  runVerification,
};
