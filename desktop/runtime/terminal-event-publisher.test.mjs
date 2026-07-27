import { describe, expect, it } from "vitest";
import { createTerminalEventPublisher } from "./terminal-event-publisher.cjs";

function createTarget(id = 1) {
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (_channel, event) => sent.push(event),
  };
}

describe("terminal event publisher", () => {
  it("coalesces a foreground terminal burst into one sequenced delta", () => {
    const target = createTarget();
    let callback;
    const publisher = createTerminalEventPublisher({
      targets: () => [target],
      schedule: (next) => {
        callback = next;
        return 1;
      },
      cancel: () => undefined,
    });

    publisher.publish({ type: "data", id: "session-1", chunk: "one", cursor: 1, incarnationId: "inc", generation: "gen" });
    publisher.publish({ type: "data", id: "session-1", chunk: "two", cursor: 2, incarnationId: "inc", generation: "gen" });
    callback();

    expect(target.sent).toEqual([
      {
        type: "data",
        id: "session-1",
        chunk: "onetwo",
        cursor: 2,
        incarnationId: "inc",
        generation: "gen",
        requiresSnapshot: false,
      },
    ]);
  });

  it("marks an over-budget renderer queue for host-owned snapshot recovery", () => {
    const target = createTarget();
    let callback;
    const publisher = createTerminalEventPublisher({
      targets: () => [target],
      maxPendingBytes: 3,
      schedule: (next) => {
        callback = next;
        return 1;
      },
      cancel: () => undefined,
    });

    publisher.publish({ type: "data", id: "session-1", chunk: "abc", cursor: 1 });
    publisher.publish({ type: "data", id: "session-1", chunk: "def", cursor: 2 });
    callback();

    expect(target.sent[0]).toMatchObject({ id: "session-1", cursor: 2, chunk: "", requiresSnapshot: true });
  });

  it("flushes pending output before delivering an exit event", () => {
    const target = createTarget();
    const publisher = createTerminalEventPublisher({ targets: () => [target], schedule: () => 1, cancel: () => undefined });

    publisher.publish({ type: "data", id: "session-1", chunk: "final", cursor: 1 });
    publisher.publish({ type: "exit", id: "session-1", status: "stopped", cursor: 1 });

    expect(target.sent.map((event) => event.type)).toEqual(["data", "exit"]);
  });

  it("discards queued output when a renderer frame is disposed before its flush", () => {
    const target = createTarget();
    let callback;
    const publisher = createTerminalEventPublisher({
      targets: () => [target],
      schedule: (next) => {
        callback = next;
        return 1;
      },
      cancel: () => undefined,
    });

    publisher.publish({ type: "data", id: "session-1", chunk: "stale", cursor: 1 });
    target.mainFrame = { isDestroyed: () => true };

    expect(() => callback()).not.toThrow();
    expect(target.sent).toEqual([]);
    expect(publisher.evidence()).toEqual({ pendingTargets: 0 });
  });

  it("does not throw when WebContents.send races a frame disposal", () => {
    const target = createTarget();
    target.send = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    const publisher = createTerminalEventPublisher({ targets: () => [target], schedule: () => 1, cancel: () => undefined });

    expect(() => publisher.publish({ type: "exit", id: "session-1", status: "stopped" })).not.toThrow();
  });
});
