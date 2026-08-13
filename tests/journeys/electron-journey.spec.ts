import { _electron as electron, expect, test } from "@playwright/test";
import { createElectronLaunchEnvironment } from "./electron-launch-environment.js";
import {
  CONTROLLED_UI_BRANCH_CELL_MODES,
  controlledUiBranchScenario,
  electronLinearScenario,
  type ControlledUiBranchCellMode,
} from "./full-journey.scenario.js";
import {
  appendRunnerActionEvidence,
  createReadOnlyHostLedgerReader,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

const electronMain = process.env.AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN;
const ledgerSource = process.env.AGENT_WORKSPACE_JOURNEY_HOST_LEDGER;
const cellMode = controlledCellMode(process.env.AGENT_WORKSPACE_JOURNEY_CELL_MODE);
const scenario = cellMode === "main" ? electronLinearScenario : controlledUiBranchScenario("electron", cellMode);

test.skip(!electronMain || !ledgerSource, "BLOCKED_CAPABILITY: formal Electron main or trusted Host ledger is not configured");
test.setTimeout(180_000);

test("Electron controlled cell uses a real window and preload IPC", async () => {
  const application = await electron.launch({
    args: [electronMain!],
    env: createElectronLaunchEnvironment(process.env),
  });
  try {
    const renderer = await application.firstWindow();
    const consoleErrors: string[] = [];
    renderer.on("console", (entry) => {
      if (entry.type() === "error") consoleErrors.push(entry.text());
    });
    const result = await runActualOperationScenario({
      page: renderer,
      scenario,
      hostLedger: createReadOnlyHostLedgerReader({
        source: ledgerSource!,
        accessToken: process.env.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN,
      }),
      traceNamespace: `trace_namespace_electron-controlled-${cellMode}`,
      restartExecutable: process.env.AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER,
      providerBarrierExecutable: process.env.AGENT_WORKSPACE_JOURNEY_PROVIDER_BARRIER_RUNNER,
      providerClockEnabled: cellMode === "main" || cellMode === "j08-late-final",
    });
    await appendRunnerActionEvidence(process.env.AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE, {
      scenarioId: scenario.scenarioId,
      traces: result.traces,
      correlations: result.correlations,
    });
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
  }
});

function controlledCellMode(value: string | undefined): "main" | ControlledUiBranchCellMode {
  if (value === undefined || value === "main") return "main";
  if ((CONTROLLED_UI_BRANCH_CELL_MODES as readonly string[]).includes(value)) {
    return value as ControlledUiBranchCellMode;
  }
  throw new Error("controlled_ui_branch_cell_mode_invalid");
}
