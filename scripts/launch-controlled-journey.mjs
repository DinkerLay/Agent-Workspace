#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productionArtifactDigest } from "./production-release-artifact.mjs";
import { startProductionWorkbenchServer } from "./production-workbench-server.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loopbackHost = "127.0.0.1";
const runtimeConfig = path.join(repositoryRoot, "vite.runtime.config.ts");
const workbenchBuild = path.join(repositoryRoot, "dist", "workbench", "index.html");
const electronMain = path.join(repositoryRoot, "apps", "desktop", "main.cjs");
const serviceEntry = path.join(repositoryRoot, "tests", "journeys", "support", "controlled-unified-host-service-cli.ts");
const controlModule = path.join(repositoryRoot, "scripts", "restart-controlled-journey-host.mjs");
const providerStages = Object.freeze([
  "j05_researcher_waiting_observed",
  "j06_researcher_final_observed",
  "j08_idle_human_delivered_observed",
  "j08_busy_human_held_observed",
  "j08_late_final_human_held_observed",
  "j09_human_interrupt_intent_recorded",
  "j09_conductor_interrupt_intent_recorded",
]);
const controlledCellModes = Object.freeze([
  "main",
  "j08-unknown",
  "j08-late-final",
  "j10-pending-lane",
  "j10-tool-result",
  "j10-provider-accepted",
  "j10-human-interrupting",
  "j10-final-before-inbox",
]);

export async function launchControlledJourney({
  manifestPath,
  stateRoot,
  browserPort,
  expectedLineage,
  lineageFile: inputLineageFile,
  cellMode: inputCellMode = "main",
  buildWorkbench = true,
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const cellMode = normalizeCellMode(inputCellMode);
  const absoluteManifest = requiredAbsolute(manifestPath, "controlled_journey_manifest_absolute_required");
  const root = stateRoot === undefined
    ? await mkdtemp(path.join(tmpdir(), "agent-workspace-controlled-journey-"))
    : requiredAbsolute(stateRoot, "controlled_journey_state_root_absolute_required");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(path.dirname(absoluteManifest), { recursive: true, mode: 0o700 });
  if (expectedLineage !== undefined && inputLineageFile !== undefined) {
    throw new Error("controlled_journey_lineage_input_conflict");
  }
  const lineage = expectedLineage === undefined
    ? inputLineageFile === undefined
      ? defaultExpectedLineage()
      : await readPrivateExpectedLineage(inputLineageFile)
    : normalizeExpectedLineage(expectedLineage);
  const lineageFile = path.join(root, "runtime-anchor.json");
  await writePrivateJson(lineageFile, lineage);

  const selectedBrowserPort = browserPort === undefined
    ? await reserveLoopbackPort()
    : validPort(browserPort, "controlled_journey_browser_port_invalid");
  const bridgePort = await reserveLoopbackPort();
  const servicePort = await reserveLoopbackPort();
  const browserUrl = `http://${loopbackHost}:${selectedBrowserPort}/`;
  const rendererToken = secret();
  const desktopRendererToken = secret();
  const evidenceToken = secret();
  const controlToken = secret();
  const children = [];
  let closed = false;
  let serviceReady;
  let controlFile;
  let workbenchServer;

  try {
    if (buildWorkbench) {
      const viteEntry = path.join(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
      await spawnExit(process.execPath, [viteEntry, "build", "--config", runtimeConfig], {
        cwd: repositoryRoot,
        env: {
          ...narrowOsEnvironment(environment),
          AGENT_WORKSPACE_OWNER_ID: "user_local",
        },
        stdio: "inherit",
      });
    }
    const buildDigest = await productionArtifactDigest(repositoryRoot);

    const serviceChild = spawnTracked(process.execPath, [
      path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      serviceEntry,
      "--state-root", root,
      "--bridge-port", String(bridgePort),
      "--service-port", String(servicePort),
      "--allowed-origin", browserUrl,
      "--lineage", lineageFile,
      "--cell-mode", cellMode,
    ], {
      cwd: repositoryRoot,
      env: {
        ...narrowOsEnvironment(environment),
        AGENT_WORKSPACE_OWNER_ID: "user_local",
        AGENT_WORKSPACE_CONTROLLED_RENDERER_TOKEN: rendererToken,
        AGENT_WORKSPACE_CONTROLLED_DESKTOP_RENDERER_TOKEN: desktopRendererToken,
        AGENT_WORKSPACE_CONTROLLED_EVIDENCE_TOKEN: evidenceToken,
        AGENT_WORKSPACE_CONTROLLED_CONTROL_TOKEN: controlToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }, children);
    serviceReady = await waitForReadyLine(serviceChild, "controlled_unified_host_ready", 30_000, stderr);

    controlFile = path.join(root, ".controlled-host-control.json");
    await writePrivateJson(controlFile, {
      schemaVersion: 1,
      serviceUrl: serviceReady.serviceUrl,
      controlToken,
    });
    const restartExecutable = path.join(root, "restart-controlled-host.mjs");
    const barrierExecutable = path.join(root, "advance-controlled-provider-stage.mjs");
    await writeExecutable(restartExecutable, restartWrapperSource(controlFile));
    await writeExecutable(barrierExecutable, barrierWrapperSource(controlFile));

    const electronEnvironmentFile = path.join(root, "electron-environment.json");
    await writePrivateJson(electronEnvironmentFile, {
      AGENT_WORKSPACE_RUNTIME_URL: serviceReady.runtimeUrl,
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: desktopRendererToken,
      AGENT_WORKSPACE_RUNTIME_ORIGIN: new URL(browserUrl).origin,
    });
    const runnerEnvironmentFile = path.join(root, "runner-evidence-environment.json");
    await writePrivateJson(runnerEnvironmentFile, {
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: evidenceToken,
    });
    const actionEvidenceFile = path.join(root, "runner-action-evidence.jsonl");
    await writeFile(actionEvidenceFile, "", { mode: 0o600 });
    await chmod(actionEvidenceFile, 0o600);

    workbenchServer = await startProductionWorkbenchServer({
      repositoryRoot,
      host: loopbackHost,
      port: selectedBrowserPort,
      runtimeUrl: serviceReady.runtimeUrl,
      rendererToken,
      ownerId: "user_local",
    });
    if (workbenchServer.url !== browserUrl) throw new Error("controlled_journey_browser_url_mismatch");
    await waitForHttp(browserUrl, 30_000);
    await waitForReadyHealth(serviceReady.healthUrl, 10_000);

    const manifest = Object.freeze({
      schemaVersion: 1,
      evidenceClass: "deterministic_fake",
      cellMode,
      browserUrl,
      hostLedgerUrl: serviceReady.hostLedgerUrl,
      operationLedgerUrl: serviceReady.operationLedgerUrl,
      observedLineageUrl: serviceReady.observedLineageUrl,
      healthUrl: serviceReady.healthUrl,
      runtimeInstanceId: serviceReady.runtimeInstanceId,
      lineageId: serviceReady.lineageId,
      lineage,
      restartExecutable,
      providerBarrierExecutable: barrierExecutable,
      actionEvidenceFile,
      electronEnvironmentFile,
      runnerEnvironmentFile,
      electronMain,
      workbenchBuild,
      buildDigest,
    });
    await writePrivateJson(absoluteManifest, manifest);
    stdout.write(`${JSON.stringify({
      type: "controlled_journey_ready",
      manifestPath: absoluteManifest,
      browserUrl,
      healthUrl: serviceReady.healthUrl,
      runtimeInstanceId: serviceReady.runtimeInstanceId,
    })}\n`);

    return Object.freeze({
      manifest,
      async close() {
        if (closed) return;
        closed = true;
        await workbenchServer?.close();
        workbenchServer = undefined;
        if (controlFile && serviceReady) {
          await fetch(`${serviceReady.serviceUrl}/control/shutdown`, {
            method: "POST",
            headers: { authorization: `Bearer ${controlToken}` },
          }).catch(() => undefined);
        }
        await stopChildren(children);
      },
    });
  } catch (error) {
    closed = true;
    await workbenchServer?.close();
    workbenchServer = undefined;
    await stopChildren(children);
    throw error;
  }
}

export function narrowOsEnvironment(environment = process.env) {
  const allow = [
    "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  ];
  return Object.fromEntries(allow.flatMap((name) =>
    typeof environment[name] === "string" ? [[name, environment[name]]] : []));
}

function restartWrapperSource(controlFilePath) {
  return [
    `#!${process.execPath}`,
    `import { invokeControlledJourneyControl } from ${JSON.stringify(pathToFileURL(controlModule).href)};`,
    `await invokeControlledJourneyControl({ controlFile: ${JSON.stringify(controlFilePath)}, action: "restart" });`,
    "",
  ].join("\n");
}

function barrierWrapperSource(controlFilePath) {
  return [
    `#!${process.execPath}`,
    `import { invokeControlledJourneyControl } from ${JSON.stringify(pathToFileURL(controlModule).href)};`,
    `const stages = new Set(${JSON.stringify(providerStages)});`,
    "const stage = process.argv[2];",
    "if (!stages.has(stage) || process.argv.length !== 3) throw new Error(\"controlled_provider_stage_invalid\");",
    `await invokeControlledJourneyControl({ controlFile: ${JSON.stringify(controlFilePath)}, action: "provider-stage", stage });`,
    "",
  ].join("\n");
}

async function writeExecutable(file, source) {
  await writeFile(file, source, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function writePrivateJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function spawnTracked(command, args, options, children) {
  const child = spawn(command, args, { shell: false, ...options });
  children.push(child);
  return child;
}

function waitForReadyLine(child, expectedType, timeoutMs, stderr) {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error("controlled_journey_child_stdio_missing"));
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("controlled_journey_service_start_timeout")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const onData = (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let value;
        try { value = JSON.parse(line); } catch { value = undefined; }
        if (value?.type === expectedType) return finish(undefined, value);
        if (line.trim()) stderr.write(`${line}\n`);
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`controlled_journey_service_exited:${code ?? signal ?? "unknown"}`));
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.once("error", onError);
    child.once("exit", onExit);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    }
  });
}

async function spawnExit(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`controlled_journey_build_failed:${code ?? signal ?? "unknown"}`));
    });
  });
}

function reserveLoopbackPort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopbackHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port)) reject(new Error("controlled_journey_port_reservation_failed"));
        else resolve(port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("controlled_journey_browser_start_timeout");
}

async function waitForReadyHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error" });
      const value = response.ok ? await response.json() : undefined;
      if (value?.ready === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("controlled_journey_host_health_timeout");
}

async function stopChildren(children) {
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  })));
}

function secret() {
  return randomBytes(32).toString("base64url");
}

function validPort(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(code);
  return value;
}

function normalizeCellMode(value) {
  if (typeof value !== "string" || !controlledCellModes.includes(value)) {
    throw new Error("controlled_journey_cell_mode_invalid");
  }
  return value;
}

function requiredAbsolute(value, code) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

async function readPrivateExpectedLineage(value) {
  const file = requiredAbsolute(value, "controlled_journey_lineage_file_absolute_required");
  const metadata = await stat(file);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("controlled_journey_lineage_file_invalid");
  }
  try {
    return normalizeExpectedLineage(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("controlled_journey_expected_lineage")) throw error;
    throw new Error("controlled_journey_lineage_file_invalid");
  }
}

function defaultExpectedLineage() {
  const suffix = randomBytes(12).toString("hex");
  return normalizeExpectedLineage({
    runtimeInstanceId: `runtime_instance_${suffix}`,
  });
}

function normalizeExpectedLineage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled_journey_expected_lineage_invalid");
  }
  if (Object.keys(value).length !== 1 || Object.keys(value)[0] !== "runtimeInstanceId") {
    throw new Error("controlled_journey_expected_lineage_invalid");
  }
  return Object.freeze({
    runtimeInstanceId: expectedId(value.runtimeInstanceId, "runtime_instance"),
  });
}

function expectedId(value, prefix) {
  if (typeof value !== "string" || value.length > 128
    || !new RegExp(`^${prefix}_[A-Za-z0-9-]+$`).test(value)) {
    throw new Error("controlled_journey_expected_lineage_invalid");
  }
  return value;
}

function parseCli(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--skip-build") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) throw new Error("controlled_journey_launcher_usage");
    values.set(name, value);
    index += 1;
  }
  if ([...values.keys()].some((key) => ![
    "--manifest", "--state-root", "--browser-port", "--lineage", "--cell-mode",
  ].includes(key))) {
    throw new Error("controlled_journey_launcher_usage");
  }
  return Object.freeze({
    manifestPath: values.get("--manifest"),
    ...(values.has("--state-root") ? { stateRoot: values.get("--state-root") } : {}),
    ...(values.has("--browser-port") ? { browserPort: Number(values.get("--browser-port")) } : {}),
    ...(values.has("--lineage")
      ? { lineageFile: values.get("--lineage") }
      : {}),
    cellMode: normalizeCellMode(values.get("--cell-mode") ?? "main"),
    buildWorkbench: !flags.has("--skip-build"),
  });
}

function isEntryModule() {
  return typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntryModule()) {
  let launched;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void launched?.close().finally(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  void launchControlledJourney(parseCli(process.argv.slice(2))).then((value) => {
    launched = value;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
