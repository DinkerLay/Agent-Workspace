import path from "node:path";
import { verifyScenarioSourceSafety } from "./locator-action-dsl.js";

await verifyScenarioSourceSafety(path.resolve("tests/journeys"));
process.stdout.write("journey scenario locator-only static gate: PASS\n");
