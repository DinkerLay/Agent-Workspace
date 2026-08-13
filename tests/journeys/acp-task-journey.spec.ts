import { _electron as electron, expect, test } from "@playwright/test";
import { createElectronLaunchEnvironment } from "./electron-launch-environment.js";
import {
  createAcpTaskJourneyScenarios,
  type AcpTaskJourneyProviderFamily,
} from "./full-journey.scenario.js";
import {
  appendRunnerActionEvidence,
  createReadOnlyHostLedgerReader,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

const browserUrl = process.env.AGENT_WORKSPACE_JOURNEY_BROWSER_URL;
const electronMain = process.env.AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN;
const ledgerSource = process.env.AGENT_WORKSPACE_JOURNEY_HOST_LEDGER;
const configuredScenario = acpTaskScenario(process.env);

test.skip(
  !browserUrl || !electronMain || !ledgerSource || !configuredScenario,
  "BLOCKED_CAPABILITY: ACP Task Browser→Electron cell is not configured",
);
test.setTimeout(900_000);

test("ACP Task cell drives one provider-qualified Browser→Electron lineage through visible controls", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
  const hostLedger = createReadOnlyHostLedgerReader({
    source: ledgerSource!,
    accessToken: process.env.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN,
  });
  await page.goto(browserUrl!, { waitUntil: "domcontentloaded" });
  const browserResult = await runActualOperationScenario({
    page,
    scenario: configuredScenario!.browser,
    hostLedger,
    traceNamespace: `trace_namespace_${configuredScenario!.providerFamily}-acp-task-browser`,
    restartExecutable: process.env.AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER,
    providerClockEnabled: false,
  });

  const application = await electron.launch({
    args: [electronMain!],
    env: createElectronLaunchEnvironment(process.env),
  });
  try {
    const renderer = await application.firstWindow();
    renderer.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
    const electronResult = await runActualOperationScenario({
      page: renderer,
      scenario: configuredScenario!.electron,
      hostLedger,
      traceNamespace: `trace_namespace_${configuredScenario!.providerFamily}-acp-task-electron`,
      restartExecutable: process.env.AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER,
      providerClockEnabled: false,
    });
    await appendRunnerActionEvidence(process.env.AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE, {
      scenarioId: configuredScenario!.browser.scenarioId,
      browserTraces: browserResult.traces,
      browserCorrelations: browserResult.correlations,
      electronTraces: electronResult.traces,
      electronCorrelations: electronResult.correlations,
    });
  } finally {
    await application.close();
  }
  expect(consoleErrors).toEqual([]);
});

function acpTaskScenario(environment: NodeJS.ProcessEnv): Readonly<{
  providerFamily: AcpTaskJourneyProviderFamily;
  browser: ReturnType<typeof createAcpTaskJourneyScenarios>["browser"];
  electron: ReturnType<typeof createAcpTaskJourneyScenarios>["electron"];
}> | undefined {
  const providerFamily = environment.AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY;
  const model = environment.AGENT_WORKSPACE_ACP_TASK_MODEL;
  const scenarioId = environment.AGENT_WORKSPACE_RELEASE_SCENARIO_ID;
  if (!providerFamily || !model || !scenarioId) return undefined;
  if (providerFamily !== "opencode" && providerFamily !== "codex") {
    throw new Error("acp_task_journey_provider_family_invalid");
  }
  const scenarios = createAcpTaskJourneyScenarios({ providerFamily, model });
  if (scenarios.browser.scenarioId !== scenarioId || scenarios.electron.scenarioId !== scenarioId) {
    throw new Error("acp_task_journey_scenario_identity_mismatch");
  }
  return Object.freeze({ providerFamily, ...scenarios });
}
