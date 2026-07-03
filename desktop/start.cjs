const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const electronBinary = resolveElectronBinary();
const child = spawn(electronBinary, ["desktop/main.cjs"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});

function resolveElectronBinary() {
  const candidates = [
    process.env.ELECTRON_BINARY,
    path.join(process.cwd(), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    path.join(process.cwd(), "node_modules/.bin/electron"),
    "electron",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    if (!candidate.includes("/")) return candidate;
  }

  throw new Error("Electron binary not found. Set ELECTRON_BINARY or install the electron package.");
}
