import type { InvocationRecord, SessionMessageRecord } from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { authorizeRequestedArtifactClaim } from "./artifacts.js";

const invocation: InvocationRecord = {
  invocationId: "invocation_report",
  taskId: "task_report",
  runId: "run_report",
  replyToLogicalSessionId: "logical_session_conductor",
  targetLogicalSessionId: "logical_session_writer",
  targetAgentCardId: "agent_card_writer",
  bindingId: "binding_writer",
  assignmentMessageId: "message_assignment",
  instruction: "Write the report.",
  acceptanceCriteria: ["Return the requested artifact"],
  requestedArtifacts: ["reports/NVDA-deepsearch.html"],
  finalMessageId: "message_writer_final",
  status: "returned",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:01:00.000Z",
};

const finalMessage: SessionMessageRecord = {
  messageId: "message_writer_final",
  taskId: invocation.taskId,
  runId: invocation.runId,
  sourceLogicalSessionId: invocation.targetLogicalSessionId,
  sourceSessionTurnId: "session_turn_writer",
  invocationId: invocation.invocationId,
  kind: "agent_final",
  content: "Completed the requested report.\n\nArtifact: reports/NVDA-deepsearch.html",
  contentDigest: "sha256:final",
  createdAt: invocation.updatedAt,
};

describe("authorizeRequestedArtifactClaim", () => {
  it("authorizes only the returned Invocation's requested path and canonical final", () => {
    expect(authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: finalMessage,
      conductorLogicalSessionId: "logical_session_conductor",
      workspaceRelativePath: "./reports/NVDA-deepsearch.html",
    })).toEqual({
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
      sourceInvocationId: invocation.invocationId,
      sourceMessageId: finalMessage.messageId,
    });
  });

  it("rejects unrequested, unclaimed, non-final, or unfinished provenance", () => {
    expect(() => authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: finalMessage,
      conductorLogicalSessionId: "logical_session_conductor",
      workspaceRelativePath: "reports/other.html",
    })).toThrow("artifact_path_not_requested");
    expect(() => authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: { ...finalMessage, content: "Done." },
      conductorLogicalSessionId: "logical_session_conductor",
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
    })).toThrow("artifact_path_not_claimed_in_final");
    expect(() => authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: { ...finalMessage, messageId: "message_other_final" },
      conductorLogicalSessionId: "logical_session_conductor",
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
    })).toThrow("artifact_source_message_not_invocation_final");
    expect(() => authorizeRequestedArtifactClaim({
      invocation: { ...invocation, status: "awaiting_final" },
      sourceFinalMessage: finalMessage,
      conductorLogicalSessionId: "logical_session_conductor",
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
    })).toThrow("artifact_invocation_not_returned");
  });

  it("requires an exact declaration line rather than a substring or Markdown link", () => {
    for (const content of [
      "Artifact: reports/NVDA-deepsearch.html.bak",
      "Artifact: backup-reports/NVDA-deepsearch.html",
      "[report](reports/NVDA-deepsearch.html)",
      "- Artifact: reports/NVDA-deepsearch.html",
      "Artifact: `reports/NVDA-deepsearch.html`",
    ]) {
      expect(() => authorizeRequestedArtifactClaim({
        invocation,
        sourceFinalMessage: { ...finalMessage, content },
        conductorLogicalSessionId: "logical_session_conductor",
        workspaceRelativePath: "reports/NVDA-deepsearch.html",
      })).toThrow("artifact_path_not_claimed_in_final");
    }
  });

  it("rejects an Invocation that does not reply to this Run's Conductor", () => {
    expect(() => authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: finalMessage,
      conductorLogicalSessionId: "logical_session_other_conductor",
      workspaceRelativePath: "reports/NVDA-deepsearch.html",
    })).toThrow("artifact_source_invocation_not_conductor_owned");
  });
});
