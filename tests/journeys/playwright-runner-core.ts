import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import {
  createLocatorActionDriver,
  executeLocatorActionScenario,
  type HostCommandLedgerEntry,
  type HostCommandLedgerReader,
  type LocatorAction,
  type LocatorActionScenario,
  type LocatorTarget,
  type RunnerCheckpointBoundary,
} from "./locator-action-dsl.js";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_VISIBLE_ACTION_TIMEOUT_MS = 120_000;

export type ActualOperationResult = Awaited<ReturnType<typeof executeLocatorActionScenario>>;

export function createPlaywrightLocatorDriver(
  page: Page,
  options: Readonly<{ signal?: AbortSignal }> = {},
) {
  const locator = (target: LocatorTarget): Locator => {
    switch (target.by) {
      case "role": return page.getByRole(target.role, { name: target.name });
      case "label": return page.getByLabel(target.name);
      case "testId": return page.getByTestId(target.value);
      case "text": return page.getByText(target.value, { exact: target.exact });
    }
  };
  const actionOptions = () => Object.freeze({
    timeout: PLAYWRIGHT_VISIBLE_ACTION_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const perform = async (
    action: LocatorAction["action"],
    target: LocatorTarget,
    operation: (resolved: Locator) => Promise<void>,
  ): Promise<void> => {
    try {
      options.signal?.throwIfAborted();
      await operation(locator(target));
    } catch (error) {
      const outcome = options.signal?.aborted
        ? "aborted"
        : isPlaywrightTimeout(error) ? "timeout" : "failed";
      throw new PlaywrightLocatorActionFailure(action, target, outcome);
    }
  };
  return createLocatorActionDriver({
    async click(target) {
      await perform("click", target, (resolved) => resolved.click(actionOptions()));
    },
    async fill(target, value) {
      await perform("fill", target, (resolved) => resolved.fill(value, actionOptions()));
    },
    async select(target, value) {
      await perform("select", target, (resolved) => resolved.selectOption(value, actionOptions()).then(() => undefined));
    },
    async press(target, key) {
      await perform("press", target, (resolved) => resolved.press(key, actionOptions()));
    },
    async expectVisible(target) {
      await perform("expectVisible", target, (resolved) => resolved.waitFor({ state: "visible", ...actionOptions() }));
    },
  });
}

export function createReadOnlyHostLedgerReader(input: Readonly<{
  source: string;
  accessToken?: string;
}>): HostCommandLedgerReader {
  if (!input.source) throw new Error("BLOCKED_CAPABILITY: journey Host evidence ledger source is missing");
  if (/^https?:\/\//.test(input.source)) {
    const endpoint = new URL(input.source);
    if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
      throw new Error("journey_host_evidence_endpoint_must_be_loopback");
    }
    return Object.freeze({
      async snapshot(): Promise<readonly HostCommandLedgerEntry[]> {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : undefined,
          redirect: "error",
        });
        if (!response.ok) throw new Error(`journey_host_evidence_endpoint_${response.status}`);
        return parseLedger(await response.text());
      },
    });
  }
  if (!path.isAbsolute(input.source)) throw new Error("journey_host_evidence_file_must_be_absolute");
  return Object.freeze({
    async snapshot(): Promise<readonly HostCommandLedgerEntry[]> {
      return parseLedger(await readFile(input.source, "utf8"));
    },
  });
}

export function createAuditedHostRestartBoundary(
  restartExecutable: string | undefined,
  providerBarrierExecutable?: string,
  providerClockEnabled = true,
): RunnerCheckpointBoundary {
  let restarted = false;
  return Object.freeze({
    async afterAction(action: LocatorAction) {
      const providerStage = providerClockEnabled ? controlledProviderStageAfterAction(action) : undefined;
      if (providerStage) {
        if (!providerBarrierExecutable) {
          throw new Error("BLOCKED_CAPABILITY: controlled Provider barrier runner is missing");
        }
        if (!path.isAbsolute(providerBarrierExecutable)) {
          throw new Error("journey_provider_barrier_runner_must_be_absolute");
        }
        await execFileAsync(providerBarrierExecutable, [providerStage], {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: narrowJourneyExecutableEnvironment(),
        });
      }
      if (!["J-08", "J-10"].includes(action.checkpoint)
        || action.intentKind !== "view.task.before_restart" || restarted) return;
      if (!restartExecutable) {
        throw new Error("BLOCKED_CAPABILITY: audited Host restart runner is missing");
      }
      if (!path.isAbsolute(restartExecutable)) {
        throw new Error("journey_host_restart_runner_must_be_absolute");
      }
      await execFileAsync(restartExecutable, [], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: narrowJourneyExecutableEnvironment(),
      });
      restarted = true;
    },
  });
}

export async function runActualOperationScenario(input: Readonly<{
  page: Page;
  scenario: LocatorActionScenario;
  hostLedger: HostCommandLedgerReader;
  traceNamespace: string;
  restartExecutable?: string;
  providerBarrierExecutable?: string;
  providerClockEnabled?: boolean;
  signal?: AbortSignal;
}>): Promise<ActualOperationResult> {
  try {
    return await executeLocatorActionScenario({
      scenario: input.scenario,
      driver: createPlaywrightLocatorDriver(input.page, { signal: input.signal }),
      hostLedger: input.hostLedger,
      traceNamespace: input.traceNamespace,
      checkpointBoundary: createAuditedHostRestartBoundary(
        input.restartExecutable,
        input.providerBarrierExecutable,
        input.providerClockEnabled ?? true,
      ),
    });
  } catch (error) {
    if (!(error instanceof Error) || !(error.cause instanceof PlaywrightLocatorActionFailure)) throw error;
    const locatorFailure = error.cause;
    throw new Error(
      `${error.message}:${locatorFailure.targetCode}:${locatorFailure.outcomeCode}`,
      { cause: error },
    );
  }
}

export function controlledProviderStageAfterAction(action: LocatorAction): string | undefined {
  const stages = new Map<string, string>([
    ["view.session.materialized", "j05_researcher_waiting_observed"],
    ["view.session.final", "j06_researcher_final_observed"],
    ["view.human.idle_direct_delivered", "j08_idle_human_delivered_observed"],
    ["view.human.held", "j08_busy_human_held_observed"],
    ["view.branch.human_held", "j08_late_final_human_held_observed"],
    ["session.request_interrupt", "j09_human_interrupt_intent_recorded"],
    ["task.submit_input", "j09_conductor_interrupt_intent_recorded"],
  ]);
  return stages.get(action.intentKind);
}

/**
 * Generated restart/barrier wrappers own their mode-0600 control sidecar.
 * Only non-secret OS process variables are forwarded to those executables.
 */
export function narrowJourneyExecutableEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const allowlist = [
    "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
  ];
  return Object.fromEntries(allowlist.flatMap((name) => {
    const value = source[name];
    return typeof value === "string" ? [[name, value] as const] : [];
  }));
}

export async function appendRunnerActionEvidence(
  file: string | undefined,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!file) return;
  if (!path.isAbsolute(file)) throw new Error("journey_action_evidence_file_must_be_absolute");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

function parseLedger(source: string): readonly HostCommandLedgerEntry[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  let value: unknown;
  try {
    value = trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed.split("\n").map((line) => JSON.parse(line));
  } catch {
    throw new Error("journey_host_evidence_ledger_invalid_json");
  }
  if (!Array.isArray(value)) throw new Error("journey_host_evidence_ledger_invalid_json");
  return value as readonly HostCommandLedgerEntry[];
}

class PlaywrightLocatorActionFailure extends Error {
  readonly targetCode: string;
  readonly outcomeCode: string;

  constructor(
    action: LocatorAction["action"],
    target: LocatorTarget,
    outcome: "aborted" | "failed" | "timeout",
  ) {
    const targetCode = safeLocatorTargetCode(target);
    const outcomeCode = outcome === "timeout"
      ? `timeout_${PLAYWRIGHT_VISIBLE_ACTION_TIMEOUT_MS}`
      : outcome;
    super(`journey_playwright_locator_action_${outcome}:${action}:${targetCode}`);
    this.name = "PlaywrightLocatorActionFailure";
    this.targetCode = targetCode;
    this.outcomeCode = outcomeCode;
  }
}

function safeLocatorTargetCode(target: LocatorTarget): string {
  if (target.by !== "testId") return `target_${target.by}`;
  return /^[A-Za-z0-9_.:-]{1,160}$/u.test(target.value)
    ? `target_testId_${target.value}`
    : "target_testId_redacted";
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
