import type {
  ProviderActivityReadModel,
  ProviderActivityStatus,
} from "@agent-workspace/runtime-contracts";

const SAFE_ID = /^[a-z][A-Za-z0-9_-]{2,255}$/u;
const SAFE_ACTIVITY_KEY = /^activity_key_[a-f0-9]{64}$/u;
const MAX_SCOPES = 128;
const MAX_ACTIVITIES_PER_SCOPE = 128;
const MAX_TOOL_CORRELATIONS = 512;
const MAX_PROGRESS_BYTES = 128 * 1024;

export type SessionIdAcpHumanActivityInput =
  | Readonly<{
      scope: "task";
      kind: "agent_message_chunk";
      sessionExecutionAttemptId: string;
      text: string;
    }>
  | Readonly<{
      scope: "task";
      kind: "agent_thought_chunk";
      sessionExecutionAttemptId: string;
      text: string;
    }>
  | Readonly<{
      scope: "task";
      kind: "tool_status";
      sessionExecutionAttemptId: string;
      activityKey: string;
      title?: string;
      status?: ProviderActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
    }>
  | Readonly<{
      scope: "meta";
      kind: "agent_message_chunk";
      metaSessionId: string;
      metaTurnId: string;
      text: string;
    }>
  | Readonly<{
      scope: "meta";
      kind: "agent_thought_chunk";
      metaSessionId: string;
      metaTurnId: string;
      text: string;
    }>
  | Readonly<{
      scope: "meta";
      kind: "tool_status";
      metaSessionId: string;
      metaTurnId: string;
      activityKey: string;
      title?: string;
      status?: ProviderActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
    }>;

export type SessionIdAcpHumanActivityOwner = Readonly<{
  record(input: SessionIdAcpHumanActivityInput): void;
  listForAttempt(sessionExecutionAttemptId: string): readonly ProviderActivityReadModel[];
  listForMetaTurn(metaSessionId: string, metaTurnId: string): readonly ProviderActivityReadModel[];
  clear(): void;
}>;

/**
 * Host-memory owner for live human-only ACP activity. Canonical messages and
 * settlements remain durable elsewhere; losing this cache on Host restart is
 * safe and the next read is rebuilt from subsequent observations.
 */
export function createSessionIdAcpHumanActivityOwner(options: Readonly<{
  now: () => string;
  createId: (kind: "provider_activity") => string;
}>): SessionIdAcpHumanActivityOwner {
  if (!options || typeof options.now !== "function" || typeof options.createId !== "function") {
    throw new Error("session_id_acp_human_activity_owner_options_invalid");
  }
  const scopes = new Map<string, readonly ProviderActivityReadModel[]>();
  const toolActivityIds = new Map<string, string>();

  return Object.freeze({
    record(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("session_id_acp_human_activity_invalid");
      }
      const key = scopeKey(input);
      const current = scopes.get(key) ?? [];
      const observedAt = timestamp(options.now());
      let next: ProviderActivityReadModel[];
      if (input.kind === "agent_message_chunk" || input.kind === "agent_thought_chunk") {
        if (input.text === "") return;
        const text = requiredText(input.text, 65_536, true);
        const contentKind = input.kind === "agent_thought_chunk" ? "reasoning" : "response";
        const last = current.at(-1);
        if (last?.kind === "assistant_progress" && last.contentKind === contentKind) {
          const content = `${last.content}${text}`.slice(-MAX_PROGRESS_BYTES);
          next = [...current.slice(0, -1), Object.freeze({ ...last, content, observedAt })];
        } else {
          next = [...current, Object.freeze({
            activityId: activityId(options.createId("provider_activity")),
            kind: "assistant_progress" as const,
            contentKind,
            content: text,
            observedAt,
          })];
        }
      } else {
        if (!SAFE_ACTIVITY_KEY.test(input.activityKey)) {
          throw new Error("session_id_acp_human_activity_invalid");
        }
        const correlationKey = `${key}:${input.activityKey}`;
        const correlatedActivityId = toolActivityIds.get(correlationKey);
        const existingIndex = correlatedActivityId === undefined
          ? -1
          : current.findIndex((activity) => activity.activityId === correlatedActivityId);
        const existing = existingIndex >= 0 && current[existingIndex]?.kind === "tool"
          ? current[existingIndex]
          : undefined;
        const title = input.title === undefined
          ? existing?.title ?? "工具调用"
          : requiredText(input.title, 512);
        const status = input.status ?? "in_progress";
        if (!["pending", "in_progress", "completed", "failed"].includes(status)) {
          throw new Error("session_id_acp_human_activity_invalid");
        }
        const inputSummary = input.inputSummary === undefined
          ? existing?.inputSummary
          : requiredText(input.inputSummary, 16 * 1024, true);
        const outputSummary = input.outputSummary === undefined
          ? existing?.outputSummary
          : requiredText(input.outputSummary, 16 * 1024, true);
        const nextActivityId = existingIndex >= 0
          ? current[existingIndex]!.activityId
          : activityId(options.createId("provider_activity"));
        if (existingIndex < 0) {
          toolActivityIds.set(correlationKey, nextActivityId);
          while (toolActivityIds.size > MAX_TOOL_CORRELATIONS) {
            toolActivityIds.delete(toolActivityIds.keys().next().value!);
          }
        }
        const activity = Object.freeze({
          activityId: nextActivityId,
          kind: "tool" as const,
          title,
          status,
          ...(inputSummary ? { inputSummary } : {}),
          ...(outputSummary ? { outputSummary } : {}),
          observedAt,
        });
        next = existingIndex >= 0
          ? current.map((candidate, index) => index === existingIndex ? activity : candidate)
          : [...current, activity];
      }
      scopes.delete(key);
      scopes.set(key, Object.freeze(next.slice(-MAX_ACTIVITIES_PER_SCOPE)));
      while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
    },
    listForAttempt(sessionExecutionAttemptId) {
      return snapshot(scopes.get(`task:${requiredId(sessionExecutionAttemptId)}`));
    },
    listForMetaTurn(metaSessionId, metaTurnId) {
      return snapshot(scopes.get(`meta:${requiredId(metaSessionId)}:${requiredId(metaTurnId)}`));
    },
    clear() {
      scopes.clear();
      toolActivityIds.clear();
    },
  });
}

function scopeKey(input: SessionIdAcpHumanActivityInput): string {
  if (input.scope === "task") return `task:${requiredId(input.sessionExecutionAttemptId)}`;
  return `meta:${requiredId(input.metaSessionId)}:${requiredId(input.metaTurnId)}`;
}

function snapshot(value: readonly ProviderActivityReadModel[] | undefined): readonly ProviderActivityReadModel[] {
  return Object.freeze([...(value ?? [])].map((activity) => Object.freeze({ ...activity })));
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error("session_id_acp_human_activity_invalid");
  }
  return value;
}

function activityId(value: unknown): string {
  const id = requiredId(value);
  if (!id.startsWith("provider_activity_")) throw new Error("session_id_acp_human_activity_invalid");
  return id;
}

function requiredText(value: unknown, max: number, allowNewlines = false): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")
    || (!allowNewlines && /[\r\n]/u.test(value))) {
    throw new Error("session_id_acp_human_activity_invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("session_id_acp_human_activity_invalid");
  }
  return value;
}
