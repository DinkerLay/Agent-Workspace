const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolves local project directories for the Task-creation boundary.
 *
 * This service deliberately does not create a Task or write Runtime state.
 * It only validates a user-selected project root and can create one direct
 * child beneath an already validated parent.  The Task/Run service remains
 * the sole owner of the Task snapshot that later uses this cwd.
 */
function createAgentLoopProjectDirectoryService({ homePath = () => process.env.HOME ?? "" } = {}) {
  const expandPath = (value) => {
    const source = String(value ?? "").trim();
    const home = String(homePath() ?? "").trim();
    if (source === "~") return home;
    if ((source.startsWith("~/") || source.startsWith("~\\")) && home) return path.join(home, source.slice(2));
    return source;
  };

  const validate = async ({ path: inputPath } = {}) => {
    const value = String(inputPath ?? "").trim();
    if (!value) throw new Error("请输入项目文件夹路径。");
    const cwd = path.resolve(expandPath(value));
    let stat;
    try {
      stat = await fs.promises.stat(cwd);
    } catch {
      throw new Error("项目文件夹不存在或无法访问。");
    }
    if (!stat.isDirectory()) throw new Error("项目路径不是文件夹。");
    return { path: cwd, name: path.basename(cwd) || cwd };
  };

  const suggest = async ({ prefix } = {}) => {
    const value = String(prefix ?? "").trim();
    if (!value) return [];
    const expanded = expandPath(value);
    const resolved = path.resolve(expanded);
    const hasTrailingSeparator = /[\\/]$/.test(value);
    const openedDirectory = hasTrailingSeparator && await isDirectory(resolved);
    const partialPath = hasTrailingSeparator && !openedDirectory
      ? (expanded.replace(/[\\/]+$/, "") || path.parse(resolved).root)
      : resolved;
    const parent = openedDirectory ? resolved : path.dirname(partialPath);
    const entryPrefix = openedDirectory ? "" : path.basename(partialPath).toLocaleLowerCase();
    try {
      const entries = await fs.promises.readdir(parent, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.toLocaleLowerCase().startsWith(entryPrefix))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 40)
        .map((entry) => `${path.join(parent, entry.name)}${path.sep}`);
    } catch {
      return [];
    }
  };

  const createChild = async ({ parentPath, name } = {}) => {
    const parent = await validate({ path: parentPath });
    const childName = assertDirectChildName(name);
    const target = path.resolve(parent.path, childName);
    if (path.dirname(target) !== parent.path) throw new Error("新项目文件夹必须是所选父目录的直接子目录。");
    try {
      await fs.promises.mkdir(target);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new Error("该项目文件夹已存在；请直接选择并确认它。");
      }
      throw new Error(`无法创建项目文件夹：${error instanceof Error ? error.message : "未知错误"}`);
    }
    return { ...(await validate({ path: target })), created: true };
  };

  return Object.freeze({ validate, suggest, createChild });
}

function assertDirectChildName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("请输入新项目文件夹名称。");
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("新项目文件夹名称只能是一个直接子目录名。");
  }
  return name;
}

async function isDirectory(candidate) {
  try {
    return (await fs.promises.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { createAgentLoopProjectDirectoryService };
