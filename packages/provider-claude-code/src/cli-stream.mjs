import { createHash } from "node:crypto";

/**
 * This fingerprint covers the version-pinned stream surface below, not a
 * conversational transcript. Runtime Host verifies the installed CLI version
 * and its `system/init` capability flags before exposing a Binding fact.
 */
export const CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT =
  "sha256:96e0c48346de4e8e33591749e5ad2256ab42ce29e695cba2239ad3de01908b9b";

/** Observed from Claude Code 2.1.222's stream-json `system/init` frame. */
export const CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES = Object.freeze([
  "interrupt_receipt_v1",
  "interrupt_cancel_queued_v1",
  "msg_lifecycle_v1",
]);

/**
 * Only capabilities exercised by the version-pinned CLI stream spike are
 * advertised. Tool attention, native children, and native presentation remain
 * unavailable until their protocol paths have their own verified bridge.
 */
export const CLAUDE_CODE_PROVEN_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);

/**
 * A stable UUID is required by Claude Code's stream-json command lifecycle.
 * It is derived from the Runtime idempotency key so an ambiguous retry sends
 * the same native command identity without exposing the prompt in the journal.
 */
export function createClaudeCodeCommandUuid({ bindingId, idempotencyKey }) {
  const digest = createHash("sha256")
    .update(`agent-workspace:claude-code:${requiredString(bindingId)}:${requiredString(idempotencyKey)}`)
    .digest("hex");
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Returns the part of a real `system/init` frame that is safe to pin. */
export function readClaudeCodeCliInit(frame) {
  const raw = asRecord(frame);
  if (raw.type !== "system" || raw.subtype !== "init") return undefined;
  const sessionId = string(raw.session_id);
  const providerVersion = string(raw.claude_code_version);
  if (!sessionId || !providerVersion) return undefined;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((value) => typeof value === "string")
    : [];
  return Object.freeze({ sessionId, providerVersion, capabilities: Object.freeze(capabilities) });
}

export function cliInitSupportsRequiredCapabilities(init) {
  const observed = new Set(init?.capabilities ?? []);
  return CLAUDE_CODE_CLI_REQUIRED_NATIVE_CAPABILITIES.every((capability) => observed.has(capability));
}

/**
 * Converts only live-proven Claude CLI NDJSON frames into the adapter-local
 * NativeProviderFact dialect. The Host supplies durable source/correlation
 * context; this package never starts a process or reads a transcript.
 */
export function mapClaudeCodeCliFrame(frame, context) {
  const raw = asRecord(frame);
  const type = string(raw.type);
  const cursor = requiredString(context?.cursor);
  const sourceInstanceId = requiredString(context?.sourceInstanceId);
  const eventId = string(raw.uuid) ?? `claude-code:${sourceInstanceId}:${cursor}`;

  if (type === "system" && raw.subtype === "init") {
    const init = readClaudeCodeCliInit(raw);
    if (!init) return Object.freeze([]);
    return Object.freeze([nativeFact({
      type: context?.disposition === "resume" ? "claude-code.binding.resumed" : "claude-code.binding.created",
      raw,
      eventId,
      sourceInstanceId,
      cursor,
      payload: {
        nativeBindingRef: init.sessionId,
        providerVersion: init.providerVersion,
        nativeCapabilities: [...init.capabilities],
      },
    })]);
  }

  if (type === "system" && raw.subtype === "status" && raw.status === "requesting") {
    const correlation = context?.activeCorrelation;
    if (!correlation) return Object.freeze([]);
    return Object.freeze([nativeFact({
      type: "claude-code.turn.started",
      raw,
      eventId,
      sourceInstanceId,
      cursor,
      correlation,
      nativeTurnId: eventId,
      payload: { status: "requesting" },
    })]);
  }

  if (type === "command_lifecycle") {
    const commandUuid = string(raw.command_uuid);
    const correlation = commandUuid ? context?.correlationForCommandUuid?.(commandUuid) : undefined;
    if (!correlation) return Object.freeze([]);
    if (raw.state === "started" || raw.state === "completed") {
      return Object.freeze([nativeFact({
        type: "claude-code.delivery.receipt",
        raw,
        eventId,
        sourceInstanceId,
        cursor,
        correlation,
        nativeMessageId: eventId,
        historyMarker: commandUuid,
        payload: { commandUuid, lifecycleState: raw.state },
      })]);
    }
    if (raw.state === "cancelled") {
      return Object.freeze([nativeFact({
        type: "claude-code.interrupt.confirmed",
        raw,
        eventId,
        sourceInstanceId,
        cursor,
        correlation,
        nativeTurnId: eventId,
        payload: { commandUuid, lifecycleState: "cancelled" },
      })]);
    }
    return Object.freeze([]);
  }

  if (type === "result") {
    const commandUuid = string(raw.user_message_uuid);
    const correlation = commandUuid ? context?.correlationForCommandUuid?.(commandUuid) : context?.activeCorrelation;
    if (!correlation) return Object.freeze([]);
    if (raw.terminal_reason === "aborted_streaming") return Object.freeze([]);
    const finalContent = string(raw.result);
    const result = {
      text: typeof raw.result === "string" ? raw.result : "",
      terminalReason: string(raw.terminal_reason) ?? "unknown",
      isError: raw.is_error === true,
      ...(typeof raw.duration_ms === "number" ? { durationMs: raw.duration_ms } : {}),
      ...(typeof raw.num_turns === "number" ? { numTurns: raw.num_turns } : {}),
    };
    const terminal = nativeFact({
      type: raw.is_error === true ? "claude-code.turn.failed" : "claude-code.turn.completed",
      raw,
      // A successful result can produce both an assistant_final message fact
      // and a terminal-turn fact. Give each durable observation its own native
      // event identity so ProviderFact deduplication never discards either.
      eventId: raw.is_error === true || !finalContent ? eventId : `${eventId}:turn_terminal`,
      sourceInstanceId,
      cursor,
      correlation,
      nativeTurnId: eventId,
      payload: { result },
    });
    if (raw.is_error === true || !finalContent) return Object.freeze([terminal]);
    return Object.freeze([
      nativeFact({
        type: "claude-code.assistant.final",
        raw,
        eventId: `${eventId}:assistant_final`,
        sourceInstanceId,
        cursor,
        correlation,
        nativeMessageId: eventId,
        nativeTurnId: eventId,
        payload: { content: finalContent },
      }),
      terminal,
    ]);
  }

  if (type === "claude-code.host.closed") {
    const correlation = context?.activeCorrelation;
    return Object.freeze([nativeFact({
      type: raw.expected === true ? "claude-code.native.terminal" : "claude-code.delivery.unknown",
      raw,
      eventId,
      sourceInstanceId,
      cursor,
      correlation,
      payload: { reason: string(raw.reason) ?? "host_process_closed" },
    })]);
  }

  return Object.freeze([]);
}

function nativeFact({ type, raw, eventId, sourceInstanceId, cursor, correlation, nativeMessageId, nativeTurnId, historyMarker, payload }) {
  return withoutUndefined({
    kind: type,
    providerEventId: eventId,
    sourceInstanceId,
    cursor,
    inputSubmissionId: correlation?.inputSubmissionId,
    invocationId: correlation?.invocationId,
    nativeMessageId,
    nativeTurnId,
    historyMarker,
    payload: { ...payload, sessionId: string(raw.session_id) },
  });
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(value) {
  const result = string(value);
  if (!result) throw new TypeError("claude_code_cli_value_required");
  return result;
}

function withoutUndefined(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)));
}
