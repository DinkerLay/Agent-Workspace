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

function trimRendererTranscript(transcript: string[]) {
  return transcript.slice(-maxRendererTranscriptChunks);
}
