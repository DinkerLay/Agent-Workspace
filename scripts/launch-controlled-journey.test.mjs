import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchControlledJourney } from "./launch-controlled-journey.mjs";
import { productionArtifactDigest } from "./production-release-artifact.mjs";

const execFileAsync = promisify(execFile);

test("launches a private deterministic UI cell with frozen lineage and audited controls", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-journey-launcher-"));
  const manifestPath = path.join(root, "launch-manifest.json");
  const lineage = expectedLineage("launcher-test");
  let stdout = "";
  let stderr = "";
  const launched = await launchControlledJourney({
    manifestPath,
    stateRoot: root,
    expectedLineage: lineage,
    environment: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      OPENAI_API_KEY: "must-not-propagate",
      AGENT_WORKSPACE_RELEASE_NONCE: "must-not-propagate",
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: "must-not-propagate",
      SCENARIO_SECRET: "must-not-propagate",
      CHECKPOINT_CREDENTIAL: "must-not-propagate",
    },
    stdout: { write: (chunk) => { stdout += String(chunk); return true; } },
    stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
  });
  try {
    const manifestBytes = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.cellMode, "main");
    assert.deepEqual(manifest.lineage, lineage);
    assert.equal(manifest.runtimeInstanceId, lineage.runtimeInstanceId);
    assert.equal(manifest.buildDigest, await productionArtifactDigest(path.resolve(".")));
    assert.equal((await stat(manifestPath)).mode & 0o077, 0);
    assert.equal((await stat(manifest.electronEnvironmentFile)).mode & 0o077, 0);
    assert.equal((await stat(manifest.runnerEnvironmentFile)).mode & 0o077, 0);
    assert.equal((await stat(manifest.restartExecutable)).mode & 0o077, 0);

    const electronEnvironment = JSON.parse(await readFile(manifest.electronEnvironmentFile, "utf8"));
    assert.deepEqual(Object.keys(electronEnvironment).sort(), [
      "AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN",
      "AGENT_WORKSPACE_RUNTIME_ORIGIN",
      "AGENT_WORKSPACE_RUNTIME_URL",
    ]);
    assert.equal("AGENT_WORKSPACE_RUNTIME_TOKEN" in electronEnvironment, false);
    assert.equal(electronEnvironment.AGENT_WORKSPACE_RUNTIME_URL.startsWith("http://127.0.0.1:"), true);
    assert.equal(manifestBytes.includes(electronEnvironment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN), false);
    assert.equal(stdout.includes(electronEnvironment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN), false);

    const browserHtml = await (await fetch(manifest.browserUrl)).text();
    assert.equal(browserHtml.includes("agent-workspace-expected-task-id"), false);
    const browserToken = browserHtml.match(/agent-workspace-runtime-bridge-token" content="([^"]+)"/)?.[1];
    assert.equal(typeof browserToken, "string");
    assert.notEqual(browserToken, electronEnvironment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN);
    assert.equal(manifestBytes.includes(browserToken), false);
    assert.equal(stdout.includes(browserToken), false);
    assert.equal(JSON.stringify(electronEnvironment).includes(browserToken), false);

    const runnerEnvironment = JSON.parse(await readFile(manifest.runnerEnvironmentFile, "utf8"));
    const evidenceToken = runnerEnvironment.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN;
    assert.equal(typeof evidenceToken, "string");
    assert.equal(manifestBytes.includes(evidenceToken), false);
    assert.equal(stdout.includes(evidenceToken), false);
    assert.equal(browserHtml.includes(evidenceToken), false);
    assert.equal((await fetch(manifest.hostLedgerUrl)).status, 401);
    assert.equal((await fetch(manifest.hostLedgerUrl, {
      headers: { authorization: `Bearer ${evidenceToken}` },
    })).status, 200);

    const builtHtml = await readFile(manifest.workbenchBuild, "utf8");
    assert.equal(builtHtml.includes("agent-workspace-expected-task-id"), false);
    assert.match(builtHtml, /agent-workspace-runtime-bridge-token" content=""/);
    assert.equal(builtHtml.includes(browserToken), false);
    assert.equal(builtHtml.includes(electronEnvironment.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN), false);

    const { _electron: electron } = await import("@playwright/test");
    const application = await electron.launch({
      args: [manifest.electronMain],
      env: electronLaunchEnvironment(electronEnvironment),
    });
    try {
      const window = await application.firstWindow({ timeout: 10_000 });
      assert.equal(await window.locator('meta[name="agent-workspace-runtime-bridge-token"]').getAttribute("content"), "");
      assert.equal(await window.locator('meta[name="agent-workspace-expected-task-id"]').count(), 0);
      await window.getByTestId("agent-loop-surface").waitFor({ state: "visible", timeout: 10_000 });
    } finally {
      await closeElectronApplication(application);
    }

    await execFileAsync(manifest.providerBarrierExecutable, ["j05_researcher_waiting_observed"], {
      env: hostileEnvironment(),
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    assert.deepEqual((await json(manifest.healthUrl)).providerClock.releasedStages, ["j05_researcher_waiting_observed"]);
    await execFileAsync(manifest.restartExecutable, [], {
      env: hostileEnvironment(),
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const health = await json(manifest.healthUrl);
    assert.equal(health.runtimeInstanceId, lineage.runtimeInstanceId);
    assert.equal(health.generation, 2);
    assert.equal(health.ready, true);
    assert.equal(stderr.includes("must-not-propagate"), false);
  } finally {
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an undeclared actual-operation cell mode before starting children", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-journey-mode-negative-"));
  try {
    await assert.rejects(launchControlledJourney({
      manifestPath: path.join(root, "launch-manifest.json"),
      stateRoot: root,
      cellMode: "j10-not-declared",
      buildWorkbench: false,
    }), /controlled_journey_cell_mode_invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function hostileEnvironment() {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    OPENAI_API_KEY: "must-not-propagate",
    AGENT_WORKSPACE_RELEASE_NONCE: "must-not-propagate",
    AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: "must-not-propagate",
    CODEX_CREDENTIAL: "must-not-propagate",
    SCENARIO_SECRET: "must-not-propagate",
    CHECKPOINT_SECRET: "must-not-propagate",
  };
}

function electronLaunchEnvironment(candidate) {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY",
  ];
  return Object.fromEntries([
    ...allowed.flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []),
    ...Object.entries(candidate),
  ]);
}

function expectedLineage(suffix) {
  return {
    runtimeInstanceId: `runtime_instance_${suffix}`,
  };
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

async function closeElectronApplication(application) {
  const child = application.process();
  try {
    await withTimeout(application.close(), 10_000, "controlled_journey_electron_close_timeout");
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await withTimeout(new Promise((resolve) => child.once("exit", resolve)), 2_000,
      "controlled_journey_electron_term_timeout").catch(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    throw error;
  }
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
