#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(root, "tests", "journeys", "release-cell-worker.ts");
const expected = process.env.AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256?.replace(/^sha256:/u, "");
const TERMINATION_GRACE_MS = 3_000;

if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) {
  process.stderr.write("release cell worker digest is missing or invalid\n");
  process.exitCode = 2;
} else {
  const status = await lstat(worker);
  if (!status.isFile() || status.isSymbolicLink()) {
    process.stderr.write("release cell worker is not a regular repository file\n");
    process.exitCode = 2;
  } else {
    const actual = createHash("sha256").update(await readFile(worker)).digest("hex");
    if (actual !== expected) {
      process.stderr.write(`release cell worker digest mismatch (observed sha256:${actual})\n`);
      process.exitCode = 2;
    } else {
      const child = spawn(process.execPath, ["--import", "tsx", worker, ...process.argv.slice(2)], {
        cwd: root,
        env: process.env,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached: process.platform !== "win32",
      });
      const ownedProcessTrees = new Set(child.pid ? [child.pid] : []);
      announceProcessTree(child.pid, "started");
      let shutdownRequested = false;
      let settled = false;
      let hardStop;
      const requestShutdown = () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        if (process.platform === "win32" && child.connected) {
          try { child.send({ type: "release_cell_shutdown" }); } catch { /* hard stop follows */ }
        } else {
          try { child.kill("SIGTERM"); } catch { /* hard stop follows */ }
        }
        hardStop = setTimeout(() => {
          void hardStopOwnedProcessTrees(ownedProcessTrees).finally(() => finishExecutor(1));
        }, TERMINATION_GRACE_MS);
      };
      const onMessage = (message) => {
        if (isShutdownMessage(message)) requestShutdown();
      };
      process.once("SIGTERM", requestShutdown);
      process.once("SIGINT", requestShutdown);
      process.on("message", onMessage);
      child.on("message", (message) => {
        const observed = processTreeMessage(message);
        if (!observed) return;
        if (observed.state === "started") ownedProcessTrees.add(observed.pid);
        else ownedProcessTrees.delete(observed.pid);
        announceProcessTree(observed.pid, observed.state);
      });
      child.once("error", () => {
        process.stderr.write("release cell worker spawn failed\n");
        void hardStopOwnedProcessTrees(ownedProcessTrees).finally(() => finishExecutor(1));
      });
      child.once("exit", (code, signal) => {
        void hardStopOwnedProcessTrees(ownedProcessTrees)
          .finally(() => finishExecutor(signal ? 1 : (code ?? 1)));
      });

      function finishExecutor(exitCode) {
        if (settled) return;
        settled = true;
        if (hardStop) clearTimeout(hardStop);
        announceProcessTree(child.pid, "stopped");
        process.removeListener("SIGTERM", requestShutdown);
        process.removeListener("SIGINT", requestShutdown);
        process.removeListener("message", onMessage);
        process.exitCode = exitCode;
        if (process.connected) process.disconnect();
      }
    }
  }
}

function isShutdownMessage(message) {
  return message && typeof message === "object" && !Array.isArray(message)
    && Object.keys(message).length === 1
    && message.type === "release_cell_shutdown";
}

function processTreeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  if (Object.keys(message).sort().join(",") !== "pid,state,type"
    || message.type !== "release_cell_process_tree"
    || (message.state !== "started" && message.state !== "stopped")
    || !Number.isSafeInteger(message.pid) || message.pid < 1) return undefined;
  return Object.freeze({ state: message.state, pid: message.pid });
}

function announceProcessTree(pid, state) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof process.send !== "function") return;
  try { process.send(Object.freeze({ type: "release_cell_process_tree", state, pid })); } catch { /* parent fallback remains */ }
}

async function hardStopOwnedProcessTrees(owned) {
  await Promise.all([...owned].reverse().map((pid) => hardKillProcessTree(pid)));
}

async function hardKillProcessTree(pid) {
  if (process.platform === "win32") {
    await taskkillBounded(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function taskkillBounded(pid) {
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(executable, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    let settled = false;
    const timer = setTimeout(finish, 2_000);
    killer.once("exit", finish);
    killer.once("error", finish);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { killer.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }
  });
}
