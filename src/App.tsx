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

    const startSession = async () => {
      const sessionId = await invoke<string>("pty_spawn", {
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: null,
      });
      sessionIdRef.current = sessionId;

      const unlisten = await listen<{ session_id: string; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.session_id !== sessionIdRef.current) return;
          terminal.write(event.payload.data);
        },
      );

      terminal.onData((data) => {
        if (!sessionIdRef.current) return;
        invoke("pty_write", { session_id: sessionIdRef.current, data });
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (!sessionIdRef.current) return;
        invoke("pty_resize", {
          session_id: sessionIdRef.current,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      });
      resizeObserver.observe(terminalRef.current!);

      const focusTerminal = () => terminal.focus();
      terminalRef.current?.addEventListener("mousedown", focusTerminal);
      terminalRef.current?.addEventListener("touchstart", focusTerminal);

      return () => {
        resizeObserver.disconnect();
        terminalRef.current?.removeEventListener("mousedown", focusTerminal);
        terminalRef.current?.removeEventListener("touchstart", focusTerminal);
        unlisten();
        if (sessionIdRef.current) {
          invoke("pty_kill", { session_id: sessionIdRef.current });
        }
      };
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
