import type { NativePtySession } from "../runtime/nativeBridge";
import type { Task } from "../types";

type RuntimeEventInput = {
  task: Task;
  sessionId?: string;
  type: "user.intervention";
  summary: string;
  data: Record<string, unknown>;
};

export async function writeNativePtyDataWithRuntimeEvidence(input: {
  session: NativePtySession | undefined;
  task: Task | undefined;
  data: string;
  ptyData?: string;
  source: string;
  summary: string;
  writePtySession: (id: string, text: string) => Promise<NativePtySession | undefined>;
  storePtySession?: (session: NativePtySession | undefined) => void;
  recordRuntimeEvent?: (event: RuntimeEventInput) => Promise<unknown> | unknown;
}) {
  if (!input.session || input.session.status !== "running") return undefined;
  const session = await input.writePtySession(input.session.id, input.ptyData ?? input.data);
  input.storePtySession?.(session);

  const message = input.data.trim();
  if (!input.task || !message) return session;
  if (!shouldRecordRuntimeEvidence(input.source)) return session;

  await input.recordRuntimeEvent?.({
    task: input.task,
    sessionId: input.session.id,
    type: "user.intervention",
    summary: input.summary,
    data: {
      message,
      source: input.source,
      targetSessionId: input.session.id,
    },
  });
  return session;
}

function shouldRecordRuntimeEvidence(source: string) {
  return source !== "ide-terminal";
}
