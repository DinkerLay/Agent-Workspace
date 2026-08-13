import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const suites = {
  bridge: {
    required: [],
    command: ["vitest", "run", "--config", "vitest.config.ts", "tests/e2e/deepsearch-runtime-bridge.contract.test.ts"],
  },
  browser: {
    locatorPreflight: "browser",
    required: [
      "AGENT_WORKSPACE_JOURNEY_BROWSER_URL",
      "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
      "AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER",
      "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
    ],
    command: ["playwright", "test", "tests/journeys/browser-journey.spec.ts", "--reporter=line", "--workers=1"],
  },
  desktop: {
    locatorPreflight: "desktop",
    required: [
      "AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN",
      "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
      "AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER",
      "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
    ],
    command: ["playwright", "test", "tests/journeys/electron-journey.spec.ts", "--reporter=line", "--workers=1"],
  },
  cross: {
    locatorPreflight: "cross",
    required: [
      "AGENT_WORKSPACE_JOURNEY_BROWSER_URL",
      "AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN",
      "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
      "AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER",
      "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
    ],
    command: ["playwright", "test", "tests/journeys/cross-surface-journey.spec.ts", "--reporter=line", "--workers=1"],
  },
  "acp-task": {
    locatorPreflight: "acp-task",
    required: [
      "AGENT_WORKSPACE_JOURNEY_BROWSER_URL",
      "AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN",
      "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
      "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN",
      "AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER",
      "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
      "AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY",
      "AGENT_WORKSPACE_ACP_TASK_MODEL",
      "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
    ],
    command: ["playwright", "test", "tests/journeys/acp-task-journey.spec.ts", "--reporter=line", "--workers=1"],
  },
  "acp-meta": {
    locatorPreflight: "acp-meta",
    required: [
      "AGENT_WORKSPACE_JOURNEY_BROWSER_URL",
      "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
      "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN",
      "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
      "AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID",
      "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
    ],
    command: ["playwright", "test", "tests/journeys/acp-meta-journey.spec.ts", "--reporter=line", "--workers=1"],
  },
};

if (mode && Object.hasOwn(suites, mode)) {
  await runSuite(suites[mode]);
} else {
  console.error("usage: node scripts/run-journey-suite.mjs bridge|browser|desktop|cross|acp-task|acp-meta");
  process.exitCode = 1;
}

async function runSuite(suite) {
  if (suite.locatorPreflight) {
    const preflight = await runLocatorPreflight(suite.locatorPreflight);
    if (preflight !== 0) {
      process.exitCode = preflight;
      return;
    }
  }
  const missing = suite.required.filter((name) => !process.env[name]);
  if (missing.length > 0) return blocked(`missing ${missing.join(", ")}`);
  const [binary, ...args] = suite.command;
  const executable = path.join(root, "node_modules", ".bin", binary);
  if (suite === suites.bridge && !process.env.AGENT_WORKSPACE_JOURNEY_BRIDGE_FIXTURE) {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agent-workspace-bridge-fixture-config-"));
    const fixtureConfig = path.join(fixtureRoot, "fixture.mjs");
    const fixtureSource = path.join(root, "tests", "e2e", "support", "session-id-deterministic-bridge-fixture.ts");
    await writeFile(
      fixtureConfig,
      `export { runDeterministicSessionIdJourney } from ${JSON.stringify(pathToFileURL(fixtureSource).href)};\n`,
      { mode: 0o600 },
    );
    try {
      process.exitCode = await spawnExit(executable, args, {
        ...process.env,
        AGENT_WORKSPACE_JOURNEY_BRIDGE_FIXTURE: fixtureConfig,
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    return;
  }
  process.exitCode = await spawnExit(executable, args);
}

function runLocatorPreflight(mode) {
  return spawnExit(path.join(root, "node_modules", ".bin", "tsx"), [
    "tests/journeys/verify-production-locators.ts", mode,
  ]);
}

function spawnExit(executable, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

function blocked(reason) {
  console.error(JSON.stringify({ outcome: "BLOCKED_CAPABILITY", reason }));
  process.exitCode = 2;
}
