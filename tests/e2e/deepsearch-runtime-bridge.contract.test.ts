import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureModule = process.env.AGENT_WORKSPACE_JOURNEY_BRIDGE_FIXTURE
  ?? fileURLToPath(new URL("./support/session-id-deterministic-bridge-fixture.ts", import.meta.url));

type DeterministicBridgeFixture = Readonly<{
  runDeterministicSessionIdJourney(input: Readonly<{
    runtimeInstanceId: string;
    scenarioId: string;
  }>): Promise<Readonly<{ hostLedgerFile: string; fixtureRoot: string }>>;
}>;

type BridgeLedgerEntry = Readonly<{
  runtimeInstanceId: string;
  scenarioId: string;
  evidenceClass: string;
  issuer: string;
  surface: string;
  uiClaim: boolean;
  nativeClaim: boolean;
  checkpoint: string;
  event: string;
  toolName?: string;
  crashPoint?: string;
}>;

describe("deterministic Session-ID Runtime Bridge journey", () => {
  it("covers J-04..J-10 through the ACP Host/tool composition without UI/native claims", async () => {
    const module = await import(pathToImport(fixtureModule)) as Partial<DeterministicBridgeFixture>;
    if (typeof module.runDeterministicSessionIdJourney !== "function") {
      throw new Error("BLOCKED_CAPABILITY: deterministic Bridge fixture does not expose the Session-ID journey contract");
    }
    const result = await module.runDeterministicSessionIdJourney({
      runtimeInstanceId: "runtime_instance_bridge-fake-main",
      scenarioId: "scenario_bridge-fake-main",
    });
    try {
      if (!path.isAbsolute(result.hostLedgerFile) || !path.isAbsolute(result.fixtureRoot)) {
        throw new Error("journey_bridge_host_ledger_must_be_absolute");
      }
      const ledger = parseLedger(await readFile(result.hostLedgerFile, "utf8"));
      expect(new Set(ledger.map(({ checkpoint }) => checkpoint))).toEqual(new Set([
        "J-04", "J-05", "J-06", "J-07", "J-08", "J-09", "J-10",
      ]));
      expect(ledger.every((entry) => entry.runtimeInstanceId === "runtime_instance_bridge-fake-main"
        && entry.scenarioId === "scenario_bridge-fake-main"
        && entry.evidenceClass === "deterministic_fake"
        && entry.issuer === "runtime_host"
        && entry.surface === "runtime_bridge"
        && entry.uiClaim === false
        && entry.nativeClaim === false)).toBe(true);
      expect(new Set(ledger.filter(({ event }) => event === "conductor_tool_call").map(({ toolName }) => toolName)))
        .toEqual(new Set(["invoke_agent", "send_to_session", "interrupt_session", "close_session"]));
      expect(ledger.some(({ event }) => event === "publisher_native_file_write")).toBe(true);
      const j08Events = new Set(ledger.filter(({ checkpoint }) => checkpoint === "J-08").map(({ event }) => event));
      expect(j08Events.has("idle_human_turn_completed") && j08Events.has("human_intervention_released")).toBe(true);
      expect(new Set(ledger.filter(({ event }) => event === "host_crash_recovery").map(({ crashPoint }) => crashPoint)))
        .toEqual(new Set(["pending-lane", "tool-result", "provider-accepted", "human-interrupting", "final-before-inbox"]));
    } finally {
      await rm(result.fixtureRoot, { recursive: true, force: true });
    }
  });
});

function pathToImport(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("journey_bridge_fixture_must_be_absolute");
  return pathToFileURL(value).href;
}

function parseLedger(source: string): readonly BridgeLedgerEntry[] {
  const entries = source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as BridgeLedgerEntry);
  if (entries.length === 0 || entries.some((entry) => !entry || typeof entry !== "object")) {
    throw new Error("journey_bridge_host_ledger_invalid");
  }
  return entries;
}
