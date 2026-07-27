import { describe, expect, it } from "vitest";
import { createHeadlessTerminalModel } from "./headless-terminal-model.cjs";
import { createTerminalHost } from "./terminal-host.cjs";

function createFakePty() {
  const calls = [];
  const processes = [];
  let nextPid = 900;
  return {
    calls,
    processes,
    pty: {
      spawn(command, args, options) {
        let onData = () => undefined;
        let onExit = () => undefined;
        const process = {
          pid: nextPid++,
          onData(listener) {
            onData = listener;
          },
          onExit(listener) {
            onExit = listener;
          },
          write(value) {
            calls.push(["write", process.pid, value]);
          },
          resize(cols, rows) {
            calls.push(["resize", process.pid, cols, rows]);
          },
          pause() {
            calls.push(["pause", process.pid]);
          },
          resume() {
            calls.push(["resume", process.pid]);
          },
          kill(signal) {
            calls.push(["kill", process.pid, signal]);
          },
          emitData(value) {
            onData(value);
          },
          emitExit(event = { exitCode: 0, signal: 0 }) {
            onExit(event);
          },
        };
        processes.push(process);
        calls.push(["spawn", process.pid, command, args, options.cols, options.rows]);
        return process;
      },
    },
  };
}

function launch(host, overrides = {}) {
  return host.start({
    id: "opencode:task:researcher",
    taskId: "task-1",
    command: "opencode",
    args: ["--model", "opencode-go/deepseek-v4-flash"],
    cwd: "/tmp/project",
    model: "opencode-go/deepseek-v4-flash",
    incarnationId: "incarnation-1",
    generation: "generation-1",
    cols: 24,
    rows: 4,
    ...overrides,
  });
}

describe("TerminalHost", () => {
  it("models output before it publishes it, then restores a TUI redraw from the host snapshot", async () => {
    const fake = createFakePty();
    const host = createTerminalHost({ pty: fake.pty, scrollback: 8 });
    const events = [];
    host.onEvent((event) => events.push(event));
    launch(host);

    fake.processes[0].emitData("obsolete");
    fake.processes[0].emitData("\x1b[2J\x1b[Hcurrent");
    const attached = await host.attachClient({ id: "opencode:task:researcher", clientId: "workbench", generation: "panel-1" });
    const renderer = createHeadlessTerminalModel({ cols: attached.snapshot.cols, rows: attached.snapshot.rows, scrollback: 8 });
    await renderer.write(attached.snapshot.ansi);

    expect(events.filter((event) => event.type === "data").map((event) => event.cursor)).toEqual([
      Buffer.byteLength("obsolete"),
      Buffer.byteLength("obsolete\x1b[2J\x1b[Hcurrent"),
    ]);
    expect(renderer.visibleLines()[0]).toBe("current");
    expect(attached.snapshot.cursor).toBe(Buffer.byteLength("obsolete\x1b[2J\x1b[Hcurrent"));
    renderer.dispose();
    host.close();
  });

  it("uses a cursor ACK to apply real PTY pause/resume flow control", async () => {
    const fake = createFakePty();
    const host = createTerminalHost({ pty: fake.pty, maxUnacknowledgedBytes: 3, maxPendingBytes: 8 });
    launch(host);
    const attached = await host.attachClient({ id: "opencode:task:researcher", clientId: "workbench", generation: "panel-1" });
    expect(
      host.acknowledgeOutput({ id: "opencode:task:researcher", clientId: "workbench", generation: "panel-1", cursor: attached.snapshot.cursor }),
    ).toMatchObject({ accepted: true });

    fake.processes[0].emitData("abcd");
    await host.getSnapshot("opencode:task:researcher");
    const delivery = host.takePendingOutput({ id: "opencode:task:researcher", clientId: "workbench", generation: "panel-1" });
    expect(delivery.deltas).toHaveLength(1);
    expect(fake.calls).toContainEqual(["pause", 900]);

    expect(
      host.acknowledgeOutput({ id: "opencode:task:researcher", clientId: "workbench", generation: "panel-1", cursor: 4 }),
    ).toMatchObject({ accepted: true });
    expect(fake.calls).toContainEqual(["resume", 900]);
    host.close();
  });

  it("does not allow a stale PTY incarnation to write output into its replacement", async () => {
    const fake = createFakePty();
    const host = createTerminalHost({ pty: fake.pty });
    launch(host);
    const first = fake.processes[0];
    host.stop("opencode:task:researcher", { expectedIncarnationId: "incarnation-1" });
    first.emitExit();
    await host.getSnapshot("opencode:task:researcher");
    const second = launch(host, { incarnationId: "incarnation-2", generation: "generation-2" });

    first.emitData("must-not-appear");
    first.emitExit({ exitCode: 9, signal: 9 });
    fake.processes[1].emitData("replacement");
    const snapshot = await host.getSnapshot("opencode:task:researcher");

    expect(second).toMatchObject({ incarnationId: "incarnation-2", generation: "generation-2" });
    expect(snapshot.ansi).toContain("replacement");
    expect(snapshot.ansi).not.toContain("must-not-appear");
    host.close();
  });

  it("terminates a live PTY when the host closes", () => {
    const fake = createFakePty();
    const host = createTerminalHost({ pty: fake.pty });
    launch(host);

    host.close();

    expect(fake.calls).toContainEqual(["kill", 900, "SIGTERM"]);
  });
});
