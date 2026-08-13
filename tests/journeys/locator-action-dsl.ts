import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FullJourneyCheckpoint } from "../e2e/journey-evidence.js";

export type LocatorTarget =
  | Readonly<{ by: "role"; role: "button" | "textbox" | "tab" | "link" | "option" | "heading"; name: string }>
  | Readonly<{ by: "label"; name: string }>
  | Readonly<{ by: "testId"; value: string }>
  | Readonly<{ by: "text"; value: string; exact?: boolean }>;

export type LocatorAction = Readonly<{
  checkpoint: FullJourneyCheckpoint;
  target: LocatorTarget;
  intentKind: string;
  expectedHostCommands?: number;
}> & (
  | Readonly<{ action: "click" }>
  | Readonly<{ action: "fill"; value: string }>
  | Readonly<{ action: "select"; value: string }>
  | Readonly<{ action: "press"; key: "Enter" | "Escape" | "Space" | "Tab" }>
  | Readonly<{ action: "expectVisible" }>
);

/**
 * Scenario-owned data contains only visible locator actions. Release identity,
 * evidence class, surface, status and durable lineage are runner-owned.
 */
export type LocatorActionScenario = Readonly<{
  scenarioId: string;
  actions: readonly LocatorAction[];
}>;

export type HostCommandLedgerEntry = Readonly<{
  commandId: string;
  uiIntentId: string;
  intentKind: string;
  runtimeInstanceId: string;
  source: "authenticated_runtime_bridge";
}>;

export type JourneyActionTrace = Readonly<{
  actionTraceId: string;
  scenarioId: string;
  checkpoint: FullJourneyCheckpoint;
  intentKind: string;
  action: LocatorAction["action"];
  target: LocatorTarget;
  expectedHostCommands: number;
}>;

export type ActionCommandCorrelation = Readonly<{
  actionTraceId: string;
  scenarioId: string;
  checkpoint: FullJourneyCheckpoint;
  intentKind: string;
  uiIntentId: string;
  commandId: string;
  runtimeInstanceId: string;
}>;

export interface LocatorActionDriver {
  click(target: LocatorTarget): Promise<void>;
  fill(target: LocatorTarget, value: string): Promise<void>;
  select(target: LocatorTarget, value: string): Promise<void>;
  press(target: LocatorTarget, key: "Enter" | "Escape" | "Space" | "Tab"): Promise<void>;
  expectVisible(target: LocatorTarget): Promise<void>;
}

export interface HostCommandLedgerReader {
  snapshot(): Promise<readonly HostCommandLedgerEntry[]>;
}

export interface RunnerCheckpointBoundary {
  beforeCheckpoint?(checkpoint: FullJourneyCheckpoint): Promise<void>;
  afterAction?(action: LocatorAction, index: number): Promise<void>;
}

export type ProductionLocatorCoverage = Readonly<{
  requiredTestIds: readonly string[];
  coveredTestIds: readonly string[];
  missingTestIds: readonly string[];
}>;

const DRIVER_REGISTRY = new WeakSet<object>();

export function createLocatorActionDriver(
  implementation: LocatorActionDriver,
): LocatorActionDriver {
  const driver = Object.freeze(Object.assign(Object.create(null) as LocatorActionDriver, {
    click: (target: LocatorTarget) => implementation.click(target),
    fill: (target: LocatorTarget, value: string) => implementation.fill(target, value),
    select: (target: LocatorTarget, value: string) => implementation.select(target, value),
    press: (target: LocatorTarget, key: "Enter" | "Escape" | "Space" | "Tab") => implementation.press(target, key),
    expectVisible: (target: LocatorTarget) => implementation.expectVisible(target),
  }));
  DRIVER_REGISTRY.add(driver);
  return driver;
}

export async function executeLocatorActionScenario(input: Readonly<{
  scenario: LocatorActionScenario;
  driver: LocatorActionDriver;
  hostLedger: HostCommandLedgerReader;
  traceNamespace: string;
  checkpointBoundary?: RunnerCheckpointBoundary;
}>): Promise<Readonly<{
  traces: readonly JourneyActionTrace[];
  correlations: readonly ActionCommandCorrelation[];
}>> {
  validateScenario(input.scenario);
  if (!DRIVER_REGISTRY.has(input.driver)) throw new Error("journey_locator_driver_not_runner_owned");
  if (!/^trace_namespace_[A-Za-z0-9-]+$/.test(input.traceNamespace)) {
    throw new Error("journey_action_trace_namespace_invalid");
  }

  const traces: JourneyActionTrace[] = [];
  const correlations: ActionCommandCorrelation[] = [];
  let previousCommands = await input.hostLedger.snapshot();
  validateHostLedger(previousCommands);
  let previousCheckpoint: FullJourneyCheckpoint | undefined;

  for (const [index, action] of input.scenario.actions.entries()) {
    if (action.checkpoint !== previousCheckpoint) {
      if (input.checkpointBoundary?.beforeCheckpoint) {
        await input.checkpointBoundary.beforeCheckpoint(action.checkpoint);
        previousCommands = await input.hostLedger.snapshot();
        validateHostLedger(previousCommands);
      }
      previousCheckpoint = action.checkpoint;
    }
    const actionTraceId = `action_trace_${input.traceNamespace.slice("trace_namespace_".length)}-${index + 1}`;
    const trace = Object.freeze({
      actionTraceId,
      scenarioId: input.scenario.scenarioId,
      checkpoint: action.checkpoint,
      intentKind: action.intentKind,
      action: action.action,
      target: action.target,
      expectedHostCommands: action.expectedHostCommands ?? 0,
    });
    traces.push(trace);

    try {
      await performAction(input.driver, action);
    } catch (error) {
      throw new Error(
        `journey_visible_action_failed:${action.checkpoint}:${action.intentKind}:${action.action}`,
        { cause: error },
      );
    }
    const previousIds = new Set(previousCommands.map(({ commandId }) => commandId));
    const nextCommands = await waitForHostCommandCount(
      input.hostLedger,
      previousIds,
      action.expectedHostCommands ?? 0,
    );
    const newCommands = nextCommands.filter(({ commandId }) => !previousIds.has(commandId));
    const expectedHostCommands = action.expectedHostCommands ?? 0;
    if (newCommands.length !== expectedHostCommands) {
      throw new Error(
        `journey_visible_action_host_command_count_mismatch:${action.checkpoint}:${action.intentKind}`
        + `:expected_${expectedHostCommands}:observed_${newCommands.length}`,
      );
    }
    for (const command of newCommands) {
      if (command.intentKind !== action.intentKind) {
        throw new Error(
          `journey_visible_action_host_command_mismatch:${action.checkpoint}`
          + `:expected_${action.intentKind}:observed_${command.intentKind}`,
        );
      }
      correlations.push(Object.freeze({
        actionTraceId,
        scenarioId: input.scenario.scenarioId,
        checkpoint: action.checkpoint,
        intentKind: command.intentKind,
        uiIntentId: command.uiIntentId,
        commandId: command.commandId,
        runtimeInstanceId: command.runtimeInstanceId,
      }));
    }
    previousCommands = nextCommands;
    if (input.checkpointBoundary?.afterAction) {
      await input.checkpointBoundary.afterAction(action, index);
      previousCommands = await input.hostLedger.snapshot();
      validateHostLedger(previousCommands);
    }
  }

  verifyActionCommandCorrelation(traces, correlations);
  return Object.freeze({ traces: Object.freeze(traces), correlations: Object.freeze(correlations) });
}

async function waitForHostCommandCount(
  ledger: HostCommandLedgerReader,
  previousIds: ReadonlySet<string>,
  expected: number,
): Promise<readonly HostCommandLedgerEntry[]> {
  const deadline = Date.now() + (expected > 0 ? 10_000 : 100);
  let latest: readonly HostCommandLedgerEntry[] = [];
  do {
    latest = await ledger.snapshot();
    validateHostLedger(latest);
    const count = latest.filter(({ commandId }) => !previousIds.has(commandId)).length;
    if (count === expected && (expected > 0 || Date.now() >= deadline)) return latest;
    if (count > expected) return latest;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return latest;
}

export function verifyActionCommandCorrelation(
  traces: readonly JourneyActionTrace[],
  correlations: readonly ActionCommandCorrelation[],
): void {
  const traceById = new Map<string, JourneyActionTrace>();
  for (const trace of traces) {
    validateTrace(trace);
    if (traceById.has(trace.actionTraceId)) throw new Error("journey_action_trace_duplicate");
    traceById.set(trace.actionTraceId, trace);
  }

  const commandIds = new Set<string>();
  const uiIntentIds = new Set<string>();
  for (const correlation of correlations) {
    validateCorrelation(correlation);
    const trace = traceById.get(correlation.actionTraceId);
    if (!trace) throw new Error("journey_host_command_missing_visible_action");
    if (trace.scenarioId !== correlation.scenarioId
      || trace.checkpoint !== correlation.checkpoint
      || trace.intentKind !== correlation.intentKind) {
      throw new Error("journey_host_command_visible_action_mismatch");
    }
    if (commandIds.has(correlation.commandId)) throw new Error("journey_host_command_duplicate");
    if (uiIntentIds.has(correlation.uiIntentId)) throw new Error("journey_ui_intent_duplicate");
    commandIds.add(correlation.commandId);
    uiIntentIds.add(correlation.uiIntentId);
  }

  for (const trace of traces) {
    const expected = expectedHostCommandsForTrace(trace, traces);
    const actual = correlations.filter(({ actionTraceId }) => actionTraceId === trace.actionTraceId).length;
    if (actual !== expected) throw new Error("journey_visible_action_correlation_incomplete");
  }
}

export async function verifyScenarioSourceSafety(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error("journey_scenario_scan_root_must_be_absolute");
  const files = await listScenarioFiles(root);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const forbidden = FORBIDDEN_SCENARIO_SOURCE.find(({ pattern }) => pattern.test(source));
    if (forbidden) throw new Error(`journey_scenario_forbidden_${forbidden.name}:${path.basename(file)}`);
  }
}

export async function inspectProductionLocatorCoverage(input: Readonly<{
  productionRoots: readonly string[];
  scenarios: readonly LocatorActionScenario[];
}>): Promise<ProductionLocatorCoverage> {
  const requiredTestIds = [...new Set(input.scenarios.flatMap(({ actions }) => actions.flatMap(({ target }) =>
    target.by === "testId" ? [target.value] : [])))].sort();
  const sourceFiles = (await Promise.all(input.productionRoots.map((root) => listSourceFiles(root)))).flat();
  const declared = new Set<string>();
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) {
      if (match[1]) declared.add(match[1]);
    }
  }
  const coveredTestIds = requiredTestIds.filter((testId) => declared.has(testId));
  const missingTestIds = requiredTestIds.filter((testId) => !declared.has(testId));
  return Object.freeze({
    requiredTestIds: Object.freeze(requiredTestIds),
    coveredTestIds: Object.freeze(coveredTestIds),
    missingTestIds: Object.freeze(missingTestIds),
  });
}

const FORBIDDEN_SCENARIO_SOURCE = [
  { name: "playwright_import", pattern: /from\s+["'](?:@playwright\/test|playwright(?:\/[^"']*)?)["']/ },
  { name: "electron_import", pattern: /from\s+["']electron["']/ },
  { name: "runtime_client", pattern: /(?:RuntimeClient|runtime-client|runtimeClient)/ },
  { name: "host_or_testkit_import", pattern: /from\s+["'][^"']*(?:runtime-host|conductor-tools|test-kit)[^"']*["']/ },
  { name: "evidence_authority_import", pattern: /from\s+["'][^"']*(?:journey-evidence|evidence-issuers|release-verifier)[^"']*["']/ },
  { name: "preload_facade", pattern: /(?:preload|\bwindow\b|\bdocument\b|\bglobalThis\b)/i },
  { name: "raw_handle", pattern: /\b(?:Page|BrowserContext|ElectronApplication)\b/ },
  { name: "raw_locator", pattern: /\.\s*locator\s*\(/ },
  { name: "evaluate", pattern: /\.\s*evaluate(?:Handle)?\s*\(/ },
  { name: "request", pattern: /\.\s*request\b/ },
  { name: "fetch", pattern: /\bfetch\s*\(/ },
] as const;

async function performAction(driver: LocatorActionDriver, action: LocatorAction): Promise<void> {
  switch (action.action) {
    case "click": return driver.click(action.target);
    case "fill": return driver.fill(action.target, action.value);
    case "select": return driver.select(action.target, action.value);
    case "press": return driver.press(action.target, action.key);
    case "expectVisible": return driver.expectVisible(action.target);
  }
}

function expectedHostCommandsForTrace(trace: JourneyActionTrace, traces: readonly JourneyActionTrace[]): number {
  const matching = traces.filter(({ actionTraceId }) => actionTraceId === trace.actionTraceId);
  if (matching.length !== 1) throw new Error("journey_action_trace_duplicate");
  return matching[0]!.expectedHostCommands;
}

function validateScenario(scenario: LocatorActionScenario): void {
  if (!scenario || typeof scenario !== "object"
    || !/^scenario_[A-Za-z0-9-]+$/.test(scenario.scenarioId)
    || !Array.isArray(scenario.actions)
    || scenario.actions.length === 0) {
    throw new Error("journey_locator_scenario_invalid");
  }
  const keys = Object.keys(scenario);
  if (keys.some((key) => !["scenarioId", "actions"].includes(key))) {
    throw new Error("journey_locator_scenario_authority_field_forbidden");
  }
  for (const action of scenario.actions) validateAction(action);
}

function validateAction(action: LocatorAction): void {
  if (!action || typeof action !== "object"
    || !/^J-(?:0[1-9]|1[0-2])$/.test(action.checkpoint)
    || typeof action.intentKind !== "string"
    || action.intentKind.length === 0
    || (action.expectedHostCommands !== undefined
      && (!Number.isSafeInteger(action.expectedHostCommands) || action.expectedHostCommands < 0 || action.expectedHostCommands > 8))) {
    throw new Error("journey_locator_action_invalid");
  }
  validateTarget(action.target);
}

function validateTarget(target: LocatorTarget): void {
  if (!target || typeof target !== "object") throw new Error("journey_locator_target_invalid");
  const value = target.by === "role" || target.by === "label" ? target.name : target.value;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("journey_locator_target_invalid");
  }
}

function validateHostLedger(entries: readonly HostCommandLedgerEntry[]): void {
  if (!Array.isArray(entries)) throw new Error("journey_host_ledger_invalid");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object"
      || Object.keys(entry).some((key) => ![
        "commandId", "uiIntentId", "intentKind", "runtimeInstanceId", "source",
      ].includes(key))
      || !/^command_[A-Za-z0-9-]+$/.test(entry.commandId)
      || !/^ui_intent_[A-Za-z0-9-]+$/.test(entry.uiIntentId)
      || !/^runtime_instance_[A-Za-z0-9-]+$/.test(entry.runtimeInstanceId)
      || typeof entry.intentKind !== "string"
      || entry.intentKind.length === 0
      || entry.intentKind.length > 128
      || entry.source !== "authenticated_runtime_bridge"
      || ids.has(entry.commandId)) {
      throw new Error("journey_host_ledger_invalid");
    }
    ids.add(entry.commandId);
  }
}

function validateTrace(trace: JourneyActionTrace): void {
  if (!/^action_trace_[A-Za-z0-9-]+$/.test(trace.actionTraceId)
    || !/^scenario_[A-Za-z0-9-]+$/.test(trace.scenarioId)
    || !/^J-(?:0[1-9]|1[0-2])$/.test(trace.checkpoint)
    || !Number.isSafeInteger(trace.expectedHostCommands)
    || trace.expectedHostCommands < 0
    || trace.expectedHostCommands > 8) {
    throw new Error("journey_action_trace_invalid");
  }
  validateTarget(trace.target);
}

function validateCorrelation(correlation: ActionCommandCorrelation): void {
  if (!/^action_trace_[A-Za-z0-9-]+$/.test(correlation.actionTraceId)
    || !/^scenario_[A-Za-z0-9-]+$/.test(correlation.scenarioId)
    || !/^J-(?:0[1-9]|1[0-2])$/.test(correlation.checkpoint)
    || !/^ui_intent_[A-Za-z0-9-]+$/.test(correlation.uiIntentId)
    || !/^command_[A-Za-z0-9-]+$/.test(correlation.commandId)
    || !/^runtime_instance_[A-Za-z0-9-]+$/.test(correlation.runtimeInstanceId)) {
    throw new Error("journey_action_command_correlation_invalid");
  }
}

async function listScenarioFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const rootStatus = await stat(root);
  if (rootStatus.isFile()) return root.endsWith(".scenario.ts") ? [root] : [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listScenarioFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".scenario.ts")) result.push(absolute);
  }
  return result.sort();
}

async function listSourceFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const rootStatus = await stat(root);
  if (rootStatus.isFile()) return /\.[cm]?[jt]sx?$/.test(root) ? [root] : [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listSourceFiles(absolute));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) result.push(absolute);
  }
  return result.sort();
}
