import { createHash } from "node:crypto";
import { canonicalJson } from "@agent-workspace/runtime-contracts";
import type { RuntimeRepositories, SessionIdCanonicalStore } from "@agent-workspace/runtime-store";

export type SessionIdObservedLineage = Readonly<{
  schemaVersion: 1;
  runtimeInstanceId: string;
  templateDraftIds: readonly string[];
  taskSetupDraftIds: readonly string[];
  taskIds: readonly string[];
  runIds: readonly string[];
  metaSessionIds: readonly string[];
  metaTurnIds: readonly string[];
  cardSessionSlotIds: readonly string[];
  logicalSessionIds: readonly string[];
  bindingIds: readonly string[];
  messageIds: readonly string[];
  messageForwardIds: readonly string[];
  humanInterventionIds: readonly string[];
  inputSubmissionIds: readonly string[];
  sessionTurnIds: readonly string[];
  sessionControlAuditIds: readonly string[];
  canonicalDigest: string;
}>;

/**
 * Host-owned release projection. Every identifier is rediscovered from the
 * persisted owner rows (and correlated Provider facts); no expected allocator,
 * launch manifest, or Renderer payload is accepted as input.
 */
export function projectSessionIdObservedLineage(input: Readonly<{
  runtimeInstanceId: string;
  authenticatedUserId: string;
  repositories: RuntimeRepositories;
  canonical: SessionIdCanonicalStore;
}>): SessionIdObservedLineage {
  const metaSessions = input.repositories.configuration.listMetaSessions()
    .filter((session) => session.ownerId === input.authenticatedUserId)
    .sort((left, right) => metaModeOrder(left.mode) - metaModeOrder(right.mode)
      || left.createdAt.localeCompare(right.createdAt)
      || left.metaSessionId.localeCompare(right.metaSessionId));
  const templateDraftIds = uniqueSorted([
    ...input.repositories.templateTask.listDrafts()
      .filter((draft) => draft.ownerId === input.authenticatedUserId)
      .map((draft) => draft.templateDraftId),
    ...metaSessions.flatMap((session) => session.target.kind === "template_draft"
      ? [session.target.templateDraftId]
      : []),
  ]);
  const taskSetupDraftIds = input.repositories.configuration.listTaskSetupDrafts()
    .filter((draft) => draft.ownerId === input.authenticatedUserId)
    .sort(byCreatedAtThen((draft) => draft.taskSetupDraftId))
    .map((draft) => draft.taskSetupDraftId);
  const tasks = input.canonical.taskRun.listOwnedTaskIds()
    .map((taskId) => required(input.repositories.templateTask.getTask(taskId), "session_id_observed_task_missing"));
  const runs = tasks.flatMap((task) => input.canonical.taskRun.listRuns(task.taskId));
  const logicalSessionIds: string[] = [];
  const cardSessionSlotIds: string[] = [];
  const bindingIds: string[] = [];
  const messageIds: string[] = [];
  const messageForwardIds: string[] = [];
  const humanInterventionIds: string[] = [];
  const sessionControlAuditIds: string[] = [];
  const inputSubmissions = new Map<string, Readonly<{ inputSubmissionId: string; createdAt: string }>>();
  const turns = new Map<string, Readonly<{ sessionTurnId: string; inputSubmissionId: string; createdAt: string }>>();

  for (const run of runs) {
    const architecture = required(
      input.repositories.templateTask.getArchitectureSnapshot(run.taskId),
      "session_id_observed_architecture_missing",
    );
    const sessionIds = [run.conductorLogicalSessionId];
    messageIds.push(...input.canonical.message.listMessages(run.runId).map((message) => message.messageId));
    messageForwardIds.push(...input.canonical.message.listForwards(run.runId).map((forward) => forward.forwardId));
    humanInterventionIds.push(...input.canonical.humanIntervention.list(run.runId)
      .map((intervention) => intervention.humanInterventionId));
    sessionControlAuditIds.push(...input.canonical.orchestration.listControlAudits(run.runId)
      .map((audit) => audit.sessionControlAuditId));
    for (const card of architecture.definition.agentCards) {
      const slot = input.canonical.taskRun.findSlot(run.runId, card.agentCardId);
      if (!slot) continue;
      cardSessionSlotIds.push(slot.cardSessionSlotId);
      sessionIds.push(...input.canonical.taskRun.listGenerations(slot.cardSessionSlotId)
        .map((generation) => generation.sessionId));
    }
    for (const sessionId of sessionIds) {
      logicalSessionIds.push(sessionId);
      const binding = input.canonical.binding.getBindingForSession(sessionId);
      if (binding) {
        bindingIds.push(binding.bindingId);
        for (const fact of input.canonical.providerFact.listFacts(binding.bindingId)) {
          if (fact.correlation.inputSubmissionId) {
            const submission = required(
              input.canonical.orchestration.getInputSubmission(fact.correlation.inputSubmissionId),
              "session_id_observed_provider_input_missing",
            );
            inputSubmissions.set(submission.inputSubmissionId, submission);
          }
          if (fact.correlation.sessionTurnId) {
            const turn = required(
              input.canonical.orchestration.getTurn(fact.correlation.sessionTurnId),
              "session_id_observed_provider_turn_missing",
            );
            turns.set(turn.sessionTurnId, turn);
          }
        }
      }
      for (const inbox of input.canonical.orchestration.listInboxItems(sessionId)) {
        const submission = input.canonical.orchestration.findInputByInboxItem(inbox.inboxItemId);
        if (submission) inputSubmissions.set(submission.inputSubmissionId, submission);
      }
      for (const turn of input.canonical.orchestration.listTurns(sessionId)) {
        turns.set(turn.sessionTurnId, turn);
        const submission = input.canonical.orchestration.getInputSubmission(turn.inputSubmissionId);
        if (submission) inputSubmissions.set(submission.inputSubmissionId, submission);
      }
    }
  }

  const lineage = Object.freeze({
    schemaVersion: 1 as const,
    runtimeInstanceId: input.runtimeInstanceId,
    templateDraftIds: Object.freeze(templateDraftIds),
    taskSetupDraftIds: Object.freeze(taskSetupDraftIds),
    taskIds: Object.freeze(tasks.map((task) => task.taskId)),
    runIds: Object.freeze(runs.map((run) => run.runId)),
    metaSessionIds: Object.freeze(metaSessions.map((session) => session.metaSessionId)),
    metaTurnIds: Object.freeze(metaSessions.flatMap((session) =>
      input.repositories.configuration.listMetaTurns(session.metaSessionId).map((turn) => turn.metaTurnId))),
    cardSessionSlotIds: Object.freeze(cardSessionSlotIds),
    logicalSessionIds: Object.freeze(uniqueInOrder(logicalSessionIds)),
    bindingIds: Object.freeze(uniqueInOrder(bindingIds)),
    messageIds: Object.freeze(messageIds),
    messageForwardIds: Object.freeze(messageForwardIds),
    humanInterventionIds: Object.freeze(humanInterventionIds),
    inputSubmissionIds: Object.freeze([...inputSubmissions.values()]
      .sort(byCreatedAtThen((submission) => submission.inputSubmissionId))
      .map((submission) => submission.inputSubmissionId)),
    sessionTurnIds: Object.freeze([...turns.values()]
      .sort(byCreatedAtThen((turn) => turn.sessionTurnId))
      .map((turn) => turn.sessionTurnId)),
    sessionControlAuditIds: Object.freeze(sessionControlAuditIds),
  });
  return Object.freeze({
    ...lineage,
    canonicalDigest: sessionIdObservedLineageDigest(lineage),
  });
}

export function sessionIdObservedLineageDigest(
  lineage: Omit<SessionIdObservedLineage, "canonicalDigest">,
): string {
  return `sha256:${createHash("sha256").update(canonicalJson(lineage as never)).digest("hex")}`;
}

function metaModeOrder(mode: "template_design" | "task_setup"): number {
  return mode === "template_design" ? 0 : 1;
}

function byCreatedAtThen<T extends Readonly<{ createdAt: string }>>(
  identity: (value: T) => string,
): (left: T, right: T) => number {
  return (left, right) => left.createdAt.localeCompare(right.createdAt)
    || identity(left).localeCompare(identity(right));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
