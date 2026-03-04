import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  GitCommit,
  Github,
  Folder,
  GitCompareArrows,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import type { ExplorerEntry, ExplorerState } from "@/features/explorer/types";
import { EMPTY_GIT_STATUS, formatGitStatus } from "@/features/git/types";
import type { GitStatusState } from "@/features/git/types";
import { useLayoutTree } from "@/features/layout/hooks/useLayoutTree";
import type { HandleInfo } from "@/features/layout/hooks/useLayoutTree";
import { RUNNERS } from "@/features/terminal/runners";
import type { RunnerOption } from "@/features/terminal/runners";
import TerminalPane from "@/TerminalPane";
import type { TerminalPaneActions } from "@/TerminalPane";
import { fsReadDir, gitCommit, gitPush, gitStatus } from "@/shared/api/tauri";

const BRAND_LOGOS: Partial<Record<string, string>> = {
  claude: "/Logo/claudecode.svg",
  codex: "/Logo/codex.svg",
  cursor: "/Logo/cursor.svg",
  windsurf: "/Logo/windsurf.svg",
  opencode: "/Logo/opencode.svg",
};

const renderBrandLogo = (id: string, fallback: ReactNode) => {
  const logo = BRAND_LOGOS[id];
  if (!logo) return fallback;
  return <img className="cli-runner__logo-image" src={logo} alt="" aria-hidden="true" />;
};

const omitPaneKey = <T,>(record: Record<string, T>, paneId: string): Record<string, T> => {
  if (!(paneId in record)) return record;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [paneId]: _removed, ...rest } = record;
  return rest;
};

type OpenTargetId =
  | "vscode"
  | "cursor"
  | "windsurf"
  | "antigravity"
  | "finder"
  | "terminal"
  | "warp"
  | "xcode"
  | "pycharm"
  | "webstorm";

type OpenTarget = {
  id: OpenTargetId;
  label: string;
  badge: string;
  command: (cwd: string) => string;
};

const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const OPEN_TARGETS: OpenTarget[] = [
  {
    id: "vscode",
    label: "VS Code",
    badge: "VS",
    command: (cwd) => `open -a "Visual Studio Code" ${quoteShell(cwd)}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    badge: "CU",
    command: (cwd) => `open -a "Cursor" ${quoteShell(cwd)}`,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    badge: "WI",
    command: (cwd) => `open -a "Windsurf" ${quoteShell(cwd)}`,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    badge: "AG",
    command: (cwd) => `open -a "Antigravity" ${quoteShell(cwd)}`,
  },
  {
    id: "finder",
    label: "Finder",
    badge: "FI",
    command: (cwd) => `open ${quoteShell(cwd)}`,
  },
  {
    id: "terminal",
    label: "Terminal",
    badge: "TM",
    command: (cwd) => `open -a "Terminal" ${quoteShell(cwd)}`,
  },
  {
    id: "warp",
    label: "Warp",
    badge: "WA",
    command: (cwd) => `open -a "Warp" ${quoteShell(cwd)}`,
  },
  {
    id: "xcode",
    label: "Xcode",
    badge: "XC",
    command: (cwd) => `open -a "Xcode" ${quoteShell(cwd)}`,
  },
  {
    id: "pycharm",
    label: "PyCharm",
    badge: "PC",
    command: (cwd) => `open -a "PyCharm" ${quoteShell(cwd)}`,
  },
  {
    id: "webstorm",
    label: "WebStorm",
    badge: "WS",
    command: (cwd) => `open -a "WebStorm" ${quoteShell(cwd)}`,
  },
];

function App() {
  const [paneBusy, setPaneBusy] = useState<Record<string, boolean>>({});
  const paneBusyRef = useRef<Record<string, boolean>>({});
  const allowWindowCloseRef = useRef(false);
  const closeConfirmOpenRef = useRef(false);
  const [sidebarModeByPane, setSidebarModeByPane] = useState<Record<string, "explorer" | "scm" | null>>({});
  const [paneCwd, setPaneCwd] = useState<Record<string, string>>({});
  const [explorerState, setExplorerState] = useState<Record<string, ExplorerState>>({});
  const [drawerOpenByPane, setDrawerOpenByPane] = useState<Record<string, boolean>>(
    {},
  );
  const [gitStatusByPane, setGitStatusByPane] = useState<Record<string, GitStatusState>>(
    {},
  );
  const [commitMessageByPane, setCommitMessageByPane] = useState<Record<string, string>>(
    {},
  );
  const [commitBusyByPane, setCommitBusyByPane] = useState<Record<string, boolean>>(
    {},
  );
  const [commitErrorByPane, setCommitErrorByPane] = useState<Record<string, string | null>>(
    {},
  );
  const [drawerHeightByPane, setDrawerHeightByPane] = useState<Record<string, number>>(
    {},
  );
  const {
    activeId,
    setActiveId,
    allPaneIds,
    paneCount,
    maxPanes,
    canCloseActive,
    onFocus,
    splitPane,
    removePaneFromTree,
    getNeighborId,
    setSplitRatio,
    paneBoundsMap,
    handles,
  } = useLayoutTree({
    maxPanes: 15,
  });
  const [commandByPane, setCommandByPane] = useState<Record<string, string>>({});
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runDialogValue, setRunDialogValue] = useState("");
  const [selectedRunnerId, setSelectedRunnerId] = useState<RunnerOption["id"]>(
    RUNNERS[0].id,
  );
  const [selectedOpenTargetId, setSelectedOpenTargetId] = useState<OpenTargetId>(
    OPEN_TARGETS[0].id,
  );
  const [runCliMenuOpen, setRunCliMenuOpen] = useState(false);
  const runCliMenuRef = useRef<HTMLDivElement | null>(null);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openMenuRef = useRef<HTMLDivElement | null>(null);
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const gitMenuRef = useRef<HTMLDivElement | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogValue, setCommitDialogValue] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const sidebarMode = sidebarModeByPane[activeId] ?? null;
  const explorerOpen = sidebarMode === "explorer";
  const scmOpen = sidebarMode === "scm";
  const setSidebarMode = useCallback(
    (mode: "explorer" | "scm" | null) => {
      setSidebarModeByPane((current) => ({ ...current, [activeId]: mode }));
    },
    [activeId],
  );

  const handleBusyState = useCallback((id: string, isBusy: boolean) => {
    setPaneBusy((current) => {
      if (current[id] === isBusy) return current;
      return { ...current, [id]: isBusy };
    });
  }, []);

  useEffect(() => {
    paneBusyRef.current = paneBusy;
  }, [paneBusy]);

  useEffect(() => {
    closeConfirmOpenRef.current = closeConfirmOpen;
  }, [closeConfirmOpen]);

  useEffect(() => {
    const windowHandle = getCurrentWindow();
    const unlistenPromise = windowHandle.onCloseRequested(async (event) => {
      if (allowWindowCloseRef.current) return;
      const hasBusyPanes = Object.values(paneBusyRef.current).some(Boolean);
      if (!hasBusyPanes) return;
      event.preventDefault();
      if (closeConfirmOpenRef.current) return;
      closeConfirmOpenRef.current = true;
      setCloseConfirmOpen(true);
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleCwdChange = useCallback((id: string, cwd: string) => {
    setPaneCwd((current) => (current[id] === cwd ? current : { ...current, [id]: cwd }));
    setExplorerState((current) => {
      const existing = current[id];
      if (existing?.cwd === cwd) return current;
      return {
        ...current,
        [id]: {
          cwd,
          entries: [],
          children: {},
          expanded: [],
          loading: [],
          error: null,
        },
      };
    });
  }, []);

  const loadDirectory = useCallback(
    async (paneId: string, path: string, parentPath: string | null) => {
      setExplorerState((current) => {
        const existing =
          current[paneId] ??
          ({
            cwd: paneCwd[paneId] ?? null,
            entries: [],
            children: {},
            expanded: [],
            loading: [],
            error: null,
          } as ExplorerState);
        if (existing.loading.includes(path)) return current;
        return {
          ...current,
          [paneId]: {
            ...existing,
            loading: [...existing.loading, path],
            error: null,
          },
        };
      });

      try {
        const entries = await fsReadDir(path);
        setExplorerState((current) => {
          const existing = current[paneId];
          if (!existing) return current;
          const loading = existing.loading.filter((item) => item !== path);
          if (!parentPath) {
            return {
              ...current,
              [paneId]: {
                ...existing,
                entries,
                loading,
                error: null,
              },
            };
          }
          const children = { ...existing.children, [parentPath]: entries };
          const expanded = existing.expanded.includes(parentPath)
            ? existing.expanded
            : [...existing.expanded, parentPath];
          return {
            ...current,
            [paneId]: {
              ...existing,
              children,
              expanded,
              loading,
              error: null,
            },
          };
        });
      } catch (error) {
        setExplorerState((current) => {
          const existing = current[paneId];
          if (!existing) return current;
          const loading = existing.loading.filter((item) => item !== path);
          return {
            ...current,
            [paneId]: {
              ...existing,
              loading,
              error: String(error),
            },
          };
        });
      }
    },
    [paneCwd],
  );

  const updateGitState = useCallback(
    (paneId: string, patch: Partial<GitStatusState>) => {
      setGitStatusByPane((current) => {
        const existing = current[paneId] ?? { ...EMPTY_GIT_STATUS };
        return {
          ...current,
          [paneId]: {
            ...existing,
            ...patch,
          },
        };
      });
    },
    [],
  );

  const loadGitStatus = useCallback(
    async (paneId: string, path: string) => {
      updateGitState(paneId, { loading: true, error: null });
      try {
        const payload = await gitStatus(path);
        updateGitState(paneId, {
          loading: false,
          error: null,
          root: payload.root,
          branch: payload.branch,
          ahead: payload.ahead,
          behind: payload.behind,
          files: payload.files,
        });
      } catch (error) {
        updateGitState(paneId, {
          loading: false,
          error: String(error),
          root: null,
          branch: null,
          ahead: 0,
          behind: 0,
          files: [],
        });
      }
    },
    [updateGitState],
  );

  const purgePaneState = useCallback((paneId: string) => {
    paneActionsRef.current.get(paneId)?.dispose();
    setPaneBusy((current) => omitPaneKey(current, paneId));
    setPaneCwd((current) => omitPaneKey(current, paneId));
    setExplorerState((current) => omitPaneKey(current, paneId));
    setDrawerOpenByPane((current) => omitPaneKey(current, paneId));
    setDrawerHeightByPane((current) => omitPaneKey(current, paneId));
    setCommandByPane((current) => omitPaneKey(current, paneId));
    setGitStatusByPane((current) => omitPaneKey(current, paneId));
    setCommitMessageByPane((current) => omitPaneKey(current, paneId));
    setCommitBusyByPane((current) => omitPaneKey(current, paneId));
    setCommitErrorByPane((current) => omitPaneKey(current, paneId));
    setSidebarModeByPane((current) => omitPaneKey(current, paneId));
  }, []);

  const closePane = useCallback(
    (targetId: string) => {
      if (paneCount <= 1 && targetId === activeId) return;
      if (paneBusy[targetId]) {
        const shouldClose = window.confirm(
          "Do you want to terminate running processes in this window?",
        );
        if (!shouldClose) return;
      }
      const neighborId = targetId === activeId ? getNeighborId(targetId) : null;
      const removed = removePaneFromTree(targetId);
      if (!removed) return;
      purgePaneState(targetId);
      if (neighborId) {
        setActiveId(neighborId);
      }
    },
    [activeId, paneBusy, paneCount, purgePaneState, setActiveId, removePaneFromTree, getNeighborId],
  );

  const addWorkspaceAt = useCallback(
    (targetId: string, direction: "horizontal" | "vertical" = "horizontal") => {
      const newId = splitPane(targetId, direction);
      if (newId) {
        setActiveId(newId);
      }
    },
    [splitPane, setActiveId],
  );

  const addWorkspace = useCallback(() => {
    addWorkspaceAt(activeId, "horizontal");
  }, [activeId, addWorkspaceAt]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetId: string;
    hasSelection: boolean;
    selectionText: string;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const paneActionsRef = useRef(new Map<string, TerminalPaneActions>());

  const openContextMenu = useCallback(
    (id: string, event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setActiveId(id);
      const selection = paneActionsRef.current.get(id)?.getSelection() ?? "";
      const trimmed = selection.trim();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        targetId: id,
        hasSelection: trimmed.length > 0,
        selectionText: selection,
      });
    },
    [setActiveId],
  );

  const registerActions = useCallback((id: string, actions: TerminalPaneActions) => {
    paneActionsRef.current.set(id, actions);
  }, []);

  const unregisterActions = useCallback((id: string) => {
    paneActionsRef.current.delete(id);
  }, []);

  const setDrawerOpenForPane = useCallback((id: string, open: boolean) => {
    setDrawerOpenByPane((current) => ({ ...current, [id]: open }));
  }, []);

  const setDrawerHeightForPane = useCallback((id: string, height: number) => {
    setDrawerHeightByPane((current) => ({ ...current, [id]: height }));
  }, []);

  const handleCommit = useCallback(async (overrideMessage?: string) => {
    const rawMessage = overrideMessage ?? commitMessageByPane[activeId] ?? "";
    const message = rawMessage.trim();
    if (!message) return;
    const cwd = paneCwd[activeId] ?? null;
    const root = gitStatusByPane[activeId]?.root ?? cwd;
    if (!root) return;
    setCommitBusyByPane((current) => ({ ...current, [activeId]: true }));
    setCommitErrorByPane((current) => ({ ...current, [activeId]: null }));
    try {
      await gitCommit(root, message);
      setCommitMessageByPane((current) => ({ ...current, [activeId]: "" }));
      await loadGitStatus(activeId, root);
    } catch (error) {
      setCommitErrorByPane((current) => ({ ...current, [activeId]: String(error) }));
    } finally {
      setCommitBusyByPane((current) => ({ ...current, [activeId]: false }));
    }
  }, [activeId, commitMessageByPane, paneCwd, gitStatusByPane, loadGitStatus]);

  const handleGitPush = useCallback(async () => {
    const cwd = paneCwd[activeId] ?? null;
    const root = gitStatusByPane[activeId]?.root ?? cwd;
    if (!root) return;
    setCommitBusyByPane((current) => ({ ...current, [activeId]: true }));
    setCommitErrorByPane((current) => ({ ...current, [activeId]: null }));
    try {
      await gitPush(root);
      await loadGitStatus(activeId, root);
    } catch (error) {
      setCommitErrorByPane((current) => ({ ...current, [activeId]: String(error) }));
    } finally {
      setCommitBusyByPane((current) => ({ ...current, [activeId]: false }));
    }
  }, [activeId, paneCwd, gitStatusByPane, loadGitStatus]);

  const handleRefreshGit = useCallback(() => {
    const cwd = paneCwd[activeId];
    if (!cwd) return;
    void loadGitStatus(activeId, cwd);
  }, [activeId, loadGitStatus, paneCwd]);

  const toggleScmSidebar = useCallback(() => {
    setSidebarModeByPane((current) => {
      const mode = current[activeId] ?? null;
      const next = mode === "scm" ? null : "scm";
      if (next === "scm") {
        const cwd = paneCwd[activeId];
        if (cwd) {
          void loadGitStatus(activeId, cwd);
        }
      }
      return { ...current, [activeId]: next };
    });
    window.requestAnimationFrame(() => {
      paneActionsRef.current.get(activeId)?.focus();
    });
  }, [activeId, loadGitStatus, paneCwd]);

  const openCommitDialog = useCallback(() => {
    setCommitDialogValue(commitMessageByPane[activeId] ?? "");
    setCommitDialogOpen(true);
    setSidebarModeByPane((current) => ({ ...current, [activeId]: "scm" }));
  }, [activeId, commitMessageByPane]);

  const selectedOpenTarget = useMemo(
    () =>
      OPEN_TARGETS.find((target) => target.id === selectedOpenTargetId) ??
      OPEN_TARGETS[0],
    [selectedOpenTargetId],
  );
  const selectedRunner = useMemo(
    () => RUNNERS.find((runner) => runner.id === selectedRunnerId) ?? RUNNERS[0],
    [selectedRunnerId],
  );

  const handleRunCommand = useCallback(
    (paneId: string, override?: string) => {
      const raw = override ?? commandByPane[paneId] ?? "";
      const trimmed = raw.trim();
      if (!trimmed) return;
      const command = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
      const event = new CustomEvent("drawer-run-command", {
        detail: { paneId, command },
      });
      window.dispatchEvent(event);
    },
    [commandByPane],
  );

  const handleOpenInTarget = useCallback((target: OpenTarget) => {
    const actions = paneActionsRef.current.get(activeId);
    if (!actions) return;
    const cwd = paneCwd[activeId] ?? ".";
    actions.paste(`${target.command(cwd)}\n`);
  }, [activeId, paneCwd]);

  const handleRunCli = useCallback((runner: RunnerOption) => {
    const actions = paneActionsRef.current.get(activeId);
    if (!actions) return;
    actions.paste(`${runner.command}\n`);
  }, [activeId]);

  const handleStartDragging = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void getCurrentWindow().startDragging();
    },
    [],
  );

  // ── Resize handle drag logic ──
  const paneRootRef = useRef<HTMLDivElement | null>(null);

  const startHandleDrag = useCallback(
    (e: React.MouseEvent, handle: HandleInfo) => {
      e.preventDefault();
      const root = paneRootRef.current;
      if (!root) return;

      const onMove = (ev: MouseEvent) => {
        const rect = root.getBoundingClientRect();
        if (handle.direction === "horizontal") {
          const mouseX = (ev.clientX - rect.left) / rect.width;
          const newRatio = (mouseX - handle.splitBounds.left) / handle.splitBounds.width;
          setSplitRatio(handle.splitId, newRatio);
        } else {
          const mouseY = (ev.clientY - rect.top) / rect.height;
          const newRatio = (mouseY - handle.splitBounds.top) / handle.splitBounds.height;
          setSplitRatio(handle.splitId, newRatio);
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor =
        handle.direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setSplitRatio],
  );

  useEffect(() => {
    const isMac =
      typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    document.documentElement.dataset.platform = isMac ? "darwin" : "other";
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.metaKey && event.key.toLowerCase() === "d")) return;
      event.preventDefault();
      if (event.shiftKey) {
        addWorkspace();
      } else {
        addWorkspace();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [addWorkspace]);

  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const { offsetWidth, offsetHeight } = contextMenuRef.current;
    const padding = 8;
    const maxX = window.innerWidth - offsetWidth - padding;
    const maxY = window.innerHeight - offsetHeight - padding;
    const clampedX = Math.min(contextMenu.x, Math.max(padding, maxX));
    const clampedY = Math.min(contextMenu.y, Math.max(padding, maxY));
    if (clampedX === contextMenu.x && clampedY === contextMenu.y) return;
    setContextMenu((current) =>
      current ? { ...current, x: clampedX, y: clampedY } : current,
    );
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
    };
    const handleScroll = () => setContextMenu(null);
    const handleResize = () => setContextMenu(null);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!runDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRunDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runDialogOpen]);

  useEffect(() => {
    if (!runCliMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (runCliMenuRef.current?.contains(event.target as Node)) return;
      setRunCliMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRunCliMenuOpen(false);
    };
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [runCliMenuOpen]);

  useEffect(() => {
    if (!openMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (openMenuRef.current?.contains(event.target as Node)) return;
      setOpenMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMenuOpen(false);
    };
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenuOpen]);

  useEffect(() => {
    if (!gitMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (gitMenuRef.current?.contains(event.target as Node)) return;
      setGitMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setGitMenuOpen(false);
    };
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [gitMenuOpen]);

  useEffect(() => {
    if (!commitDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCommitDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commitDialogOpen]);

  useEffect(() => {
    if (!explorerOpen) return;
    const cwd = paneCwd[activeId];
    if (!cwd) return;
    const existing = explorerState[activeId];
    if (!existing || existing.cwd !== cwd || existing.entries.length === 0) {
      void loadDirectory(activeId, cwd, null);
    }
  }, [activeId, explorerOpen, explorerState, loadDirectory, paneCwd]);

  useEffect(() => {
    const cwd = paneCwd[activeId];
    if (!cwd) return;
    void loadGitStatus(activeId, cwd);
  }, [activeId, paneCwd, loadGitStatus]);

  const toggleDirectory = useCallback(
    (paneId: string, entry: ExplorerEntry) => {
      if (!entry.isDir) return;
      setExplorerState((current) => {
        const existing = current[paneId];
        if (!existing) return current;
        const isExpanded = existing.expanded.includes(entry.path);
        if (isExpanded) {
          return {
            ...current,
            [paneId]: {
              ...existing,
              expanded: existing.expanded.filter((path) => path !== entry.path),
            },
          };
        }
        const hasChildren = Boolean(existing.children[entry.path]);
        if (!hasChildren) {
          void loadDirectory(paneId, entry.path, entry.path);
        }
        return {
          ...current,
          [paneId]: {
            ...existing,
            expanded: [...existing.expanded, entry.path],
          },
        };
      });
    },
    [loadDirectory],
  );

  const activeExplorer = explorerState[activeId];
  const activeCwd = paneCwd[activeId] ?? activeExplorer?.cwd ?? null;

  const renderExplorerEntries = useCallback(
    (paneId: string, entries: ExplorerEntry[], depth: number) => {
      const paneState = explorerState[paneId];
      if (!paneState) return null;
      return entries.map((entry) => {
        const isExpanded = paneState.expanded.includes(entry.path);
        const childEntries = paneState.children[entry.path];
        const isLoading = paneState.loading.includes(entry.path);
        return (
          <div key={entry.path} className="explorer-item">
            <button
              type="button"
              className={`explorer-row${entry.isDir ? "" : " explorer-row--file"}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => toggleDirectory(paneId, entry)}
            >
              <span
                className={`explorer-caret${entry.isDir ? "" : " explorer-caret--hidden"}${
                  isExpanded ? " explorer-caret--open" : ""
                }`}
              >
                {entry.isDir ? (
                  <ChevronRight className="icon icon--tiny" aria-hidden="true" />
                ) : null}
              </span>
              <span className={`explorer-icon${entry.isDir ? " explorer-icon--dir" : " explorer-icon--file"}`} />
              <span className="explorer-name">{entry.name}</span>
            </button>
            {entry.isDir && isExpanded && (
              <div className="explorer-children">
                {isLoading && <div className="explorer-loading">Loading...</div>}
                {!isLoading && childEntries && childEntries.length > 0
                  ? renderExplorerEntries(paneId, childEntries, depth + 1)
                  : null}
                {!isLoading && childEntries && childEntries.length === 0 ? (
                  <div
                    className="explorer-empty"
                    style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
                  >
                    (empty)
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      });
    },
    [explorerState, toggleDirectory],
  );

  const activeGit = gitStatusByPane[activeId] ?? { ...EMPTY_GIT_STATUS };
  const commitBusy = commitBusyByPane[activeId] ?? false;
  const commitError = commitErrorByPane[activeId] ?? null;
  const hasRepo = Boolean(activeGit.root) && !activeGit.error;
  const canCommit = hasRepo && !activeGit.loading && activeGit.files.length > 0 && !commitBusy;
  const canPush = hasRepo && !activeGit.loading && activeGit.ahead > 0 && !commitBusy;
  const canPull = hasRepo && !activeGit.loading && activeGit.behind > 0 && !commitBusy;
  const canCreatePr =
    hasRepo && !activeGit.loading && activeGit.ahead > 0 && activeGit.branch !== "HEAD";
  const repoName =
    activeGit.root?.split("/").filter(Boolean).pop() ??
    activeGit.root?.split("\\").filter(Boolean).pop() ??
    null;
  const branchLabel = repoName
    ? `${repoName} ${activeGit.branch || "HEAD"}`
    : activeGit.branch || "HEAD";
  const gitErrorMessage = activeGit.error
    ? /not a git repository/i.test(activeGit.error)
      ? "No Git repository found for this workspace."
      : activeGit.error
    : null;
  const explorerPathLabel = useMemo(() => {
    if (!activeCwd) return null;
    const normalized = activeCwd.replace(/\\+/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return activeCwd;
    const last = parts[parts.length - 1];
    if (!last) return activeCwd;
    return last;
  }, [activeCwd]);

  const gitPrimaryLabel = canCommit
    ? "Commit"
    : canPush
      ? "Push"
      : canPull
        ? "Pull"
        : "Sync";

  const gitPrimaryIcon = canCommit
    ? GitCommit
    : canPush
      ? CloudUpload
      : canPull
        ? CloudDownload
        : RefreshCw;

  const gitPrimaryAction = useCallback(() => {
    if (canCommit) {
      openCommitDialog();
      return;
    }
    if (canPush) {
      void handleGitPush();
      return;
    }
    if (canPull) {
      const root = activeGit.root ?? paneCwd[activeId];
      if (!root) return;
      const actions = paneActionsRef.current.get(activeId);
      if (!actions) return;
      const quotedRoot = `'${root.replace(/'/g, `'\\''`)}'`;
      actions.paste(`git -C ${quotedRoot} pull\n`);
    }
  }, [activeGit.root, activeId, canCommit, canPull, canPush, handleGitPush, openCommitDialog, paneCwd]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-traffic-gap" aria-hidden="true" />
        <div className="topbar-drag-strip" onMouseDown={handleStartDragging} />
        <div className="topbar-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="icon-button topbar-icon-tooltip"
            onClick={addWorkspace}
            disabled={paneCount >= maxPanes}
            aria-label="New workspace"
            title="New workspace"
            data-tooltip="Add Workspace"
            data-tauri-drag-region="false"
          >
            <Plus className="icon topbar-icon" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button topbar-icon-tooltip${explorerOpen ? " icon-button--active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setSidebarModeByPane((current) => {
                const mode = current[activeId] ?? null;
                return { ...current, [activeId]: mode === "explorer" ? null : "explorer" };
              });
              window.requestAnimationFrame(() => {
                paneActionsRef.current.get(activeId)?.focus();
              });
            }}
            aria-label="Open file explorer"
            title="Open file explorer"
            data-tooltip="Explorer"
            data-tauri-drag-region="false"
          >
            <Folder className="icon topbar-icon" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button topbar-icon-tooltip${scmOpen ? " icon-button--active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleScmSidebar}
            aria-label={scmOpen ? "Close changes" : "Open changes"}
            title={scmOpen ? "Close changes" : "Open changes"}
            data-tooltip="Changes"
            data-tauri-drag-region="false"
          >
            <GitCompareArrows
              className="icon topbar-icon topbar-icon--changes"
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button topbar-icon-tooltip${
              drawerOpenByPane[activeId] ? " icon-button--active" : ""
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setDrawerOpenForPane(activeId, !(drawerOpenByPane[activeId] ?? false));
              window.requestAnimationFrame(() => {
                paneActionsRef.current.get(activeId)?.focus();
              });
            }}
            aria-label="Toggle workspace terminal"
            title="Toggle workspace terminal"
            data-tooltip="Terminal"
            data-tauri-drag-region="false"
          >
            <Terminal className="icon topbar-icon" aria-hidden="true" />
          </Button>
          <button
            type="button"
            className="play-button"
            onClick={() => {
              setRunDialogValue(commandByPane[activeId] ?? "");
              setRunDialogOpen(true);
            }}
            aria-label="Play"
            title="Play"
            data-tauri-drag-region="false"
          >
            <Play className="icon topbar-icon" aria-hidden="true" />
          </button>
          <div className="cli-runner" ref={openMenuRef} data-tauri-drag-region="false">
            <button
              type="button"
              className="cli-runner__button"
              onClick={() => {
                handleOpenInTarget(selectedOpenTarget);
                setOpenMenuOpen(false);
                setRunCliMenuOpen(false);
                setGitMenuOpen(false);
              }}
              aria-label={`Open in ${selectedOpenTarget.label}`}
              title={`Open in ${selectedOpenTarget.label}`}
              data-tauri-drag-region="false"
            >
              <span className="cli-runner__label">Open</span>
            </button>
            <button
              type="button"
              className="cli-runner__caret"
              onClick={() => {
                setRunCliMenuOpen(false);
                setGitMenuOpen(false);
                setOpenMenuOpen((open) => !open);
              }}
              aria-label="Open app menu"
              title="Open app menu"
              data-tauri-drag-region="false"
            >
              <ChevronDown className="icon icon--small" aria-hidden="true" />
            </button>
            {openMenuOpen && (
              <div
                className="cli-runner__menu cli-runner__menu--apps"
                role="menu"
                data-tauri-drag-region="false"
              >
                <div className="cli-runner__menu-title">Open in</div>
                {OPEN_TARGETS.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className={`cli-runner__item${
                      target.id === selectedOpenTarget.id ? " cli-runner__item--active" : ""
                    }`}
                    onClick={() => {
                      setSelectedOpenTargetId(target.id);
                      handleOpenInTarget(target);
                      setRunCliMenuOpen(false);
                      setGitMenuOpen(false);
                      setOpenMenuOpen(false);
                    }}
                    role="menuitem"
                    data-tauri-drag-region="false"
                  >
                    <span>{target.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="cli-runner run-cli-cluster" ref={runCliMenuRef} data-tauri-drag-region="false">
            <button
              type="button"
              className="cli-runner__button"
              onClick={() => {
                handleRunCli(selectedRunner);
                setOpenMenuOpen(false);
                setRunCliMenuOpen(false);
                setGitMenuOpen(false);
              }}
              aria-label={`Run ${selectedRunner.label}`}
              title={`Run ${selectedRunner.label}`}
              data-tauri-drag-region="false"
            >
              <span className="cli-runner__label">Run</span>
            </button>
            <button
              type="button"
              className="cli-runner__caret"
              onClick={() => {
                setOpenMenuOpen(false);
                setGitMenuOpen(false);
                setRunCliMenuOpen((open) => !open);
              }}
              aria-label="Open runner menu"
              title="Open runner menu"
              data-tauri-drag-region="false"
            >
              <ChevronDown className="icon icon--small" aria-hidden="true" />
            </button>
            {runCliMenuOpen && (
              <div
                className="cli-runner__menu run-cli-cluster__menu"
                role="menu"
                data-tauri-drag-region="false"
              >
                <div className="cli-runner__menu-title">Run with</div>
                {RUNNERS.map((runner) => (
                  <button
                    key={runner.id}
                    type="button"
                    className={`cli-runner__item${
                      runner.id === selectedRunner.id ? " cli-runner__item--active" : ""
                    }`}
                    onClick={() => {
                      setSelectedRunnerId(runner.id);
                      handleRunCli(runner);
                      setOpenMenuOpen(false);
                      setGitMenuOpen(false);
                      setRunCliMenuOpen(false);
                    }}
                    role="menuitem"
                    data-tauri-drag-region="false"
                  >
                    <span
                      className={`cli-runner__item-logo cli-runner__logo--${runner.id}${
                        BRAND_LOGOS[runner.id] ? " cli-runner__logo--image" : ""
                      }`}
                    >
                      {renderBrandLogo(runner.id, runner.badge)}
                    </span>
                    <span>{runner.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="cli-runner git-cluster" ref={gitMenuRef} data-tauri-drag-region="false">
            <button
              type="button"
              className="cli-runner__button"
              onClick={() => {
                if (!(canCommit || canPush || canPull)) return;
                gitPrimaryAction();
                setOpenMenuOpen(false);
                setRunCliMenuOpen(false);
              }}
              aria-label={gitPrimaryLabel}
              title={gitPrimaryLabel}
              disabled={!(canCommit || canPush || canPull)}
              data-tauri-drag-region="false"
            >
              <span className="cli-runner__logo cli-runner__logo--git">
                {(() => {
                  const Icon = gitPrimaryIcon;
                  return <Icon className="icon icon--small" aria-hidden="true" />;
                })()}
              </span>
              <span className="cli-runner__label">{gitPrimaryLabel}</span>
            </button>
            <button
              type="button"
              className="cli-runner__caret"
              onClick={() => {
                setOpenMenuOpen(false);
                setRunCliMenuOpen(false);
                setGitMenuOpen((open) => !open);
              }}
              aria-label="Open Git menu"
              title="Open Git menu"
              data-tauri-drag-region="false"
            >
              <ChevronDown className="icon icon--small" aria-hidden="true" />
            </button>
            {gitMenuOpen && (
              <div className="cli-runner__menu git-cluster__menu" role="menu" data-tauri-drag-region="false">
                <div className="cli-runner__menu-title">Git actions</div>
                <button
                  type="button"
                  className="cli-runner__item"
                  onClick={() => {
                    if (!canCommit) return;
                    openCommitDialog();
                    setGitMenuOpen(false);
                  }}
                  disabled={!canCommit}
                  role="menuitem"
                  data-tauri-drag-region="false"
                >
                  <GitCommit className="icon icon--small cli-runner__item-icon" aria-hidden="true" />
                  <span>Commit</span>
                </button>
                <button
                  type="button"
                  className="cli-runner__item"
                  onClick={() => {
                    if (!canPush) return;
                    void handleGitPush();
                    setGitMenuOpen(false);
                  }}
                  disabled={!canPush}
                  role="menuitem"
                  data-tauri-drag-region="false"
                >
                  <CloudUpload className="icon icon--small cli-runner__item-icon" aria-hidden="true" />
                  <span>Push</span>
                </button>
                <button
                  type="button"
                  className="cli-runner__item"
                  disabled={!canCreatePr}
                  role="menuitem"
                  data-tauri-drag-region="false"
                >
                  <Github className="icon icon--small cli-runner__item-icon" aria-hidden="true" />
                  <span>Create PR</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="terminal-shell">
        {explorerOpen && (
          <aside className="file-explorer">
            <div className="file-explorer__header">
              <div className="file-explorer__header-row">
                <div className="file-explorer__title">Explorer</div>
                <button
                  type="button"
                  className="file-explorer__close"
                  onClick={() => setSidebarMode(null)}
                  aria-label="Close explorer"
                  title="Close explorer"
                >
                  <X className="icon icon--small" aria-hidden="true" />
                </button>
              </div>
              <div className="file-explorer__cwd" title={activeCwd ?? undefined}>
                {explorerPathLabel ?? "Waiting for shell..."}
              </div>
            </div>
            <div className="file-explorer__body">
              {!activeCwd ? (
                <div className="explorer-empty-state">
                  Open a shell to load the file list.
                </div>
              ) : activeExplorer?.error ? (
                <div className="explorer-error">{activeExplorer.error}</div>
              ) : activeExplorer?.loading?.includes(activeCwd ?? "") ? (
                <div className="explorer-loading">Loading...</div>
              ) : activeExplorer?.entries?.length ? (
                renderExplorerEntries(activeId, activeExplorer.entries, 0)
              ) : (
                <div className="explorer-empty-state">No files found.</div>
              )}
            </div>
          </aside>
        )}
        {/* ── Absolute-positioned pane layout ── */}
        <div className="pane-root" ref={paneRootRef}>
          {allPaneIds.map((paneId) => {
            const b = paneBoundsMap.get(paneId);
            if (!b) return null;
            return (
              <div
                key={paneId}
                className="pane-container"
                style={{
                  position: "absolute",
                  top: `${b.top * 100}%`,
                  left: `${b.left * 100}%`,
                  width: `${b.width * 100}%`,
                  height: `${b.height * 100}%`,
                }}
              >
                <TerminalPane
                  id={paneId}
                  isActive={paneId === activeId}
                  cwd={paneCwd[paneId] ?? null}
                  drawerOpen={drawerOpenByPane[paneId] ?? false}
                  drawerHeight={drawerHeightByPane[paneId] ?? 180}
                  onResizeDrawer={(height) => setDrawerHeightForPane(paneId, height)}
                  onCloseDrawer={() => setDrawerOpenForPane(paneId, false)}
                  onFocus={onFocus}
                  onBusyState={handleBusyState}
                  onCwdChange={handleCwdChange}
                  initialCwd={paneCwd[paneId] ?? null}
                  onContextMenu={openContextMenu}
                  onRegisterActions={registerActions}
                  onUnregisterActions={unregisterActions}
                />
                <button
                  type="button"
                  className="pane-close"
                  onClick={() => closePane(paneId)}
                  disabled={paneId === activeId && !canCloseActive}
                  aria-label="Close workspace"
                  title="Close workspace"
                >
                  <X className="icon icon--small" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {/* Resize handles */}
          {handles.map((h) => (
            <div
              key={h.splitId}
              className={`pane-handle pane-handle--${h.direction}`}
              style={
                h.direction === "horizontal"
                  ? {
                      position: "absolute",
                      top: `${h.splitBounds.top * 100}%`,
                      left: `${h.pos * 100}%`,
                      width: "6px",
                      height: `${h.splitBounds.height * 100}%`,
                      transform: "translateX(-50%)",
                    }
                  : {
                      position: "absolute",
                      top: `${h.pos * 100}%`,
                      left: `${h.splitBounds.left * 100}%`,
                      width: `${h.splitBounds.width * 100}%`,
                      height: "6px",
                      transform: "translateY(-50%)",
                    }
              }
              onMouseDown={(e) => startHandleDrag(e, h)}
            />
          ))}
        </div>
        {scmOpen && (
          <aside className="source-control">
            <div className="source-control__header">
              <div className="source-control__header-row">
                <div className="source-control__title">Changes</div>
                <div className="source-control__header-actions">
                  <button
                    type="button"
                    className="source-control__refresh"
                    onClick={handleRefreshGit}
                    aria-label="Refresh status"
                    title="Refresh status"
                  >
                    <RefreshCw className="icon icon--small" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="source-control__close"
                    onClick={() => setSidebarMode(null)}
                    aria-label="Close changes"
                    title="Close changes"
                  >
                    <X className="icon icon--small" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {gitErrorMessage && (
                <div className="source-control__error">{gitErrorMessage}</div>
              )}
              {activeGit.loading && (
                <div className="source-control__loading">Loading...</div>
              )}
            </div>
            <div className="source-control__body">
              {!activeGit.loading && !hasRepo && !activeGit.error && (
                <div className="source-control__empty">No repository detected.</div>
              )}
              {hasRepo && (
                <div className="sc-text">
                  <div className="sc-line sc-line--muted">
                    {branchLabel} · ↑{activeGit.ahead} ↓{activeGit.behind}
                  </div>
                  <div className="sc-line sc-line--muted">
                    {activeGit.files.length} files
                  </div>
                  {commitError && (
                    <div className="source-control__error">{commitError}</div>
                  )}
                  {activeGit.files.length === 0 ? (
                    <div className="source-control__empty">Working tree clean.</div>
                  ) : (
                    <div className="sc-list">
                      {activeGit.files.map((file) => {
                        const status = formatGitStatus(file.status);
                        return (
                          <div key={file.path} className="sc-item">
                            <span
                              className={`sc-status sc-status--${status.className}`}
                            >
                              {status.label}
                            </span>
                            <span className="sc-path">{file.path}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="context-menu-panel"
            role="menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            data-tauri-drag-region="false"
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                if (!navigator.clipboard) {
                  setContextMenu(null);
                  return;
                }
                const selection = contextMenu.selectionText.trim();
                if (selection) {
                  void navigator.clipboard.writeText(selection);
                }
                setContextMenu(null);
              }}
              disabled={!contextMenu.hasSelection}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Copy
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                if (!navigator.clipboard) {
                  setContextMenu(null);
                  return;
                }
                const selection = contextMenu.selectionText.trim();
                if (selection) {
                  void navigator.clipboard.writeText(selection);
                  paneActionsRef.current.get(contextMenu.targetId)?.clearSelection();
                }
                setContextMenu(null);
              }}
              disabled={!contextMenu.hasSelection}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Cut
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                if (!navigator.clipboard) {
                  setContextMenu(null);
                  return;
                }
                const actions = paneActionsRef.current.get(contextMenu.targetId);
                if (!actions) {
                  setContextMenu(null);
                  return;
                }
                void navigator.clipboard.readText().then((text) => {
                  if (text) {
                    actions.paste(text);
                  }
                });
                setContextMenu(null);
              }}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Paste
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                paneActionsRef.current.get(contextMenu.targetId)?.selectAll();
                setContextMenu(null);
              }}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Select All
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const selection = contextMenu.selectionText.trim();
                if (selection) {
                  window.open(
                    `https://www.google.com/search?q=${encodeURIComponent(selection)}`,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }
                setContextMenu(null);
              }}
              disabled={!contextMenu.hasSelection}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Search Google
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                paneActionsRef.current.get(contextMenu.targetId)?.clearBuffer();
                setContextMenu(null);
              }}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Clear
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                addWorkspaceAt(contextMenu.targetId, "horizontal");
                setContextMenu(null);
              }}
              disabled={paneCount >= maxPanes}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Add Workspace Horizontal
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                addWorkspaceAt(contextMenu.targetId, "vertical");
                setContextMenu(null);
              }}
              disabled={paneCount >= maxPanes}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Add Workspace Vertical
            </button>
            <button
              type="button"
              className="menu-item menu-item--danger"
              onClick={() => {
                closePane(contextMenu.targetId);
                setContextMenu(null);
              }}
              disabled={paneCount <= 1}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Close Workspace
            </button>
          </div>
        )}
        {runDialogOpen && (
          <div
            className="run-dialog__backdrop"
            onMouseDown={() => setRunDialogOpen(false)}
            role="presentation"
          >
            <div
              className="run-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Run command"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="run-dialog__title">Run Command</div>
              <input
                type="text"
                className="run-dialog__input"
                placeholder="npm run dev"
                value={runDialogValue}
                onChange={(event) => setRunDialogValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  setCommandByPane((current) => ({ ...current, [activeId]: runDialogValue }));
                  handleRunCommand(activeId, runDialogValue);
                  setRunDialogOpen(false);
                }}
                autoFocus
              />
              <div className="run-dialog__actions">
                <button
                  type="button"
                  className="run-dialog__cancel"
                  onClick={() => setRunDialogOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="run-dialog__run"
                  onClick={() => {
                    setCommandByPane((current) => ({ ...current, [activeId]: runDialogValue }));
                    handleRunCommand(activeId, runDialogValue);
                    setRunDialogOpen(false);
                  }}
                >
                  Run
                </button>
              </div>
            </div>
          </div>
        )}
        {commitDialogOpen && (
          <div
            className="run-dialog__backdrop"
            onMouseDown={() => setCommitDialogOpen(false)}
            role="presentation"
          >
            <div
              className="run-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Commit changes"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="run-dialog__title">Commit</div>
              <input
                type="text"
                className="run-dialog__input"
                placeholder="Commit message"
                value={commitDialogValue}
                onChange={(event) => setCommitDialogValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  setCommitMessageByPane((current) => ({
                    ...current,
                    [activeId]: commitDialogValue,
                  }));
                  void handleCommit(commitDialogValue);
                  setCommitDialogOpen(false);
                }}
                autoFocus
              />
              <div className="run-dialog__actions">
                <button
                  type="button"
                  className="run-dialog__cancel"
                  onClick={() => setCommitDialogOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="run-dialog__run"
                  onClick={() => {
                    setCommitMessageByPane((current) => ({
                      ...current,
                      [activeId]: commitDialogValue,
                    }));
                    void handleCommit(commitDialogValue);
                    setCommitDialogOpen(false);
                  }}
                  disabled={!commitDialogValue.trim() || commitBusy}
                >
                  {commitBusy ? "Committing..." : "Commit"}
                </button>
              </div>
            </div>
          </div>
        )}
        {closeConfirmOpen && (
          <div
            className="run-dialog__backdrop"
            onMouseDown={() => {
              closeConfirmOpenRef.current = false;
              setCloseConfirmOpen(false);
            }}
            role="presentation"
          >
            <div
              className="run-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Confirm quit"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="run-dialog__title">Quit ForgeTerm?</div>
              <div className="run-dialog__body">
                There are tasks still running. Quit now and terminate them?
              </div>
              <div className="run-dialog__actions">
                <button
                  type="button"
                  className="run-dialog__cancel"
                  onClick={() => {
                    closeConfirmOpenRef.current = false;
                    setCloseConfirmOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="run-dialog__run"
                  onClick={async () => {
                    closeConfirmOpenRef.current = false;
                    setCloseConfirmOpen(false);
                    allowWindowCloseRef.current = true;
                    await getCurrentWindow().close();
                  }}
                >
                  Quit
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
