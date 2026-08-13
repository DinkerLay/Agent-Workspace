import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createElectronLaunchEnvironment } from "./electron-launch-environment.js";

describe("actual-operation Electron launch environment", () => {
  it("passes only OS launch fields and the distinct Desktop bridge contract", () => {
    const environment = createElectronLaunchEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      AGENT_WORKSPACE_WORKBENCH_URL: "http://127.0.0.1:5191/",
      AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4321",
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop_renderer_token",
      AGENT_WORKSPACE_RUNTIME_ORIGIN: "http://127.0.0.1:5191",
      AGENT_WORKSPACE_OWNER_ID: "user_local",
      AGENT_WORKSPACE_RUNTIME_TOKEN: "browser_renderer_token",
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: "evidence_secret",
      AGENT_WORKSPACE_RELEASE_NONCE: "release_secret",
      AGENT_WORKSPACE_SCENARIO_ID: "forged_scenario",
      AGENT_WORKSPACE_CHECKPOINT: "forged_checkpoint",
      CODEX_API_KEY: "provider_secret",
      OPENAI_API_KEY: "provider_secret",
      NATIVE_CREDENTIAL_REF: "provider_secret_ref",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      AGENT_WORKSPACE_WORKBENCH_URL: "http://127.0.0.1:5191/",
      AGENT_WORKSPACE_RUNTIME_URL: "http://127.0.0.1:4321",
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: "desktop_renderer_token",
      AGENT_WORKSPACE_RUNTIME_ORIGIN: "http://127.0.0.1:5191",
      AGENT_WORKSPACE_OWNER_ID: "user_local",
    });
    expect(Object.keys(environment)).not.toEqual(expect.arrayContaining([
      "AGENT_WORKSPACE_RUNTIME_TOKEN",
      "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN",
      "AGENT_WORKSPACE_RELEASE_NONCE",
      "AGENT_WORKSPACE_SCENARIO_ID",
      "AGENT_WORKSPACE_CHECKPOINT",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "NATIVE_CREDENTIAL_REF",
    ]));
  });

  it("is the only environment builder used by both actual Electron scenarios", () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    for (const fileName of ["electron-journey.spec.ts", "cross-surface-journey.spec.ts", "acp-task-journey.spec.ts"]) {
      const source = readFileSync(path.join(directory, fileName), "utf8");
      expect(source).toContain("createElectronLaunchEnvironment(process.env)");
      expect(source).not.toContain("Object.entries(process.env)");
      expect(source).not.toContain("definedEnvironment");
    }
  });
});
