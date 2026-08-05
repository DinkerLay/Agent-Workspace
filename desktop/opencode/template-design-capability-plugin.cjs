const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE = "agent-workspace-template-design-capability.js";

/**
 * Creates the app-owned OpenCode config overlay that installs the Template
 * Design capability plugin. The overlay is stable for one canonical project
 * root, so every owner sharing that Host supplies the same configuration.
 *
 * This is deliberately a Host configuration concern rather than a renderer
 * setting. The generated plugin receives its transport credentials through
 * the server process environment; neither the Template Draft projection nor
 * the official OpenCode WebUI receive them.
 */
function ensureTemplateDesignCapabilityPluginConfig({ cwd, configuredRoot = process.env.OPENCODE_CONFIG_DIR } = {}) {
  const root = canonicalProjectRoot(cwd);
  const runtimeRoot = path.join(root, ".agent-workspace", "runtime", "opencode-template-design");
  const configured = String(configuredRoot ?? "").trim();
  const configDir = configured && isDirectory(configured)
    ? ensureConfigOverlay({ runtimeRoot, sourceDir: path.resolve(configured) })
    : path.join(runtimeRoot, "shared");
  const pluginsDir = path.join(configDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE), templateDesignCapabilityPluginSource(), "utf8");
  return configDir;
}

function ensureConfigOverlay({ runtimeRoot, sourceDir }) {
  const digest = crypto.createHash("sha256").update(sourceDir).digest("hex").slice(0, 24);
  const overlayDir = path.join(runtimeRoot, "overlays", digest);
  fs.mkdirSync(overlayDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "plugins") continue;
    mirrorEntry(path.join(sourceDir, entry.name), path.join(overlayDir, entry.name));
  }
  const sourcePlugins = path.join(sourceDir, "plugins");
  const overlayPlugins = path.join(overlayDir, "plugins");
  fs.mkdirSync(overlayPlugins, { recursive: true });
  if (isDirectory(sourcePlugins)) {
    for (const entry of fs.readdirSync(sourcePlugins, { withFileTypes: true })) {
      if (entry.name === TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE) continue;
      mirrorEntry(path.join(sourcePlugins, entry.name), path.join(overlayPlugins, entry.name));
    }
  }
  return overlayDir;
}

function mirrorEntry(source, target) {
  if (fs.existsSync(target)) return;
  try {
    fs.symlinkSync(source, target, fs.lstatSync(source).isDirectory() ? "dir" : "file");
  } catch {
    // The custom plugin remains usable if a user config entry cannot be
    // mirrored. Do not copy an arbitrary config tree or credential material.
  }
}

/**
 * Source is emitted as an ESM OpenCode plugin because the provider discovers
 * plugins from `OPENCODE_CONFIG_DIR/plugins`. Keep the capability entirely
 * inside this process: model-visible schemas omit the private binding, while
 * custom-tool execution receives the authoritative OpenCode Session id in
 * its provider context. The bridge resolves the durable Draft capability
 * server-side.
 *
 * Do not route these tools through an external MCP child. OpenCode v1.18.13
 * invokes `tool.execute.before`, but executes MCP calls with the original
 * argument object after that hook; mutations to `output.args` do not reach
 * the MCP child. A custom plugin tool is the supported execution boundary
 * that carries `context.sessionID` without making it a model-visible field.
 */
function templateDesignCapabilityPluginSource() {
  return [
    "const bridgeUrl = process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL;",
    "const bridgeToken = process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN;",
    "function usableSessionID(value) { return typeof value === 'string' && value.trim().length > 0; }",
    "function bridgeEndpoint(pathname) {",
    "  if (!bridgeUrl || !bridgeToken) return undefined;",
    "  let url; try { url = new URL(bridgeUrl); } catch { return undefined; }",
    "  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) return undefined;",
    "  url.pathname = pathname; return url.toString();",
    "}",
    "async function sessionIsBound(sessionID) {",
    "  const endpoint = bridgeEndpoint('/binding/status');",
    "  if (!endpoint || !usableSessionID(sessionID)) return false;",
    "  try {",
    "    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridgeToken}` }, body: JSON.stringify({ providerSessionId: sessionID }) });",
    "    if (!response.ok) return false; const body = await response.json(); return body?.bound === true;",
    "  } catch { return false; }",
    "}",
    "function publicArguments(value) {",
    "  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};",
    "}",
    "async function callBoundTool(name, args, context) {",
    "  const endpoint = bridgeEndpoint(`/tools/${encodeURIComponent(name)}`);",
    "  const sessionID = context?.sessionID;",
    "  if (!endpoint) throw new Error('template_design_tool_bridge_unavailable');",
    "  if (!usableSessionID(sessionID)) throw new Error('template_design_session_binding_unavailable');",
    "  let response;",
    "  try {",
    "    response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridgeToken}` }, body: JSON.stringify({ ...publicArguments(args), providerSessionId: sessionID }), signal: context?.abort });",
    "  } catch (error) {",
    "    if (error?.name === 'AbortError') throw error;",
    "    throw new Error('template_design_tool_bridge_unavailable');",
    "  }",
    "  const body = await response.json().catch(() => ({}));",
    "  if (!response.ok) throw new Error(String(body?.error || `template_design_tool_bridge_http_${response.status}`));",
    "  return JSON.stringify(body);",
    "}",
    "const applyPatchArgs = {",
    "  expectedRevision: { type: 'integer', minimum: 0 },",
    "  operationId: { type: 'string', minLength: 1 },",
    "  patch: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: ['add', 'replace', 'remove'] }, path: { type: 'string', minLength: 2 }, value: {} }, required: ['op', 'path'] } },",
    "};",
    "export const AgentWorkspaceTemplateDesignerCapability = async () => ({",
    "  'experimental.chat.system.transform': async (input, output) => {",
    "    if (!await sessionIsBound(input?.sessionID)) return;",
    "    output.system.push('This is a Session-bound Template Design Draft. Use read_draft before changes; the Host binds every Template Designer tool call to this Session Draft. The Draft is mutable, but a Card must always use one explicit contract. A new Draft may have an empty agents array. For every new or replaced prompt-split Card, submit the complete object in one patch operation: { id, name, kind: researcher|reviewer|publisher|general, model, mcp: [], skills: [], dispatchProfile: { title, description }, workerSystemPrompt }. Use the Draft model for model unless the user deliberately selects another available model. dispatchProfile is only Conductor context: put the dispatch trigger, required inputs, acceptance criteria, expected artifacts, limits, and any detailed routing guidance together in its free-form description. workerSystemPrompt is only the Worker system prompt. Do not use systemPrompt, role, instructions, expectedOutput, or nested dispatchProfile fields on a prompt-split Card. Read the revision immediately before applying a patch. If a patch is rejected, read the Draft again and send a corrected complete patch; do not claim it was applied.');",
    "  },",
    "  tool: {",
    "    agent_workspace_template_designer_read_draft: {",
    "      description: 'Read the editable Template Design Draft bound to this OpenCode Session. It is not a saved Template Version and it never creates a Task.',",
    "      args: {},",
    "      execute: async (_args, context) => callBoundTool('read_draft', {}, context),",
    "    },",
    "    agent_workspace_template_designer_apply_patch: {",
    "      description: 'Apply one reviewed JSON Patch to the editable Template Design Draft bound to this OpenCode Session. Supply the revision returned by read_draft and a new operationId. This tool cannot save a Template Version or create a Task.',",
    "      args: applyPatchArgs,",
    "      execute: async (args, context) => callBoundTool('apply_patch', args, context),",
    "    },",
    "  },",
    "});",
    "",
  ].join("\n");
}

function canonicalProjectRoot(cwd) {
  const resolved = path.resolve(requiredString(cwd, "opencode_template_design_plugin_cwd_required"));
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(resolved);
  } catch {
    return resolved;
  }
}

function requiredString(value, reason) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(reason);
  return text;
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE,
  ensureTemplateDesignCapabilityPluginConfig,
  templateDesignCapabilityPluginSource,
};
