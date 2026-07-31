import { describe, expect, it } from "vitest";
import { createTerminalDeliveryWindow } from "./terminal-delivery-window.cjs";

describe("terminal delivery window", () => {
  it("pauses a producer for a slow ACK and resumes after the renderer confirms parsed output", () => {
    const calls = [];
    const window = createTerminalDeliveryWindow({
      maxUnacknowledgedBytes: 3,
      maxPendingBytes: 8,
      pauseProducer: () => calls.push("pause"),
      resumeProducer: () => calls.push("resume"),
    });
    window.attach({ clientId: "renderer-1", generation: "generation-1" });
    window.beginSnapshot({ clientId: "renderer-1", generation: "generation-1", cursor: 0 });
    expect(window.acknowledge({ clientId: "renderer-1", generation: "generation-1", cursor: 0 })).toMatchObject({ accepted: true });
    window.enqueue({ chunk: "abcd", startCursor: 0, cursor: 4 });

    const delivery = window.take({ clientId: "renderer-1", generation: "generation-1" });
    expect(calls).toEqual(["pause"]);
    expect(delivery.deltas).toEqual([{ chunk: "abcd", startCursor: 0, cursor: 4, bytes: 4, bufferMode: "normal" }]);
    expect(window.acknowledge({ clientId: "renderer-1", generation: "generation-1", cursor: 4 })).toMatchObject({ accepted: true });
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("fences an attachment for host snapshot recovery before its pending output can become unbounded", () => {
    const window = createTerminalDeliveryWindow({ maxUnacknowledgedBytes: 3, maxPendingBytes: 5 });
    window.attach({ clientId: "renderer-1", generation: "generation-1" });
    window.beginSnapshot({ clientId: "renderer-1", generation: "generation-1", cursor: 0 });
    expect(window.acknowledge({ clientId: "renderer-1", generation: "generation-1", cursor: 0 })).toMatchObject({ accepted: true });
    window.enqueue({ chunk: "abcdef", startCursor: 0, cursor: 6 });

    expect(window.take({ clientId: "renderer-1", generation: "generation-1" })).toMatchObject({
      accepted: true,
      restoreRequired: true,
      deltas: [],
    });
    expect(window.evidence().attachments[0]).toMatchObject({ pendingBytes: 0, restoreRequired: true, backpressureBlocked: true });
  });

  it("does not let a stale renderer ACK mutate a replacement attachment", () => {
    const window = createTerminalDeliveryWindow();
    window.attach({ clientId: "renderer-1", generation: "generation-1" });
    window.attach({ clientId: "renderer-1", generation: "generation-2" });

    expect(window.acknowledge({ clientId: "renderer-1", generation: "generation-1", cursor: 0 })).toEqual({
      accepted: false,
      reason: "attachment_stale",
    });
  });

  it("holds deltas behind the snapshot ACK and asks for a newer snapshot if output arrives first", () => {
    const window = createTerminalDeliveryWindow();
    window.attach({ clientId: "renderer-1", generation: "generation-1" });
    window.beginSnapshot({ clientId: "renderer-1", generation: "generation-1", cursor: 4 });
    window.enqueue({ chunk: "later", startCursor: 4, cursor: 9 });

    expect(window.take({ clientId: "renderer-1", generation: "generation-1" })).toMatchObject({
      accepted: true,
      snapshotPending: true,
      deltas: [],
    });
    expect(window.acknowledge({ clientId: "renderer-1", generation: "generation-1", cursor: 4 })).toMatchObject({
      accepted: true,
      restoreRequired: true,
    });
  });

  it("preserves the alternate-buffer transition for the Terminal Runtime observer", () => {
    const window = createTerminalDeliveryWindow();
    window.attach({ clientId: "runtime-observer", generation: "generation-1" });
    window.beginSnapshot({ clientId: "runtime-observer", generation: "generation-1", cursor: 0 });
    window.acknowledge({ clientId: "runtime-observer", generation: "generation-1", cursor: 0 });
    const alternateBufferEnter = `${String.fromCharCode(27)}[?1049h`;
    window.enqueue({ chunk: alternateBufferEnter, startCursor: 0, cursor: 8, bufferMode: "alternate" });

    expect(window.take({ clientId: "runtime-observer", generation: "generation-1" }).deltas).toEqual([
      { chunk: alternateBufferEnter, startCursor: 0, cursor: 8, bytes: 8, bufferMode: "alternate" },
    ]);
  });
});
