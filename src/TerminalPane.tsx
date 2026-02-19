import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

type TerminalPaneProps = {
  id: string;
  isActive: boolean;
  onFocus: (id: string) => void;
  onSessionReady?: (id: string) => void;
};

export default function TerminalPane({
  id,
  isActive,
  onFocus,
  onSessionReady,
}: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const xtermRef = useRef<Terminal | null>(null);
  const startedRef = useRef(false);
  const startSessionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    isActiveRef.current = isActive;
    if (xtermRef.current) {
      xtermRef.current.setOption("disableStdin", !isActive);
    }
    if (isActive && !startedRef.current) {
      startSessionRef.current?.();
    }
  }, [isActive]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      disableStdin: !isActiveRef.current,
      theme: {
        background: "#1e1e1e",
        foreground: "#f2f2f2",
        cursor: "#f2f2f2",
        selectionBackground: "rgba(120, 120, 120, 0.45)",
        black: "#1e1e1e",
        brightBlack: "#5c5c5c",
        red: "#d75f5f",
        brightRed: "#ff6b6b",
        green: "#87af5f",
        brightGreen: "#9ecb6b",
        yellow: "#d7af5f",
        brightYellow: "#ffd479",
        blue: "#5f87d7",
        brightBlue: "#7aa2f7",
        magenta: "#af87d7",
        brightMagenta: "#c7a1ff",
        cyan: "#5fafd7",
        brightCyan: "#7dd3fc",
        white: "#d0d0d0",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();
    xtermRef.current = terminal;

    let cleanupCurrent: (() => void) | null = null;
    const autoRestart = true;

    const startSession = async () => {
      let sessionId: string;
      try {
        sessionId = await invoke<string>("pty_spawn", {
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: null,
        });
      } catch (error) {
        terminal.writeln(`\r\n[pty_spawn error] ${String(error)}`);
        return () => {};
      }

      sessionIdRef.current = sessionId;
      const localSessionId = sessionId;
      let isActiveSession = true;
      let restartPending = false;
      let readyNotified = false;

      let pendingOutput = "";
      let flushScheduled: number | null = null;
      const flushOutput = () => {
        flushScheduled = null;
        if (!pendingOutput) return;
        terminal.write(pendingOutput);
        pendingOutput = "";
      };

      const unlistenOutput = await listen<{ session_id: string; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.session_id !== localSessionId) return;
          pendingOutput += event.payload.data;
          if (flushScheduled) return;
          flushScheduled = window.requestAnimationFrame(flushOutput);
        },
      );

      const unlistenExit = await listen<{ session_id: string; code?: number }>(
        "pty-exit",
        (event) => {
          if (event.payload.session_id !== localSessionId) return;
          isActiveSession = false;
          const exitMessage = `\r\n[process exited${event.payload.code !== undefined ? ` (${event.payload.code})` : ""}]`;
          if (autoRestart) {
            terminal.write(`${exitMessage} Restarting...\r\n`);
            restartPending = true;
            window.setTimeout(() => {
              cleanupCurrent?.();
              terminal.reset();
              terminal.focus();
              restartPending = false;
              void startSession();
            }, 300);
          } else {
            terminal.write(`${exitMessage} Press Enter to restart.\r\n`);
          }
        },
      );

      let pendingInput = "";
      let inputFlushScheduled: number | null = null;
      const flushInput = () => {
        inputFlushScheduled = null;
        if (!pendingInput || !isActiveSession) {
          pendingInput = "";
          return;
        }
        const payload = pendingInput;
        pendingInput = "";
        void invoke("pty_write", { sessionId: localSessionId, data: payload }).catch(
          (error) => {
            terminal.writeln(`\r\n[pty_write error] ${String(error)}`);
          },
        );
      };

      const onDataDisposable = terminal.onData((data) => {
        if (!isActiveSession && !autoRestart && data === "\r" && !restartPending) {
          restartPending = true;
          cleanupCurrent?.();
          window.setTimeout(() => {
            terminal.reset();
            terminal.focus();
            restartPending = false;
            void startSession();
          }, 0);
          return;
        }
        if (!isActiveSession) return;
        pendingInput += data;
        if (inputFlushScheduled) return;
        inputFlushScheduled = window.requestAnimationFrame(flushInput);
      });

      let resizeFrame: number | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = window.requestAnimationFrame(() => {
          fitAddon.fit();
          if (!isActiveSession) return;
          void invoke("pty_resize", {
            sessionId: localSessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch((error) => {
            terminal.writeln(`\r\n[pty_resize error] ${String(error)}`);
          });
        });
      });
      resizeObserver.observe(terminalRef.current!);

      const focusTerminal = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        terminal.focus();
      };
      const focusOnPointerDown = (event: Event) => {
        event.preventDefault();
        focusTerminal();
      };
      terminalRef.current?.addEventListener("mousedown", focusOnPointerDown);
      terminalRef.current?.addEventListener("touchstart", focusOnPointerDown);

      const cleanup = () => {
        isActiveSession = false;
        resizeObserver.disconnect();
        if (flushScheduled) {
          window.cancelAnimationFrame(flushScheduled);
          flushScheduled = null;
        }
        if (pendingOutput) {
          terminal.write(pendingOutput);
          pendingOutput = "";
        }
        if (inputFlushScheduled) {
          window.cancelAnimationFrame(inputFlushScheduled);
          inputFlushScheduled = null;
          pendingInput = "";
        }
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        terminalRef.current?.removeEventListener("mousedown", focusOnPointerDown);
        terminalRef.current?.removeEventListener("touchstart", focusOnPointerDown);
        onDataDisposable.dispose();
        unlistenOutput();
        unlistenExit();
        void invoke("pty_kill", { sessionId: localSessionId });
      };
      if (!readyNotified) {
        readyNotified = true;
        onSessionReady?.(id);
      }
      cleanupCurrent = cleanup;
      return cleanup;
    };

    let isMounted = true;
    startSessionRef.current = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      window.setTimeout(() => {
        if (!isMounted) return;
        void startSession();
      }, 0);
    };

    if (isActiveRef.current) {
      startSessionRef.current();
    }

    return () => {
      isMounted = false;
      cleanupCurrent?.();
      xtermRef.current = null;
      startSessionRef.current = null;
      startedRef.current = false;
      terminal.dispose();
    };
  }, [id, onFocus, onSessionReady]);

  useEffect(() => {
    if (isActive) {
      terminalRef.current?.focus();
    }
  }, [isActive]);

  return (
    <div
      className={`terminal ${isActive ? "terminal--active" : ""}`}
      ref={terminalRef}
      tabIndex={0}
    />
  );
}
