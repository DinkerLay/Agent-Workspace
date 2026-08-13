import { _electron as electron, test } from "@playwright/test";
import { createElectronLaunchEnvironment } from "./electron-launch-environment.js";
import { crossSurfaceBrowserScenario, crossSurfaceElectronScenario } from "./full-journey.scenario.js";
import {
  appendRunnerActionEvidence,
  createReadOnlyHostLedgerReader,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

const browserUrl = process.env.AGENT_WORKSPACE_JOURNEY_BROWSER_URL;
const electronMain = process.env.AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN;
const ledgerSource = process.env.AGENT_WORKSPACE_JOURNEY_HOST_LEDGER;

test.skip(
  !browserUrl || !electronMain || !ledgerSource,
  "BLOCKED_CAPABILITY: cross-surface Browser, Electron and shared Host lineage are not configured",
);
test.setTimeout(240_000);

test("J-12 continues one Host/Draft/Task/Run lineage from Browser into Electron", async ({ page }) => {
  const hostLedger = createReadOnlyHostLedgerReader({
    source: ledgerSource!,
    accessToken: process.env.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN,
  });
  await page.goto(browserUrl!, { waitUntil: "domcontentloaded" });
  const browserResult = await runActualOperationScenario({
    page,
    scenario: crossSurfaceBrowserScenario,
    hostLedger,
    traceNamespace: "trace_namespace_cross-surface-browser",
    restartExecutable: process.env.AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER,
    providerBarrierExecutable: process.env.AGENT_WORKSPACE_JOURNEY_PROVIDER_BARRIER_RUNNER,
  });

  const application = await electron.launch({ args: [electronMain!], env: createElectronLaunchEnvironment(process.env) });
  try {
    const renderer = await application.firstWindow();
    const electronResult = await runActualOperationScenario({
      page: renderer,
      scenario: crossSurfaceElectronScenario,
      hostLedger,
      traceNamespace: "trace_namespace_cross-surface-electron",
      restartExecutable: process.env.AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER,
      providerBarrierExecutable: process.env.AGENT_WORKSPACE_JOURNEY_PROVIDER_BARRIER_RUNNER,
    });
    await appendRunnerActionEvidence(process.env.AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE, {
      scenarioId: crossSurfaceBrowserScenario.scenarioId,
      browserTraces: browserResult.traces,
      browserCorrelations: browserResult.correlations,
      electronTraces: electronResult.traces,
      electronCorrelations: electronResult.correlations,
    });
  } finally {
    await application.close();
  }
});
