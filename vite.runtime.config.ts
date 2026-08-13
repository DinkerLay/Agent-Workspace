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
  plugins: [react(), sessionIdRuntimeBootstrap(command)],
  resolve: { alias: aliases(root) },
  build: {
    outDir: path.join(root, "dist/workbench"),
    emptyOutDir: true,
  },
  server: sessionIdRuntimeProxy(),
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
    "@agent-workspace/conductor-tools": source("conductor-tools"),
    "@agent-workspace/workbench-ui": source("workbench-ui"),
    "@agent-workspace/test-kit": source("test-kit"),
  };
}

function sessionIdRuntimeProxy() {
  const target = runtimeTarget(process.env.AGENT_WORKSPACE_RUNTIME_URL, process.env.AGENT_WORKSPACE_RUNTIME_PORT);
  const token = nonEmptyText(process.env.AGENT_WORKSPACE_RUNTIME_TOKEN);
  if (!target || !token) return undefined;
  return {
    proxy: {
      "/runtime": {
        target,
        changeOrigin: true,
        ws: true,
        headers: { authorization: token },
      },
    },
  };
}

function sessionIdRuntimeBootstrap(command: string) {
  const token = command === "serve" ? nonEmptyText(process.env.AGENT_WORKSPACE_RUNTIME_TOKEN) : undefined;
  const ownerId = nonEmptyText(process.env.AGENT_WORKSPACE_OWNER_ID) ?? "user_local";
  if (command !== "serve" || !token) return undefined;
  return {
    name: "agent-workspace-session-id-runtime-bootstrap",
    transformIndexHtml(html: string) {
      return html
        .replace(
          '<meta name="agent-workspace-runtime-bridge-token" content="" />',
          `<meta name="agent-workspace-runtime-bridge-token" content="${escapeHtmlAttribute(token ?? "")}" />`,
        )
        .replace(
          '<meta name="agent-workspace-owner-id" content="" />',
          `<meta name="agent-workspace-owner-id" content="${escapeHtmlAttribute(ownerId)}" />`,
        );
    },
  };
}

function runtimeTarget(urlValue: string | undefined, portValue: string | undefined): string | undefined {
  const configured = nonEmptyText(urlValue);
  if (configured) {
    const url = new URL(configured);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.search || url.hash) {
      throw new Error("session_id_runtime_url_invalid");
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  }
  const port = Number(portValue);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? `http://127.0.0.1:${port}`
    : undefined;
}

function nonEmptyText(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
