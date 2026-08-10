import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Formal build of the preserved AgentLoop renderer. The Desktop shell loads
 * this single artifact; it contains no generic Workbench page or Provider UI.
 */
export default defineConfig(({ command }) => ({
  root: path.join(root, "apps/workbench"),
  base: command === "build" ? "./" : "/",
  plugins: [react(), runtimeBridgeBootstrap(command)],
  resolve: { alias: aliases(root) },
  build: {
    outDir: path.join(root, "dist/workbench"),
    emptyOutDir: true,
  },
  server: runtimeBridgeProxy(),
}));

function aliases(repoRoot: string): Record<string, string> {
  const source = (name: string) => path.join(repoRoot, "packages", name, "src", "index.ts");
  return {
    "@agent-workspace/runtime-contracts": source("runtime-contracts"),
    "@agent-workspace/runtime-domain": source("runtime-domain"),
    "@agent-workspace/runtime-application": source("runtime-application"),
    "@agent-workspace/runtime-store": source("runtime-store"),
    "@agent-workspace/runtime-client": source("runtime-client"),
    "@agent-workspace/provider-port": source("provider-port"),
    "@agent-workspace/provider-opencode": source("provider-opencode"),
    "@agent-workspace/provider-codex": source("provider-codex"),
    "@agent-workspace/provider-claude-code": source("provider-claude-code"),
    "@agent-workspace/conductor-tools": source("conductor-tools"),
    "@agent-workspace/workbench-ui": source("workbench-ui"),
    "@agent-workspace/test-kit": source("test-kit"),
  };
}

function runtimeBridgeProxy() {
  const port = Number(process.env.AGENT_WORKSPACE_RUNTIME_PORT);
  const token = process.env.AGENT_WORKSPACE_RUNTIME_TOKEN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token) return undefined;
  return {
    proxy: {
      "/runtime": {
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        ws: true,
        headers: { authorization: `Bearer ${token}` },
      },
    },
  };
}

function runtimeBridgeBootstrap(command: string) {
  if (command !== "serve") return undefined;
  const token = process.env.AGENT_WORKSPACE_RUNTIME_TOKEN;
  if (!token) return undefined;
  return {
    name: "agent-workspace-runtime-bridge-bootstrap",
    transformIndexHtml(html: string) {
      return html.replace(
        '<meta name="agent-workspace-runtime-bridge-token" content="" />',
        `<meta name="agent-workspace-runtime-bridge-token" content="${escapeHtmlAttribute(token)}" />`,
      );
    },
  };
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
