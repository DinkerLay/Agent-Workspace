import type { NativePtySession } from "../runtime/nativeBridge";

const maxRendererTranscriptChunks = 2_000;
const maxPtyReadinessBufferChars = 12_000;

export function formatPtyInput(input: string) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.includes("\n")) return `\u001b[200~${normalized}\u001b[201~\r`;
  return `${normalized}\r`;
}

export function isOpencodeTuiReady(session: NativePtySession, readinessBuffer = "") {
  if (session.status !== "running") return false;
  const transcript = readinessBuffer || session.transcript.join("");
  return transcript.includes("Ask anything") || transcript.includes("tab agents") || transcript.includes("ctrl+p commands");
}

export function normalizeNativePtySession(session: NativePtySession): NativePtySession {
  const transcript = trimRendererTranscript(session.transcript);
  return {
    ...session,
    transcript,
    cursor: session.cursor ?? session.transcript.length,
  };
}

export function mergeNativePtySession(current: NativePtySession | undefined, next: NativePtySession): NativePtySession {
  const nextCursor = next.cursor ?? next.transcript.length;
  const currentCursor = current?.cursor ?? current?.transcript.length ?? 0;
  const preservesTranscript =
    Boolean(current) &&
    current?.id === next.id &&
    next.transcript.length === 0 &&
    nextCursor >= currentCursor;

  return normalizeNativePtySession({
    ...(current ?? next),
    ...next,
    transcript: preservesTranscript ? (current?.transcript ?? []) : next.transcript,
    cursor: nextCursor,
  });
}

export function isLiveNativePtySession(session: NativePtySession | undefined): session is NativePtySession {
  return session?.status === "running" || session?.status === "stopping";
}

export function appendPtyReadinessBuffer(current: string, chunk: string) {
  return `${current}${chunk}`.slice(-maxPtyReadinessBufferChars);
}

export function cleanupNativePtySessionTracking(
  refs: {
    sessionKeysById: Record<string, unknown>;
    agentsById: Record<string, unknown>;
    readinessBuffersById: Record<string, unknown>;
    pendingEventsById: Record<string, unknown>;
    initialInputFlushedIds: Set<string>;
    outputAfterInitialInputIds: Set<string>;
    pendingInitialInputsByKey?: Record<string, unknown>;
  },
  input: { sessionId: string; sessionKey?: string },
) {
  delete refs.sessionKeysById[input.sessionId];
  delete refs.agentsById[input.sessionId];
  delete refs.readinessBuffersById[input.sessionId];
  delete refs.pendingEventsById[input.sessionId];
  refs.initialInputFlushedIds.delete(input.sessionId);
  refs.outputAfterInitialInputIds.delete(input.sessionId);
  if (input.sessionKey && refs.pendingInitialInputsByKey) {
    delete refs.pendingInitialInputsByKey[input.sessionKey];
  }
}

export async function waitForNativePtySessionStop<TSession extends Pick<NativePtySession, "id" | "status">>(input: {
  sessionId: string;
  stopSession: (sessionId: string) => Promise<TSession | undefined>;
  getSession: (sessionId: string) => Promise<TSession | undefined>;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  const delay = input.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? 3_000;
  const intervalMs = input.intervalMs ?? 100;
  let latest = await input.stopSession(input.sessionId);
  if (!latest || latest.status === "stopped") return latest;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await delay(intervalMs);
    latest = await input.getSession(input.sessionId);
    if (!latest || latest.status === "stopped") return latest;
  }
  return latest;
}

function trimRendererTranscript(transcript: string[]) {
  return transcript.slice(-maxRendererTranscriptChunks);
}
