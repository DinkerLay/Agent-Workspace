const path = require("node:path");

function resolveProjectWindowContext({ projectPath = process.cwd(), projectName } = {}) {
  const resolvedPath = path.resolve(String(projectPath));
  return {
    projectPath: resolvedPath,
    projectName: String(projectName || path.basename(resolvedPath) || "Agent Workspace"),
  };
}

function withProjectWindowContext(input, context = resolveProjectWindowContext()) {
  const url = new URL(input);
  if (!url.searchParams.has("projectPath")) url.searchParams.set("projectPath", context.projectPath);
  if (!url.searchParams.has("projectName")) url.searchParams.set("projectName", context.projectName);
  return url.toString();
}

module.exports = { resolveProjectWindowContext, withProjectWindowContext };
