const childProcess = require("node:child_process");
const path = require("node:path");

/** Starts/stops the isolated local terminal daemon; it never owns a PTY. */
function createOrcaTerminalDaemonSupervisor({
  childPath = path.join(__dirname, "orca-terminal-daemon-child.cjs"),
  cwd = path.resolve(__dirname, "..", ".."),
  fork = childProcess.fork,
  startupTimeoutMs = 8_000,
} = {}) {
  let child;
  let startPromise;
  let stopped = false;

  function start() {
    if (stopped) return Promise.reject(new Error("terminal_daemon_supervisor_stopped"));
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      child = fork(childPath, [], { cwd, silent: true });
      const timeout = setTimeout(() => fail(new Error("terminal_daemon_start_timeout")), startupTimeoutMs);
      const onMessage = (message) => {
        if (message?.type === "terminal-daemon-ready") succeed(message.endpoint);
        else if (message?.type === "terminal-daemon-failed") fail(new Error(message.error ?? "terminal_daemon_start_failed"));
      };
      const onExit = (code, signal) => fail(new Error(`terminal_daemon_exited_before_ready:${code ?? signal ?? "unknown"}`));
      const succeed = (endpoint) => {
        clearTimeout(timeout);
        child?.off("message", onMessage);
        child?.off("exit", onExit);
        resolve(endpoint);
      };
      const fail = (error) => {
        clearTimeout(timeout);
        child?.off("message", onMessage);
        child?.off("exit", onExit);
        startPromise = undefined;
        if (child?.exitCode === null && !child?.killed) child.kill("SIGTERM");
        reject(error);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", fail);
    });
    return startPromise;
  }

  async function stop() {
    stopped = true;
    const current = child;
    if (!current || current.exitCode !== null || current.killed) return;
    await new Promise((resolve) => {
      const force = setTimeout(() => current.kill("SIGKILL"), 2_000);
      current.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      current.send?.({ type: "terminal-daemon-stop" });
    });
  }

  return { start, stop, get child() { return child; } };
}

module.exports = { createOrcaTerminalDaemonSupervisor };
