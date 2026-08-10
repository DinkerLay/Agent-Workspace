import type { InvocationRecord, SessionMessageRecord } from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";
import { normalizeRequestedArtifactPaths } from "./messages.js";

export type RequestedArtifactClaim = Readonly<{
  workspaceRelativePath: string;
  sourceInvocationId: string;
  sourceMessageId: string;
}>;

/**
 * Authorizes one Host verification request from durable collaboration facts.
 * It never touches the filesystem: the Host-owned ManagedArtifactPort performs
 * canonical path resolution and byte verification after this check succeeds.
 */
export function authorizeRequestedArtifactClaim(input: Readonly<{
  invocation: InvocationRecord;
  sourceFinalMessage: SessionMessageRecord;
  conductorLogicalSessionId: string;
  workspaceRelativePath: string;
}>): RequestedArtifactClaim {
  const requestedPath = normalizeRequestedArtifactPaths([input.workspaceRelativePath])[0]!;
  const requestedArtifacts = normalizeRequestedArtifactPaths(input.invocation.requestedArtifacts);
  invariant(input.invocation.status === "returned", "artifact_invocation_not_returned");
  invariant(Boolean(input.invocation.finalMessageId), "artifact_invocation_final_missing");
  invariant(input.sourceFinalMessage.messageId === input.invocation.finalMessageId, "artifact_source_message_not_invocation_final");
  invariant(input.sourceFinalMessage.kind === "agent_final", "artifact_source_message_kind_invalid");
  invariant(input.sourceFinalMessage.invocationId === input.invocation.invocationId, "artifact_source_message_invocation_mismatch");
  invariant(
    input.invocation.replyToLogicalSessionId === input.conductorLogicalSessionId
      && input.invocation.targetLogicalSessionId !== input.conductorLogicalSessionId,
    "artifact_source_invocation_not_conductor_owned",
  );
  invariant(
    input.sourceFinalMessage.taskId === input.invocation.taskId
      && input.sourceFinalMessage.runId === input.invocation.runId
      && input.sourceFinalMessage.sourceLogicalSessionId === input.invocation.targetLogicalSessionId,
    "artifact_source_message_scope_mismatch",
  );
  invariant(requestedArtifacts.includes(requestedPath), "artifact_path_not_requested");
  const declaredPaths = artifactDeclarations(input.sourceFinalMessage.content);
  invariant(declaredPaths.includes(requestedPath), "artifact_path_not_claimed_in_final");
  return Object.freeze({
    workspaceRelativePath: requestedPath,
    sourceInvocationId: input.invocation.invocationId,
    sourceMessageId: input.sourceFinalMessage.messageId,
  });
}

/**
 * A final must opt into one exact, auditable declaration grammar. Ordinary
 * prose, Markdown links, tool output, and prefix/suffix matches are not claims.
 */
export function artifactDeclarations(content: string): readonly string[] {
  const declarations = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^Artifact: ([^\n]+)$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
  return normalizeRequestedArtifactPaths(declarations);
}
