import { expect, test } from "@playwright/test";
import {
  browserLinearScenario,
  CONTROLLED_UI_BRANCH_CELL_MODES,
  controlledUiBranchScenario,
  type ControlledUiBranchCellMode,
} from "./full-journey.scenario.js";
import {
  appendRunnerActionEvidence,
  createReadOnlyHostLedgerReader,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

const browserUrl = process.env.AGENT_WORKSPACE_JOURNEY_BROWSER_URL;
const ledgerSource = process.env.AGENT_WORKSPACE_JOURNEY_HOST_LEDGER;
const cellMode = controlledCellMode(process.env.AGENT_WORKSPACE_JOURNEY_CELL_MODE);
const scenario = cellMode === "main" ? browserLinearScenario : controlledUiBranchScenario("browser", cellMode);

test.skip(!browserUrl || !ledgerSource, "BLOCKED_CAPABILITY: formal Browser URL or trusted Host ledger is not configured");
test.setTimeout(180_000);

test("Browser controlled cell uses visible controls and the formal bridge", async ({ page }) => {
  const consoleErrors: string[] = [];
  const responseErrorReads: Promise<string>[] = [];
  page.on("console", (entry) => {
    if (entry.type() === "error") {
      const location = entry.location();
      consoleErrors.push(`${entry.text()}${location.url ? ` @ ${new URL(location.url).pathname}` : ""}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) responseErrorReads.push(response.text().then((body) =>
      `${response.status()} ${new URL(response.url()).pathname} ${body.slice(0, 240)}`));
  });
  await page.goto(browserUrl!, { waitUntil: "domcontentloaded" });
  const result = await runActualOperationScenario({
    page,
    scenario,
    hostLedger: createReadOnlyHostLedgerReader({
      source: ledgerSource!,
      accessToken: process.env.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN,
    }),
    traceNamespace: `trace_namespace_browser-controlled-${cellMode}`,
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
  expect(await Promise.all(responseErrorReads)).toEqual([]);
});

function controlledCellMode(value: string | undefined): "main" | ControlledUiBranchCellMode {
  if (value === undefined || value === "main") return "main";
  if ((CONTROLLED_UI_BRANCH_CELL_MODES as readonly string[]).includes(value)) {
    return value as ControlledUiBranchCellMode;
  }
  throw new Error("controlled_ui_branch_cell_mode_invalid");
}
