import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRuntimeProviderPortsFromEnvironment } from "./provider-composition.js";
import { loadMetaProfileOptionsFromEnvironment } from "./meta-profile-composition.js";
import { loadRuntimeMetaAgentPortsFromEnvironment } from "./meta-provider-composition.js";
import { createRuntimeBridgeServer } from "./runtime-bridge.js";
import { createRuntimeHost } from "./runtime-host.js";

export * from "./runtime-bridge.js";
export * from "./runtime-host.js";
export * from "./workspace-directory-resolver.js";
export * from "./managed-artifact-service.js";
export * from "./codex-meta-app-server-bridge.js";
export * from "./meta-profile-composition.js";
export * from "./meta-provider-composition.js";
export * from "./provider-composition.js";

async function main(): Promise<void> {
  const runtimeDataPath = process.env.AGENT_WORKSPACE_RUNTIME_DATA_DIR
    // A standalone v2 Host must never reopen or mingle with the removed
    // Runtime's `.agent-workspace/**` data. Desktop supplies its own userData
    // path; this is only the isolated local default.
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".agent-workspace-v2", "runtime");
  mkdirSync(runtimeDataPath, { recursive: true });
  const host = createRuntimeHost({
    databasePath: path.join(runtimeDataPath, "runtime.sqlite"),
    providerPorts: loadRuntimeProviderPortsFromEnvironment({ runtimeDataDirectory: runtimeDataPath }),
    metaAgentPorts: loadRuntimeMetaAgentPortsFromEnvironment({ runtimeDataDirectory: runtimeDataPath }),
    metaProfileOptions: loadMetaProfileOptionsFromEnvironment(),
  });
  const token = process.env.AGENT_WORKSPACE_RUNTIME_TOKEN;
  if (!token) throw new Error("AGENT_WORKSPACE_RUNTIME_TOKEN is required for standalone Runtime Host.");
  const bridge = createRuntimeBridgeServer({ host, token });
  const address = await bridge.listen(Number(process.env.AGENT_WORKSPACE_RUNTIME_PORT ?? 0));
  host.startDispatcher();
  process.stdout.write(`${JSON.stringify({ type: "runtime_host_ready", ...address })}\n`);
  const close = async () => {
    await bridge.close();
    await host.close();
  };
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
