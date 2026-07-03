import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { Terminal as XtermTerminalInstance } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { readNativePtySession, subscribeNativePtyEvents, type NativePtySession } from "../runtime/nativeBridge";

type PtyTerminalProps = {
  ariaLabel: string;
  command: string;
  session?: NativePtySession;
  transcriptLines: string[];
  className?: string;
  emptyTitle: string;
  emptyDetail: string;
  waitingDetail?: string;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
};

export function PtyTerminal({
  ariaLabel,
  command,
  session,
  transcriptLines,
  className = "",
  emptyTitle,
  emptyDetail,
  waitingDetail = "PTY 已启动，正在等待 terminal 输出。",
  onData,
  onResize,
}: PtyTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminalInstance | null>(null);
  const writeStateRef = useRef({ sessionId: "", cursor: 0 });
  const sizeStateRef = useRef({ cols: 0, rows: 0 });
  const sessionRef = useRef<NativePtySession | undefined>(session);
  const sessionStatusRef = useRef<NativePtySession["status"] | undefined>(session?.status);
  const onDataRef = useRef<typeof onData>(onData);
  const onResizeRef = useRef<typeof onResize>(onResize);
  const hasOutputRef = useRef(Boolean(session?.transcript.length));
  const [hasOutput, setHasOutput] = useState(Boolean(session?.transcript.length));
  const isJsdom =
    import.meta.env.MODE === "test" ||
    (typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom"));
  const canUseXterm = typeof window !== "undefined" && "ResizeObserver" in window && !isJsdom;

  useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    sessionRef.current = session;
    sessionStatusRef.current = session?.status;
  }, [onData, onResize, session, session?.status]);

  const markHasOutput = () => {
    if (hasOutputRef.current) return;
    hasOutputRef.current = true;
    setHasOutput(true);
  };

  const replaySessionSnapshot = (terminal: XtermTerminalInstance, targetSession: NativePtySession) => {
    void readNativePtySession(targetSession.id, 0).then((snapshot) => {
      if (!snapshot || sessionRef.current?.id !== targetSession.id || terminalRef.current !== terminal) return;
      terminal.reset();
      for (const chunk of snapshot.transcript) {
        terminal.write(chunk);
      }
      writeStateRef.current = {
        sessionId: targetSession.id,
        cursor: snapshot.cursor ?? snapshot.transcript.length,
      };
      if (snapshot.transcript.length > 0) markHasOutput();
    });
  };

  useEffect(() => {
    if (!canUseXterm || !containerRef.current) return undefined;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xtermModule, fitModule]) => {
      if (disposed || !containerRef.current) return;

      const terminal = new xtermModule.Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.18,
        scrollback: 5000,
        theme: {
          background: "#101626",
          foreground: "#d7fbe8",
          cursor: "#d7fbe8",
          selectionBackground: "#2f415f",
        },
      });
      const fitAddon: FitAddonInstance = new fitModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      terminalRef.current = terminal;

      const fitTerminal = () => {
        try {
          fitAddon.fit();
          const cols = terminal.cols;
          const rows = terminal.rows;
          const sizeState = sizeStateRef.current;
          if (cols > 0 && rows > 0 && (cols !== sizeState.cols || rows !== sizeState.rows)) {
            sizeState.cols = cols;
            sizeState.rows = rows;
            onResizeRef.current?.(cols, rows);
          }
        } catch {
          // The terminal may briefly have no measurable box during layout transitions.
        }
      };
      fitTerminal();
      window.requestAnimationFrame(fitTerminal);
      window.setTimeout(fitTerminal, 80);

      const dataDisposable = terminal.onData((data) => {
        if (sessionStatusRef.current === "running") {
          onDataRef.current?.(data);
        }
      });
      const resizeDisposable = terminal.onResize((size) => {
        const sizeState = sizeStateRef.current;
        if (size.cols > 0 && size.rows > 0 && (size.cols !== sizeState.cols || size.rows !== sizeState.rows)) {
          sizeState.cols = size.cols;
          sizeState.rows = size.rows;
          onResizeRef.current?.(size.cols, size.rows);
        }
      });
      const resizeObserver = new ResizeObserver(fitTerminal);
      resizeObserver.observe(containerRef.current);

      const currentSession = sessionRef.current;
      if (currentSession) {
        for (const chunk of currentSession.transcript) {
          terminal.write(chunk);
        }
        if (currentSession.transcript.length > 0) markHasOutput();
        writeStateRef.current = {
          sessionId: currentSession.id,
          cursor: currentSession.cursor ?? currentSession.transcript.length,
        };
        if (currentSession.status === "running") terminal.focus();
        replaySessionSnapshot(terminal, currentSession);
      }

      cleanup = () => {
        resizeObserver.disconnect();
        dataDisposable.dispose();
        resizeDisposable.dispose();
        terminal.dispose();
        terminalRef.current = null;
        writeStateRef.current = { sessionId: "", cursor: 0 };
        sizeStateRef.current = { cols: 0, rows: 0 };
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [canUseXterm]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (!session) {
      terminal.reset();
      writeStateRef.current = { sessionId: "", cursor: 0 };
      hasOutputRef.current = false;
      setHasOutput(false);
      return;
    }

    terminal.reset();
    writeStateRef.current = { sessionId: session.id, cursor: 0 };
    hasOutputRef.current = false;
    setHasOutput(false);

    if (session.transcript.length > 0) {
      for (const chunk of session.transcript) {
        terminal.write(chunk);
      }
      writeStateRef.current = {
        sessionId: session.id,
        cursor: session.cursor ?? session.transcript.length,
      };
      markHasOutput();
    }

    replaySessionSnapshot(terminal, session);
  }, [session?.id]);

  useEffect(() => {
    if (!canUseXterm) return undefined;

    return subscribeNativePtyEvents((event) => {
      if (event.type !== "data") return;
      const terminal = terminalRef.current;
      const activeSession = sessionRef.current;
      if (!terminal || !activeSession || activeSession.id !== event.id) return;

      const writeState = writeStateRef.current;
      if (writeState.sessionId !== event.id) {
        writeState.sessionId = event.id;
        writeState.cursor = 0;
      }
      if (event.cursor <= writeState.cursor) return;

      terminal.write(event.chunk);
      writeState.cursor = event.cursor;
      markHasOutput();
    });
  }, [canUseXterm]);

  const baseClassName = [
    className,
    "terminal-screen",
    "conversation-terminal-screen",
    canUseXterm ? "xterm-screen" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!canUseXterm) {
    return (
      <div className={baseClassName} aria-label={ariaLabel}>
        {transcriptLines.length > 0 ? (
          transcriptLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
        ) : (
          <div className="terminal-empty-state">
            <strong>{emptyTitle}</strong>
            <p>{emptyDetail}</p>
            <code>{command}</code>
          </div>
        )}
      </div>
    );
  }

  const showEmptyState = !session;
  const showWaitingState = Boolean(session && session.status === "running" && !hasOutput);

  return (
    <div className={baseClassName} aria-label={ariaLabel}>
      <div className="xterm-terminal-host" ref={containerRef} />
      {showEmptyState ? (
        <div className="terminal-empty-state terminal-start-overlay">
          <strong>{emptyTitle}</strong>
          <p>{emptyDetail}</p>
          <code>{command}</code>
        </div>
      ) : null}
      {showWaitingState ? (
        <div className="terminal-empty-state terminal-start-overlay compact">
          <p>{waitingDetail}</p>
          <code>{command}</code>
        </div>
      ) : null}
    </div>
  );
}
