const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const defaultCandidates = [
  process.env.OPENCODE_PATH,
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  "opencode",
].filter(Boolean);

function getRuntimeStatus({
  ptyAvailable = false,
  ptyBackend,
  conductorToolBridgeUrl,
  conductorToolBridgeToken,
  conductorMcpServerPath,
} = {}) {
  const opencodePath = resolveOpencodePath();
  const bridgeStatus = {
    conductorToolBridgeUrl,
    conductorToolBridgeToken,
    conductorMcpServerPath,
  };
  if (!opencodePath) {
    return {
      available: false,
      mode: "desktop",
      ptyAvailable,
      ptyBackend,
      ...bridgeStatus,
      message: "桌面壳已启动，但没有找到本地 opencode。",
    };
  }

  try {
    const version = execFileSync(opencodePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    return {
      available: true,
      mode: "desktop",
      ptyAvailable,
      ptyBackend,
      ...bridgeStatus,
      opencodePath,
      opencodeVersion: version,
      message: ptyAvailable ? "opencode 与 PTY runtime 已可用。" : "opencode 可用；PTY runtime 依赖未加载。",
    };
  } catch (error) {
    return {
      available: false,
      mode: "desktop",
      ptyAvailable,
      ptyBackend,
      ...bridgeStatus,
      opencodePath,
      message: error instanceof Error ? error.message : "opencode version check failed",
    };
  }
}

function resolveOpencodePath(candidates = defaultCandidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    if (!candidate.includes("/") && commandExists(candidate)) return candidate;
  }
  return undefined;
}

function commandExists(command) {
  try {
    execFileSync("/bin/sh", ["-lc", `command -v ${shellEscape(command)}`], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function buildOpencodeRunArgs(message, options = {}) {
  const args = ["run", "--format", "json"];
  const model = options.model?.trim();
  if (model) args.push("--model", model);
  args.push(message);
  return args;
}

function listOpencodeAgents(dependencies = {}) {
  const resolvePath = dependencies.resolveOpencodePath ?? resolveOpencodePath;
  const exec = dependencies.execFileSync ?? execFileSync;
  const opencodePath = resolvePath();

  if (!opencodePath) {
    return {
      ok: false,
      agents: [],
      stderr: "No local opencode binary found.",
    };
  }

  try {
    const stdout = exec(opencodePath, ["agent", "list"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return {
      ok: true,
      agents: parseOpencodeAgentList(stdout),
      stdout,
    };
  } catch (error) {
    return {
      ok: false,
      agents: [],
      stderr: error instanceof Error ? error.message : "opencode agent list failed",
    };
  }
}

function runOpencode(input, dependencies = {}) {
  const resolvePath = dependencies.resolveOpencodePath ?? resolveOpencodePath;
  const spawnProcess = dependencies.spawn ?? spawn;
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const opencodePath = resolvePath();
  const startedAt = Date.now();
  const cwd = input.cwd;
  const message = input.message?.trim();
  const model = input.model?.trim();

  if (!opencodePath) {
    return Promise.resolve(failedResult({ cwd, message: "No local opencode binary found.", startedAt }));
  }
  if (!cwd || !existsSync(cwd)) {
    return Promise.resolve(failedResult({ cwd, message: `Working directory does not exist: ${cwd}`, startedAt }));
  }
  if (!message) {
    return Promise.resolve(failedResult({ cwd, message: "opencode message is required.", startedAt }));
  }

  const args = buildOpencodeRunArgs(message, { model });
  const command = formatOpencodeCommand(opencodePath, args);

  return new Promise((resolve) => {
    const child = spawnProcess(opencodePath, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          resolve({
            ok: false,
            command,
            cwd,
            stdout: "",
            stderr: appendDiagnostic(stderr, `opencode run timed out after ${timeoutMs}ms`),
            exitCode: null,
            durationMs: Date.now() - startedAt,
            error: "timeout",
            model,
          });
        }, timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        command,
        cwd,
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        error: error.message,
        model,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        command,
        cwd,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        model,
      });
    });
  });
}

function failedResult({ cwd, message, startedAt }) {
  return {
    ok: false,
    command: "opencode run --format json",
    cwd,
    stdout: "",
    stderr: message,
    exitCode: null,
    durationMs: Date.now() - startedAt,
    error: message,
  };
}

function formatOpencodeCommand(opencodePath, args) {
  const visibleArgs = args.slice(0, 3);
  const modelIndex = args.indexOf("--model");
  if (modelIndex !== -1) visibleArgs.push("--model", args[modelIndex + 1]);
  return `${opencodePath} ${visibleArgs.join(" ")}`;
}

function appendDiagnostic(stderr, message) {
  return [stderr.trimEnd(), message].filter(Boolean).join("\n");
}

function parseOpencodeAgentList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-zA-Z0-9_-]+)\s+\(([^)]+)\)/))
    .filter(Boolean)
    .map((match) => ({
      name: match[1],
      kind: match[2],
    }));
}

function shellEscape(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

module.exports = {
  buildOpencodeRunArgs,
  formatOpencodeCommand,
  getRuntimeStatus,
  listOpencodeAgents,
  parseOpencodeAgentList,
  resolveOpencodePath,
  runOpencode,
};
