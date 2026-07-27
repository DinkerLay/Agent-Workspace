import { describe, expect, it } from "vitest";
import { createHeadlessTerminalModel } from "./headless-terminal-model.cjs";

describe("headless terminal model", () => {
  it("keeps the host screen authoritative across a full TUI redraw and renderer restore", async () => {
    const host = createHeadlessTerminalModel({ cols: 24, rows: 4, scrollback: 8 });
    await host.write("obsolete frame");
    await host.write("\x1b[2J\x1b[Hcurrent frame");

    const snapshot = host.snapshot({ cursor: 17 });
    const renderer = createHeadlessTerminalModel({ cols: snapshot.cols, rows: snapshot.rows, scrollback: snapshot.scrollback });
    await renderer.write(snapshot.ansi);

    expect(host.visibleLines()[0]).toBe("current frame");
    expect(renderer.visibleLines()[0]).toBe("current frame");
    expect(snapshot).toMatchObject({ cursor: 17, modelSequence: Buffer.byteLength("obsolete frame\x1b[2J\x1b[Hcurrent frame") });
    host.dispose();
    renderer.dispose();
  });

  it("serializes dimensions and a bounded scrollback rather than retaining raw PTY history", async () => {
    const terminal = createHeadlessTerminalModel({ cols: 20, rows: 2, scrollback: 2 });
    for (let index = 1; index <= 8; index += 1) {
      await terminal.write(`row-${index}\r\n`);
    }

    const snapshot = terminal.snapshot();
    expect(snapshot).toMatchObject({ cols: 20, rows: 2, scrollback: 2 });
    expect(snapshot.ansi).toContain("row-8");
    expect(snapshot.ansi).not.toContain("row-1");
    terminal.dispose();
  });

  it("reports alternate-screen mode so the renderer does not pretend TUI history is scrollback", async () => {
    const terminal = createHeadlessTerminalModel({ cols: 20, rows: 2, scrollback: 8 });
    await terminal.write("normal\n");
    expect(terminal.snapshot().bufferMode).toBe("normal");
    await terminal.write("\u001b[?1049halt-screen");
    expect(terminal.snapshot().bufferMode).toBe("alternate");
    terminal.dispose();
  });

  it("rejects invalid dimensions before a session can create an unusable screen", () => {
    expect(() => createHeadlessTerminalModel({ cols: 0 })).toThrow("terminal_cols_invalid");
    expect(() => createHeadlessTerminalModel({ rows: 0 })).toThrow("terminal_rows_invalid");
  });
});
