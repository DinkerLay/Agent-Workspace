import { describe, expect, it } from "vitest";
import { writeNativePtyDataWithRuntimeEvidence } from "./nativePtyTimeline";
import type { NativePtySession } from "../runtime/nativeBridge";
import type { Task } from "../types";

const runningSession: NativePtySession = {
  id: "task-1-conductor",
  taskId: "task-1",
  command: "opencode",
  args: [],
  cwd: "/tmp/project",
  backend: "pty",
  status: "running",
  cols: 100,
  rows: 30,
  transcript: [],
  cursor: 0,
};

const task: Task = {
  id: "task-1",
  runtimeTaskId: "task-runtime-1",
  title: "Record IDE PTY input",
  status: "running",
  source: "manual",
  owner: "Conductor",
  risk: "medium",
  verification: "timeline",
  summary: "Raw IDE terminal input should be timeline evidence.",
};

describe("native PTY timeline evidence", () => {
  it("records non-empty composer PTY input as a user intervention after writing to the session", async () => {
    const writes: Array<{ id: string; text: string }> = [];
    const records: unknown[] = [];
    const stored: NativePtySession[] = [];

    await writeNativePtyDataWithRuntimeEvidence({
      session: runningSession,
      task,
      data: "都行\n",
      source: "task-composer",
      summary: "User intervention sent to Conductor",
      writePtySession: async (id, text) => {
        writes.push({ id, text });
        return { ...runningSession, transcript: [] };
      },
      storePtySession: (session) => {
        if (session) stored.push(session);
      },
      recordRuntimeEvent: async (event) => {
        records.push(event);
      },
    });

    expect(writes).toEqual([{ id: "task-1-conductor", text: "都行\n" }]);
    expect(stored).toHaveLength(1);
    expect(records).toEqual([
      {
        task,
        sessionId: "task-1-conductor",
        type: "user.intervention",
        summary: "User intervention sent to Conductor",
        data: {
          message: "都行",
          source: "task-composer",
          targetSessionId: "task-1-conductor",
        },
      },
    ]);
  });

  it("can submit composer input to PTY with provider formatting while recording clean timeline text", async () => {
    const writes: Array<{ id: string; text: string }> = [];
    const records: unknown[] = [];

    await writeNativePtyDataWithRuntimeEvidence({
      session: runningSession,
      task,
      data: "做成一个html文件给我\n",
      ptyData: "\x1b[200~做成一个html文件给我\x1b[201~\r",
      source: "task-composer",
      summary: "User intervention sent to Conductor",
      writePtySession: async (id, text) => {
        writes.push({ id, text });
        return runningSession;
      },
      recordRuntimeEvent: async (event) => {
        records.push(event);
      },
    });

    expect(writes).toEqual([
      {
        id: "task-1-conductor",
        text: "\x1b[200~做成一个html文件给我\x1b[201~\r",
      },
    ]);
    expect(records).toEqual([
      {
        task,
        sessionId: "task-1-conductor",
        type: "user.intervention",
        summary: "User intervention sent to Conductor",
        data: {
          message: "做成一个html文件给我",
          source: "task-composer",
          targetSessionId: "task-1-conductor",
        },
      },
    ]);
  });

  it("writes raw IDE terminal text without creating timeline evidence", async () => {
    const records: unknown[] = [];

    await writeNativePtyDataWithRuntimeEvidence({
      session: runningSession,
      task,
      data: "都行\n",
      source: "ide-terminal",
      summary: "User intervention sent from IDE terminal",
      writePtySession: async () => runningSession,
      recordRuntimeEvent: async (event) => {
        records.push(event);
      },
    });

    expect(records).toEqual([]);
  });

  it("writes whitespace-only PTY input without creating timeline noise", async () => {
    const records: unknown[] = [];

    await writeNativePtyDataWithRuntimeEvidence({
      session: runningSession,
      task,
      data: " \n",
      source: "ide-terminal",
      summary: "User intervention sent from IDE terminal",
      writePtySession: async () => runningSession,
      recordRuntimeEvent: async (event) => {
        records.push(event);
      },
    });

    expect(records).toEqual([]);
  });

  it("writes terminal control sequences without creating timeline noise", async () => {
    const writes: Array<{ id: string; text: string }> = [];
    const records: unknown[] = [];

    for (const data of ["\u001b]10;rgb:d7d7/fbfb/e8e8\u001b\\", "\u001b[25;6R", "\u001b[?2027;0$y", "\u001b[<35;26;19M"]) {
      await writeNativePtyDataWithRuntimeEvidence({
        session: runningSession,
        task,
        data,
        source: "ide-terminal",
        summary: "User intervention sent from IDE terminal",
        writePtySession: async (id, text) => {
          writes.push({ id, text });
          return runningSession;
        },
        recordRuntimeEvent: async (event) => {
          records.push(event);
        },
      });
    }

    expect(writes).toHaveLength(4);
    expect(records).toEqual([]);
  });
});
