import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(workbenchRoot, "..", "..");

describe("production Session-ID Workbench entry", () => {
  it("mounts the Session-ID AgentLoop root without a legacy controller fallback", () => {
    const entry = readFileSync(path.join(workbenchRoot, "src", "main.tsx"), "utf8");
    const runtime = readFileSync(path.join(workbenchRoot, "src", "runtime.ts"), "utf8");
    const source = `${entry}\n${runtime}`;

    expect(entry).toContain("AgentLoopSessionIdRuntimeApp");
    expect(entry).toContain("createAgentLoopSessionIdController");
    expect(runtime).toContain("createAgentLoopSessionIdRootController");
    expect(runtime).toContain("sessionIdRuntime");
    expect(source).not.toMatch(/AgentLoopRuntimeApp|createAgentLoopRuntimeController|createAgentLoopControllers/u);
    expect(source).not.toContain("sessionIdRuntimeCandidate");
    expect(source).not.toContain("agentWorkspace.runtime");
  });

  it("uses the default Vite root and formal dist/workbench artifact", () => {
    const config = readFileSync(path.join(repositoryRoot, "vite.runtime.config.ts"), "utf8");
    expect(config).toContain('root: path.join(root, "apps/workbench")');
    expect(config).toContain('outDir: path.join(root, "dist/workbench")');
    expect(config).toContain("agent-workspace-owner-id");
    expect(config).toContain("AGENT_WORKSPACE_RUNTIME_URL");
    expect(config).toContain("headers: { authorization: token }");
    expect(config).not.toMatch(/candidate|AGENT_WORKSPACE_RUNTIME_MODE|legacy/u);
  });
});
