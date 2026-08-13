import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => path.join(root, "packages", name, "src", "index.ts");

// All Phase 1 RED contracts have been promoted. Keep the isolated config until
// Phase 8 removes the expected-RED infrastructure; no production test may add
// a path here without reopening the plan's explicit RED inventory.
const allowedFiles = new Set<string>();

const requestedFiles = parseRequestedFiles(process.env.AGENT_WORKSPACE_EXPECTED_RED_FILES);

export default defineConfig({
  resolve: {
    alias: {
      "@agent-workspace/runtime-contracts": source("runtime-contracts"),
      "@agent-workspace/runtime-domain": source("runtime-domain"),
      "@agent-workspace/runtime-application": source("runtime-application"),
      "@agent-workspace/runtime-store": source("runtime-store"),
      "@agent-workspace/runtime-client": source("runtime-client"),
      "@agent-workspace/provider-port": source("provider-port"),
      "@agent-workspace/conductor-tools": source("conductor-tools"),
      "@agent-workspace/workbench-ui": source("workbench-ui"),
      "@agent-workspace/test-kit": source("test-kit"),
    },
  },
  test: {
    environment: "node",
    include: requestedFiles,
    exclude: ["node_modules", "dist"],
    restoreMocks: true,
    clearMocks: true,
  },
});

function parseRequestedFiles(serialized: string | undefined): string[] {
  if (!serialized) throw new Error("expected_red_config_runner_required");

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("expected_red_config_files_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("expected_red_config_files_invalid");
  }

  const files: string[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || !allowedFiles.has(value) || seen.has(value)) {
      throw new Error("expected_red_config_file_not_allowed");
    }
    seen.add(value);
    files.push(value);
  }
  return files;
}
