import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // Electron's production shell loads dist/index.html through file://. Keep
  // built assets relative while preserving Vite's normal root-relative dev
  // server URLs, so both shells execute the same renderer entrypoint.
  base: command === "build" ? "./" : "/",
  plugins: [react()],
  server: runtimeBridgeProxy(),
}));

function runtimeBridgeProxy() {
  const port = Number(process.env.AGENT_WORKSPACE_WEB_HOST_PORT);
  const token = process.env.AGENT_WORKSPACE_WEB_BRIDGE_TOKEN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token) return undefined;
  return {
    proxy: {
      "/runtime": {
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        rewrite: (value: string) => value.replace(/^\/runtime/, ""),
        headers: { authorization: `Bearer ${token}` },
      },
    },
  };
}
