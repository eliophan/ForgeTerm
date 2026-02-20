import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

type TerminalPaneProps = {
  id: string;
  isActive: boolean;
  onFocus: (id: string) => void;
  onBusyState?: (id: string, isBusy: boolean) => void;
};

type PaneRuntime = {
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionId: string | null;
  initialized: boolean;
};

const paneRuntime = new Map<string, PaneRuntime>();

export default function TerminalPane({
  id,
  isActive,
  onFocus,
  onBusyState,
}: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const xtermRef = useRef<Terminal | null>(null);
  const startedRef = useRef(false);
  const startRequestedRef = useRef(false);
  const spawnInFlightRef = useRef(false);
  const spawnAttemptsRef = useRef(0);
  const startSessionRef = useRef<(() => void) | null>(null);
  const cleanupSessionRef = useRef<(() => void) | null>(null);
  const cleanupTerminalRef = useRef<(() => void) | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const initializedRef = useRef(false);
  const initTerminalRef = useRef<(() => void) | null>(null);
  const lastInputAtRef = useRef(0);
  const lastOutputAtRef = useRef(0);
  const busyTimerRef = useRef<number | null>(null);
  const inputGuardTimerRef = useRef<number | null>(null);
  const fallbackClearTimerRef = useRef<number | null>(null);
  const markerBufferRef = useRef("");
  const integrationActiveRef = useRef(false);
  const markBusy = useCallback((next: boolean) => {
    setIsBusy(next);
    onBusyState?.(id, next);
  }, [id, onBusyState]);

  const extractIntegrationMarkers = useCallback(
    (chunk: string) => {
      const busyMarker = "\u001b]999;busy\u0007";
      const idleMarker = "\u001b]999;idle\u0007";
      let text = markerBufferRef.current + chunk;
      markerBufferRef.current = "";
      let output = "";
      while (text.length > 0) {
        const busyIndex = text.indexOf(busyMarker);
        const idleIndex = text.indexOf(idleMarker);
        let nextIndex = -1;
        let markerLength = 0;
        let nextState: boolean | null = null;

        if (busyIndex >= 0 && (idleIndex < 0 || busyIndex < idleIndex)) {
          nextIndex = busyIndex;
          markerLength = busyMarker.length;
          nextState = true;
        } else if (idleIndex >= 0) {
          nextIndex = idleIndex;
          markerLength = idleMarker.length;
          nextState = false;
        }

        if (nextIndex < 0) {
          break;
        }

        output += text.slice(0, nextIndex);
        integrationActiveRef.current = true;
        if (nextState !== null) {
          markBusy(nextState);
        }
        text = text.slice(nextIndex + markerLength);
      }

      const markers = [busyMarker, idleMarker];
      let maxPrefix = 0;
      for (const marker of markers) {
        const limit = Math.min(marker.length - 1, text.length);
        for (let i = 1; i <= limit; i += 1) {
          if (text.endsWith(marker.slice(0, i))) {
            maxPrefix = Math.max(maxPrefix, i);
          }
        }
      }
      if (maxPrefix > 0) {
        markerBufferRef.current = text.slice(text.length - maxPrefix);
        text = text.slice(0, text.length - maxPrefix);
      }

      return output + text;
    },
    [markBusy],
  );

  // Queue terminal initialization to avoid blocking UI when splitting.
  const initQueueRef = useRef(Promise.resolve());
  const enqueueInit = (task: () => Promise<void>) => {
    initQueueRef.current = initQueueRef.current.then(task).catch(() => {});
  };

  useEffect(() => {
    isActiveRef.current = isActive;
    if (xtermRef.current && typeof xtermRef.current.setOption === "function") {
      xtermRef.current.setOption("disableStdin", !isActive);
    }
    if (isActive && !startedRef.current) {
      startSessionRef.current?.();
    }
    if (isActive && !initializedRef.current) {
      initTerminalRef.current?.();
    }
  }, [isActive]);

  useEffect(() => {
    if (!terminalRef.current) return;

    let isMounted = true;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;

    const autoRestart = true;

    const startSession = async () => {
      if (!terminal || !fitAddon) return () => {};
      const runtime = paneRuntime.get(id);
      if (runtime?.sessionId) {
        sessionIdRef.current = runtime.sessionId;
        return () => {};
      }
      if (spawnInFlightRef.current) return () => {};
      spawnInFlightRef.current = true;
      spawnAttemptsRef.current += 1;
      let sessionId: string;
      try {
        sessionId = await invoke<string>("pty_spawn", {
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: null,
        });
      } catch (error) {
        spawnInFlightRef.current = false;
        setSessionError(String(error));
        terminal.writeln(`\r\n[pty_spawn error] ${String(error)}`);
        return () => {};
      }

      sessionIdRef.current = sessionId;
      spawnInFlightRef.current = false;
      setSessionError(null);
      setSessionStarted(true);
      markBusy(false);
      if (runtime) {
        runtime.sessionId = sessionId;
      }
      const localSessionId = sessionId;
      let isActiveSession = true;
      let restartPending = false;

      let pendingOutput = "";
      let flushScheduled: number | null = null;
      const flushOutput = () => {
        flushScheduled = null;
        if (!pendingOutput) return;
        if (!terminal) {
          pendingOutput = "";
          return;
        }
        terminal.write(pendingOutput);
        pendingOutput = "";
      };

      const unlistenOutput = await listen<{ session_id: string; data: string }>(
        "pty-output",
        (event) => {
          if (event.payload.session_id !== localSessionId) return;
          if (!terminal) return;
          lastOutputAtRef.current = Date.now();
          const cleaned = extractIntegrationMarkers(event.payload.data);
          if (!cleaned) return;
          pendingOutput += cleaned;
          if (flushScheduled) return;
          flushScheduled = window.requestAnimationFrame(flushOutput);
          if (busyTimerRef.current) {
            window.clearTimeout(busyTimerRef.current);
          }
          busyTimerRef.current = window.setTimeout(() => {
            const now = Date.now();
            const idleMs = now - Math.max(lastInputAtRef.current, lastOutputAtRef.current);
            if (integrationActiveRef.current) return;
            if (idleMs >= 5000) {
              markBusy(false);
            }
          }, 5000);
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
              cleanupSessionRef.current?.();
              terminal.reset();
              if (isActiveRef.current) {
                terminal.focus();
              }
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
          cleanupSessionRef.current?.();
          window.setTimeout(() => {
            terminal.reset();
            terminal.focus();
            restartPending = false;
            void startSession();
          }, 0);
          return;
        }
        if (!isActiveSession) return;
        lastInputAtRef.current = Date.now();
        markBusy(true);
        if (fallbackClearTimerRef.current) {
          window.clearTimeout(fallbackClearTimerRef.current);
        }
        if (!integrationActiveRef.current && data.includes("\r")) {
          fallbackClearTimerRef.current = window.setTimeout(() => {
            if (!integrationActiveRef.current) {
              markBusy(false);
            }
          }, 15000);
        }
        if (inputGuardTimerRef.current) {
          window.clearTimeout(inputGuardTimerRef.current);
        }
        inputGuardTimerRef.current = window.setTimeout(() => {
          const now = Date.now();
          const hasOutputAfterInput = lastOutputAtRef.current > lastInputAtRef.current;
          if (integrationActiveRef.current) return;
          if (!hasOutputAfterInput && now - lastInputAtRef.current >= 1200) {
            markBusy(false);
          }
        }, 1200);
        pendingInput += data;
        if (inputFlushScheduled) return;
        inputFlushScheduled = window.requestAnimationFrame(flushInput);
      });

      let resizeFrame: number | null = null;
      let resizeTimer: number | null = null;
      let resizeObserver: ResizeObserver | null = null;
      const runFit = () => {
        if (!terminalRef.current) return;
        const { clientWidth, clientHeight } = terminalRef.current;
        if (clientWidth === 0 || clientHeight === 0) return;
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = window.requestAnimationFrame(() => {
          fitAddon.fit();
          if (isActiveSession) {
            void invoke("pty_resize", {
              sessionId: localSessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch((error) => {
              terminal.writeln(`\r\n[pty_resize error] ${String(error)}`);
            });
          }
        });
      };

      const scheduleFit = () => {
        if (resizeTimer) {
          window.clearTimeout(resizeTimer);
        }
        resizeTimer = window.setTimeout(runFit, 80);
      };

      window.addEventListener("resize", scheduleFit);
      if ("ResizeObserver" in window && terminalRef.current) {
        resizeObserver = new ResizeObserver(() => {
          scheduleFit();
        });
        resizeObserver.observe(terminalRef.current);
      }
      scheduleFit();

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
        window.removeEventListener("resize", scheduleFit);
        if (busyTimerRef.current) {
          window.clearTimeout(busyTimerRef.current);
          busyTimerRef.current = null;
        }
        if (inputGuardTimerRef.current) {
          window.clearTimeout(inputGuardTimerRef.current);
          inputGuardTimerRef.current = null;
        }
        if (fallbackClearTimerRef.current) {
          window.clearTimeout(fallbackClearTimerRef.current);
          fallbackClearTimerRef.current = null;
        }
        markerBufferRef.current = "";
        integrationActiveRef.current = false;
        markBusy(false);
        resizeObserver?.disconnect();
        if (resizeTimer) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
        }
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
      };
      cleanupSessionRef.current = cleanup;
      return cleanup;
    };

    startSessionRef.current = () => {
      if (startedRef.current) return;
      startRequestedRef.current = true;
      if (!terminal || !fitAddon) return;
      startedRef.current = true;
      window.setTimeout(() => {
        if (!isMounted) return;
        void startSession();
      }, 0);
    };

    const initTerminal = async () => {
      if (initializedRef.current) return;
      // keep minimal work during init to avoid UI stalls
      await new Promise<void>((resolve) => {
        const idle = (callback: () => void) => {
          if ("requestIdleCallback" in window) {
            (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(callback);
          } else {
            window.setTimeout(callback, 0);
          }
        };
        idle(() => resolve());
      });

      if (!isMounted || !terminalRef.current) return;
      if (initializedRef.current) return;

      const existing = paneRuntime.get(id);
      if (existing) {
        terminal = existing.terminal;
        fitAddon = existing.fitAddon;
      } else {
        terminal = new Terminal({
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
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        paneRuntime.set(id, {
          terminal,
          fitAddon,
          sessionId: null,
          initialized: false,
        });
      }

      const runtime = paneRuntime.get(id);
      if (!runtime || !terminal || !fitAddon) return;

      if (terminal.element && terminalRef.current && terminal.element.parentElement !== terminalRef.current) {
        terminalRef.current.innerHTML = "";
        terminalRef.current.appendChild(terminal.element);
      } else if (!terminal.element) {
        terminal.open(terminalRef.current);
      }

      fitAddon.fit();
      xtermRef.current = terminal;
      setIsReady(true);
      initializedRef.current = true;
      runtime.initialized = true;
      if (import.meta.env.DEV) {
        terminal.writeln("\r\n[terminal ready]");
      }
      void startedAt;

      if (startRequestedRef.current && !startedRef.current) {
        startedRef.current = true;
        window.setTimeout(() => {
          if (!isMounted) return;
          void startSession();
        }, 0);
      }

      const focusTerminal = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        terminal?.focus();
      };
      const focusOnPointerDown = (event: Event) => {
        event.preventDefault();
        focusTerminal();
      };
      terminalRef.current?.addEventListener("mousedown", focusOnPointerDown);
      terminalRef.current?.addEventListener("touchstart", focusOnPointerDown);

      if (!startedRef.current) {
        startRequestedRef.current = true;
        startedRef.current = true;
        window.setTimeout(() => {
          if (!isMounted) return;
          void startSession();
        }, 0);
      }

      const retryTimer = window.setInterval(() => {
        if (!isMounted) return;
        if (sessionIdRef.current) {
          window.clearInterval(retryTimer);
          return;
        }
        if (spawnAttemptsRef.current >= 3) {
          window.clearInterval(retryTimer);
          return;
        }
        void startSession();
      }, 500);

      cleanupTerminalRef.current = () => {
        isMounted = false;
        terminalRef.current?.removeEventListener("mousedown", focusOnPointerDown);
        terminalRef.current?.removeEventListener("touchstart", focusOnPointerDown);
        terminal = null;
        fitAddon = null;
        xtermRef.current = null;
        setIsReady(false);
        setSessionStarted(false);
        markBusy(false);
        if (inputGuardTimerRef.current) {
          window.clearTimeout(inputGuardTimerRef.current);
          inputGuardTimerRef.current = null;
        }
        if (fallbackClearTimerRef.current) {
          window.clearTimeout(fallbackClearTimerRef.current);
          fallbackClearTimerRef.current = null;
        }
        markerBufferRef.current = "";
        integrationActiveRef.current = false;
        window.clearInterval(retryTimer);
      };
    };

    initTerminalRef.current = () => enqueueInit(initTerminal);
    if (isActiveRef.current) {
      initTerminalRef.current();
    }

    return () => {
      isMounted = false;
      cleanupTerminalRef.current?.();
      startSessionRef.current = null;
      initTerminalRef.current = null;
      startedRef.current = false;
      initializedRef.current = false;
      markBusy(false);
    };
  }, [id, onFocus, markBusy]);

  useEffect(() => {
    if (isActive) {
      terminalRef.current?.focus();
    }
  }, [isActive]);

  useEffect(() => {
    if (!isReady) return;
    startSessionRef.current?.();
  }, [isReady]);

  return (
    <div
      className={`terminal ${isActive ? "terminal--active" : ""}`}
      onMouseDown={() => onFocus(id)}
      onTouchStart={() => onFocus(id)}
    >
      {import.meta.env.DEV && (
        <div className="terminal-debug">
          ready: {String(isReady)} | session: {String(sessionStarted)} | requested:{" "}
          {String(startRequestedRef.current)} | started: {String(startedRef.current)}{" "}
          | active: {String(isActive)} | sessionId: {sessionIdRef.current ?? "none"} | attempts:{" "}
          {String(spawnAttemptsRef.current)}{" "}
          | busy: {String(isBusy)} | integration: {String(integrationActiveRef.current)}
          {sessionError ? `| error: ${sessionError}` : ""}
        </div>
      )}
      {!isReady && (
        <div className="terminal-placeholder">
          Starting shell…
        </div>
      )}
      <div ref={terminalRef} tabIndex={0} className="terminal-inner" />
    </div>
  );
}
