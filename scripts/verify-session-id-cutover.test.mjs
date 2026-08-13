import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySessionIdCutover } from "./verify-session-id-cutover.mjs";

test("cutover gate accepts only a Session-ID production import graph", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  });
});

test("cutover gate rejects a reachable legacy route and a fresh legacy table", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "packages/conductor-tools/src/tools.ts", 'export const names = ["invoke_agent", "send_to_session", "interrupt_session", "close_session", "session.publish_message"];');
    fixtureFile(root, "packages/runtime-store/src/sqlite.ts", "const schema = 'CREATE TABLE artifacts(id TEXT)';");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_protocol_token" && entry.token === "session.publish_message"));
    assert(result.issues.some((entry) => entry.code === "legacy_table_in_fresh_schema" && entry.token === "artifacts"));
  });
});

test("cutover gate rejects direct Provider packages and a direct Provider production import", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "apps/runtime-host/src/index.ts",
      'import "@agent-workspace/provider-opencode"; export * from "./session-id-unified-runtime-bridge.js";',
    );
    fixtureFile(root, "packages/provider-opencode/src/index.ts", "export const directOpenCode = true;");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_direct_provider_path"
      && entry.file === "packages/provider-opencode"));
    assert(result.issues.some((entry) => entry.code === "forbidden_direct_provider_import"
      && entry.file === "apps/runtime-host/src/index.ts"
      && entry.token === "@agent-workspace/provider-opencode"));
  });
});

test("cutover gate requires the ACP client and Host ACP compositions in the production graph", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "apps/runtime-host/src/index.ts",
      'import "@agent-workspace/conductor-tools"; export * from "./session-id-unified-runtime-bridge.js";',
    );

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    for (const required of [
      "packages/provider-acp/src/index.ts",
      "apps/runtime-host/src/acp-provider-composition.ts",
      "apps/runtime-host/src/acp-meta-provider-composition.ts",
      "apps/runtime-host/src/acp-task-session-runtime-provider.ts",
      "apps/runtime-host/src/acp-runtime-host-private-authority.ts",
    ]) {
      assert(result.issues.some((entry) => entry.code === "required_acp_production_path_unreachable"
        && entry.file === required));
    }
  });
});

test("cutover gate does not accept an empty reachable ACP placeholder", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "apps/runtime-host/src/acp-task-session-runtime-provider.ts", "export const placeholder = true;");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "required_cutover_symbol_unreachable"
      && entry.file === "production-import-graph"
      && entry.token === "createAcpTaskSessionRuntimeProvider"));
  });
});

test("cutover gate rejects a hidden direct Provider selector or fallback outside the deleted composition", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "packages/runtime-application/src/hidden-provider-fallback.ts",
      'export const hidden = ["opencode-server", "loadRuntimeProviderPortsFromEnvironment"];',
    );

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_direct_provider_token"
      && entry.file === "packages/runtime-application/src/hidden-provider-fallback.ts"
      && entry.token === "opencode-server"));
    assert(result.issues.some((entry) => entry.code === "forbidden_direct_provider_token"
      && entry.file === "packages/runtime-application/src/hidden-provider-fallback.ts"
      && entry.token === "loadRuntimeProviderPortsFromEnvironment"));
  });
});

test("cutover gate rejects a conductor-forward compatibility projection to the legacy relay kind", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "packages/runtime-application/src/session-id-configuration-task-lifecycle.ts",
      `${retentionCommands()}\nexport const compatibility = { conductor_forward: "relay_forward" };`,
    );

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_protocol_token" && entry.token === "relay_forward"));
  });
});

test("cutover gate rejects a missing retention lifecycle capability in one cutover layer", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "apps/runtime-host/src/session-id-unified-runtime-bridge.ts",
      `import "@agent-workspace/runtime-application";\nexport const createSessionIdUnifiedRuntimeBridgeServer = true;\n${retentionCommands(["task.permanently_delete"])}`,
    );

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "required_lifecycle_command_missing"
      && entry.file === "apps/runtime-host/src/session-id-unified-runtime-bridge.ts"
      && entry.token === "task.permanently_delete"));
  });
});

test("cutover gate rejects a missing Template Library capability in one cutover layer", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(
      root,
      "packages/workbench-ui/src/agent-loop/agent-loop-session-id-configuration-controller.ts",
      templateCommands(["template.export"]),
    );

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "required_template_command_missing"
      && entry.file === "packages/workbench-ui/src/agent-loop/agent-loop-session-id-configuration-controller.ts"
      && entry.token === "template.export"));
  });
});

test("cutover gate rejects any candidate-named path under apps", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "apps/workbench/session-id-candidate/main.tsx", "export const candidate = true;");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_candidate_app_path"
      && entry.file === "apps/workbench/session-id-candidate"));
  });
});

test("cutover gate rejects the superseded generic Session-ID bridge path", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "apps/runtime-host/src/session-id-runtime-bridge.ts", "export const oldBridge = true;");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_superseded_app_path"
      && entry.file === "apps/runtime-host/src/session-id-runtime-bridge.ts"));
  });
});

test("cutover gate rejects superseded Desktop generic bridge paths and protocol tokens", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "apps/desktop/runtime-host-client.cjs", 'const route = "/runtime/read";');
    fixtureFile(root, "apps/desktop/legacy-runtime-channel.cjs", 'const channel = "agent-workspace:runtime:command";');

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_superseded_app_path"
      && entry.file === "apps/desktop/runtime-host-client.cjs"));
    assert(result.issues.some((entry) => entry.code === "forbidden_protocol_token"
      && entry.file === "apps/desktop/runtime-host-client.cjs"
      && entry.token === '"/runtime/read"'));
    assert(result.issues.some((entry) => entry.code === "forbidden_protocol_token"
      && entry.file === "apps/desktop/legacy-runtime-channel.cjs"
      && entry.token === "agent-workspace:runtime:"));
  });
});

test("cutover gate rejects release launchers that restore a candidate entry or expected Task injection", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "scripts/launch-controlled-journey.mjs", [
      'const config = "vite.session-id-candidate.config.ts";',
      'const build = ["dist", "workbench", "index.html"];',
      'const main = ["apps", "desktop", "main.cjs"];',
      'const expected = "AGENT_WORKSPACE_EXPECTED_TASK_ID";',
    ].join("\n"));

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "release_production_entry_required_token_missing"
      && entry.file === "scripts/launch-controlled-journey.mjs"
      && entry.token === "vite.runtime.config.ts"));
    assert(result.issues.some((entry) => entry.code === "release_candidate_entry_token_forbidden"
      && entry.file === "scripts/launch-controlled-journey.mjs"
      && entry.token === "vite.session-id-candidate"));
    assert(result.issues.some((entry) => entry.code === "release_candidate_entry_token_forbidden"
      && entry.file === "scripts/launch-controlled-journey.mjs"
      && entry.token === "AGENT_WORKSPACE_EXPECTED_TASK_ID"));
  });
});

test("cutover gate rejects a cell worker that does not pin the production build and Electron main", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "tests/journeys/release-cell-worker.ts", "export const worker = true;");

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "release_production_entry_required_token_missing"
      && entry.file === "tests/journeys/release-cell-worker.ts"
      && entry.token === '"dist", "workbench", "index.html"'));
    assert(result.issues.some((entry) => entry.code === "release_production_entry_required_token_missing"
      && entry.file === "tests/journeys/release-cell-worker.ts"
      && entry.token === '"apps", "desktop", "main.cjs"'));
  });
});

test("cutover gate rejects direct imports and superseded aliases in the formal ACP release graph", () => {
  withFixture((root) => {
    sessionIdProductionFixture(root);
    fixtureFile(root, "tests/journeys/support/acp-release-cell-launcher.ts", [
      'import "../../../packages/provider-opencode/src/index.mjs";',
      'const build = ["dist", "workbench", "index.html"];',
      'const main = ["apps", "desktop", "main.cjs"];',
      "const productionArtifactDigest = true;",
      "const startProductionWorkbenchServer = true;",
      'export const cell = "cell_native-full";',
    ].join("\n"));
    fixtureFile(root, "scripts/run-journey-suite.mjs", 'export const spec = "tests/journeys/native-full-journey.spec.ts";');

    const result = verifySessionIdCutover(root);
    assert.equal(result.ok, false);
    assert(result.issues.some((entry) => entry.code === "forbidden_release_direct_provider_import"
      && entry.file === "tests/journeys/support/acp-release-cell-launcher.ts"
      && entry.token === "../../../packages/provider-opencode/src/index.mjs"));
    assert(result.issues.some((entry) => entry.code === "forbidden_release_native_full_token"
      && entry.file === "tests/journeys/support/acp-release-cell-launcher.ts"
      && entry.token === "cell_native-full"));
    assert(result.issues.some((entry) => entry.code === "forbidden_release_native_full_token"
      && entry.file === "scripts/run-journey-suite.mjs"
      && entry.token === "native-full-journey.spec.ts"));
  });
});

function sessionIdProductionFixture(root) {
  fixtureFile(root, "apps/runtime-host/src/index.ts", [
    'import "@agent-workspace/conductor-tools";',
    'import "./acp-provider-composition.js";',
    'import "./acp-meta-provider-composition.js";',
    'import "./acp-task-session-runtime-provider.js";',
    'import "./acp-runtime-host-private-authority.js";',
    'export * from "./session-id-unified-runtime-bridge.js";',
  ].join("\n"));
  fixtureFile(root, "apps/runtime-host/src/acp-provider-composition.ts", 'import "@agent-workspace/provider-acp"; export const createAcpProviderComposition = true;');
  fixtureFile(root, "apps/runtime-host/src/acp-meta-provider-composition.ts", "export const createAcpMetaProviderComposition = true;");
  fixtureFile(root, "apps/runtime-host/src/acp-task-session-runtime-provider.ts", "export const createAcpTaskSessionRuntimeProvider = true;");
  fixtureFile(root, "apps/runtime-host/src/acp-runtime-host-private-authority.ts", "export const createAcpRuntimeHostPrivateAuthority = true;");
  fixtureFile(root, "packages/provider-acp/src/index.ts", "export const createManagedAcpV1Client = true;");
  fixtureFile(root, "apps/runtime-host/src/session-id-unified-runtime-bridge.ts", `import "@agent-workspace/runtime-application";\nexport const createSessionIdUnifiedRuntimeBridgeServer = true;\n${retentionCommands()}\n${templateCommands()}`);
  fixtureFile(root, "apps/workbench/src/main.tsx", 'import { AgentLoopSessionIdRuntimeApp, AgentLoopSessionIdTaskSurface } from "@agent-workspace/workbench-ui"; void AgentLoopSessionIdRuntimeApp; void AgentLoopSessionIdTaskSurface;');
  fixtureFile(root, "apps/desktop/main.cjs", 'require("./session-id.cjs");');
  fixtureFile(root, "apps/desktop/preload.cjs", 'require("./session-id.cjs");');
  fixtureFile(root, "apps/desktop/session-id.cjs", "module.exports = {};");
  fixtureFile(root, "packages/conductor-tools/src/index.ts", 'export * from "./tools.js";');
  fixtureFile(root, "packages/conductor-tools/src/tools.ts", 'export const names = ["invoke_agent", "send_to_session", "interrupt_session", "close_session"];');
  fixtureFile(root, "packages/runtime-application/src/index.ts", 'export * from "./session-id-configuration-task-lifecycle.js";');
  fixtureFile(root, "packages/runtime-application/src/session-id-configuration-task-lifecycle.ts", `${retentionCommands()}\n${templateCommands()}`);
  fixtureFile(root, "packages/workbench-ui/src/index.ts", [
    'export * from "./agent-loop/AgentLoopSessionIdTaskSurface.js";',
    'export * from "./agent-loop/AgentLoopSessionIdRuntimeApp.js";',
    'export * from "./agent-loop/agent-loop-session-id-root-controller.js";',
    'export * from "./agent-loop/agent-loop-session-id-configuration-controller.js";',
    'export * from "./agent-loop/AgentLoopTemplateStudio.js";',
  ].join("\n"));
  fixtureFile(root, "packages/workbench-ui/src/agent-loop/AgentLoopSessionIdTaskSurface.tsx", "export const AgentLoopSessionIdTaskSurface = true;");
  fixtureFile(root, "packages/workbench-ui/src/agent-loop/AgentLoopSessionIdRuntimeApp.tsx", [
    'import "./agent-loop-session-id-configuration-controller.js";',
    'import "./AgentLoopTemplateStudio.js";',
    "export const actions = ['archiveTask', 'restoreTask', 'previewPermanentDelete', 'permanentlyDeleteTask'];",
  ].join("\n"));
  fixtureFile(root, "packages/workbench-ui/src/agent-loop/agent-loop-session-id-root-controller.ts", retentionCommands());
  fixtureFile(root, "packages/workbench-ui/src/agent-loop/agent-loop-session-id-configuration-controller.ts", templateCommands());
  fixtureFile(root, "packages/workbench-ui/src/agent-loop/AgentLoopTemplateStudio.tsx", "export const actions = ['archiveTemplate', 'previewImport', 'exportVersion'];");
  fixtureFile(root, "packages/runtime-store/src/sqlite.ts", "const schema = 'CREATE TABLE session_id_logical_sessions(id TEXT)';");
  fixtureFile(root, "scripts/launch-controlled-journey.mjs", releaseLauncherFixture());
  fixtureFile(root, "tests/journeys/support/acp-release-cell-launcher.ts", acpReleaseLauncherFixture());
  fixtureFile(root, "scripts/run-journey-suite.mjs", "export const suites = ['acp-task', 'acp-meta'];");
  fixtureFile(root, "tests/journeys/release-cell-worker.ts", [
    'const build = ["dist", "workbench", "index.html"];',
    'const main = ["apps", "desktop", "main.cjs"];',
  ].join("\n"));
}

function acpReleaseLauncherFixture() {
  return [
    'const build = ["dist", "workbench", "index.html"];',
    'const main = ["apps", "desktop", "main.cjs"];',
    "const productionArtifactDigest = true;",
    "const startProductionWorkbenchServer = true;",
  ].join("\n");
}

function releaseLauncherFixture() {
  return [
    'const config = "vite.runtime.config.ts";',
    'const build = ["dist", "workbench", "index.html"];',
    'const main = ["apps", "desktop", "main.cjs"];',
  ].join("\n");
}

function retentionCommands(omitted = []) {
  return `export const retentionCommands = ${JSON.stringify([
    "task.archive",
    "task.restore",
    "task.preview_permanent_delete",
    "task.permanently_delete",
  ].filter((command) => !omitted.includes(command)))};`;
}

function templateCommands(omitted = []) {
  return `export const templateCommands = ${JSON.stringify([
    "template.archive",
    "template.import",
    "template.export",
  ].filter((command) => !omitted.includes(command)))};`;
}

function fixtureFile(root, relative, content) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${content}\n`, "utf8");
}

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-cutover-gate-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
