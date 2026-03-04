import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { onPtyExit, onPtyOutput, ptyKill, ptyResize, ptySpawn, ptyWrite } from "@/shared/api/tauri";
import type { ImeMode } from "@/shared/ime";
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
const IME_DEBUG =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  window.localStorage.getItem("terminal:ime-debug") === "1";
const INPUT_COMPAT =
  typeof window !== "undefined" &&
  window.localStorage.getItem("terminal:ime-compat") !== "0";
const INPUT_COMPAT_DEDUPE_MS = 12;
const INPUT_COMPAT_OVERLAP_MS = 800;
const INPUT_COMPAT_HISTORY_MAX = 64;
const INPUT_COMPAT_SUPPRESS_MS = 40;
const IME_LOCAL_ECHO = false;
const IME_BUFFER_IDLE_MS = 250;
const IME_SHOW_OVERLAY = true;

type UseTerminalPaneRuntimeOptions = {
  id: string;
  isActive: boolean;
  cwd?: string | null;
  drawerOpen: boolean;
  drawerHeight: number;
  imeMode?: ImeMode;
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
  imeMode,
  onResizeDrawer,
  onFocus,
  onBusyState,
  onCwdChange,
  initialCwd,
  onRegisterActions,
  onUnregisterActions,
}: UseTerminalPaneRuntimeOptions) => {
  const resolvedImeMode = imeMode ?? "buffered";
  const useCustomIme = resolvedImeMode === "buffered";
  const useAsciiImeHeuristic = resolvedImeMode === "buffered";
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
  const imeFallbackTimerRef = useRef<number | null>(null);
  const imeBufferRef = useRef("");
  const imeBufferActiveRef = useRef(false);
  const imeBufferTimerRef = useRef<number | null>(null);
  const compatLastSentCharRef = useRef("");
  const compatLastSentAtRef = useRef(0);
  const drawerCompatLastSentCharRef = useRef("");
  const drawerCompatLastSentAtRef = useRef(0);
  const compatHistoryRef = useRef<{ base: string; at: number }[]>([]);
  const drawerCompatHistoryRef = useRef<{ base: string; at: number }[]>([]);
  const domInputAtRef = useRef(0);
  const drawerDomInputAtRef = useRef(0);
  const domInputHandlerRef = useRef<((text: string) => void) | null>(null);
  const drawerDomInputHandlerRef = useRef<((text: string) => void) | null>(null);
  const compatDomValueRef = useRef("");
  const drawerCompatDomValueRef = useRef("");
  const domSuppressUntilRef = useRef(0);
  const drawerDomSuppressUntilRef = useRef(0);
  const bufferedSpaceSuppressUntilRef = useRef(0);
  const compatNativeImeUntilRef = useRef(0);
  const drawerCompatNativeImeUntilRef = useRef(0);
  const compatInputDataRef = useRef("");
  const compatInputAtRef = useRef(0);
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
  const imeEventLogRef = useRef<string[]>([]);
  const markBusy = useCallback((next: boolean) => {
    onBusyState?.(id, next);
  }, [id, onBusyState]);

  const setImeComposing = useCallback((target: "main" | "drawer", active: boolean) => {
    if (target === "drawer") {
      drawerRef.current?.classList.toggle("ime-composing", active);
    } else {
      containerRef.current?.classList.toggle("ime-composing", active);
    }
  }, []);

  const updateCompositionOverlay = useCallback(
    (target: "main" | "drawer", text: string) => {
      if (!IME_SHOW_OVERLAY) return;
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

  const recordImeEvent = useCallback(
    (
      target: "main" | "drawer",
      kind: string,
      payload: Record<string, unknown>,
    ) => {
      if (!IME_DEBUG) return;
      const ts = performance.now().toFixed(1);
      const extras = Object.entries(payload)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      const line = `${ts} ${target} ${kind} ${extras}`.trim();
      imeEventLogRef.current.push(line);
      if (imeEventLogRef.current.length > 240) {
        imeEventLogRef.current.shift();
      }
      (window as { __terminalImeLog?: string }).__terminalImeLog =
        imeEventLogRef.current.join("\n");
      updateImeDebug(target, line);
    },
    [updateImeDebug],
  );

  const getFirstGrapheme = (text: string) => {
    const chars = Array.from(text);
    if (!chars.length) return "";
    let cluster = chars[0];
    for (let i = 1; i < chars.length; i += 1) {
      const ch = chars[i];
      if (/^\p{M}$/u.test(ch)) {
        cluster += ch;
      } else {
        break;
      }
    }
    return cluster;
  };

  const getLastGrapheme = (text: string) => {
    const chars = Array.from(text);
    if (!chars.length) return "";
    let cluster = "";
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      const ch = chars[i];
      cluster = ch + cluster;
      if (!/^\p{M}$/u.test(ch)) break;
    }
    return cluster;
  };

  const normalizeForCompare = (text: string) => text.normalize("NFC");

  const stripDiacritics = (text: string) =>
    text.normalize("NFD").replace(/\p{M}+/gu, "");

  const splitGraphemes = (text: string) => {
    const clusters: string[] = [];
    for (const ch of Array.from(text)) {
      if (/^\p{M}$/u.test(ch) && clusters.length) {
        clusters[clusters.length - 1] += ch;
      } else {
        clusters.push(ch);
      }
    }
    return clusters;
  };

  const getWordSuffixRemoval = (word: string, baseSuffix: string) => {
    if (!word || !baseSuffix) return null;
    const clusters = splitGraphemes(word);
    let acc = "";
    let removeChars = 0;
    for (let i = clusters.length - 1; i >= 0; i -= 1) {
      const cluster = clusters[i];
      acc = stripDiacritics(cluster) + acc;
      removeChars += cluster.length;
      if (acc.length === baseSuffix.length) {
        if (acc === baseSuffix) {
          return { removeChars, acc };
        }
        return null;
      }
      if (acc.length > baseSuffix.length) return null;
    }
    return null;
  };

  const isPrintablePayload = (text: string) => {
    if (!text) return false;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0x7f) return false;
      if (code < 0x20) return false;
    }
    return true;
  };

  const updateCompatHistory = (
    ref: React.MutableRefObject<{ base: string; at: number }[]>,
    text: string,
  ) => {
    if (!text) return;
    const now = performance.now();
    for (const cluster of splitGraphemes(text)) {
      if (cluster === "\x7f" || cluster === "\b") {
        ref.current.pop();
        continue;
      }
      const base = stripDiacritics(cluster);
      ref.current.push({ base, at: now });
      if (ref.current.length > INPUT_COMPAT_HISTORY_MAX) {
        ref.current.shift();
      }
    }
  };

  const applyCompatHistoryBackspace = (
    ref: React.MutableRefObject<{ base: string; at: number }[]>,
    count: number,
  ) => {
    if (!count) return;
    ref.current.splice(-count, count);
  };

  const findCompatHistorySuffix = (
    ref: React.MutableRefObject<{ base: string; at: number }[]>,
    basePayload: string,
  ) => {
    const baseClusters = splitGraphemes(basePayload);
    if (!baseClusters.length) return 0;
    const entries = ref.current;
    if (entries.length < baseClusters.length) return 0;
    const start = entries.length - baseClusters.length;
    if (performance.now() - entries[start].at > INPUT_COMPAT_OVERLAP_MS) return 0;
    for (let i = 0; i < baseClusters.length; i += 1) {
      if (entries[start + i].base !== baseClusters[i]) return 0;
    }
    return baseClusters.length;
  };

  const getTextDiffPayload = (prev: string, next: string) => {
    if (prev === next) return "";
    const prevClusters = splitGraphemes(prev);
    const nextClusters = splitGraphemes(next);
    let prefix = 0;
    while (
      prefix < prevClusters.length &&
      prefix < nextClusters.length &&
      prevClusters[prefix] === nextClusters[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < prevClusters.length - prefix &&
      suffix < nextClusters.length - prefix &&
      prevClusters[prevClusters.length - 1 - suffix] ===
        nextClusters[nextClusters.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const deleteCount = Math.max(0, prevClusters.length - prefix - suffix);
    const insertText = nextClusters
      .slice(prefix, nextClusters.length - suffix)
      .join("");
    if (suffix === 0) {
      return `${"\x7f".repeat(deleteCount)}${insertText}`;
    }
    const moveLeft = "\x1b[D".repeat(suffix);
    const moveRight = "\x1b[C".repeat(suffix);
    return `${moveLeft}${"\x7f".repeat(deleteCount)}${insertText}${moveRight}`;
  };

  const normalizeCompatValue = (value: string) => value.replace(/\u00a0/g, " ");

  const removeLastGrapheme = (value: string) => {
    if (!value) return "";
    const clusters = splitGraphemes(value);
    clusters.pop();
    return clusters.join("");
  };

  const buildCompatNextValue = (
    prevValue: string,
    inputType: string | undefined,
    dataValue: string,
    textareaValue: string,
  ) => {
    const normalizedData = normalizeCompatValue(dataValue);
    const normalizedTextarea = normalizeCompatValue(textareaValue);
    const rawValue = normalizedData || normalizedTextarea;
    if (!rawValue) return prevValue;

    const hasWhitespace = /\s/.test(rawValue);
    const prevHasWhitespace = /\s/.test(prevValue);
    const isReplacement =
      inputType === "insertReplacementText" || inputType === "insertFromComposition";

    if (inputType === "insertText" && !isReplacement) {
      if (rawValue.length === 1) {
        return `${prevValue}${rawValue}`;
      }
    }

    const replaceLastWord = (value: string) => {
      const lastWhitespace = Math.max(
        prevValue.lastIndexOf(" "),
        prevValue.lastIndexOf("\t"),
        prevValue.lastIndexOf("\n"),
        prevValue.lastIndexOf("\r"),
      );
      if (lastWhitespace >= 0) {
        return `${prevValue.slice(0, lastWhitespace + 1)}${value}`;
      }
      return value;
    };

    if (isReplacement && !hasWhitespace) {
      return replaceLastWord(rawValue);
    }

    if (!hasWhitespace && prevHasWhitespace) {
      return replaceLastWord(rawValue);
    }

    return rawValue;
  };

  const applyImeSuffixReplacement = (prevValue: string, dataValue: string) => {
    if (!prevValue || !dataValue) return null;
    const basePayload = stripDiacritics(dataValue);
    if (!basePayload) return null;
    const lastWhitespace = Math.max(
      prevValue.lastIndexOf(" "),
      prevValue.lastIndexOf("\t"),
      prevValue.lastIndexOf("\n"),
      prevValue.lastIndexOf("\r"),
    );
    const word = prevValue.slice(lastWhitespace + 1);
    if (!word) return null;
    const baseWord = stripDiacritics(word);
    let overlap = 0;
    const maxOverlap = Math.min(baseWord.length, basePayload.length);
    for (let len = maxOverlap; len > 0; len -= 1) {
      if (baseWord.endsWith(basePayload.slice(0, len))) {
        overlap = len;
        break;
      }
    }
    if (overlap === 0) return null;
    const removal = getWordSuffixRemoval(word, basePayload.slice(0, overlap));
    if (!removal) return null;
    const nextWord = word.slice(0, Math.max(0, word.length - removal.removeChars)) + dataValue;
    return `${prevValue.slice(0, lastWhitespace + 1)}${nextWord}`;
  };

  const isCompatNativeImeActive = (target: "main" | "drawer") => {
    const now = performance.now();
    const until =
      target === "drawer"
        ? drawerCompatNativeImeUntilRef.current
        : compatNativeImeUntilRef.current;
    return now < until;
  };

  const markCompatNativeIme = (target: "main" | "drawer", ms = 1200) => {
    const until = performance.now() + ms;
    if (target === "drawer") {
      drawerCompatNativeImeUntilRef.current = until;
    } else {
      compatNativeImeUntilRef.current = until;
    }
  };

  const markDomSuppress = (target: "main" | "drawer", ms: number) => {
    const until = performance.now() + ms;
    if (target === "drawer") {
      drawerDomSuppressUntilRef.current = Math.max(
        drawerDomSuppressUntilRef.current,
        until,
      );
    } else {
      domSuppressUntilRef.current = Math.max(domSuppressUntilRef.current, until);
    }
  };

  const graphemeOverlaps = (prev: string, next: string) => {
    const a = normalizeForCompare(prev);
    const b = normalizeForCompare(next);
    if (!a || !b) return false;
    if (a === b) return true;
    return stripDiacritics(a) === stripDiacritics(b);
  };

  const getLastPrintableChar = (text: string) => {
    const cluster = getLastGrapheme(text);
    if (cluster === "\r" || cluster === "\n") return "";
    return cluster;
  };

  const armImeFallbackWindow = useCallback((ms = 120) => {
    imeFallbackArmedRef.current = true;
    imeBufferActiveRef.current = true;
    if (imeFallbackTimerRef.current) {
      window.clearTimeout(imeFallbackTimerRef.current);
    }
    imeFallbackTimerRef.current = window.setTimeout(() => {
      imeFallbackArmedRef.current = false;
      if (!imeBufferRef.current) {
        imeBufferActiveRef.current = false;
      }
      imeFallbackTimerRef.current = null;
    }, ms);
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
      if (IME_LOCAL_ECHO) {
        const terminal = target === "drawer" ? drawerXtermRef.current : xtermRef.current;
        if (terminal) {
          const pendingRef = target === "drawer" ? drawerImePendingEchoRef : imePendingEchoRef;
          pendingRef.current += normalized;
          terminal.write(normalized);
        }
      }
      updateCompositionOverlay(target, "");
      updateImeDebug(
        target,
        `IME commit "${normalized}" | session ${target === "drawer" ? drawerSessionIdRef.current ?? "none" : sessionIdRef.current ?? "none"}`,
      );
      const sessionId =
        target === "drawer" ? drawerSessionIdRef.current : sessionIdRef.current;
      if (!sessionId) return;
      void ptyWrite(sessionId, normalized).catch(() => { });
    },
    [updateCompositionOverlay, updateImeDebug],
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const setupCompositionListeners = useCallback(
    (target: "main" | "drawer", terminal: Terminal | null) => {
      if (!useCustomIme && !IME_DEBUG && !INPUT_COMPAT) return () => { };
      const textarea = terminal?.textarea;
      if (!terminal || !textarea) return () => { };
      updateImeDebug(target, "IME: ready");

      const handleCompositionStart = (event: CompositionEvent) => {
        recordImeEvent(target, "compositionstart", {
          data: event.data ?? "",
          value: textarea.value,
        });
        imeTargetRef.current = target;
        imeActiveRef.current = true;
        markCompatNativeIme(target);
        setImeComposing(target, true);
        if (!useCustomIme) return;
        imeBufferRef.current = "";
        if (imeBufferTimerRef.current) {
          window.clearTimeout(imeBufferTimerRef.current);
          imeBufferTimerRef.current = null;
        }
        armImeFallbackWindow(200);
        lastCompositionValueRef.current = event.data ?? "";
        updateCompositionOverlay(target, event.data ?? textarea.value ?? "");
        updateImeDebug(target, "IME: compositionstart");
      };
      const handleCompositionUpdate = (event: CompositionEvent) => {
        const value = event.data ?? textarea.value ?? "";
        recordImeEvent(target, "compositionupdate", { data: event.data ?? "", value });
        markCompatNativeIme(target);
        if (!useCustomIme) return;
        lastCompositionValueRef.current = value;
        updateCompositionOverlay(target, value);
        updateImeDebug(target, `IME: update "${value}"`);
      };
      const handleCompositionEnd = (event: CompositionEvent) => {
        const value = event.data || lastCompositionValueRef.current || textarea.value || "";
        recordImeEvent(target, "compositionend", {
          data: event.data ?? "",
          value,
          textarea: textarea.value,
        });
        imeActiveRef.current = false;
        markCompatNativeIme(target, 500);
        setImeComposing(target, false);
        if (!useCustomIme) return;
        updateImeDebug(
          target,
          `IME: end data="${event.data ?? ""}" value="${value}" textarea="${textarea.value}"`,
        );
        armImeFallbackWindow(200);
        updateCompositionOverlay(target, "");
      };
      const handleBeforeInput = (event: Event) => {
        const inputEvent = event as InputEvent;
        recordImeEvent(target, "beforeinput", {
          inputType: inputEvent.inputType,
          data: inputEvent.data ?? "",
          value: textarea.value,
          composing: inputEvent.isComposing,
        });
        if (
          !useCustomIme &&
          (inputEvent.inputType === "insertCompositionText" ||
            inputEvent.inputType === "insertFromComposition")
        ) {
          markCompatNativeIme(target);
        }
        if (!useCustomIme) return;
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
          imeActiveRef.current = false;
          if (!useCustomIme) {
            markCompatNativeIme(target, 500);
          }
          const value = inputEvent.data || textarea.value || "";
          updateImeDebug(
            target,
            `IME: beforeinput type=${inputEvent.inputType} data="${inputEvent.data ?? ""}" value="${value}" textarea="${textarea.value}"`,
          );
          armImeFallbackWindow(200);
          imeActiveRef.current = false;
          updateCompositionOverlay(target, "");
        }
      };
      const handleInput = (event: Event) => {
        const inputEvent = event as InputEvent;
        recordImeEvent(target, "input", {
          inputType: inputEvent.inputType,
          data: inputEvent.data ?? "",
          value: textarea.value,
          composing: inputEvent.isComposing,
        });
        if (
          INPUT_COMPAT &&
          !inputEvent.isComposing &&
          inputEvent.inputType === "insertText" &&
          inputEvent.data
        ) {
          compatInputDataRef.current = inputEvent.data;
          compatInputAtRef.current = performance.now();
        }
        if (
          INPUT_COMPAT &&
          !useCustomIme &&
          !inputEvent.isComposing &&
          (inputEvent.inputType === "insertText" ||
            inputEvent.inputType === "insertReplacementText" ||
            inputEvent.inputType === "insertFromPaste" ||
            inputEvent.inputType === "insertFromComposition")
        ) {
          const rawData = inputEvent.data ?? "";
          const isReplacement =
            inputEvent.inputType === "insertReplacementText" ||
            inputEvent.inputType === "insertFromComposition";
          const suppressMs = isReplacement ? 200 : INPUT_COMPAT_SUPPRESS_MS;
          if (target === "drawer") {
            const prevValue = drawerCompatDomValueRef.current;
            const nextValue = buildCompatNextValue(
              prevValue,
              inputEvent.inputType,
              rawData,
              textarea.value,
            );
            const payload = getTextDiffPayload(prevValue, nextValue);
            drawerCompatDomValueRef.current = nextValue;
            if (payload) {
              drawerDomInputAtRef.current = performance.now();
              drawerDomInputHandlerRef.current?.(payload);
              markDomSuppress("drawer", suppressMs);
            }
            if (IME_DEBUG) {
              recordImeEvent(target, "compat-dom-input", {
                data: inputEvent.data,
                value: nextValue,
                payload,
              });
            }
          } else {
            const prevValue = compatDomValueRef.current;
            const nextValue = buildCompatNextValue(
              prevValue,
              inputEvent.inputType,
              rawData,
              textarea.value,
            );
            const payload = getTextDiffPayload(prevValue, nextValue);
            compatDomValueRef.current = nextValue;
            if (payload) {
              domInputAtRef.current = performance.now();
              domInputHandlerRef.current?.(payload);
              markDomSuppress("main", suppressMs);
            }
            if (IME_DEBUG) {
              recordImeEvent(target, "compat-dom-input", {
                data: inputEvent.data,
                value: nextValue,
                payload,
              });
            }
          }
          return;
        }
        if (
          useCustomIme &&
          !inputEvent.isComposing &&
          !isCompatNativeImeActive(target) &&
          (inputEvent.inputType === "insertText" ||
            inputEvent.inputType === "insertReplacementText") &&
          inputEvent.data &&
          /[^\u0000-\u007F]/.test(inputEvent.data)
        ) {
          const prevValue = compatDomValueRef.current;
          const rawData = inputEvent.data ?? "";
          const suffixValue = applyImeSuffixReplacement(prevValue, rawData);
          const nextValue =
            suffixValue ??
            buildCompatNextValue(prevValue, inputEvent.inputType, rawData, textarea.value);
          const payload = getTextDiffPayload(prevValue, nextValue);
          compatDomValueRef.current = nextValue;
          if (payload) {
            domInputAtRef.current = performance.now();
            domInputHandlerRef.current?.(payload);
            markDomSuppress("main", INPUT_COMPAT_SUPPRESS_MS);
          }
          return;
        }
        if (
          useCustomIme &&
          !inputEvent.isComposing &&
          !isCompatNativeImeActive(target) &&
          inputEvent.inputType === "insertText" &&
          inputEvent.data === " "
        ) {
          bufferedSpaceSuppressUntilRef.current = performance.now() + 120;
          domInputAtRef.current = performance.now();
          domInputHandlerRef.current?.(" ");
          return;
        }
        if (!useCustomIme) return;
        updateImeDebug(
          target,
          `IME: input data="${inputEvent.data ?? ""}" composing=${inputEvent.isComposing} textarea="${textarea.value}"`,
        );
        updateImeDebug(
          target,
          `IME: flags active=${imeActiveRef.current} bypass=${imeBypassRef.current} fallback=${imeFallbackArmedRef.current}`,
        );
        if (!inputEvent.isComposing) {
          imeActiveRef.current = false;
        }
        if (inputEvent.isComposing && inputEvent.inputType !== "insertFromComposition") return;
        const value = inputEvent.data ?? "";
        const text = value || textarea.value || lastCompositionValueRef.current || "";
        if (!text) return;
        const useHeuristic = useAsciiImeHeuristic;
        const isImeCommit =
          inputEvent.inputType === "insertFromComposition" ||
          (useHeuristic && /[^\\x00-\\x7F]/.test(text));
        const hasBuffer = imeBufferRef.current.length > 0;
        if (
          !imeFallbackArmedRef.current &&
          !imeBufferActiveRef.current &&
          !hasBuffer &&
          !isImeCommit
        )
          return;

        imeBufferActiveRef.current = true;
        imeBufferRef.current += text;
        lastCompositionValueRef.current = "";
        textarea.value = "";
        const buffer = imeBufferRef.current;
        const lastWhitespace = Math.max(
          buffer.lastIndexOf(" "),
          buffer.lastIndexOf("\n"),
          buffer.lastIndexOf("\r"),
          buffer.lastIndexOf("\t"),
        );
        if (lastWhitespace >= 0) {
          const commitChunk = buffer.slice(0, lastWhitespace + 1);
          const remainder = buffer.slice(lastWhitespace + 1);
          if (commitChunk) {
            commitImeText(target, commitChunk, "input-space");
          }
          imeBufferRef.current = remainder;
          if (!imeBufferRef.current && !imeFallbackArmedRef.current) {
            imeBufferActiveRef.current = false;
          }
          return;
        }

        if (imeBufferTimerRef.current) {
          window.clearTimeout(imeBufferTimerRef.current);
        }
        imeBufferTimerRef.current = window.setTimeout(() => {
          const pending = imeBufferRef.current;
          imeBufferRef.current = "";
          if (pending) {
            commitImeText(target, pending, "input-idle");
          }
          if (!imeFallbackArmedRef.current) {
            imeBufferActiveRef.current = false;
          }
          imeBufferTimerRef.current = null;
        }, IME_BUFFER_IDLE_MS);
      };
      const handleCompatKeyDown = (event: KeyboardEvent) => {
        if (!INPUT_COMPAT) return;
        if (imeActiveRef.current) return;
        if (event.key === "Process" || event.key === "Unidentified") return;
        if (isCompatNativeImeActive(target)) return;
        if (useCustomIme && !event.isComposing) return;
        const nonPrintable =
          event.key === "Enter" ||
          event.key === "Backspace" ||
          event.key === "Tab" ||
          event.key === "Escape" ||
          event.key === "Delete" ||
          event.key === "Home" ||
          event.key === "End" ||
          event.key === "PageUp" ||
          event.key === "PageDown" ||
          event.key.startsWith("Arrow");
        const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey;
        const isPrintableSingle = event.key.length === 1 && !nonPrintable;
        const shouldBlock =
          noModifiers &&
          !event.isComposing &&
          (event.key === " " ||
            isPrintableSingle ||
            (event.key.length > 1 && !nonPrintable));
        if (!shouldBlock) return;
        recordImeEvent(target, "compat-block", {
          key: event.key,
          code: event.code,
        });
        event.stopImmediatePropagation();
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        recordImeEvent(target, "keydown", {
          key: event.key,
          code: event.code,
          composing: event.isComposing,
          repeat: event.repeat,
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
        });
        if (!useCustomIme) return;
        updateImeDebug(
          target,
          `IME: keydown key="${event.key}" code="${event.code}"`,
        );
      };

      textarea.addEventListener("compositionstart", handleCompositionStart);
      textarea.addEventListener("compositionupdate", handleCompositionUpdate);
      textarea.addEventListener("compositionend", handleCompositionEnd);
      textarea.addEventListener("beforeinput", handleBeforeInput);
      textarea.addEventListener("input", handleInput);
      textarea.addEventListener("keydown", handleCompatKeyDown, true);
      textarea.addEventListener("keydown", handleKeyDown);

      return () => {
        textarea.removeEventListener("compositionstart", handleCompositionStart);
        textarea.removeEventListener("compositionupdate", handleCompositionUpdate);
        textarea.removeEventListener("compositionend", handleCompositionEnd);
        textarea.removeEventListener("beforeinput", handleBeforeInput);
        textarea.removeEventListener("input", handleInput);
        textarea.removeEventListener("keydown", handleCompatKeyDown, true);
        textarea.removeEventListener("keydown", handleKeyDown);
      };
    },
    [
      armImeFallbackWindow,
      commitImeText,
      recordImeEvent,
      setImeComposing,
      updateCompositionOverlay,
      updateImeDebug,
      useAsciiImeHeuristic,
      useCustomIme,
    ],
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        let payload = data;
        if (INPUT_COMPAT && !useCustomIme) {
          if (payload === "\x7f") {
            drawerCompatDomValueRef.current = removeLastGrapheme(
              drawerCompatDomValueRef.current,
            );
          } else if (payload.includes("\r") || payload.includes("\n")) {
            drawerCompatDomValueRef.current = "";
          }
        }
        if (
          INPUT_COMPAT &&
          !useCustomIme &&
          isPrintablePayload(payload)
        ) {
          if (IME_DEBUG) {
            recordImeEvent("drawer", "compat-suppress", { payload });
          }
          return;
        }
        if (INPUT_COMPAT) {
          const lastData = compatInputDataRef.current;
          if (
            lastData &&
            payload === lastData
          ) {
            const dedupeMs =
              useCustomIme && lastData === " " ? 120 : INPUT_COMPAT_DEDUPE_MS;
            if (performance.now() - compatInputAtRef.current < dedupeMs) {
              compatInputDataRef.current = "";
              return;
            }
          }
          if (
            payload.length > 1 &&
            !payload.includes("\r") &&
            !payload.includes("\n")
          ) {
            const firstCluster = getFirstGrapheme(payload);
            if (firstCluster) {
              const lastChar = drawerCompatLastSentCharRef.current;
              if (
                lastChar &&
                graphemeOverlaps(lastChar, firstCluster) &&
                performance.now() - drawerCompatLastSentAtRef.current < INPUT_COMPAT_OVERLAP_MS
              ) {
                if (IME_DEBUG) {
                  recordImeEvent("drawer", "compat-overlap", {
                    mode: "backspace",
                    lastChar,
                    firstCluster,
                    payload,
                  });
                }
                payload = `\x7f${payload}`;
              }
            }
          }
        }
        if (useCustomIme) {
          if (imeBufferActiveRef.current) return;
          if (imeBypassRef.current) {
            const lastCommit = lastImeCommitRef.current;
            if (lastCommit && payload === lastCommit.value) return;
          }
          if (IME_LOCAL_ECHO) {
            const lastCommit = lastImeCommitRef.current;
            if (
              lastCommit &&
              payload === lastCommit.value &&
              performance.now() - lastCommit.at < 120
            ) {
              return;
            }
          }
        }
        const lastChar = getLastPrintableChar(payload);
        if (lastChar) {
          drawerCompatLastSentCharRef.current = lastChar;
          drawerCompatLastSentAtRef.current = performance.now();
        }
        if (INPUT_COMPAT) {
          updateCompatHistory(drawerCompatHistoryRef, payload);
        }
        void ptyWrite(sessionId, payload).catch((error) => {
          drawerTerminal.writeln(`\r\n[pty_write error] ${String(error)}`);
        });
      });

      drawerDomInputHandlerRef.current = (payload: string) => {
        const data = payload;
        if (INPUT_COMPAT) {
          const lastData = compatInputDataRef.current;
          if (
            lastData &&
            data === lastData &&
            performance.now() - compatInputAtRef.current < INPUT_COMPAT_DEDUPE_MS
          ) {
            compatInputDataRef.current = "";
            return;
          }
        }
        if (useCustomIme) {
          if (imeBufferActiveRef.current) return;
          if (imeBypassRef.current) {
            const lastCommit = lastImeCommitRef.current;
            if (lastCommit && data === lastCommit.value) return;
          }
          if (IME_LOCAL_ECHO) {
            const lastCommit = lastImeCommitRef.current;
            if (
              lastCommit &&
              data === lastCommit.value &&
              performance.now() - lastCommit.at < 120
            ) {
              return;
            }
          }
        }
        const lastChar = getLastPrintableChar(data);
        if (lastChar) {
          drawerCompatLastSentCharRef.current = lastChar;
          drawerCompatLastSentAtRef.current = performance.now();
        }
        if (INPUT_COMPAT) {
          updateCompatHistory(drawerCompatHistoryRef, data);
        }
        void ptyWrite(sessionId, data).catch((error) => {
          drawerTerminal.writeln(`\r\n[pty_write error] ${String(error)}`);
        });
      };

      drawerCleanupRef.current = () => {
        onDataDisposable.dispose();
        unlistenOutput();
        unlistenExit();
        drawerDomInputHandlerRef.current = null;
      };

      sendDrawerCwd(sessionId, targetCwd);
      return sessionId;
    },
    [ensureDrawerTerminal, sendDrawerCwd, stripDrawerMarkers, stripDrawerEcho],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const lastChar = getLastPrintableChar(payload);
        if (lastChar) {
          compatLastSentCharRef.current = lastChar;
          compatLastSentAtRef.current = performance.now();
        }
        if (INPUT_COMPAT) {
          updateCompatHistory(compatHistoryRef, payload);
        }
        void ptyWrite(localSessionId, payload).catch(
          (error) => {
            terminal!.writeln(`\r\n[pty_write error] ${String(error)}`);
          },
        );
      };

      const handleInput = (data: string, source: "xterm" | "dom" = "xterm") => {
        let payload = data;
        if (source === "xterm" && useCustomIme) {
          if (
            payload === " " &&
            performance.now() < bufferedSpaceSuppressUntilRef.current
          ) {
            return;
          }
          if (payload === "\x7f") {
            compatDomValueRef.current = removeLastGrapheme(compatDomValueRef.current);
          } else if (payload.includes("\r") || payload.includes("\n")) {
            compatDomValueRef.current = "";
          } else if (isPrintablePayload(payload)) {
            compatDomValueRef.current += payload;
          }
        }
        if (source === "xterm" && INPUT_COMPAT && !useCustomIme) {
          if (payload === "\x7f") {
            compatDomValueRef.current = removeLastGrapheme(compatDomValueRef.current);
          } else if (payload.includes("\r") || payload.includes("\n")) {
            compatDomValueRef.current = "";
          }
        }
        if (
          source === "xterm" &&
          INPUT_COMPAT &&
          !useCustomIme &&
          isPrintablePayload(payload)
        ) {
          if (IME_DEBUG) {
            recordImeEvent("main", "compat-suppress", { payload });
          }
          return;
        }
        if (INPUT_COMPAT) {
          const lastData = compatInputDataRef.current;
          if (
            lastData &&
            payload === lastData &&
            performance.now() - compatInputAtRef.current < INPUT_COMPAT_DEDUPE_MS
          ) {
            compatInputDataRef.current = "";
            return;
          }
          if (
            source === "xterm" &&
            payload.length > 1 &&
            !payload.includes("\r") &&
            !payload.includes("\n")
          ) {
            const basePayload = stripDiacritics(payload);
            let overlapHandled = false;
            if (basePayload && pendingInput) {
              const lastWhitespace = Math.max(
                pendingInput.lastIndexOf(" "),
                pendingInput.lastIndexOf("\n"),
                pendingInput.lastIndexOf("\r"),
                pendingInput.lastIndexOf("\t"),
              );
              const word = pendingInput.slice(lastWhitespace + 1);
              const baseWord = stripDiacritics(word);
              if (baseWord.endsWith(basePayload)) {
                const removal = getWordSuffixRemoval(word, basePayload);
                if (removal) {
                  if (IME_DEBUG) {
                    recordImeEvent("main", "compat-overlap", {
                      mode: "pending-word",
                      basePayload,
                      baseWord,
                      removed: removal.acc,
                      payload,
                    });
                  }
                  pendingInput = pendingInput.slice(0, pendingInput.length - removal.removeChars);
                  overlapHandled = true;
                }
              }
            }
            if (!overlapHandled && basePayload) {
              const removalCount = findCompatHistorySuffix(compatHistoryRef, basePayload);
              if (removalCount > 0) {
                if (IME_DEBUG) {
                  recordImeEvent("main", "compat-overlap", {
                    mode: "history",
                    basePayload,
                    removalCount,
                    payload,
                  });
                }
                applyCompatHistoryBackspace(compatHistoryRef, removalCount);
                payload = `${"\x7f".repeat(removalCount)}${payload}`;
                overlapHandled = true;
              }
            }
            if (!overlapHandled) {
              const firstCluster = getFirstGrapheme(payload);
              if (firstCluster) {
                const lastCluster = getLastGrapheme(pendingInput);
                if (
                  lastCluster &&
                  lastCluster !== "\r" &&
                  lastCluster !== "\n" &&
                  graphemeOverlaps(lastCluster, firstCluster)
                ) {
                  if (IME_DEBUG) {
                    recordImeEvent("main", "compat-overlap", {
                      mode: "pending",
                      lastCluster,
                      firstCluster,
                      payload,
                    });
                  }
                  pendingInput = pendingInput.slice(0, -lastCluster.length);
                } else {
                  const lastChar = compatLastSentCharRef.current;
                  if (
                    lastChar &&
                    graphemeOverlaps(lastChar, firstCluster) &&
                    performance.now() - compatLastSentAtRef.current < INPUT_COMPAT_OVERLAP_MS
                  ) {
                    if (IME_DEBUG) {
                      recordImeEvent("main", "compat-overlap", {
                        mode: "backspace",
                        lastChar,
                        firstCluster,
                        payload,
                      });
                    }
                    payload = `\x7f${payload}`;
                  }
                }
              }
            }
          }
        }
        if (useCustomIme) {
          if (imeBufferActiveRef.current) return;
          if (imeBypassRef.current) {
            const lastCommit = lastImeCommitRef.current;
            if (lastCommit && payload === lastCommit.value) return;
          }
          if (IME_LOCAL_ECHO) {
            const lastCommit = lastImeCommitRef.current;
            if (
              lastCommit &&
              payload === lastCommit.value &&
              performance.now() - lastCommit.at < 120
            ) {
              return;
            }
          }
        }
        if (!isActiveSession && !autoRestart && payload === "\r" && !restartPending) {
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
        if (!integrationActiveRef.current && payload.includes("\r")) {
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
        pendingInput += payload;
        if (inputFlushScheduled) return;
        inputFlushScheduled = window.requestAnimationFrame(flushInput);
      };

      domInputHandlerRef.current = (payload: string) => {
        handleInput(payload, "dom");
      };
      const onDataDisposable = terminal.onData((payload) => handleInput(payload, "xterm"));

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
      const focusOnPointerDown = () => {
        focusTerminal();
      };
      const focusDrawerOnPointerDown = () => {
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
        domInputHandlerRef.current = null;
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
      const focusOnPointerDown = () => {
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
  }, [
    id,
    onFocus,
    markBusy,
    extractIntegrationMarkers,
    onRegisterActions,
    onUnregisterActions,
  ]);

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
