import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { Terminal as XtermTerminalInstance } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import {
  acknowledgeNativeTerminalOutput,
  attachNativeTerminalClient,
  detachNativeTerminalClient,
  isNativeTerminalTransportAvailable,
  readNativePtySession,
  subscribeNativePtyEvents,
  subscribeNativeTerminalClientEvents,
  type NativePtySession,
} from "../runtime/nativeBridge";

type PtyTerminalProps = {
  ariaLabel: string;
  command: string;
  session?: NativePtySession;
  transcriptLines: string[];
  className?: string;
  emptyTitle: string;
  emptyDetail: string;
  waitingDetail?: string;
  /** Per-terminal density. The Host is resized after this changes. */
  fontSize?: number;
  onFontSizeChange?: (fontSize: number) => void;
  /** Hidden Session tabs remain host-attached, but do not reflow on every split drag. */
  isVisible?: boolean;
  readOnly?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** The terminal surface follows its owning workbench theme. */
  theme?: "dark" | "light";
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
  fontSize = 11,
  onFontSizeChange,
  isVisible = true,
  readOnly = false,
  onData,
  onResize,
  theme = "dark",
}: PtyTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminalInstance | null>(null);
  const writeStateRef = useRef({ sessionId: "", cursor: 0 });
  const clientIdRef = useRef(createTerminalClientId());
  const attachmentRef = useRef<{ sessionId: string; generation: string } | undefined>(undefined);
  const sizeStateRef = useRef({ cols: 0, rows: 0 });
  const sessionRef = useRef<NativePtySession | undefined>(session);
  const sessionStatusRef = useRef<NativePtySession["status"] | undefined>(session?.status);
  const onDataRef = useRef<typeof onData>(onData);
  const onResizeRef = useRef<typeof onResize>(onResize);
  const onFontSizeChangeRef = useRef<typeof onFontSizeChange>(onFontSizeChange);
  const isVisibleRef = useRef(isVisible);
  const fitTerminalRef = useRef<(() => void) | undefined>(undefined);
  const hasOutputRef = useRef(Boolean(session?.transcript.length));
  const [hasOutput, setHasOutput] = useState(Boolean(session?.transcript.length));
  const [bufferMode, setBufferMode] = useState<"normal" | "alternate">("normal");
  const isJsdom =
    import.meta.env.MODE === "test" ||
    (typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom"));
  const canUseXterm = typeof window !== "undefined" && "ResizeObserver" in window && !isJsdom;
  const canUseHostTerminalTransport = canUseXterm && isNativeTerminalTransportAvailable();

  useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    onFontSizeChangeRef.current = onFontSizeChange;
    isVisibleRef.current = isVisible;
    sessionRef.current = session;
    sessionStatusRef.current = session?.status;
  }, [isVisible, onData, onResize, session, session?.status]);

  const markHasOutput = () => {
    if (hasOutputRef.current) return;
    hasOutputRef.current = true;
    setHasOutput(true);
  };

  const setTerminalBufferMode = (next: "normal" | "alternate") => {
    setBufferMode(next);
  };

  const replayLegacySessionSnapshot = (terminal: XtermTerminalInstance, targetSession: NativePtySession) => {
    void readNativePtySession(targetSession.id, 0).then((snapshot) => {
      if (!snapshot || sessionRef.current?.id !== targetSession.id || terminalRef.current !== terminal) return;
      terminal.reset();
      setTerminalBufferMode("normal");
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

  const acknowledgeHostCursor = (terminal: XtermTerminalInstance, targetSession: NativePtySession, generation: string, cursor: number) => {
    void acknowledgeNativeTerminalOutput({
      sessionId: targetSession.id,
      clientId: clientIdRef.current,
      generation,
      cursor,
    }).then((acknowledgement) => {
      const attachment = attachmentRef.current;
      if (!acknowledgement?.restoreRequired || !attachment || attachment.generation !== generation) return;
      if (terminalRef.current !== terminal || sessionRef.current?.id !== targetSession.id) return;
      restoreFromHostSnapshot(terminal, targetSession);
    });
  };

  const restoreFromHostSnapshot = (terminal: XtermTerminalInstance, targetSession: NativePtySession) => {
    // Orca reaps a dead host session (and its headless emulator) after exit.
    // Historical output belongs to the persisted terminal-history surface, not
    // to a new live stream attachment.  Attaching here used to surface the
    // misleading `terminal_session_not_live` IPC error for an already-ended
    // Session.
    if (targetSession.status !== "running") return;
    const generation = createTerminalClientId();
    attachmentRef.current = { sessionId: targetSession.id, generation };
    void attachNativeTerminalClient({ sessionId: targetSession.id, clientId: clientIdRef.current, generation })
      .then((attached) => {
        const activeAttachment = attachmentRef.current;
        if (!attached || !activeAttachment || activeAttachment.generation !== generation) return;
        if (terminalRef.current !== terminal || sessionRef.current?.id !== targetSession.id) return;
        terminal.reset();
        setTerminalBufferMode(attached.snapshot.bufferMode ?? "normal");
        if (terminal.cols !== attached.snapshot.cols || terminal.rows !== attached.snapshot.rows) {
          terminal.resize(attached.snapshot.cols, attached.snapshot.rows);
        }
        const confirmSnapshotParsed = () => {
          if (terminalRef.current !== terminal || attachmentRef.current?.generation !== generation) return;
          writeStateRef.current = { sessionId: targetSession.id, cursor: attached.snapshot.cursor };
          if (attached.snapshot.ansi) markHasOutput();
          acknowledgeHostCursor(terminal, targetSession, generation, attached.snapshot.cursor);
        };
        if (attached.snapshot.ansi) terminal.write(attached.snapshot.ansi, confirmSnapshotParsed);
        else confirmSnapshotParsed();
      })
      .catch(() => {
        // A Session can exit between the renderer's live-state check and its
        // attach RPC.  The next render reads durable history; never surface a
        // transport race as a Task failure.
        if (attachmentRef.current?.generation === generation) attachmentRef.current = undefined;
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
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: clampTerminalFontSize(fontSize),
        lineHeight: 1.08,
        scrollback: 5000,
        theme: terminalTheme(theme),
      });
      const fitAddon: FitAddonInstance = new fitModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      terminalRef.current = terminal;

      const fitTerminal = () => {
        if (!isVisibleRef.current) return;
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
      fitTerminalRef.current = fitTerminal;
      fitTerminal();
      window.requestAnimationFrame(fitTerminal);
      window.setTimeout(fitTerminal, 80);

      const dataDisposable = terminal.onData((data) => {
        if (!readOnly && isVisibleRef.current && sessionStatusRef.current === "running") {
          onDataRef.current?.(data);
        }
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown" || !(event.metaKey || event.ctrlKey)) return true;
        const current = clampTerminalFontSize(terminal.options.fontSize ?? fontSize);
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          onFontSizeChangeRef.current?.(clampTerminalFontSize(current + 1));
          return false;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          onFontSizeChangeRef.current?.(clampTerminalFontSize(current - 1));
          return false;
        }
        return true;
      });
      const resizeDisposable = terminal.onResize((size) => {
        const sizeState = sizeStateRef.current;
        if (size.cols > 0 && size.rows > 0 && (size.cols !== sizeState.cols || size.rows !== sizeState.rows)) {
          sizeState.cols = size.cols;
          sizeState.rows = size.rows;
          onResizeRef.current?.(size.cols, size.rows);
        }
      });
      // Leave wheel handling to xterm. In a normal buffer xterm scrolls its
      // own scrollback. When a TUI enables terminal mouse tracking, xterm
      // emits the protocol-correct mouse-wheel report to that TUI. Never turn
      // a reader's wheel gesture into synthetic Up/Down keyboard input.
      // FitAddon resize reflows the whole xterm scrollback.  During a split
      // drag a ResizeObserver can fire dozens of times per frame, which is
      // precisely the expensive path Orca debounces.  A hidden Session stays
      // attached to the Main-owned terminal stream but does not need fitting.
      let resizeTimer: number | undefined;
      const resizeObserver = new ResizeObserver(() => {
        if (!isVisibleRef.current) return;
        if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = undefined;
          fitTerminal();
        }, 120);
      });
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
        if (canUseHostTerminalTransport && currentSession.status === "running") restoreFromHostSnapshot(terminal, currentSession);
        else replayLegacySessionSnapshot(terminal, currentSession);
      }

      cleanup = () => {
        resizeObserver.disconnect();
        if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
        dataDisposable.dispose();
        resizeDisposable.dispose();
        terminal.dispose();
        const attachment = attachmentRef.current;
        if (attachment) {
          attachmentRef.current = undefined;
          void detachNativeTerminalClient({ clientId: clientIdRef.current, generation: attachment.generation });
        }
        terminalRef.current = null;
        fitTerminalRef.current = undefined;
        writeStateRef.current = { sessionId: "", cursor: 0 };
        sizeStateRef.current = { cols: 0, rows: 0 };
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [canUseHostTerminalTransport, canUseXterm, readOnly]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = clampTerminalFontSize(fontSize);
    if (isVisible) window.requestAnimationFrame(() => fitTerminalRef.current?.());
  }, [fontSize, isVisible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    // Updating xterm options preserves the live PTY attachment and its
    // scrollback. Recreating the terminal here would make a visual theme
    // toggle look like a terminal reconnect.
    terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isVisible) return;
    const fit = fitTerminalRef.current;
    if (!fit) return;
    window.requestAnimationFrame(fit);
  }, [isVisible, session?.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (!session) {
      terminal.reset();
      setTerminalBufferMode("normal");
      writeStateRef.current = { sessionId: "", cursor: 0 };
      hasOutputRef.current = false;
      setHasOutput(false);
      return;
    }

    terminal.reset();
    setTerminalBufferMode("normal");
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

    if (canUseHostTerminalTransport && session.status === "running") restoreFromHostSnapshot(terminal, session);
    else replayLegacySessionSnapshot(terminal, session);
  }, [canUseHostTerminalTransport, session?.id]);

  useEffect(() => {
    if (!canUseXterm || canUseHostTerminalTransport) return undefined;

    return subscribeNativePtyEvents((event) => {
      if (event.type !== "data") return;
      const terminal = terminalRef.current;
      const activeSession = sessionRef.current;
      if (!terminal || !activeSession || activeSession.id !== event.id) return;

      if (event.requiresSnapshot) {
        replayLegacySessionSnapshot(terminal, activeSession);
        return;
      }

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
  }, [canUseHostTerminalTransport, canUseXterm]);

  useEffect(() => {
    if (!canUseHostTerminalTransport) return undefined;
    return subscribeNativeTerminalClientEvents((event) => {
      const terminal = terminalRef.current;
      const activeSession = sessionRef.current;
      const attachment = attachmentRef.current;
      if (!terminal || !activeSession || !attachment || event.id !== activeSession.id || event.generation !== attachment.generation) return;

      if (event.type === "restore-required") {
        restoreFromHostSnapshot(terminal, activeSession);
        return;
      }

      setTerminalBufferMode(event.bufferMode ?? "normal");

      const writeState = writeStateRef.current;
      if (event.cursor <= writeState.cursor) {
        acknowledgeHostCursor(terminal, activeSession, attachment.generation, writeState.cursor);
        return;
      }
      terminal.write(event.chunk, () => {
        const currentAttachment = attachmentRef.current;
        if (!currentAttachment || currentAttachment.generation !== event.generation || terminalRef.current !== terminal) return;
        writeStateRef.current = { sessionId: event.id, cursor: event.cursor };
        markHasOutput();
        acknowledgeHostCursor(terminal, activeSession, event.generation, event.cursor);
      });
    });
  }, [canUseHostTerminalTransport]);

  const baseClassName = [
    className,
    "terminal-screen",
    "conversation-terminal-screen",
    canUseXterm ? "xterm-screen" : "",
    bufferMode === "alternate" ? "terminal-buffer-alternate" : "terminal-buffer-normal",
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
    <div className={baseClassName} aria-label={ariaLabel} onPointerDown={() => terminalRef.current?.focus()}>
      <div className="xterm-terminal-host" ref={containerRef} />
      {bufferMode === "alternate" ? <div className="terminal-buffer-mode" title="滚轮由 xterm 按 OpenCode 声明的原生鼠标协议处理，绝不会转换为键盘输入；可拖拽选择当前屏幕文字。需要完整保留输出时请使用终端历史。">OpenCode TUI</div> : null}
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

function clampTerminalFontSize(value: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(18, Math.max(8, Math.round(numeric))) : 11;
}

function terminalTheme(theme: "dark" | "light") {
  return theme === "light"
    ? {
      background: "#f8fafc",
      foreground: "#17212b",
      cursor: "#17212b",
      selectionBackground: "#bfd6ff",
    }
    : {
      background: "#101626",
      foreground: "#d7fbe8",
      cursor: "#d7fbe8",
      selectionBackground: "#2f415f",
    };
}

function createTerminalClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
