import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";
import "./App.css";

function App() {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0b0e14",
        foreground: "#e6e8ee",
        cursor: "#7aa2f7",
        selectionBackground: "rgba(122, 162, 247, 0.35)",
        black: "#0b0e14",
        brightBlack: "#3b4261",
        red: "#f7768e",
        brightRed: "#ff9eaa",
        green: "#9ece6a",
        brightGreen: "#b9f27c",
        yellow: "#e0af68",
        brightYellow: "#ffcf83",
        blue: "#7aa2f7",
        brightBlue: "#a3c1ff",
        magenta: "#bb9af7",
        brightMagenta: "#d7b8ff",
        cyan: "#7dcfff",
        brightCyan: "#9bdfff",
        white: "#c0caf5",
        brightWhite: "#f5f7ff",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    terminal.writeln("VibeCode Terminal — MVP scaffold");
    terminal.writeln("");
    terminal.writeln("Next: wire PTY backend + pane layout system.");

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
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
        <div className="terminal" ref={terminalRef} />
      </div>
    </div>
  );
}

export default App;
