import type { ProviderFact, SessionTurnRecord } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  applyProviderFactToSessionTurn,
  hasSessionTurnTerminalFailure,
  indexSessionTurns,
  resolveProviderFactSessionTurn,
  resolveSessionTurnFinalContent,
} from "./session-turns";

const NOW = "2026-08-09T00:00:00.000Z";

describe("ProviderFact SessionTurn correlation", () => {
  it("requires every supplied Runtime key to resolve to the same unique Turn", () => {
    const first = turn("first");
    const second = turn("second");
    const index = indexSessionTurns([first, second]);

    expect(resolveProviderFactSessionTurn(fact("turn_started", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: first.inputSubmissionId,
      invocationId: first.invocationId,
    }), index)).toEqual(first);
    expect(resolveProviderFactSessionTurn(fact("turn_started", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: second.inputSubmissionId,
    }), index)).toBeUndefined();
    expect(resolveProviderFactSessionTurn(fact("turn_started", {
      sessionTurnId: "session_turn_missing",
    }), index)).toBeUndefined();

    const ambiguousInvocation = indexSessionTurns([
      first,
      { ...second, invocationId: first.invocationId },
    ]);
    expect(resolveProviderFactSessionTurn(fact("turn_started", {
      invocationId: first.invocationId,
    }), ambiguousInvocation)).toBeUndefined();
  });

  it("never advances, completes, or fails a Turn from cross-Turn facts", () => {
    const first = turn("first");
    const second = turn("second");
    const index = indexSessionTurns([first, second]);
    const crossTurnFinal = fact("assistant_final", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: second.inputSubmissionId,
    }, { content: "must not route" });
    const firstCompleted = fact("turn_completed", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: first.inputSubmissionId,
      invocationId: first.invocationId,
    });
    const crossTurnFailure = fact("turn_failed", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: second.inputSubmissionId,
    });

    expect(applyProviderFactToSessionTurn(first, crossTurnFinal, NOW, index)).toEqual(first);
    expect(resolveSessionTurnFinalContent(first, [crossTurnFinal, firstCompleted], index)).toBeUndefined();
    expect(hasSessionTurnTerminalFailure(first, [crossTurnFailure], index)).toBe(false);

    const firstFinal = fact("assistant_final", {
      sessionTurnId: first.sessionTurnId,
      inputSubmissionId: first.inputSubmissionId,
      invocationId: first.invocationId,
    }, { content: "verified final" });
    expect(resolveSessionTurnFinalContent(first, [firstFinal, firstCompleted], index)).toBe("verified final");
  });
});

function turn(suffix: string): SessionTurnRecord {
  return {
    sessionTurnId: `session_turn_${suffix}`,
    taskId: "task_001",
    runId: "run_001",
    inputSubmissionId: `input_${suffix}`,
    targetLogicalSessionId: `logical_session_${suffix}`,
    kind: "session_agent",
    initiator: "conductor",
    trigger: "conductor_invocation",
    replyToLogicalSessionId: "logical_session_conductor",
    invocationId: `invocation_${suffix}`,
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fact(
  kind: ProviderFact["kind"],
  correlation: ProviderFact["correlation"],
  payload: ProviderFact["payload"] = {},
): ProviderFact {
  return {
    providerFactId: `provider_fact_${kind}_${JSON.stringify(correlation).length}`,
    provider: "codex",
    bindingId: "binding_001",
    bindingRevision: 1,
    kind,
    deduplication: { providerEventId: `event_${kind}_${JSON.stringify(correlation).length}` },
    correlation,
    payload,
    observedAt: NOW,
  };
}
