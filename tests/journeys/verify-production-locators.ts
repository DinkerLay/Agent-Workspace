import path from "node:path";
import {
  browserLinearScenario,
  crossSurfaceBrowserScenario,
  crossSurfaceElectronScenario,
  CONTROLLED_UI_BRANCH_CELL_MODES,
  controlledUiBranchScenario,
  createAcpMetaJourneyScenario,
  createAcpTaskJourneyScenarios,
  electronLinearScenario,
} from "./full-journey.scenario.js";
import { inspectProductionLocatorCoverage } from "./locator-action-dsl.js";

const mode = process.argv[2];
const cellMode = process.env.AGENT_WORKSPACE_JOURNEY_CELL_MODE;
if (cellMode && cellMode !== "main" && !(CONTROLLED_UI_BRANCH_CELL_MODES as readonly string[]).includes(cellMode)) {
  throw new Error("controlled_ui_branch_cell_mode_invalid");
}
const scenarios = mode === "browser" ? [cellMode && cellMode !== "main"
  ? controlledUiBranchScenario("browser", cellMode as typeof CONTROLLED_UI_BRANCH_CELL_MODES[number])
  : browserLinearScenario]
  : mode === "desktop" ? [cellMode && cellMode !== "main"
    ? controlledUiBranchScenario("electron", cellMode as typeof CONTROLLED_UI_BRANCH_CELL_MODES[number])
    : electronLinearScenario]
    : mode === "cross" ? [crossSurfaceBrowserScenario, crossSurfaceElectronScenario]
      : mode === "acp-task" ? Object.values(createAcpTaskJourneyScenarios({
          providerFamily: acpTaskProviderFamily(process.env.AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY),
          model: process.env.AGENT_WORKSPACE_ACP_TASK_MODEL ?? "acp-task-model-preflight",
        }))
        : mode === "acp-meta" ? [createAcpMetaJourneyScenario({
            metaProfileOptionId: process.env.AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID ?? "meta_profile_option_preflight",
          })]
          : undefined;
if (!scenarios) throw new Error("usage: verify-production-locators.ts browser|desktop|cross|acp-task|acp-meta");

const coverage = await inspectProductionLocatorCoverage({
  productionRoots: [path.resolve("apps/workbench/src"), path.resolve("packages/workbench-ui/src")],
  scenarios,
});
if (coverage.missingTestIds.length > 0) {
  process.stderr.write(`${JSON.stringify({
    outcome: "BLOCKED_CAPABILITY",
    reason: "formal production Surface does not expose the required stable journey locators",
    coveredTestIds: coverage.coveredTestIds,
    missingTestIds: coverage.missingTestIds,
  })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`production locator coverage (${mode}): PASS\n`);
}

function acpTaskProviderFamily(value: string | undefined): "opencode" | "codex" {
  if (value === undefined) return "opencode";
  if (value === "opencode" || value === "codex") return value;
  throw new Error("acp_task_journey_provider_family_invalid");
}
