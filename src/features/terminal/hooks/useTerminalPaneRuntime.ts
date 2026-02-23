import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";
import { onPtyExit, onPtyOutput, ptyKill, ptyResize, ptySpawn, ptyWrite } from "@/shared/api/tauri";
import type { TerminalPaneActions } from "../types";

const getCssVar = (name: string, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const MIN_DRAWER_HEIGHT = 120;

type UseTerminalPaneRuntimeOptions = {
  id: string;
  isActive: boolean;
  cwd?: string | null;
  drawerOpen: boolean;
  drawerHeight: number;
  onResizeDrawer?: (height: number) => void;
  onFocus: (id: string) => void;
  onBusyState?: (id: string, isBusy: boolean) => void;
  onCwdChange?: (id: string, cwd: string) => void;
  initialCwd?: string | null;
  onRegisterActions?: (id: string, actions: TerminalPaneActions) => void;
  onUnregisterActions?: (id: string) => void;
};

type PaneRuntime = {
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionId: string | null;
  drawerSessionId: string | null;
  initialized: boolean;
  drawerTerminal: Terminal | null;
  drawerFitAddon: FitAddon | null;
};

const paneRuntime = new Map<string, PaneRuntime>();

export const useTerminalPaneRuntime = ({
  id,
  isActive,
  cwd,
  drawerOpen,
  drawerHeight,
  onResizeDrawer,
  onFocus,
  onBusyState,
  onCwdChange,
  initialCwd,
  onRegisterActions,
  onUnregisterActions,
}: UseTerminalPaneRuntimeOptions) => {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const xtermRef = useRef<Terminal | null>(null);
  const drawerXtermRef = useRef<Terminal | null>(null);
  const drawerFitRef = useRef<FitAddon | null>(null);
  const drawerSessionIdRef = useRef<string | null>(null);
  const drawerSpawnInFlightRef = useRef(false);
  const drawerCleanupRef = useRef<(() => void) | null>(null);
  const drawerSyncedCwdRef = useRef<string | null>(null);
  const drawerPendingEchoRef = useRef<string | null>(null);
  const drawerEchoBufferRef = useRef("");
  const startedRef = useRef(false);
  const startRequestedRef = useRef(false);
  const spawnInFlightRef = useRef(false);
  const spawnAttemptsRef = useRef(0);
  const startSessionRef = useRef<(() => void) | null>(null);
  const cleanupSessionRef = useRef<(() => void) | null>(null);
  const cleanupTerminalRef = useRef<(() => void) | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const initializedRef = useRef(false);
  const initTerminalRef = useRef<(() => void) | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastInputAtRef = useRef(0);
  const lastOutputAtRef = useRef(0);
  const busyTimerRef = useRef<number | null>(null);
  const inputGuardTimerRef = useRef<number | null>(null);
  const fallbackClearTimerRef = useRef<number | null>(null);
  const markerBufferRef = useRef("");
  const drawerMarkerBufferRef = useRef("");
  const integrationActiveRef = useRef(false);
  const initialCwdRef = useRef<string | null>(initialCwd ?? null);
  const disposedRef = useRef(false);
  const markBusy = useCallback((next: boolean) => {
    onBusyState?.(id, next);
  }, [id, onBusyState]);

  const { title: cwdTitle, subtitle: cwdSubtitle } = useMemo(() => {
    if (!cwd) {
      return { title: "Terminal", subtitle: "Waiting for shell…" };
    }
    const normalized = cwd.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const title = parts[parts.length - 1] ?? cwd;
    let shortened = normalized;
    const macMatch = normalized.match(/^\/Users\/([^/]+)(\/.*)?$/);
    if (macMatch) {
      shortened = `~${macMatch[2] ?? ""}`;
    } else {
      const linuxMatch = normalized.match(/^\/home\/([^/]+)(\/.*)?$/);
      if (linuxMatch) {
        shortened = `~${linuxMatch[2] ?? ""}`;
      }
    }
    return { title, subtitle: shortened };
  }, [cwd]);

  const handleResizeStart = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!onResizeDrawer) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startHeight = drawerHeight;
      const containerHeight = containerRef.current?.clientHeight ?? 0;
      const maxHeight = containerHeight
        ? Math.max(MIN_DRAWER_HEIGHT, containerHeight - 120)
        : 420;
      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        const delta = startY - moveEvent.clientY;
        const nextHeight = Math.min(
          maxHeight,
          Math.max(MIN_DRAWER_HEIGHT, startHeight + delta),
        );
        onResizeDrawer?.(nextHeight);
      };
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "row-resize";
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [drawerHeight, onResizeDrawer],
  );

  const sendDrawerCwd = useCallback(
    (sessionId: string, targetCwd: string | null) => {
      if (!targetCwd) return;
      if (drawerSyncedCwdRef.current === targetCwd) return;
      const escaped = targetCwd.replace(/(["\\])/g, "\\$1");
      const command = `cd "${escaped}"`;
      drawerPendingEchoRef.current = command;
      void ptyWrite(sessionId, `${command}\n`).catch((error) => {
        const runtime = paneRuntime.get(id);
        if (drawerSessionIdRef.current === sessionId) {
          drawerSessionIdRef.current = null;
          if (runtime) {
            runtime.drawerSessionId = null;
          }
          drawerSyncedCwdRef.current = null;
          drawerPendingEchoRef.current = null;
          drawerEchoBufferRef.current = "";
        }
        runtime?.drawerTerminal?.writeln(`\r\n[pty_write error] ${String(error)}`);
      });
      drawerSyncedCwdRef.current = targetCwd;
    },
    [id],
  );

  const stripDrawerMarkers = useCallback((chunk: string) => {
    const prefix = "\u001b]999;";
    const suffix = "\u0007";
    let text = drawerMarkerBufferRef.current + chunk;
    drawerMarkerBufferRef.current = "";
    let output = "";

    while (text.length > 0) {
      const start = text.indexOf(prefix);
      if (start < 0) {
        output += text;
        break;
      }
      output += text.slice(0, start);
      const end = text.indexOf(suffix, start + prefix.length);
      if (end < 0) {
        drawerMarkerBufferRef.current = text.slice(start);
        break;
      }
      text = text.slice(end + suffix.length);
    }

    return output;
  }, []);

  const stripDrawerEcho = useCallback((chunk: string) => {
    const pending = drawerPendingEchoRef.current;
    if (!pending) return chunk;
    let text = drawerEchoBufferRef.current + chunk;
    drawerEchoBufferRef.current = "";
    if (!text) return "";

    const matchFromStart = (candidate: string) => {
      if (candidate.startsWith(pending)) {
        drawerPendingEchoRef.current = null;
        return candidate.slice(pending.length);
      }
      if (pending.startsWith(candidate)) {
        drawerEchoBufferRef.current = candidate;
        return "";
      }
      return null;
    };

    let stripped = matchFromStart(text);
    if (stripped !== null) return stripped;
    if (text.startsWith("\r")) {
      stripped = matchFromStart(text.slice(1));
      if (stripped !== null) return `\r${stripped}`;
    }

    drawerPendingEchoRef.current = null;
    return text;
  }, []);

  const ensureDrawerSession = useCallback(
    async (targetCwd: string | null) => {
      const runtime = paneRuntime.get(id);
      if (!runtime?.drawerTerminal || !runtime.drawerFitAddon) return null;
      const drawerTerminal = runtime.drawerTerminal;

      if (drawerSessionIdRef.current) {
        sendDrawerCwd(drawerSessionIdRef.current, targetCwd);
        return drawerSessionIdRef.current;
      }
      if (drawerSpawnInFlightRef.current) return null;
      drawerSpawnInFlightRef.current = true;
      let sessionId: string;
      try {
        sessionId = await ptySpawn({
          cols: drawerTerminal.cols,
          rows: drawerTerminal.rows,
          cwd: targetCwd ?? initialCwdRef.current ?? null,
        });
      } catch (error) {
        drawerSpawnInFlightRef.current = false;
        drawerTerminal.writeln(`\r\n[pty_spawn error] ${String(error)}`);
        return null;
      }
      drawerSpawnInFlightRef.current = false;
      drawerSessionIdRef.current = sessionId;
      drawerSyncedCwdRef.current = targetCwd ?? null;
      runtime.drawerSessionId = sessionId;

      const unlistenOutput = await onPtyOutput((payload) => {
          if (payload.session_id !== sessionId) return;
          const cleaned = stripDrawerEcho(stripDrawerMarkers(payload.data));
          if (!cleaned) return;
          drawerTerminal.write(cleaned);
        });

      const unlistenExit = await onPtyExit((payload) => {
          if (payload.session_id !== sessionId) return;
          if (drawerSessionIdRef.current === sessionId) {
            drawerSessionIdRef.current = null;
            runtime.drawerSessionId = null;
            drawerSyncedCwdRef.current = null;
            drawerPendingEchoRef.current = null;
            drawerEchoBufferRef.current = "";
          }
          drawerTerminal.write(
            `\r\n[process exited${payload.code !== undefined ? ` (${payload.code})` : ""}]`,
          );
          const cleanup = drawerCleanupRef.current;
          drawerCleanupRef.current = null;
          cleanup?.();
        });

      const onDataDisposable = drawerTerminal.onData((data) => {
        void ptyWrite(sessionId, data).catch((error) => {
          drawerTerminal.writeln(`\r\n[pty_write error] ${String(error)}`);
        });
      });

      drawerCleanupRef.current = () => {
        onDataDisposable.dispose();
        unlistenOutput();
        unlistenExit();
      };

      sendDrawerCwd(sessionId, targetCwd);
      return sessionId;
    },
    [id, sendDrawerCwd, stripDrawerMarkers, stripDrawerEcho],
  );

  useEffect(() => {
    if (sessionStarted) return;
    initialCwdRef.current = initialCwd ?? null;
  }, [initialCwd, sessionStarted]);

  const extractIntegrationMarkers = useCallback(
    (chunk: string, options?: { updateCwd?: boolean }) => {
      const updateCwd = options?.updateCwd !== false;
      const prefix = "\u001b]999;";
      const suffix = "\u0007";
      let text = markerBufferRef.current + chunk;
      markerBufferRef.current = "";
      let output = "";

      while (text.length > 0) {
        const start = text.indexOf(prefix);
        if (start < 0) {
          output += text;
          break;
        }
        output += text.slice(0, start);
        const end = text.indexOf(suffix, start + prefix.length);
        if (end < 0) {
          markerBufferRef.current = text.slice(start);
          break;
        }
        const payload = text.slice(start + prefix.length, end);
        integrationActiveRef.current = true;
        if (payload === "busy") {
          markBusy(true);
        } else if (payload === "idle") {
          markBusy(false);
        } else if (payload.startsWith("cwd=") && updateCwd) {
          onCwdChange?.(id, payload.slice(4));
        }
        text = text.slice(end + suffix.length);
      }

      return output;
    },
    [id, markBusy, onCwdChange],
  );

  // Queue terminal initialization to avoid blocking UI when splitting.
  const initQueueRef = useRef(Promise.resolve());
  const enqueueInit = (task: () => Promise<void>) => {
    initQueueRef.current = initQueueRef.current
      .then(
        () =>
          new Promise<void>((resolve) => {
            const run = () => {
              Promise.resolve(task())
                .catch(() => {})
                .finally(resolve);
            };
            window.setTimeout(run, 0);
          }),
      )
      .catch(() => {});
  };

  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive && !startedRef.current) {
      startSessionRef.current?.();
    }
    if (isActive && !initializedRef.current) {
      initTerminalRef.current?.();
    }
  }, [isActive]);

  useEffect(() => {
    let isMounted = true;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let drawerTerminal: Terminal | null = null;
    let drawerFitAddon: FitAddon | null = null;

    const autoRestart = true;

    const startSession = async () => {
      if (disposedRef.current) return () => {};
      if (!terminal || !fitAddon) return () => {};
      const runtime = paneRuntime.get(id);
      if (runtime?.sessionId) {
        sessionIdRef.current = runtime.sessionId;
        setSessionStarted(true);
          markBusy(false);
          return () => {};
        }
      if (spawnInFlightRef.current) return () => {};
      spawnInFlightRef.current = true;
      spawnAttemptsRef.current += 1;
      let sessionId: string;
      try {
        sessionId = await ptySpawn({
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: initialCwdRef.current ?? null,
        });
      } catch (error) {
        spawnInFlightRef.current = false;
        terminal.writeln(`\r\n[pty_spawn error] ${String(error)}`);
        return () => {};
      }

      if (disposedRef.current) {
        void ptyKill(sessionId).catch(() => {});
        return () => {};
      }

      sessionIdRef.current = sessionId;
      spawnInFlightRef.current = false;
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

      const unlistenOutput = await onPtyOutput((payload) => {
          if (payload.session_id !== localSessionId) return;
          if (!terminal) return;
          lastOutputAtRef.current = Date.now();
          const cleaned = extractIntegrationMarkers(payload.data);
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
        });

      const unlistenExit = await onPtyExit((payload) => {
          if (payload.session_id !== localSessionId) return;
          isActiveSession = false;
          const exitMessage = `\r\n[process exited${payload.code !== undefined ? ` (${payload.code})` : ""}]`;
          if (autoRestart) {
            terminal!.write(`${exitMessage} Restarting...\r\n`);
            restartPending = true;
            window.setTimeout(() => {
              cleanupSessionRef.current?.();
              terminal!.reset();
              if (isActiveRef.current) {
                terminal!.focus();
              }
              restartPending = false;
              void startSession();
            }, 300);
          } else {
            terminal!.write(`${exitMessage} Press Enter to restart.\r\n`);
          }
        });

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
        void ptyWrite(localSessionId, payload).catch(
          (error) => {
            terminal!.writeln(`\r\n[pty_write error] ${String(error)}`);
          },
        );
      };

      const handleInput = (data: string) => {
        if (!isActiveSession && !autoRestart && data === "\r" && !restartPending) {
          restartPending = true;
          cleanupSessionRef.current?.();
          window.setTimeout(() => {
            terminal!.reset();
            terminal!.focus();
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
      };

      const onDataDisposable = terminal.onData(handleInput);

      let resizeFrame: number | null = null;
      let resizeTimer: number | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let drawerResizeObserver: ResizeObserver | null = null;
      const runFit = () => {
        if (!terminalRef.current) return;
        const { clientWidth, clientHeight } = terminalRef.current;
        if (clientWidth === 0 || clientHeight === 0) return;
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = window.requestAnimationFrame(() => {
          fitAddon!.fit();
          if (isActiveSession) {
            void ptyResize(localSessionId, terminal!.cols, terminal!.rows).catch((error) => {
              terminal!.writeln(`\r\n[pty_resize error] ${String(error)}`);
            });
          }
        });
      };

      const runDrawerFit = () => {
        if (!drawerRef.current || !drawerFitAddon) return;
        const { clientWidth, clientHeight } = drawerRef.current;
        if (clientWidth === 0 || clientHeight === 0) return;
        drawerFitAddon.fit();
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
      if ("ResizeObserver" in window && drawerRef.current) {
        drawerResizeObserver = new ResizeObserver(() => {
          runDrawerFit();
        });
        drawerResizeObserver.observe(drawerRef.current);
      }
      scheduleFit();

      const focusTerminal = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        terminal!.focus();
      };
      const focusDrawer = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        drawerTerminal?.focus();
      };
      const focusOnPointerDown = (event: Event) => {
        event.preventDefault();
        focusTerminal();
      };
      const focusDrawerOnPointerDown = (event: Event) => {
        event.preventDefault();
        focusDrawer();
      };
      terminalRef.current?.addEventListener("mousedown", focusOnPointerDown);
      terminalRef.current?.addEventListener("touchstart", focusOnPointerDown);
      drawerRef.current?.addEventListener("mousedown", focusDrawerOnPointerDown);
      drawerRef.current?.addEventListener("touchstart", focusDrawerOnPointerDown);

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
        drawerResizeObserver?.disconnect();
        if (resizeTimer) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        if (flushScheduled) {
          window.cancelAnimationFrame(flushScheduled);
          flushScheduled = null;
        }
        if (pendingOutput) {
          terminal?.write(pendingOutput);
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
        drawerRef.current?.removeEventListener("mousedown", focusDrawerOnPointerDown);
        drawerRef.current?.removeEventListener("touchstart", focusDrawerOnPointerDown);
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
      if (disposedRef.current) return;
      if (initializedRef.current) return;
      if (!isMounted || !terminalRef.current) return;
      if (initializedRef.current) return;

      const terminalBackground = getCssVar("--surface-2", "#242428");
      const drawerBackground = getCssVar("--surface-3", terminalBackground);

      const existing = paneRuntime.get(id);
      if (existing) {
        terminal = existing.terminal;
        fitAddon = existing.fitAddon;
        drawerTerminal = existing.drawerTerminal;
        drawerFitAddon = existing.drawerFitAddon;
        if (existing.drawerSessionId) {
          drawerSessionIdRef.current = existing.drawerSessionId;
        }
      } else {
        terminal = new Terminal({
          cursorBlink: true,
          fontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
          fontSize: 13,
          theme: {
            background: terminalBackground,
            foreground: "#f2f2f2",
            cursor: "#f2f2f2",
            selectionBackground: "rgba(120, 120, 120, 0.45)",
            black: terminalBackground,
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
        drawerTerminal = new Terminal({
          cursorBlink: true,
          fontFamily: "SF Mono, Menlo, Monaco, Consolas, monospace",
          fontSize: 12,
          theme: {
            background: drawerBackground,
            foreground: "#f2f2f2",
            cursor: "#f2f2f2",
            selectionBackground: "rgba(120, 120, 120, 0.45)",
            black: drawerBackground,
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
        drawerFitAddon = new FitAddon();
        drawerTerminal.loadAddon(drawerFitAddon);
        paneRuntime.set(id, {
          terminal,
          fitAddon,
          sessionId: null,
          drawerSessionId: null,
          initialized: false,
          drawerTerminal,
          drawerFitAddon,
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
      drawerXtermRef.current = drawerTerminal;
      drawerFitRef.current = drawerFitAddon;
      setIsReady(true);
      initializedRef.current = true;
      runtime.initialized = true;
      if (drawerTerminal && drawerRef.current) {
        if (
          drawerTerminal.element &&
          drawerTerminal.element.parentElement !== drawerRef.current
        ) {
          drawerRef.current.innerHTML = "";
          drawerRef.current.appendChild(drawerTerminal.element);
        } else if (!drawerTerminal.element) {
          drawerTerminal.open(drawerRef.current);
        }
      }
      onRegisterActions?.(id, {
        focus: () => {
          terminal?.focus();
        },
        getSelection: () => terminal?.getSelection?.() ?? "",
        clearSelection: () => {
          if (typeof terminal?.clearSelection === "function") {
            terminal.clearSelection();
          }
        },
        selectAll: () => {
          if (typeof terminal?.selectAll === "function") {
            terminal.selectAll();
          }
        },
        paste: (text: string) => {
          if (!text) return;
          const sessionId = sessionIdRef.current;
          if (!sessionId) return;
          void ptyWrite(sessionId, text).catch((error) => {
            terminal?.writeln(`\r\n[pty_write error] ${String(error)}`);
          });
        },
        clearBuffer: () => {
          if (typeof terminal?.clear === "function") {
            terminal.clear();
          }
        },
        dispose: () => {
          if (disposedRef.current) return;
          disposedRef.current = true;
          cleanupSessionRef.current?.();
          cleanupSessionRef.current = null;
          drawerCleanupRef.current?.();
          drawerCleanupRef.current = null;
          if (sessionIdRef.current) {
            void ptyKill(sessionIdRef.current).catch(() => {});
            sessionIdRef.current = null;
          }
          if (drawerSessionIdRef.current) {
            void ptyKill(drawerSessionIdRef.current).catch(() => {});
            drawerSessionIdRef.current = null;
          }
          const runtime = paneRuntime.get(id);
          if (runtime) {
            runtime.terminal.dispose();
            runtime.fitAddon.dispose();
            runtime.drawerTerminal?.dispose();
            runtime.drawerFitAddon?.dispose();
            paneRuntime.delete(id);
          }
        },
      });

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
        onUnregisterActions?.(id);
        terminal = null;
        fitAddon = null;
        xtermRef.current = null;
        drawerXtermRef.current = null;
        drawerFitRef.current = null;
        setIsReady(false);
        setSessionStarted(false);
        markBusy(false);
        drawerSyncedCwdRef.current = null;
        drawerPendingEchoRef.current = null;
        drawerEchoBufferRef.current = "";
        if (inputGuardTimerRef.current) {
          window.clearTimeout(inputGuardTimerRef.current);
          inputGuardTimerRef.current = null;
        }
        if (fallbackClearTimerRef.current) {
          window.clearTimeout(fallbackClearTimerRef.current);
          fallbackClearTimerRef.current = null;
        }
        markerBufferRef.current = "";
        drawerMarkerBufferRef.current = "";
        integrationActiveRef.current = false;
        window.clearInterval(retryTimer);
      };
    };

    const requestInit = () => {
      if (!isMounted) return;
      if (!terminalRef.current) {
        window.requestAnimationFrame(requestInit);
        return;
      }
      initTerminalRef.current?.();
    };
    initTerminalRef.current = () => enqueueInit(initTerminal);
    requestInit();

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

  useEffect(() => {
    if (!drawerOpen) return;
    if (!drawerFitRef.current) return;
    window.requestAnimationFrame(() => {
      drawerFitRef.current?.fit();
    });
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const runtime = paneRuntime.get(id);
    if (!runtime?.drawerTerminal || !drawerRef.current) return;
    if (
      runtime.drawerTerminal.element &&
      runtime.drawerTerminal.element.parentElement !== drawerRef.current
    ) {
      drawerRef.current.innerHTML = "";
      drawerRef.current.appendChild(runtime.drawerTerminal.element);
    } else if (!runtime.drawerTerminal.element) {
      runtime.drawerTerminal.open(drawerRef.current);
    }
    window.requestAnimationFrame(() => {
      drawerFitRef.current?.fit();
      const drawerTerminal = runtime.drawerTerminal;
      if (drawerTerminal) {
        drawerTerminal.refresh(0, Math.max(drawerTerminal.rows - 1, 0));
      }
    });
    void ensureDrawerSession(cwd ?? initialCwdRef.current ?? null);
  }, [drawerOpen, id, isReady, cwd, ensureDrawerSession]);

  useEffect(() => {
    if (!drawerOpen) return;
    const runtime = paneRuntime.get(id);
    if (!runtime?.drawerTerminal || !runtime.drawerFitAddon) return;
    let resizeTimer: number | null = null;
    let drawerResizeObserver: ResizeObserver | null = null;
    const runFit = () => {
      if (!drawerRef.current) return;
      const { clientWidth, clientHeight } = drawerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      runtime.drawerFitAddon?.fit();
      const sessionId = drawerSessionIdRef.current;
      if (!sessionId) return;
      const drawerTerminal = runtime.drawerTerminal;
      if (!drawerTerminal) return;
      void ptyResize(sessionId, drawerTerminal.cols, drawerTerminal.rows).catch((error) => {
        drawerTerminal.writeln(`\r\n[pty_resize error] ${String(error)}`);
      });
    };

    const scheduleFit = () => {
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(runFit, 80);
    };

    window.addEventListener("resize", scheduleFit);
    if ("ResizeObserver" in window && drawerRef.current) {
      drawerResizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      drawerResizeObserver.observe(drawerRef.current);
    }
    scheduleFit();

    return () => {
      window.removeEventListener("resize", scheduleFit);
      drawerResizeObserver?.disconnect();
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    };
  }, [drawerOpen, id]);

  useEffect(() => {
    const handleRun = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { paneId?: string; command?: string } | null;
      if (!detail || detail.paneId !== id || !detail.command) return;
      const command = detail.command;
      const runCommand = async () => {
        const sessionId =
          drawerSessionIdRef.current ??
          (await ensureDrawerSession(cwd ?? initialCwdRef.current ?? null));
        if (!sessionId) return;
        void ptyWrite(sessionId, command).catch((error) => {
          const runtime = paneRuntime.get(id);
          runtime?.drawerTerminal?.writeln(`\r\n[pty_write error] ${String(error)}`);
        });
      };
      void runCommand();
    };
    window.addEventListener("drawer-run-command", handleRun as EventListener);
    return () => window.removeEventListener("drawer-run-command", handleRun as EventListener);
  }, [cwd, ensureDrawerSession, id]);

  return {
    containerRef,
    terminalRef,
    drawerRef,
    isReady,
    sessionStarted,
    cwdTitle,
    cwdSubtitle,
    handleResizeStart,
  };
};
