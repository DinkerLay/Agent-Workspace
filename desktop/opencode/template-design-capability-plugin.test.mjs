import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE,
  ensureTemplateDesignCapabilityPluginConfig,
  templateDesignCapabilityPluginSource,
} = require("./template-design-capability-plugin.cjs");

test("Template Design capability plugin exposes public schemas and binds bridge calls from the current provider Session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-template-plugin-"));
  const pluginFile = path.join(root, "plugin.mjs");
  const source = templateDesignCapabilityPluginSource();
  fs.writeFileSync(pluginFile, source, "utf8");
  assert.doesNotMatch(source, /capabilitySecret/);
  assert.doesNotMatch(source, /\/binding\/session/);

  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL;
  const previousToken = process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN;
  const calls = [];
  try {
    process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL = "http://127.0.0.1:44110";
    process.env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN = "host-loopback-token";
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ bound: true }) };
    };
    const plugin = await import(`${pathToFileURL(pluginFile).href}?v=${Date.now()}`);
    const hooks = await plugin.AgentWorkspaceTemplateDesignerCapability();
    const system = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_design_a" }, system);
    assert.match(system.system.join("\n"), /Session-bound Template Design Draft/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:44110/binding/status");
    assert.equal(calls[0].init.headers.authorization, "Bearer host-loopback-token");

    assert.equal(hooks["tool.execute.before"], undefined);
    assert.deepEqual(hooks.tool.agent_workspace_template_designer_read_draft.args, {});
    assert.deepEqual(Object.keys(hooks.tool.agent_workspace_template_designer_apply_patch.args), ["expectedRevision", "operationId", "patch"]);
    assert.doesNotMatch(JSON.stringify(hooks.tool), /providerSessionId|capabilitySecret/);

    const context = { sessionID: "ses_design_a" };
    const draft = await hooks.tool.agent_workspace_template_designer_read_draft.execute({}, context);
    assert.deepEqual(JSON.parse(draft), { bound: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "http://127.0.0.1:44110/tools/read_draft");
    assert.deepEqual(JSON.parse(calls[1].init.body), { providerSessionId: "ses_design_a" });

    const patch = await hooks.tool.agent_workspace_template_designer_apply_patch.execute({
      expectedRevision: 4,
      operationId: "operation_5",
      patch: [{ op: "replace", path: "/name", value: "DeepSearch supply chain" }],
      providerSessionId: "ses_untrusted_model_value",
    }, context);
    assert.deepEqual(JSON.parse(patch), { bound: true });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, "http://127.0.0.1:44110/tools/apply_patch");
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      expectedRevision: 4,
      operationId: "operation_5",
      patch: [{ op: "replace", path: "/name", value: "DeepSearch supply chain" }],
      providerSessionId: "ses_design_a",
    });
    await assert.rejects(
      () => hooks.tool.agent_workspace_template_designer_read_draft.execute({}, { sessionID: "" }),
      /template_design_session_binding_unavailable/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL", previousUrl);
    restoreEnvironment("AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN", previousToken);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Template Design plugin config is stable per project and overlays a user config without copying it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-template-plugin-config-"));
  const userConfig = path.join(root, "user-config");
  fs.mkdirSync(path.join(userConfig, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(userConfig, "opencode.json"), JSON.stringify({ theme: "system" }), "utf8");
  fs.writeFileSync(path.join(userConfig, "plugins", "user-plugin.js"), "export const UserPlugin = async () => ({});\n", "utf8");
  try {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const first = ensureTemplateDesignCapabilityPluginConfig({ cwd, configuredRoot: userConfig });
    const second = ensureTemplateDesignCapabilityPluginConfig({ cwd, configuredRoot: userConfig });
    assert.equal(first, second);
    assert.equal(fs.readFileSync(path.join(first, "plugins", TEMPLATE_DESIGN_CAPABILITY_PLUGIN_FILE), "utf8"), templateDesignCapabilityPluginSource());
    assert.equal(fs.lstatSync(path.join(first, "opencode.json")).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(first, "plugins", "user-plugin.js")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
