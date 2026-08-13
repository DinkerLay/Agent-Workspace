import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => path.join(root, "packages", name, "src", "index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@agent-workspace/runtime-contracts": source("runtime-contracts"),
      "@agent-workspace/runtime-domain": source("runtime-domain"),
      "@agent-workspace/runtime-application": source("runtime-application"),
      "@agent-workspace/runtime-store": source("runtime-store"),
      "@agent-workspace/runtime-client": source("runtime-client"),
      "@agent-workspace/provider-port": source("provider-port"),
      "@agent-workspace/provider-acp/host-private": path.join(root, "packages", "provider-acp", "src", "host-private.ts"),
      "@agent-workspace/provider-acp/test-support": path.join(root, "packages", "provider-acp", "src", "fake-agent.ts"),
      "@agent-workspace/provider-acp": source("provider-acp"),
      "@agent-workspace/conductor-tools": source("conductor-tools"),
      "@agent-workspace/workbench-ui": source("workbench-ui"),
      "@agent-workspace/test-kit": source("test-kit"),
    },
  },
  test: {
    environment: "node",
    include: [
      "apps/**/src/**/*.test.{ts,tsx}",
      "packages/**/src/**/*.test.{ts,tsx}",
      // Each Node/MJS Provider contract suite is loaded exactly once through
      // its package-local `src/*.test.ts` Vitest entrypoint. Discovering the
      // MJS files here as well registers every suite twice.
      "packages/**/test/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
    ],
    exclude: [
      "node_modules",
      "dist",
      "**/*.red.*",
    ],
    restoreMocks: true,
    clearMocks: true,
  },
});
