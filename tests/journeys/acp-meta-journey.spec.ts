import { expect, test } from "@playwright/test";
import { createAcpMetaJourneyScenario } from "./full-journey.scenario.js";
import {
  appendRunnerActionEvidence,
  createReadOnlyHostLedgerReader,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

const browserUrl = process.env.AGENT_WORKSPACE_JOURNEY_BROWSER_URL;
const ledgerSource = process.env.AGENT_WORKSPACE_JOURNEY_HOST_LEDGER;
const metaProfileOptionId = process.env.AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID;
const releaseScenarioId = process.env.AGENT_WORKSPACE_RELEASE_SCENARIO_ID;
const scenario = metaProfileOptionId ? createAcpMetaJourneyScenario({ metaProfileOptionId }) : undefined;
if (scenario && releaseScenarioId && scenario.scenarioId !== releaseScenarioId) {
  throw new Error("acp_meta_journey_scenario_identity_mismatch");
}

test.skip(
  !browserUrl || !ledgerSource || !scenario || !releaseScenarioId,
  "BLOCKED_CAPABILITY: ACP Meta Browser cell is not configured",
);
test.setTimeout(600_000);

test("ACP Meta cell exercises only independent Template and Task Setup Meta turns", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
  await page.goto(browserUrl!, { waitUntil: "domcontentloaded" });
  const result = await runActualOperationScenario({
    page,
    scenario: scenario!,
    hostLedger: createReadOnlyHostLedgerReader({
      source: ledgerSource!,
      accessToken: process.env.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN,
    }),
    traceNamespace: "trace_namespace_acp-meta-browser",
    providerClockEnabled: false,
  });
  await appendRunnerActionEvidence(process.env.AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE, {
    scenarioId: scenario!.scenarioId,
    traces: result.traces,
    correlations: result.correlations,
  });
  expect(consoleErrors).toEqual([]);
});
