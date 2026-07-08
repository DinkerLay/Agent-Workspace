import { describe, expect, it } from "vitest";
import { cleanupNativePtySessionTracking, waitForNativePtySessionStop } from "./ptySessionUtils";

describe("PTY session utilities", () => {
  it("cleans per-session renderer tracking after a native PTY session exits", () => {
    const refs = {
      sessionKeysById: { "pty-1": "project:task:agent", "pty-2": "project:task:other" },
      agentsById: { "pty-1": { id: "agent-1" }, "pty-2": { id: "agent-2" } },
      readinessBuffersById: { "pty-1": "Ask anything", "pty-2": "ready" },
      pendingEventsById: { "pty-1": [{ type: "exit" }], "pty-2": [{ type: "data" }] },
      initialInputFlushedIds: new Set(["pty-1", "pty-2"]),
      outputAfterInitialInputIds: new Set(["pty-1", "pty-2"]),
      pendingInitialInputsByKey: {
        "project:task:agent": { sessionId: "pty-1" },
        "project:task:other": { sessionId: "pty-2" },
      },
    };

    cleanupNativePtySessionTracking(refs, { sessionId: "pty-1", sessionKey: "project:task:agent" });

    expect(refs.sessionKeysById).toEqual({ "pty-2": "project:task:other" });
    expect(refs.agentsById).toEqual({ "pty-2": { id: "agent-2" } });
    expect(refs.readinessBuffersById).toEqual({ "pty-2": "ready" });
    expect(refs.pendingEventsById).toEqual({ "pty-2": [{ type: "data" }] });
    expect([...refs.initialInputFlushedIds]).toEqual(["pty-2"]);
    expect([...refs.outputAfterInitialInputIds]).toEqual(["pty-2"]);
    expect(refs.pendingInitialInputsByKey).toEqual({
      "project:task:other": { sessionId: "pty-2" },
    });
  });

  it("waits for a stopping native PTY session before restart recovery continues", async () => {
    const calls: string[] = [];
    const snapshots = [
      { id: "session-1", status: "stopping" as const },
      { id: "session-1", status: "stopped" as const },
    ];

    const result = await waitForNativePtySessionStop({
      sessionId: "session-1",
      stopSession: async (sessionId) => {
        calls.push(`stop:${sessionId}`);
        return { id: sessionId, status: "stopping" as const };
      },
      getSession: async (sessionId) => {
        calls.push(`get:${sessionId}`);
        return snapshots.shift();
      },
      delay: async () => undefined,
      timeoutMs: 100,
      intervalMs: 1,
    });

    expect(result?.status).toBe("stopped");
    expect(calls).toEqual(["stop:session-1", "get:session-1", "get:session-1"]);
  });
});
