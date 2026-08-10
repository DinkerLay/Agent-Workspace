import type {
  ProviderActivityReadModel,
  ProviderFact,
  ProviderSessionBindingRecord,
  SessionTurnRecord,
} from "@agent-workspace/runtime-contracts";
import { indexSessionTurns, resolveProviderFactSessionTurn } from "./session-turns";

const MAX_PROJECTED_CONTENT_LENGTH = 32_000;

/**
 * Reduces already-normalized Adapter facts into one renderer-safe item per
 * activity. This projection is side-effect free and never returns native IDs
 * or the original Provider payload object.
 */
export function deriveProviderActivities(input: {
  readonly bindings: readonly ProviderSessionBindingRecord[];
  readonly sessionTurns: readonly SessionTurnRecord[];
  readonly providerFacts: readonly ProviderFact[];
}): readonly ProviderActivityReadModel[] {
  const bindingById = new Map(input.bindings.map((binding) => [binding.bindingId, binding] as const));
  const turnIndex = indexSessionTurns(input.sessionTurns);
  const states = new Map<string, MutableActivity>();

  const facts = input.providerFacts
    .filter((fact) => fact.kind === "activity_observed")
    .map((fact) => ({ fact, payload: activityPayload(fact) }))
    .filter((entry): entry is { readonly fact: ProviderFact; readonly payload: NormalizedActivityPayload } => Boolean(entry.payload))
    .sort((left, right) => left.fact.observedAt.localeCompare(right.fact.observedAt)
      || left.payload.sequence - right.payload.sequence
      || left.fact.providerFactId.localeCompare(right.fact.providerFactId));

  for (const { fact, payload } of facts) {
    const binding = bindingById.get(fact.bindingId);
    if (!binding || binding.provider !== fact.provider || binding.bindingRevision !== fact.bindingRevision) continue;
    const turn = resolveProviderFactSessionTurn(fact, turnIndex);
    if (!turn) continue;
    if (turn.taskId !== binding.taskId || turn.runId !== binding.runId || turn.targetLogicalSessionId !== binding.logicalSessionId) continue;
    const key = `${fact.bindingId}:${payload.activityId}`;
    const existing = states.get(key);
    if (existing && (existing.provider !== fact.provider || existing.category !== payload.category)) continue;
    if (existing && isTerminalStatus(existing.status) && !isTerminalPhase(payload.phase)) continue;
    const content = payload.content === undefined
      ? existing?.content
      : payload.updateMode === "append"
        ? boundedContent(`${existing?.content ?? ""}${payload.content}`)
        : boundedContent(payload.content);
    states.set(key, {
      activityId: payload.activityId,
      provider: fact.provider,
      bindingId: fact.bindingId,
      logicalSessionId: binding.logicalSessionId,
      inputSubmissionId: turn.inputSubmissionId,
      invocationId: turn.invocationId,
      sessionTurnId: turn.sessionTurnId,
      category: payload.category,
      status: statusFor(payload.phase),
      title: payload.title,
      detail: payload.detail ?? existing?.detail,
      content,
      startedAt: existing?.startedAt ?? fact.observedAt,
      updatedAt: fact.observedAt,
    });
  }

  return Object.freeze([...states.values()]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
      || left.activityId.localeCompare(right.activityId))
    .map((state) => Object.freeze(compactActivity(state))));
}

type NormalizedActivityPayload = Readonly<{
  activityId: string;
  category: ProviderActivityReadModel["category"];
  phase: "started" | "progress" | "completed" | "failed";
  title: string;
  detail?: string;
  content?: string;
  updateMode?: "append" | "replace";
  sequence: number;
}>;

type MutableActivity = Readonly<{
  activityId: string;
  provider: ProviderActivityReadModel["provider"];
  bindingId: string;
  logicalSessionId: string;
  inputSubmissionId?: string;
  invocationId?: string;
  sessionTurnId?: string;
  category: ProviderActivityReadModel["category"];
  status: ProviderActivityReadModel["status"];
  title: string;
  detail?: string;
  content?: string;
  startedAt: string;
  updatedAt: string;
}>;

function activityPayload(fact: ProviderFact): NormalizedActivityPayload | undefined {
  const payload = fact.payload;
  if (payload.schemaVersion !== 1) return undefined;
  if (typeof payload.activityId !== "string" || !/^activity_[a-zA-Z0-9-]{12,80}$/.test(payload.activityId)) return undefined;
  if (!isCategory(payload.category) || !isPhase(payload.phase)) return undefined;
  if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 160) return undefined;
  if (payload.detail !== undefined && (typeof payload.detail !== "string" || payload.detail.length > 2_000)) return undefined;
  if (payload.content !== undefined && (typeof payload.content !== "string" || payload.content.length > 16_000)) return undefined;
  if (payload.updateMode !== undefined && payload.updateMode !== "append" && payload.updateMode !== "replace") return undefined;
  if (!Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 0) return undefined;
  return {
    activityId: payload.activityId,
    category: payload.category,
    phase: payload.phase,
    title: payload.title,
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
    ...(typeof payload.content === "string" ? { content: payload.content } : {}),
    ...(payload.updateMode === "append" || payload.updateMode === "replace" ? { updateMode: payload.updateMode } : {}),
    sequence: Number(payload.sequence),
  };
}

function compactActivity(state: MutableActivity): ProviderActivityReadModel {
  return {
    activityId: state.activityId,
    provider: state.provider,
    bindingId: state.bindingId,
    logicalSessionId: state.logicalSessionId,
    ...(state.inputSubmissionId ? { inputSubmissionId: state.inputSubmissionId } : {}),
    ...(state.invocationId ? { invocationId: state.invocationId } : {}),
    ...(state.sessionTurnId ? { sessionTurnId: state.sessionTurnId } : {}),
    category: state.category,
    status: state.status,
    title: state.title,
    ...(state.detail ? { detail: state.detail } : {}),
    ...(state.content !== undefined ? { content: state.content } : {}),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

function isCategory(value: unknown): value is ProviderActivityReadModel["category"] {
  return value === "assistant_progress" || value === "tool" || value === "change" || value === "web";
}

function isPhase(value: unknown): value is NormalizedActivityPayload["phase"] {
  return value === "started" || value === "progress" || value === "completed" || value === "failed";
}

function statusFor(phase: NormalizedActivityPayload["phase"]): ProviderActivityReadModel["status"] {
  if (phase === "failed") return "failed";
  if (phase === "completed") return "completed";
  return "running";
}

function isTerminalPhase(phase: NormalizedActivityPayload["phase"]): boolean {
  return phase === "completed" || phase === "failed";
}

function isTerminalStatus(status: ProviderActivityReadModel["status"]): boolean {
  return status === "completed" || status === "failed";
}

function boundedContent(content: string): string {
  return content.length <= MAX_PROJECTED_CONTENT_LENGTH
    ? content
    : content.slice(content.length - MAX_PROJECTED_CONTENT_LENGTH);
}
