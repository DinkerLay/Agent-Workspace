const childProcess = require("node:child_process");
const pty = require("node-pty");
const { createOrcaTerminalDaemon } = require("./orca-terminal-daemon.cjs");

async function main() {
  const daemon = createOrcaTerminalDaemon({ pty, spawn: childProcess.spawn });
  const endpoint = await daemon.listen();
  notify({ type: "terminal-daemon-ready", endpoint });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.on("message", (message) => {
    if (message?.type === "terminal-daemon-stop") void stop();
  });
}

function notify(message) {
  if (typeof process.send === "function") process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

void main().catch((error) => {
  notify({ type: "terminal-daemon-failed", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
