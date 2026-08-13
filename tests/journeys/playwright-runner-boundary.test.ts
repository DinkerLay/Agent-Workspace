import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  controlledProviderStageAfterAction,
  createPlaywrightLocatorDriver,
  narrowJourneyExecutableEnvironment,
  runActualOperationScenario,
} from "./playwright-runner-core.js";

describe("actual-operation runner process boundary", () => {
  it("forwards only non-secret OS variables to restart and Provider-stage executables", () => {
    const narrowed = narrowJourneyExecutableEnvironment({
      PATH: "/usr/bin",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: "evidence-secret",
      AGENT_WORKSPACE_RELEASE_NONCE: "release-secret",
      AGENT_WORKSPACE_CODEX_CREDENTIAL_ENV_REF: "OPENAI_API_KEY",
      OPENAI_API_KEY: "api-secret",
      CODEX_HOME: "credential-home",
      scenario: "scenario-secret",
      checkpoint: "checkpoint-secret",
    });
    expect(narrowed).toEqual({ PATH: "/usr/bin", TMPDIR: "/private/tmp", LANG: "en_US.UTF-8" });
    expect(JSON.stringify(narrowed)).not.toMatch(/secret|EVIDENCE|RELEASE|CODEX|API|scenario|checkpoint|credential/u);

    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "playwright-runner-core.ts"), "utf8");
    expect(source).not.toMatch(/execFileAsync\([^)]*[\s\S]{0,400}env:\s*process\.env/u);
  });

  it("advances only the six predeclared stages after their visible action boundary", () => {
    expect(controlledProviderStageAfterAction(action("view.session.materialized")))
      .toBe("j05_researcher_waiting_observed");
    expect(controlledProviderStageAfterAction(action("view.session.final")))
      .toBe("j06_researcher_final_observed");
    expect(controlledProviderStageAfterAction(action("view.human.idle_direct_delivered")))
      .toBe("j08_idle_human_delivered_observed");
    expect(controlledProviderStageAfterAction(action("view.human.held")))
      .toBe("j08_busy_human_held_observed");
    expect(controlledProviderStageAfterAction(action("view.branch.human_held")))
      .toBe("j08_late_final_human_held_observed");
    expect(controlledProviderStageAfterAction(action("session.request_interrupt")))
      .toBe("j09_human_interrupt_intent_recorded");
    expect(controlledProviderStageAfterAction(action("task.submit_input")))
      .toBe("j09_conductor_interrupt_intent_recorded");
    expect(controlledProviderStageAfterAction(action("view.task.running"))).toBeUndefined();
  });

  it("bounds a missing visible marker and reports the exact action and test id", async () => {
    const calls: unknown[] = [];
    const timeout = new Error("raw Playwright selector diagnostics must remain a cause");
    timeout.name = "TimeoutError";
    const page = pageWithTestIdLocator("missing-marker", {
      async click(options?: unknown) {
        calls.push(options);
        throw timeout;
      },
    });

    const failure = await runActualOperationScenario({
      page,
      scenario: {
        scenarioId: "scenario_missing-marker",
        actions: [{
          checkpoint: "J-02",
          action: "click",
          target: { by: "testId", value: "missing-marker" },
          intentKind: "view.missing_marker",
        }],
      },
      hostLedger: { snapshot: async () => [] },
      traceNamespace: "trace_namespace_missing-marker",
      providerClockEnabled: false,
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "journey_visible_action_failed:J-02:view.missing_marker:click:target_testId_missing-marker:timeout_120000",
    );
    expect(errorChainMessages(failure)).not.toContain("raw Playwright selector diagnostics");
    expect(calls).toEqual([{ timeout: 120_000 }]);
  });

  it("passes an AbortSignal to Playwright and fails safely before an already-aborted action starts", async () => {
    const calls: unknown[] = [];
    const page = pageWithTestIdLocator("aborted-marker", {
      async waitFor(options?: unknown) { calls.push(options); },
    });
    const controller = new AbortController();
    const createDriver = createPlaywrightLocatorDriver as unknown as (
      page: Page,
      options: Readonly<{ signal: AbortSignal }>,
    ) => ReturnType<typeof createPlaywrightLocatorDriver>;
    const driver = createDriver(page, { signal: controller.signal });

    await expect(driver.expectVisible({ by: "testId", value: "aborted-marker" })).resolves.toBeUndefined();
    expect(calls).toEqual([{
      signal: controller.signal,
      state: "visible",
      timeout: 120_000,
    }]);

    controller.abort(new Error("private shutdown reason"));
    await expect(driver.expectVisible({ by: "testId", value: "aborted-marker" }))
      .rejects.toThrow("journey_playwright_locator_action_aborted:expectVisible:target_testId_aborted-marker");
    expect(calls).toHaveLength(1);
  });
});

function action(intentKind: string) {
  return {
    checkpoint: "J-09",
    action: "expectVisible",
    target: { by: "testId", value: "marker" },
    intentKind,
  } as const;
}

function pageWithTestIdLocator(value: string, locator: Partial<Locator>): Page {
  return {
    getByTestId(candidate: string) {
      expect(candidate).toBe(value);
      return locator as Locator;
    },
  } as unknown as Page;
}

function errorChainMessages(value: unknown): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}
