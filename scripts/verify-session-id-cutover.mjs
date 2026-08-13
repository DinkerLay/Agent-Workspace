#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRODUCTION_ENTRIES = Object.freeze([
  "apps/runtime-host/src/index.ts",
  "apps/workbench/src/main.tsx",
  "apps/desktop/main.cjs",
  "apps/desktop/preload.cjs",
]);

const FORBIDDEN_FILES = Object.freeze([
  "packages/runtime-domain/src/invocations.ts",
  "packages/conductor-tools/src/runtime-conductor-gateway.ts",
  "packages/workbench-ui/src/agent-loop/agent-loop-runtime-controller.ts",
  "packages/workbench-ui/src/agent-loop/AgentLoopTaskSurface.tsx",
  "packages/runtime-application/src/managed-artifact-port.ts",
  "apps/runtime-host/src/managed-artifact-service.ts",
]);

const FORBIDDEN_APP_PATHS = Object.freeze([
  "apps/runtime-host/src/session-id-runtime-bridge.ts",
  "apps/runtime-host/src/session-id-runtime-bridge.test.ts",
  "apps/desktop/runtime-host-client.cjs",
  "apps/desktop/runtime-ipc-facade.cjs",
  "apps/desktop/desktop-runtime-composition.cjs",
]);

const FORBIDDEN_DIRECT_PROVIDER_PATHS = Object.freeze([
  "packages/provider-opencode",
  "packages/provider-codex",
  "packages/provider-claude-code",
  "apps/runtime-host/src/provider-composition.ts",
  "apps/runtime-host/src/meta-provider-composition.ts",
  "apps/runtime-host/src/opencode-scoped-tool-qualification.ts",
  "apps/runtime-host/src/codex-scoped-tool-qualification.ts",
  "apps/runtime-host/src/codex-app-server-bridge.ts",
  "apps/runtime-host/src/codex-meta-app-server-bridge.ts",
  "apps/runtime-host/src/claude-code-stream-bridge.ts",
]);

const FORBIDDEN_DIRECT_PROVIDER_IMPORTS = Object.freeze([
  "@agent-workspace/provider-opencode",
  "@agent-workspace/provider-codex",
  "@agent-workspace/provider-claude-code",
]);

const FORBIDDEN_DIRECT_PROVIDER_TOKENS = Object.freeze([
  "opencode-server",
  "codex-app-server",
  "claude-code-stream",
  "loadRuntimeProviderPortsFromEnvironment",
  "loadRuntimeMetaAgentPortsFromEnvironment",
  "createOpenCodeProviderAdapter",
  "createCodexAppServerProviderAdapter",
  "createClaudeCodeProviderAdapter",
  "createOpenCodeMetaAgentPort",
  "createCodexMetaAgentPort",
]);

const REQUIRED_ACP_PRODUCTION_PATHS = Object.freeze([
  "packages/provider-acp/src/index.ts",
  "apps/runtime-host/src/acp-provider-composition.ts",
  "apps/runtime-host/src/acp-meta-provider-composition.ts",
  "apps/runtime-host/src/acp-task-session-runtime-provider.ts",
  "apps/runtime-host/src/acp-runtime-host-private-authority.ts",
]);

const RELEASE_PRODUCTION_ENTRY_FILES = Object.freeze([
  Object.freeze({
    relative: "scripts/launch-controlled-journey.mjs",
    required: Object.freeze([
      "vite.runtime.config.ts",
      '"dist", "workbench", "index.html"',
      '"apps", "desktop", "main.cjs"',
    ]),
  }),
  Object.freeze({
    relative: "tests/journeys/support/acp-release-cell-launcher.ts",
    required: Object.freeze([
      '"dist", "workbench", "index.html"',
      '"apps", "desktop", "main.cjs"',
      "productionArtifactDigest",
      "startProductionWorkbenchServer",
    ]),
  }),
  Object.freeze({
    relative: "tests/journeys/release-cell-worker.ts",
    required: Object.freeze([
      '"dist", "workbench", "index.html"',
      '"apps", "desktop", "main.cjs"',
    ]),
  }),
]);

const RELEASE_EXECUTION_ENTRIES = Object.freeze([
  "scripts/launch-controlled-journey.mjs",
  "tests/journeys/support/acp-release-cell-launcher.ts",
  "scripts/run-journey-suite.mjs",
  "tests/journeys/release-cell-worker.ts",
]);

const FORBIDDEN_RELEASE_PATHS = Object.freeze([
  "tests/journeys/native-full-journey.spec.ts",
  "scripts/launch-native-release-cell.mjs",
  "scripts/native-opencode-task-seal.mjs",
]);

const FORBIDDEN_RELEASE_NATIVE_FULL_TOKENS = Object.freeze([
  "cell_native-full",
  "scenario_native-full",
  "native-full-journey.spec.ts",
  "native-full-journey",
  "AGENT_WORKSPACE_NATIVE_FULL_JOURNEY_READY",
]);

const FORBIDDEN_RELEASE_DIRECT_PROVIDER_TOKENS = Object.freeze([
  "packages/provider-opencode",
  "packages/provider-codex",
  "packages/provider-claude-code",
  "opencode-binding-server",
  "codex-app-server",
  "claude-code-stream",
  "native-opencode-task-seal",
  "AGENT_WORKSPACE_OPENCODE_META_URL",
  "AGENT_WORKSPACE_NATIVE_OPENCODE_PRIVATE_SERVER",
  "native_provider_attestor",
  "native_companion_attestor",
  "privateServer",
]);

const FORBIDDEN_RELEASE_ENTRY_TOKENS = Object.freeze([
  "vite.session-id-candidate",
  "workbench-session-id-candidate",
  "session-id-root-launch-candidate",
  "AGENT_WORKSPACE_EXPECTED_TASK_ID",
]);

const FORBIDDEN_TOKENS = Object.freeze([
  "invocation.invoke_agent",
  "session.relay_message",
  "session.publish_message",
  "agent_assignment",
  "relay_forward",
  "publish_forward",
  "register_artifact",
  "InvocationRecord",
  "MessageForwardBatchRecord",
  "acceptedArtifactIds",
  "artifact.verify_requested",
  "artifact.preview",
  "ArtifactReference",
  '"/runtime/read"',
  '"/runtime/command"',
  '"/runtime/subscribe"',
  "agent-workspace:runtime:",
]);

const REQUIRED_REACHABLE_TOKENS = Object.freeze([
  "invoke_agent",
  "send_to_session",
  "interrupt_session",
  "close_session",
  "AgentLoopSessionIdTaskSurface",
  "createSessionIdUnifiedRuntimeBridgeServer",
  "createManagedAcpV1Client",
  "createAcpProviderComposition",
  "createAcpMetaProviderComposition",
  "createAcpTaskSessionRuntimeProvider",
  "createAcpRuntimeHostPrivateAuthority",
]);

const TASK_RETENTION_COMMANDS = Object.freeze([
  "task.archive",
  "task.restore",
  "task.preview_permanent_delete",
  "task.permanently_delete",
]);

const TASK_RETENTION_COMMAND_LAYERS = Object.freeze([
  "packages/runtime-application/src/session-id-configuration-task-lifecycle.ts",
  "apps/runtime-host/src/session-id-unified-runtime-bridge.ts",
  "packages/workbench-ui/src/agent-loop/agent-loop-session-id-root-controller.ts",
]);

const TASK_RETENTION_SURFACE_ACTIONS = Object.freeze([
  "archiveTask",
  "restoreTask",
  "previewPermanentDelete",
  "permanentlyDeleteTask",
]);

const TASK_RETENTION_SURFACE = "packages/workbench-ui/src/agent-loop/AgentLoopSessionIdRuntimeApp.tsx";

const TEMPLATE_LIBRARY_COMMANDS = Object.freeze([
  "template.archive",
  "template.import",
  "template.export",
]);

const TEMPLATE_LIBRARY_COMMAND_LAYERS = Object.freeze([
  "packages/runtime-application/src/session-id-configuration-task-lifecycle.ts",
  "apps/runtime-host/src/session-id-unified-runtime-bridge.ts",
  "packages/workbench-ui/src/agent-loop/agent-loop-session-id-configuration-controller.ts",
]);

const TEMPLATE_LIBRARY_SURFACE_ACTIONS = Object.freeze([
  "archiveTemplate",
  "previewImport",
  "exportVersion",
]);

const TEMPLATE_LIBRARY_SURFACE = "packages/workbench-ui/src/agent-loop/AgentLoopTemplateStudio.tsx";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function verifySessionIdCutover(root = repositoryRoot) {
  const issues = [];
  const sourceFiles = ["apps", "packages"].flatMap((directory) => collectProductionSources(path.join(root, directory), root));
  const sourceSet = new Set(sourceFiles);
  const reachable = productionImportGraph(root, PRODUCTION_ENTRIES, issues);
  const releaseReachable = productionImportGraph(root, RELEASE_EXECUTION_ENTRIES, issues);

  for (const relative of collectPaths(path.join(root, "apps"), root)) {
    if (/(?:^|\/)[^/]*candidate[^/]*(?:\/|$)/u.test(relative)) {
      issues.push(issue("forbidden_candidate_app_path", relative));
    }
  }
  for (const relative of FORBIDDEN_APP_PATHS) {
    if (existsSync(path.join(root, relative))) issues.push(issue("forbidden_superseded_app_path", relative));
  }
  for (const relative of FORBIDDEN_DIRECT_PROVIDER_PATHS) {
    if (existsSync(path.join(root, relative))) issues.push(issue("forbidden_direct_provider_path", relative));
  }
  for (const relative of FORBIDDEN_RELEASE_PATHS) {
    if (existsSync(path.join(root, relative))) issues.push(issue("forbidden_release_native_full_path", relative));
  }

  for (const entry of RELEASE_PRODUCTION_ENTRY_FILES) {
    const absolute = path.join(root, entry.relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      issues.push(issue("release_production_entry_guard_missing", entry.relative));
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    for (const token of entry.required) {
      if (!text.includes(token)) issues.push(issue("release_production_entry_required_token_missing", entry.relative, token));
    }
    for (const token of FORBIDDEN_RELEASE_ENTRY_TOKENS) {
      if (text.includes(token)) issues.push(issue("release_candidate_entry_token_forbidden", entry.relative, token));
    }
  }

  for (const relative of releaseReachable) {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const source = readFileSync(absolute, "utf8");
    for (const token of FORBIDDEN_RELEASE_NATIVE_FULL_TOKENS) {
      if (source.includes(token)) issues.push(issue("forbidden_release_native_full_token", relative, token));
    }
    for (const token of FORBIDDEN_RELEASE_DIRECT_PROVIDER_TOKENS) {
      if (source.includes(token)) issues.push(issue("forbidden_release_direct_provider_token", relative, token));
    }
    for (const specifier of importSpecifiers(source)) {
      if (isForbiddenDirectProviderSpecifier(specifier)) {
        issues.push(issue("forbidden_release_direct_provider_import", relative, specifier));
      }
    }
  }

  for (const relative of FORBIDDEN_FILES) {
    if (sourceSet.has(relative)) issues.push(issue("forbidden_production_file", relative));
  }

  for (const relative of sourceFiles) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) issues.push(issue("forbidden_protocol_token", relative, token));
    }
    for (const token of FORBIDDEN_DIRECT_PROVIDER_TOKENS) {
      if (text.includes(token)) issues.push(issue("forbidden_direct_provider_token", relative, token));
    }
    if (relative.endsWith("runtime-store/src/sqlite.ts")) {
      for (const table of ["invocations", "message_forward_batches", "artifacts"]) {
        const create = new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${table}\\b`, "iu");
        if (create.test(text)) issues.push(issue("legacy_table_in_fresh_schema", relative, table));
      }
    }
  }

  const reachableText = [...reachable]
    .filter((relative) => existsSync(path.join(root, relative)))
    .map((relative) => readFileSync(path.join(root, relative), "utf8"))
    .join("\n");
  for (const token of REQUIRED_REACHABLE_TOKENS) {
    if (!reachableText.includes(token)) issues.push(issue("required_cutover_symbol_unreachable", "production-import-graph", token));
  }

  for (const relative of TASK_RETENTION_COMMAND_LAYERS) {
    verifyRequiredLayerTokens({
      root,
      relative,
      sourceSet,
      reachable,
      tokens: TASK_RETENTION_COMMANDS,
      missingTokenCode: "required_lifecycle_command_missing",
      issues,
    });
  }
  verifyRequiredLayerTokens({
    root,
    relative: TASK_RETENTION_SURFACE,
    sourceSet,
    reachable,
    tokens: TASK_RETENTION_SURFACE_ACTIONS,
    missingTokenCode: "required_lifecycle_surface_action_missing",
    issues,
  });

  for (const relative of TEMPLATE_LIBRARY_COMMAND_LAYERS) {
    verifyRequiredLayerTokens({
      root,
      relative,
      sourceSet,
      reachable,
      tokens: TEMPLATE_LIBRARY_COMMANDS,
      missingTokenCode: "required_template_command_missing",
      issues,
    });
  }
  verifyRequiredLayerTokens({
    root,
    relative: TEMPLATE_LIBRARY_SURFACE,
    sourceSet,
    reachable,
    tokens: TEMPLATE_LIBRARY_SURFACE_ACTIONS,
    missingTokenCode: "required_template_surface_action_missing",
    issues,
  });

  for (const relative of reachable) {
    if (FORBIDDEN_FILES.includes(relative)) issues.push(issue("forbidden_file_reachable", relative));
    const absolute = path.join(root, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    for (const specifier of importSpecifiers(readFileSync(absolute, "utf8"))) {
      const direct = FORBIDDEN_DIRECT_PROVIDER_IMPORTS.find((prefix) =>
        specifier === prefix || specifier.startsWith(`${prefix}/`));
      if (direct) issues.push(issue("forbidden_direct_provider_import", relative, direct));
    }
  }

  for (const relative of REQUIRED_ACP_PRODUCTION_PATHS) {
    if (!reachable.has(relative)) issues.push(issue("required_acp_production_path_unreachable", relative));
  }

  return Object.freeze({
    ok: issues.length === 0,
    entries: PRODUCTION_ENTRIES,
    reachable: Object.freeze([...reachable].sort()),
    releaseReachable: Object.freeze([...releaseReachable].sort()),
    issues: Object.freeze(dedupeIssues(issues)),
  });
}

function isForbiddenDirectProviderSpecifier(specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  if (FORBIDDEN_DIRECT_PROVIDER_IMPORTS.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ))) return true;
  return /(?:^|\/)packages\/provider-(?:opencode|codex|claude-code)(?:\/|$)/u.test(normalized)
    || /(?:^|\/)(?:provider-composition|meta-provider-composition|codex-app-server-bridge|codex-meta-app-server-bridge|claude-code-stream-bridge|opencode-binding-server[^/]*)\.(?:[cm]?[jt]s|tsx?)$/u.test(normalized);
}

function verifyRequiredLayerTokens({ root, relative, sourceSet, reachable, tokens, missingTokenCode, issues }) {
  if (!sourceSet.has(relative)) {
    issues.push(issue("required_lifecycle_layer_missing", relative));
    return;
  }
  if (!reachable.has(relative)) issues.push(issue("required_lifecycle_layer_unreachable", relative));
  const text = readFileSync(path.join(root, relative), "utf8");
  for (const token of tokens) {
    if (!text.includes(token)) issues.push(issue(missingTokenCode, relative, token));
  }
}

function productionImportGraph(root, entries, issues) {
  const visited = new Set();
  const queue = [...entries];
  while (queue.length) {
    const relative = queue.shift();
    if (!relative || visited.has(relative)) continue;
    visited.add(relative);
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      issues.push(issue("production_entry_or_import_missing", relative));
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    for (const specifier of importSpecifiers(text)) {
      const resolved = resolveSourceImport(root, relative, specifier);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

function importSpecifiers(text) {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1]) values.push(match[1]);
  }
  return values;
}

function resolveSourceImport(root, importer, specifier) {
  let base;
  if (specifier.startsWith(".")) {
    base = path.resolve(root, path.dirname(importer), specifier);
  } else if (specifier.startsWith("@agent-workspace/")) {
    const packageName = specifier.slice("@agent-workspace/".length).split("/")[0];
    if (!packageName) return undefined;
    const suffix = specifier.slice(`@agent-workspace/${packageName}`.length).replace(/^\//u, "");
    base = path.join(root, "packages", packageName, "src", suffix || "index");
  } else {
    return undefined;
  }
  for (const candidate of sourceCandidates(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.relative(root, candidate);
  }
  return undefined;
}

function sourceCandidates(base) {
  const withoutJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
  return [
    base,
    withoutJs,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${withoutJs}${extension}`),
    ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].map((extension) => path.join(base, `index${extension}`)),
  ];
}

function collectProductionSources(directory, root) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "archive", "deprecated", "superseded"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProductionSources(absolute, root));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (/\.(?:test|spec|fixture)\.[^.]+$/u.test(entry.name) || /(?:^|\.)red\./u.test(entry.name)) continue;
    results.push(path.relative(root, absolute));
  }
  return results;
}

function collectPaths(directory, root) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    results.push(relative);
    if (entry.isDirectory()) results.push(...collectPaths(absolute, root));
  }
  return results;
}

function issue(code, file, token) {
  return Object.freeze({ code, file, ...(token ? { token } : {}) });
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifySessionIdCutover(repositoryRoot);
  const summary = {
    gate: "session-id-cutover",
    outcome: result.ok ? "PASS" : "FAIL",
    productionEntryCount: result.entries.length,
    reachableSourceCount: result.reachable.length,
    issueCount: result.issues.length,
    issues: result.issues,
  };
  (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
