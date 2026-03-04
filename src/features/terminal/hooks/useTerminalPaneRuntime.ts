import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { onPtyExit, onPtyOutput, ptyKill, ptyResize, ptySpawn, ptyWrite } from "@/shared/api/tauri";
import type { TerminalPaneActions } from "../types";

const getCssVar = (name: string, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const enableUnicodeSupport = (terminal: Terminal) => {
  const unicode = terminal.unicode;
  if (!unicode) return;
  if (unicode.activeVersion === "11") return;
  const unicodeAddon = new Unicode11Addon();
  terminal.loadAddon(unicodeAddon);
  unicode.activeVersion = "11";
};

const tuneImeTextarea = (terminal: Terminal) => {
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.setAttribute("inputmode", "text");
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("spellcheck", "false");
};

const getCellMetrics = (terminal: Terminal) => {
  const screen = terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return null;
  const { clientWidth, clientHeight } = screen;
  if (!clientWidth || !clientHeight) return null;
  return {
    screen,
    cellWidth: clientWidth / terminal.cols,
    cellHeight: clientHeight / terminal.rows,
  };
};

const MIN_DRAWER_HEIGHT = 120;
const IME_DEBUG = false;
const USE_CUSTOM_IME = false;

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
  const fitAddonRef = useRef<FitAddon | null>(null);
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
  const [showRetry, setShowRetry] = useState(false);
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
  const imeActiveRef = useRef(false);
  const imeTargetRef = useRef<"main" | "drawer">("main");
  const lastCompositionValueRef = useRef("");
  const lastImeCommitRef = useRef<{ value: string; at: number } | null>(null);
  const imeFallbackArmedRef = useRef(false);
  const imeBypassRef = useRef(false);
  const lastImeActivityAtRef = useRef(0);
  const mainCompositionRef = useRef<HTMLDivElement | null>(null);
  const drawerCompositionRef = useRef<HTMLDivElement | null>(null);
  const mainCompositionCleanupRef = useRef<(() => void) | null>(null);
  const drawerCompositionCleanupRef = useRef<(() => void) | null>(null);
  const imePendingEchoRef = useRef("");
  const imeEchoBufferRef = useRef("");
  const drawerImePendingEchoRef = useRef("");
  const drawerImeEchoBufferRef = useRef("");
  const mainImeDebugRef = useRef<HTMLDivElement | null>(null);
  const drawerImeDebugRef = useRef<HTMLDivElement | null>(null);
  const imeDebugTimerRef = useRef<number | null>(null);
  const markBusy = useCallback((next: boolean) => {
    onBusyState?.(id, next);
  }, [id, onBusyState]);

  const focusTerminalTarget = useCallback((target: "main" | "drawer") => {
    if (target === "drawer") {
      drawerXtermRef.current?.focus();
      drawerXtermRef.current?.textarea?.focus();
    } else {
      xtermRef.current?.focus();
      xtermRef.current?.textarea?.focus();
    }
  }, []);

  const updateCompositionOverlay = useCallback(
    (target: "main" | "drawer", text: string) => {
      const terminal = target === "drawer" ? drawerXtermRef.current : xtermRef.current;
      if (!terminal) return;
      let overlay = target === "drawer" ? drawerCompositionRef.current : mainCompositionRef.current;
      const metrics = getCellMetrics(terminal);
      if (!metrics) return;
      const { screen, cellWidth, cellHeight } = metrics;
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "terminal-composition-helper";
        screen.appendChild(overlay);
        if (target === "drawer") {
          drawerCompositionRef.current = overlay;
        } else {
          mainCompositionRef.current = overlay;
        }
      }
      if (!text) {
        overlay.style.display = "none";
        overlay.textContent = "";
        return;
      }
      const buffer = terminal.buffer.active;
      const viewportY = buffer.viewportY ?? 0;
      const row = Math.min(
        Math.max(buffer.cursorY - viewportY, 0),
        Math.max(terminal.rows - 1, 0),
      );
      const col = Math.min(Math.max(buffer.cursorX, 0), Math.max(terminal.cols - 1, 0));
      overlay.textContent = text;
      overlay.style.display = "block";
      overlay.style.transform = `translate(${Math.round(col * cellWidth)}px, ${Math.round(row * cellHeight)}px)`;
    },
    [],
  );

  const updateImeDebug = useCallback((target: "main" | "drawer", message: string) => {
    if (!IME_DEBUG) return;
    const container = target === "drawer" ? drawerRef.current : terminalRef.current;
    if (!container) return;
    let debug = target === "drawer" ? drawerImeDebugRef.current : mainImeDebugRef.current;
    if (!debug) {
      debug = document.createElement("div");
      debug.className = "terminal-ime-debug";
      container.appendChild(debug);
      if (target === "drawer") {
        drawerImeDebugRef.current = debug;
      } else {
        mainImeDebugRef.current = debug;
      }
    }
    debug.textContent = message;
    debug.style.opacity = "1";
    if (imeDebugTimerRef.current) {
      window.clearTimeout(imeDebugTimerRef.current);
    }
    imeDebugTimerRef.current = window.setTimeout(() => {
      debug.style.opacity = "0";
    }, 6000);
  }, []);

  const stripImeEcho = useCallback(
    (chunk: string, pendingRef: React.MutableRefObject<string>, bufferRef: React.MutableRefObject<string>) => {
      if (!pendingRef.current) return chunk;
      const text = bufferRef.current + chunk;
      bufferRef.current = "";
      if (text.startsWith(pendingRef.current)) {
        const output = text.slice(pendingRef.current.length);
        pendingRef.current = "";
        return output;
      }
      if (pendingRef.current.startsWith(text)) {
        bufferRef.current = text;
        return "";
      }
      pendingRef.current = "";
      return text;
    },
    [],
  );

  const sendImeText = useCallback(
    (target: "main" | "drawer", text: string) => {
      if (!text) return;
      const normalized = text.normalize("NFC");
      const terminal = target === "drawer" ? drawerXtermRef.current : xtermRef.current;
      if (terminal) {
        const pendingRef = target === "drawer" ? drawerImePendingEchoRef : imePendingEchoRef;
        pendingRef.current += normalized;
        terminal.write(normalized);
        updateCompositionOverlay(target, "");
      }
      updateImeDebug(
        target,
        `IME commit "${normalized}" | session ${target === "drawer" ? drawerSessionIdRef.current ?? "none" : sessionIdRef.current ?? "none"}`,
      );
      const sessionId =
        target === "drawer" ? drawerSessionIdRef.current : sessionIdRef.current;
      if (!sessionId) return;
      void ptyWrite(sessionId, normalized).catch(() => { });
    },
    [updateCompositionOverlay],
  );

  const commitImeText = useCallback(
    (target: "main" | "drawer", text: string, source: string) => {
      if (!text) return;
      const normalized = text.normalize("NFC");
      if (!normalized) return;
      const now = performance.now();
      const lastCommit = lastImeCommitRef.current;
      if (lastCommit && lastCommit.value === normalized && now - lastCommit.at < 16) {
        updateImeDebug(target, `IME: dedupe (${source})`);
        return;
      }
      lastImeCommitRef.current = { value: normalized, at: now };
      imeBypassRef.current = true;
      sendImeText(target, normalized);
      window.setTimeout(() => {
        imeBypassRef.current = false;
      }, 120);
    },
    [sendImeText, updateImeDebug],
  );

  const setupCompositionListeners = useCallback(
    (target: "main" | "drawer", terminal: Terminal | null) => {
      if (!USE_CUSTOM_IME) return () => { };
      const textarea = terminal?.textarea;
      if (!terminal || !textarea) return () => { };
      updateImeDebug(target, "IME: ready");

      const handleCompositionStart = (event: CompositionEvent) => {
        imeTargetRef.current = target;
        imeActiveRef.current = true;
        imeFallbackArmedRef.current = true;
        lastImeActivityAtRef.current = performance.now();
        lastCompositionValueRef.current = event.data ?? "";
        updateCompositionOverlay(target, event.data ?? textarea.value ?? "");
        updateImeDebug(target, "IME: compositionstart");
      };
      const handleCompositionUpdate = (event: CompositionEvent) => {
        const value = event.data ?? textarea.value ?? "";
        lastCompositionValueRef.current = value;
        lastImeActivityAtRef.current = performance.now();
        updateCompositionOverlay(target, value);
        updateImeDebug(target, `IME: update "${value}"`);
      };
      const handleCompositionEnd = (event: CompositionEvent) => {
        const value = event.data || lastCompositionValueRef.current || textarea.value || "";
        updateImeDebug(
          target,
          `IME: end data="${event.data ?? ""}" value="${value}" textarea="${textarea.value}"`,
        );
        lastImeActivityAtRef.current = performance.now();
        imeActiveRef.current = false;
        lastCompositionValueRef.current = "";
        updateCompositionOverlay(target, "");
      };
      const handleBeforeInput = (event: Event) => {
        const inputEvent = event as InputEvent;
        if (inputEvent.inputType === "insertCompositionText") {
          imeTargetRef.current = target;
          imeActiveRef.current = true;
          const value = textarea.value || inputEvent.data || "";
          lastCompositionValueRef.current = value;
          updateCompositionOverlay(target, value);
          updateImeDebug(
            target,
            `IME: beforeinput type=${inputEvent.inputType} data="${inputEvent.data ?? ""}" textarea="${textarea.value}"`,
          );
        }
        if (inputEvent.inputType === "insertFromComposition") {
          const value = inputEvent.data || textarea.value || "";
          updateImeDebug(
            target,
            `IME: beforeinput type=${inputEvent.inputType} data="${inputEvent.data ?? ""}" value="${value}" textarea="${textarea.value}"`,
          );
          imeFallbackArmedRef.current = true;
          imeActiveRef.current = false;
          lastCompositionValueRef.current = "";
          updateCompositionOverlay(target, "");
        }
      };
      const handleInput = (event: Event) => {
        const inputEvent = event as InputEvent;
        updateImeDebug(
          target,
          `IME: input data="${inputEvent.data ?? ""}" composing=${inputEvent.isComposing} textarea="${textarea.value}"`,
        );
        if (inputEvent.isComposing) return;
        if (imeActiveRef.current) return;
        const now = performance.now();
        if (now - lastImeActivityAtRef.current > 300) return;
        const lastCommit = lastImeCommitRef.current;
        if (lastCommit && now - lastCommit.at < 120) return;
        const value = inputEvent.data ?? "";
        const text = value || textarea.value || "";
        if (!text) return;
        if (!imeFallbackArmedRef.current) return;
        commitImeText(target, text, value ? "input" : "input-textarea");
        textarea.value = "";
        imeFallbackArmedRef.current = false;
      };

      textarea.addEventListener("compositionstart", handleCompositionStart);
      textarea.addEventListener("compositionupdate", handleCompositionUpdate);
      textarea.addEventListener("compositionend", handleCompositionEnd);
      textarea.addEventListener("beforeinput", handleBeforeInput);
      textarea.addEventListener("input", handleInput);

      return () => {
        textarea.removeEventListener("compositionstart", handleCompositionStart);
        textarea.removeEventListener("compositionupdate", handleCompositionUpdate);
        textarea.removeEventListener("compositionend", handleCompositionEnd);
        textarea.removeEventListener("beforeinput", handleBeforeInput);
        textarea.removeEventListener("input", handleInput);
      };
    },
    [commitImeText, updateCompositionOverlay, updateImeDebug],
  );

  const retryShell = useCallback(() => {
    setShowRetry(false);
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void ptyKill(sessionId).catch(() => { });
      sessionIdRef.current = null;
      const runtime = paneRuntime.get(id);
      if (runtime) {
        runtime.sessionId = null;
      }
    }
    cleanupSessionRef.current?.();
    spawnInFlightRef.current = false;
    spawnAttemptsRef.current = 0;
    startedRef.current = false;
    startRequestedRef.current = true;
    initTerminalRef.current?.();
    window.setTimeout(() => {
      startSessionRef.current?.();
    }, 0);
  }, [id]);

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
    const text = drawerEchoBufferRef.current + chunk;
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

  const ensureDrawerTerminal = useCallback(() => {
    const runtime = paneRuntime.get(id);
    if (!runtime) return null;
    if (runtime.drawerTerminal && runtime.drawerFitAddon) {
      enableUnicodeSupport(runtime.drawerTerminal);
      tuneImeTextarea(runtime.drawerTerminal);
      return runtime;
    }

    const terminalBackground = getCssVar("--surface-2", "#242428");
    const drawerBackground = getCssVar("--surface-3", terminalBackground);
    const drawerTerminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      rendererType: "dom",
      screenReaderMode: true,
      fontFamily:
        "SF Mono, Menlo, Monaco, Consolas, Noto Sans Mono, Noto Sans CJK JP, Apple Color Emoji, monospace",
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
    const drawerFitAddon = new FitAddon();
    drawerTerminal.loadAddon(drawerFitAddon);
    enableUnicodeSupport(drawerTerminal);
    tuneImeTextarea(drawerTerminal);

    runtime.drawerTerminal = drawerTerminal;
    runtime.drawerFitAddon = drawerFitAddon;
    drawerXtermRef.current = drawerTerminal;
    drawerFitRef.current = drawerFitAddon;

    if (drawerRef.current) {
      if (drawerTerminal.element && drawerTerminal.element.parentElement !== drawerRef.current) {
        drawerRef.current.innerHTML = "";
        drawerRef.current.appendChild(drawerTerminal.element);
      } else if (!drawerTerminal.element) {
        drawerTerminal.open(drawerRef.current);
      }
    }
    tuneImeTextarea(drawerTerminal);

    return runtime;
  }, [id]);

  const ensureDrawerSession = useCallback(
    async (targetCwd: string | null) => {
      const runtime = ensureDrawerTerminal();
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
        const cleaned = stripImeEcho(
          stripDrawerEcho(stripDrawerMarkers(payload.data)),
          drawerImePendingEchoRef,
          drawerImeEchoBufferRef,
        );
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
        if (USE_CUSTOM_IME) {
          if (imeBypassRef.current) return;
          const lastCommit = lastImeCommitRef.current;
          if (lastCommit && data === lastCommit.value && performance.now() - lastCommit.at < 120) {
            return;
          }
          if (imeTargetRef.current === "drawer" && imeActiveRef.current) return;
        }
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
    [ensureDrawerTerminal, sendDrawerCwd, stripDrawerMarkers, stripDrawerEcho],
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
  const requestInitRef = useRef<(() => void) | null>(null);
  const enqueueInit = (task: () => Promise<void>) => {
    initQueueRef.current = initQueueRef.current
      .then(
        () =>
          new Promise<void>((resolve) => {
            const run = () => {
              Promise.resolve(task())
                .catch(() => { })
                .finally(resolve);
            };
            window.setTimeout(run, 0);
          }),
      )
      .catch(() => { });
  };

  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive && !startedRef.current) {
      startSessionRef.current?.();
    }
    if (isActive && isReady && !sessionIdRef.current) {
      startSessionRef.current?.();
    }
    if (isActive && !initializedRef.current) {
      requestInitRef.current?.();
    }
  }, [isActive, isReady]);

  useEffect(() => {
    let isMounted = true;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    const drawerTerminal: Terminal | null = null;
    const drawerFitAddon: FitAddon | null = null;

    const autoRestart = true;

    const startSession = async () => {
      if (disposedRef.current) return () => { };
      if (!terminal || !fitAddon) return () => { };
      const runtime = paneRuntime.get(id);
      if (runtime?.sessionId) {
        sessionIdRef.current = runtime.sessionId;
        setSessionStarted(true);
        markBusy(false);
        return () => { };
      }
      if (spawnInFlightRef.current) return () => { };
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
        return () => { };
      }

      if (disposedRef.current) {
        void ptyKill(sessionId).catch(() => { });
        return () => { };
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
        const cleaned = stripImeEcho(
          extractIntegrationMarkers(payload.data),
          imePendingEchoRef,
          imeEchoBufferRef,
        );
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
        if (USE_CUSTOM_IME) {
          if (imeBypassRef.current) return;
          const lastCommit = lastImeCommitRef.current;
          if (lastCommit && data === lastCommit.value && performance.now() - lastCommit.at < 120) {
            return;
          }
          if (imeTargetRef.current === "main" && imeActiveRef.current) return;
        }
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

      const focusTerminal = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        imeTargetRef.current = "main";
        if (!sessionIdRef.current) {
          startSessionRef.current?.();
        }
        terminal!.focus();
        terminal!.textarea?.focus();
      };
      const focusDrawer = () => {
        if (!isActiveRef.current) {
          onFocus(id);
        }
        imeTargetRef.current = "drawer";
        drawerXtermRef.current?.focus();
      };
      const focusOnPointerDown = (event: Event) => {
        focusTerminal();
      };
      const focusDrawerOnPointerDown = (event: Event) => {
        focusDrawer();
      };
      terminalRef.current?.addEventListener("mousedown", focusOnPointerDown);
      terminalRef.current?.addEventListener("touchstart", focusOnPointerDown);
      drawerRef.current?.addEventListener("mousedown", focusDrawerOnPointerDown);
      drawerRef.current?.addEventListener("touchstart", focusDrawerOnPointerDown);

      const cleanup = () => {
        isActiveSession = false;
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
        terminalRef.current?.removeEventListener("mousedown", focusOnPointerDown);
        terminalRef.current?.removeEventListener("touchstart", focusOnPointerDown);
        drawerRef.current?.removeEventListener("mousedown", focusDrawerOnPointerDown);
        drawerRef.current?.removeEventListener("touchstart", focusDrawerOnPointerDown);
        if (mainCompositionRef.current) {
          mainCompositionRef.current.remove();
          mainCompositionRef.current = null;
        }
        if (drawerCompositionRef.current) {
          drawerCompositionRef.current.remove();
          drawerCompositionRef.current = null;
        }
        if (drawerImeDebugRef.current) {
          drawerImeDebugRef.current.remove();
          drawerImeDebugRef.current = null;
        }
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
      const existing = paneRuntime.get(id);
      if (existing) {
        terminal = existing.terminal;
        fitAddon = existing.fitAddon;
        if (existing.drawerSessionId) {
          drawerSessionIdRef.current = existing.drawerSessionId;
        }
      } else {
        terminal = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          rendererType: "dom",
          screenReaderMode: true,
          fontFamily:
            "SF Mono, Menlo, Monaco, Consolas, Noto Sans Mono, Noto Sans CJK JP, Apple Color Emoji, monospace",
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
        enableUnicodeSupport(terminal);
        tuneImeTextarea(terminal);
        paneRuntime.set(id, {
          terminal,
          fitAddon,
          sessionId: null,
          drawerSessionId: null,
          initialized: false,
          drawerTerminal: null,
          drawerFitAddon: null,
        });
      }

      const runtime = paneRuntime.get(id);
      if (!runtime || !terminal || !fitAddon) return;

      enableUnicodeSupport(terminal);
      tuneImeTextarea(terminal);
      if (terminal.element && terminalRef.current && terminal.element.parentElement !== terminalRef.current) {
        terminalRef.current.innerHTML = "";
        terminalRef.current.appendChild(terminal.element);
      } else if (!terminal.element) {
        terminal.open(terminalRef.current);
      }
      tuneImeTextarea(terminal);

      mainCompositionCleanupRef.current?.();
      mainCompositionCleanupRef.current = setupCompositionListeners("main", terminal);

      fitAddon.fit();
      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;
      drawerXtermRef.current = drawerTerminal;
      drawerFitRef.current = drawerFitAddon;
      setIsReady(true);
      initializedRef.current = true;
      runtime.initialized = true;
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
            void ptyKill(sessionIdRef.current).catch(() => { });
            sessionIdRef.current = null;
          }
          if (drawerSessionIdRef.current) {
            void ptyKill(drawerSessionIdRef.current).catch(() => { });
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
        imeTargetRef.current = "main";
        if (!sessionIdRef.current) {
          startSessionRef.current?.();
        }
        terminal?.focus();
        terminal?.textarea?.focus();
      };
      const focusOnPointerDown = (event: Event) => {
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
        mainCompositionCleanupRef.current?.();
        mainCompositionCleanupRef.current = null;
        if (mainCompositionRef.current) {
          mainCompositionRef.current.remove();
          mainCompositionRef.current = null;
        }
        if (mainImeDebugRef.current) {
          mainImeDebugRef.current.remove();
          mainImeDebugRef.current = null;
        }
        onUnregisterActions?.(id);
        terminal = null;
        fitAddon = null;
        xtermRef.current = null;
        fitAddonRef.current = null;
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
    requestInitRef.current = requestInit;

    return () => {
      isMounted = false;
      cleanupTerminalRef.current?.();
      startSessionRef.current = null;
      initTerminalRef.current = null;
      requestInitRef.current = null;
      startedRef.current = false;
      initializedRef.current = false;
      markBusy(false);
    };
  }, [id, onFocus, markBusy, extractIntegrationMarkers, onRegisterActions, onUnregisterActions]);

  useEffect(() => {
    if (!isActive) return;
    requestInitRef.current?.();
    terminalRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    if (!isReady) return;
    startSessionRef.current?.();
  }, [isReady]);

  useEffect(() => {
    if (!isReady || !isActive) return;
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

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
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        void ptyResize(sessionId, terminal.cols, terminal.rows).catch((error) => {
          terminal.writeln(`\r\n[pty_resize error] ${String(error)}`);
        });
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

    return () => {
      window.removeEventListener("resize", scheduleFit);
      resizeObserver?.disconnect();
      if (resizeTimer) {
        window.clearTimeout(resizeTimer);
      }
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
    };
  }, [isActive, isReady]);

  useEffect(() => {
    if (sessionStarted) {
      setShowRetry(false);
      return;
    }
    if (!isReady) return;
    setShowRetry(false);
    const timer = window.setTimeout(() => {
      if (!sessionStarted) {
        setShowRetry(true);
      }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isReady, sessionStarted]);

  useEffect(() => {
    if (!drawerOpen) return;
    ensureDrawerTerminal();
    if (!drawerFitRef.current) return;
    window.requestAnimationFrame(() => {
      drawerFitRef.current?.fit();
    });
  }, [drawerOpen, ensureDrawerTerminal]);

  useEffect(() => {
    if (!drawerOpen) return;
    const runtime = ensureDrawerTerminal();
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
    drawerCompositionCleanupRef.current?.();
    drawerCompositionCleanupRef.current = setupCompositionListeners(
      "drawer",
      runtime.drawerTerminal,
    );
    return () => {
      drawerCompositionCleanupRef.current?.();
      drawerCompositionCleanupRef.current = null;
    };
  }, [drawerOpen, ensureDrawerTerminal, id, isReady, cwd, ensureDrawerSession, setupCompositionListeners]);

  useEffect(() => {
    if (!drawerOpen || !isActive) return;
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
  }, [drawerOpen, id, isActive]);

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
    showRetry,
    retryShell,
    cwdTitle,
    cwdSubtitle,
    handleResizeStart,
  };
};
