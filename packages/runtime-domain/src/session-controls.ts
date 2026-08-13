import type { SessionControlAuditRecord, SessionControlState } from "../../runtime-contracts/src";
import { invariant } from "./errors";

export function createSessionControlAudit(input: Readonly<{
  sessionControlAuditId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  commandId: string;
  idempotencyKey: string;
  kind: SessionControlAuditRecord["kind"];
  affectedInboxItemIds?: readonly string[];
  now: string;
}>): SessionControlAuditRecord {
  invariant(input.sessionControlAuditId.startsWith("session_control_"), "session_control_audit_id_invalid");
  invariant(Boolean(input.idempotencyKey.trim()), "session_control_idempotency_key_required");
  return Object.freeze({
    sessionControlAuditId: input.sessionControlAuditId,
    taskId: input.taskId,
    runId: input.runId,
    sessionId: input.sessionId,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    state: input.kind === "close" ? "closed" : "requested",
    affectedInboxItemIds: Object.freeze([...(input.affectedInboxItemIds ?? [])]),
    requestedAt: input.now,
    ...(input.kind === "close" ? { settledAt: input.now } : {}),
  });
}
const CONTROL_TRANSITIONS: Readonly<Record<SessionControlState, readonly SessionControlState[]>> = Object.freeze({
  requested: ["accepted", "confirmed", "unknown", "rejected"],
  accepted: ["confirmed", "unknown", "rejected"],
  confirmed: [],
  unknown: ["confirmed"],
  rejected: [],
  closed: [],
});

export function settleSessionControlAudit(input: Readonly<{
  audit: SessionControlAuditRecord;
  state: SessionControlState;
  now: string;
  reason?: string;
}>): SessionControlAuditRecord {
  invariant(CONTROL_TRANSITIONS[input.audit.state].includes(input.state), "session_control_transition_invalid");
  return Object.freeze({
    ...input.audit,
    state: input.state,
    settledAt: input.now,
    ...(input.reason ? { reason: input.reason } : {}),
  });
}
