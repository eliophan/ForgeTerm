import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";
import "./App.css";

function App() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
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
    terminal.focus();

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
      let isActive = true;
      let restartPending = false;

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
          isActive = false;
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

      const onDataDisposable = terminal.onData((data) => {
        if (!isActive && !autoRestart && data === "\r" && !restartPending) {
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
        if (!isActive) return;
        void invoke("pty_write", { sessionId: localSessionId, data }).catch(
          (error) => {
            terminal.writeln(`\r\n[pty_write error] ${String(error)}`);
          },
        );
      });

      let resizeFrame: number | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = window.requestAnimationFrame(() => {
          fitAddon.fit();
          if (!isActive) return;
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

      const focusTerminal = () => terminal.focus();
      window.addEventListener("focus", focusTerminal);
      terminalRef.current?.addEventListener("mousedown", focusTerminal);
      terminalRef.current?.addEventListener("touchstart", focusTerminal);

      const cleanup = () => {
        isActive = false;
        resizeObserver.disconnect();
        if (flushScheduled) {
          window.cancelAnimationFrame(flushScheduled);
          flushScheduled = null;
        }
        if (pendingOutput) {
          terminal.write(pendingOutput);
          pendingOutput = "";
        }
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        window.removeEventListener("focus", focusTerminal);
        terminalRef.current?.removeEventListener("mousedown", focusTerminal);
        terminalRef.current?.removeEventListener("touchstart", focusTerminal);
        onDataDisposable.dispose();
        unlistenOutput();
        unlistenExit();
        void invoke("pty_kill", { sessionId: localSessionId });
      };
      cleanupCurrent = cleanup;
      return cleanup;
    };

    const cleanupPromise = startSession();

    return () => {
      void cleanupPromise.then((cleanup) => cleanup && cleanup());
      terminal.dispose();
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">VibeCode Terminal</div>
        <div className="subtitle">Tauri v2 + React + xterm.js</div>
      </header>
      <div className="terminal-shell">
        <div className="terminal" ref={terminalRef} tabIndex={0} />
      </div>
    </div>
  );
}

export default App;
