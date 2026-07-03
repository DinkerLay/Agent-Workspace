const fs = require("node:fs");
const path = require("node:path");

function resolveNodePtySpawnHelperPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform === "win32") return undefined;

  const packageJsonPath = options.packageJsonPath ?? require.resolve("node-pty/package.json");
  return path.join(path.dirname(packageJsonPath), "prebuilds", `${platform}-${arch}`, "spawn-helper");
}

function ensureNodePtySpawnHelperExecutable(options = {}) {
  const fsApi = options.fs ?? fs;
  const helperPath = options.helperPath ?? resolveNodePtySpawnHelperPath(options);
  if (!helperPath) {
    return { helperPath, changed: false };
  }

  const stats = fsApi.statSync(helperPath);
  if ((stats.mode & 0o111) !== 0) {
    return { helperPath, changed: false };
  }

  fsApi.chmodSync(helperPath, stats.mode | 0o111);
  return { helperPath, changed: true };
}

module.exports = {
  ensureNodePtySpawnHelperExecutable,
  resolveNodePtySpawnHelperPath,
};
