import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import TerminalPane, { type TerminalPaneActions } from "./TerminalPane";
import { Button } from "@/components/ui/button";

type SplitDirection = "row" | "column";
type LayoutNode =
  | { type: "leaf"; id: string }
  | { type: "placeholder"; id: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      children: [LayoutNode, LayoutNode];
    };

type ExplorerEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

type ExplorerState = {
  cwd: string | null;
  entries: ExplorerEntry[];
  children: Record<string, ExplorerEntry[]>;
  expanded: string[];
  loading: string[];
  error: string | null;
};

type GitFileStatus = {
  path: string;
  status: string;
};

type GitStatusPayload = {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

type GitStatusState = {
  loading: boolean;
  error: string | null;
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

type RunnerOption = {
  id: "claude" | "codex" | "opencode";
  label: string;
  command: string;
  badge: string;
};

const RUNNERS: RunnerOption[] = [
  { id: "claude", label: "Claude Code", command: "claude", badge: "CC" },
  { id: "codex", label: "Codex", command: "codex", badge: "CX" },
  { id: "opencode", label: "OpenCode", command: "opencode", badge: "OC" },
];

const DiffIcon = ({ className = "icon" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="4" y="5" width="7" height="14" rx="1" />
    <rect x="13" y="5" width="7" height="14" rx="1" />
    <path d="M7.5 9v6" />
    <path d="M5 12h5" />
    <path d="M15.5 12h4" />
  </svg>
);

const DEFAULT_DRAWER_HEIGHT = 180;
const EMPTY_GIT_STATUS: GitStatusState = {
  loading: false,
  error: null,
  root: null,
  branch: null,
  ahead: 0,
  behind: 0,
  files: [],
};

const createLeaf = (id: string): LayoutNode => ({ type: "leaf", id });
const createPlaceholder = (id: string): LayoutNode => ({ type: "placeholder", id });

const replaceLeaf = (node: LayoutNode, targetId: string, next: LayoutNode): LayoutNode => {
  if (node.type === "leaf") {
    return node.id === targetId ? next : node;
  }
  if (node.type === "placeholder") {
    return node.id === targetId ? next : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], targetId, next),
      replaceLeaf(node.children[1], targetId, next),
    ],
  };
};

const updateAtPath = (
  node: LayoutNode,
  path: number[],
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode => {
  if (path.length === 0) return updater(node);
  if (node.type !== "split") return node;
  const [index, ...rest] = path;
  const nextChildren = node.children.map((child, i) =>
    i === index ? updateAtPath(child, rest, updater) : child,
  ) as [LayoutNode, LayoutNode];
  return { ...node, children: nextChildren };
};

const countLeaves = (node: LayoutNode): number => {
  if (node.type === "leaf") return 1;
  if (node.type === "placeholder") return 0;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
};

const findPathToId = (node: LayoutNode, targetId: string, path: number[] = []): number[] | null => {
  if (node.type === "leaf" || node.type === "placeholder") {
    return node.id === targetId ? path : null;
  }
  const left = findPathToId(node.children[0], targetId, [...path, 0]);
  if (left) return left;
  return findPathToId(node.children[1], targetId, [...path, 1]);
};

const findFirstLeafId = (node: LayoutNode): string | null => {
  if (node.type === "leaf") return node.id;
  if (node.type !== "split") return null;
  return findFirstLeafId(node.children[0]) ?? findFirstLeafId(node.children[1]);
};

const findFirstPlaceholderId = (node: LayoutNode): string | null => {
  if (node.type === "placeholder") return node.id;
  if (node.type !== "split") return null;
  return (
    findFirstPlaceholderId(node.children[0]) ?? findFirstPlaceholderId(node.children[1])
  );
};

const findFirstFocusableId = (node: LayoutNode): string | null =>
  findFirstLeafId(node) ?? findFirstPlaceholderId(node);

const removeAtPath = (
  node: LayoutNode,
  path: number[],
): { node: LayoutNode; nextActiveId: string | null; removed: boolean } => {
  if (path.length === 0) {
    return { node, nextActiveId: null, removed: false };
  }
  if (node.type !== "split") {
    return { node, nextActiveId: null, removed: false };
  }
  const [index, ...rest] = path;
  if (rest.length === 0) {
    const siblingIndex = index === 0 ? 1 : 0;
    const sibling = node.children[siblingIndex];
    return { node: sibling, nextActiveId: findFirstFocusableId(sibling), removed: true };
  }

  const updated = removeAtPath(node.children[index], rest);
  if (!updated.removed) {
    return { node, nextActiveId: null, removed: false };
  }

  const nextChildren = node.children.map((child, i) =>
    i === index ? updated.node : child,
  ) as [LayoutNode, LayoutNode];
  const nextNode: LayoutNode = { ...node, children: nextChildren };

  if (
    nextNode.type === "split" &&
    nextNode.children[0].type === "placeholder" &&
    nextNode.children[1].type === "placeholder"
  ) {
    const collapsed = nextNode.children[0];
    return { node: collapsed, nextActiveId: findFirstFocusableId(collapsed), removed: true };
  }

  return { node: nextNode, nextActiveId: updated.nextActiveId, removed: true };
};

const renderNode = (
  node: LayoutNode,
  activeId: string,
  onFocus: (id: string) => void,
  onActivate: (id: string) => void,
  onResize: (path: number[], ratio: number) => void,
  onClose: (id: string) => void,
  onBusyState: (id: string, isBusy: boolean) => void,
  onCwdChange: (id: string, cwd: string) => void,
  paneCwd: Record<string, string>,
  drawerOpenByPane: Record<string, boolean>,
  onSetDrawerOpen: (id: string, open: boolean) => void,
  drawerHeightByPane: Record<string, number>,
  onSetDrawerHeight: (id: string, height: number) => void,
  canCloseActive: boolean,
  onContextMenu: (id: string, event: ReactMouseEvent<HTMLDivElement>) => void,
  onRegisterActions: (id: string, actions: TerminalPaneActions) => void,
  onUnregisterActions: (id: string) => void,
  path: number[] = [],
): JSX.Element => {
  if (node.type === "leaf") {
    return (
      <div key={node.id} className="pane-container">
        <TerminalPane
          id={node.id}
          isActive={node.id === activeId}
          cwd={paneCwd[node.id] ?? null}
          drawerOpen={drawerOpenByPane[node.id] ?? false}
          drawerHeight={drawerHeightByPane[node.id] ?? DEFAULT_DRAWER_HEIGHT}
          onResizeDrawer={(height) => onSetDrawerHeight(node.id, height)}
          onCloseDrawer={() => onSetDrawerOpen(node.id, false)}
          onFocus={onFocus}
          onBusyState={onBusyState}
          onCwdChange={onCwdChange}
          initialCwd={paneCwd[node.id] ?? null}
          onContextMenu={onContextMenu}
          onRegisterActions={onRegisterActions}
          onUnregisterActions={onUnregisterActions}
        />
        <button
          type="button"
          className="pane-close"
          onClick={() => onClose(node.id)}
          disabled={node.id === activeId && !canCloseActive}
          aria-label="Close pane"
          title="Close pane"
        >
          <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M18 6l-12 12" />
          </svg>
        </button>
      </div>
    );
  }
  if (node.type === "placeholder") {
    return (
      <div key={node.id} className="pane-container">
        <div
          className="terminal terminal--placeholder"
          onClick={() => onActivate(node.id)}
        >
          <div className="terminal-placeholder">Click to start shell</div>
        </div>
        <button
          type="button"
          className="pane-close"
          onClick={() => onClose(node.id)}
          aria-label="Close pane"
          title="Close pane"
        >
          <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M18 6l-12 12" />
          </svg>
        </button>
      </div>
    );
  }
  const className = node.direction === "row" ? "split split--row" : "split split--column";
  const ratio = Math.min(0.9, Math.max(0.1, node.ratio));
  return (
    <div className={className}>
      <div className="split-pane" style={{ flex: `${ratio} 1 0%` }}>
        {renderNode(
          node.children[0],
          activeId,
          onFocus,
          onActivate,
          onResize,
          onClose,
          onBusyState,
          onCwdChange,
          paneCwd,
          drawerOpenByPane,
          onSetDrawerOpen,
          drawerHeightByPane,
          onSetDrawerHeight,
          canCloseActive,
          onContextMenu,
          onRegisterActions,
          onUnregisterActions,
          [...path, 0],
        )}
      </div>
      <div
        className={`splitter ${node.direction === "row" ? "splitter--vertical" : "splitter--horizontal"}`}
        onMouseDown={(event) => {
          event.preventDefault();
          const start = node.direction === "row" ? event.clientX : event.clientY;
          const container =
            (event.currentTarget.parentElement as HTMLElement) || event.currentTarget;
          const size = node.direction === "row" ? container.clientWidth : container.clientHeight;
          let frame: number | null = null;
          let pendingRatio = ratio;
          const handleMove = (moveEvent: MouseEvent) => {
            const current = node.direction === "row" ? moveEvent.clientX : moveEvent.clientY;
            const delta = (current - start) / Math.max(size, 1);
            pendingRatio = Math.min(0.9, Math.max(0.1, ratio + delta));
            if (frame) return;
            frame = window.requestAnimationFrame(() => {
              onResize(path, pendingRatio);
              frame = null;
            });
          };
          const handleUp = () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);
            if (frame) {
              window.cancelAnimationFrame(frame);
              frame = null;
            }
          };
          window.addEventListener("mousemove", handleMove);
          window.addEventListener("mouseup", handleUp);
        }}
      />
      <div className="split-pane" style={{ flex: `${1 - ratio} 1 0%` }}>
        {renderNode(
          node.children[1],
          activeId,
          onFocus,
          onActivate,
          onResize,
          onClose,
          onBusyState,
          onCwdChange,
          paneCwd,
          drawerOpenByPane,
          onSetDrawerOpen,
          drawerHeightByPane,
          onSetDrawerHeight,
          canCloseActive,
          onContextMenu,
          onRegisterActions,
          onUnregisterActions,
          [...path, 1],
        )}
      </div>
    </div>
  );
};

function App() {
  const [activeId, setActiveId] = useState("pane-1");
  const [layout, setLayout] = useState<LayoutNode>(() => createLeaf("pane-1"));
  const [paneBusy, setPaneBusy] = useState<Record<string, boolean>>({});
  const [sidebarMode, setSidebarMode] = useState<"explorer" | "scm" | null>(null);
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
  const [commandByPane, setCommandByPane] = useState<Record<string, string>>({});
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runDialogValue, setRunDialogValue] = useState("");
  const [selectedRunnerId, setSelectedRunnerId] = useState<RunnerOption["id"]>(
    RUNNERS[0].id,
  );
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const runMenuRef = useRef<HTMLDivElement | null>(null);
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const gitMenuRef = useRef<HTMLDivElement | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogValue, setCommitDialogValue] = useState("");
  const explorerOpen = sidebarMode === "explorer";
  const scmOpen = sidebarMode === "scm";
  const onFocus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const activatePane = useCallback((id: string) => {
    setLayout((current) => replaceLeaf(current, id, createLeaf(id)));
    setActiveId(id);
  }, []);

  const maxPanes = 15;
  const paneCount = useMemo(() => countLeaves(layout), [layout]);

  const splitPaneAt = useCallback(
    (targetId: string, direction: SplitDirection) => {
      if (paneCount >= maxPanes) return;
      const newId = `pane-${Date.now().toString(36)}`;
      const inheritedDrawerHeight = drawerHeightByPane[targetId];
      const next: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [createLeaf(targetId), createLeaf(newId)],
      };
      setLayout((current) => replaceLeaf(current, targetId, next));
      if (inheritedDrawerHeight) {
        setDrawerHeightByPane((current) => ({ ...current, [newId]: inheritedDrawerHeight }));
      }
    },
    [paneCount, drawerHeightByPane],
  );

  const splitPane = useCallback(
    (direction: SplitDirection) => {
      splitPaneAt(activeId, direction);
    },
    [activeId, splitPaneAt],
  );

  const onResizeSplit = useCallback((path: number[], ratio: number) => {
    setLayout((current) =>
      updateAtPath(current, path, (node) =>
        node.type === "split" ? { ...node, ratio } : node,
      ),
    );
  }, []);

  const handleBusyState = useCallback((id: string, isBusy: boolean) => {
    setPaneBusy((current) => {
      if (current[id] === isBusy) return current;
      return { ...current, [id]: isBusy };
    });
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
        const entries = await invoke<ExplorerEntry[]>("fs_read_dir", { path });
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
        const payload = await invoke<GitStatusPayload>("git_status", { path });
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

  const closePane = useCallback(
    (targetId: string) => {
      let nextActiveId: string | null = null;
      let didClose = false;
      setLayout((current) => {
        const leafCount = countLeaves(current);
        if (leafCount <= 1 && targetId === activeId) {
          return current;
        }
        const path = findPathToId(current, targetId);
        if (!path) return current;
        if (paneBusy[targetId]) {
          const shouldClose = window.confirm(
            "Do you want to terminate running processes in this window?",
          );
          if (!shouldClose) return current;
        }
        const result = removeAtPath(current, path);
        if (!result.removed) return current;
        if (targetId === activeId) {
          nextActiveId = result.nextActiveId;
        }
        didClose = true;
        return result.node;
      });
      if (!didClose) return;
      paneActionsRef.current.get(targetId)?.dispose();
      if (nextActiveId) {
        setActiveId(nextActiveId);
      }
      setPaneBusy((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setPaneCwd((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setExplorerState((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setDrawerOpenByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setDrawerHeightByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setCommandByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setGitStatusByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setCommitMessageByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setCommitBusyByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
      setCommitErrorByPane((current) => {
        if (!current[targetId]) return current;
        const { [targetId]: _removed, ...rest } = current;
        return rest;
      });
    },
    [activeId, paneBusy],
  );

  const canCloseActive = paneCount > 1;

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
    [],
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
      await invoke("git_commit", { path: root, message });
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
      await invoke("git_push", { path: root });
      await loadGitStatus(activeId, root);
    } catch (error) {
      setCommitErrorByPane((current) => ({ ...current, [activeId]: String(error) }));
    } finally {
      setCommitBusyByPane((current) => ({ ...current, [activeId]: false }));
    }
  }, [activeId, paneCwd, gitStatusByPane, loadGitStatus]);

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

  const handleRunCli = useCallback(() => {
    const actions = paneActionsRef.current.get(activeId);
    if (!actions) return;
    actions.paste(`${selectedRunner.command}\n`);
  }, [activeId, selectedRunner.command]);

  const handleStartDragging = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void getCurrentWindow().startDragging();
    },
    [],
  );

  const root = useMemo(
    () =>
      renderNode(
        layout,
        activeId,
        onFocus,
        activatePane,
        onResizeSplit,
        closePane,
        handleBusyState,
        handleCwdChange,
        paneCwd,
        drawerOpenByPane,
        setDrawerOpenForPane,
        drawerHeightByPane,
        setDrawerHeightForPane,
        canCloseActive,
        openContextMenu,
        registerActions,
        unregisterActions,
      ),
    [
      layout,
      activeId,
      onFocus,
      activatePane,
      onResizeSplit,
      closePane,
      handleBusyState,
      handleCwdChange,
      paneCwd,
      drawerOpenByPane,
      setDrawerOpenForPane,
      drawerHeightByPane,
      setDrawerHeightForPane,
      canCloseActive,
      openContextMenu,
      registerActions,
      unregisterActions,
    ],
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
        splitPane("column");
      } else {
        splitPane("row");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [splitPane]);

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
    if (!runMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (runMenuRef.current?.contains(event.target as Node)) return;
      setRunMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRunMenuOpen(false);
    };
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [runMenuOpen]);

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
    if (!scmOpen) return;
    const cwd = paneCwd[activeId];
    if (!cwd) return;
    void loadGitStatus(activeId, cwd);
  }, [activeId, scmOpen, paneCwd, loadGitStatus]);

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
                  <svg className="icon icon--tiny" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
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
  const repoName =
    activeGit.root?.split("/").filter(Boolean).pop() ??
    activeGit.root?.split("\\").filter(Boolean).pop() ??
    null;
  const branchLabel = repoName
    ? `${repoName} ${activeGit.branch || "HEAD"}`
    : activeGit.branch || "HEAD";

  const formatGitStatus = (status: string) => {
    const trimmed = status.trim();
    if (trimmed === "??") {
      return { label: "?", className: "untracked" };
    }
    const primary = trimmed[0] ?? status[0] ?? "?";
    switch (primary) {
      case "A":
        return { label: "A", className: "added" };
      case "M":
        return { label: "M", className: "modified" };
      case "D":
        return { label: "D", className: "deleted" };
      case "R":
        return { label: "R", className: "renamed" };
      case "U":
        return { label: "U", className: "conflict" };
      default:
        return { label: primary, className: "modified" };
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-traffic-gap" aria-hidden="true" />
        <div className="topbar-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="icon-button"
            onClick={() => splitPane("row")}
            disabled={paneCount >= maxPanes}
            aria-label="New workspace (split vertical)"
            title="New workspace (split vertical)"
            data-tauri-drag-region="false"
          >
            <DiffIcon className="icon topbar-icon" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button${explorerOpen ? " icon-button--active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setSidebarMode((mode) => (mode === "explorer" ? null : "explorer"));
              window.requestAnimationFrame(() => {
                paneActionsRef.current.get(activeId)?.focus();
              });
            }}
            aria-label="Open file explorer"
            title="Open file explorer"
            data-tauri-drag-region="false"
          >
            <DiffIcon className="icon topbar-icon" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button${scmOpen ? " icon-button--active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setSidebarMode((mode) => (mode === "scm" ? null : "scm"));
              window.requestAnimationFrame(() => {
                paneActionsRef.current.get(activeId)?.focus();
              });
            }}
            aria-label="Open changes"
            title="Open changes"
            data-tauri-drag-region="false"
          >
            <DiffIcon className="icon topbar-icon" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button${
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
            data-tauri-drag-region="false"
          >
            <DiffIcon className="icon topbar-icon" />
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
            <DiffIcon className="icon topbar-icon" />
          </button>
          <div className="cli-runner" ref={runMenuRef} data-tauri-drag-region="false">
            <button
              type="button"
              className="cli-runner__button"
              onClick={handleRunCli}
              aria-label={`Run ${selectedRunner.label}`}
              title={`Run ${selectedRunner.label}`}
              data-tauri-drag-region="false"
            >
              <span className={`cli-runner__logo cli-runner__logo--${selectedRunner.id}`}>
                {selectedRunner.badge}
              </span>
              <span className="cli-runner__label">Run CLI</span>
            </button>
            <button
              type="button"
              className="cli-runner__caret"
              onClick={() => setRunMenuOpen((open) => !open)}
              aria-label="Change CLI runner"
              title="Change CLI runner"
              data-tauri-drag-region="false"
            >
              <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {runMenuOpen && (
              <div className="cli-runner__menu" role="menu" data-tauri-drag-region="false">
                {RUNNERS.map((runner) => (
                  <button
                    key={runner.id}
                    type="button"
                    className={`cli-runner__item${
                      runner.id === selectedRunner.id ? " cli-runner__item--active" : ""
                    }`}
                    onClick={() => {
                      setSelectedRunnerId(runner.id);
                      setRunMenuOpen(false);
                    }}
                    role="menuitem"
                    data-tauri-drag-region="false"
                  >
                    {runner.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="topbar-drag-strip" onMouseDown={handleStartDragging} />
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
                  <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12" />
                    <path d="M18 6l-12 12" />
                  </svg>
                </button>
              </div>
              <div className="file-explorer__cwd" title={activeCwd ?? undefined}>
                {activeCwd ?? "Waiting for shell..."}
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
        <div className="pane-root">{root}</div>
        {scmOpen && (
          <aside className="source-control">
            <div className="source-control__header">
              <div className="source-control__header-row">
                <div className="source-control__title">Changes</div>
                <div className="source-control__header-actions">
                  <div className="source-control__menu" ref={gitMenuRef}>
                    <button
                      type="button"
                      className="source-control__menu-button"
                      onClick={() => setGitMenuOpen((open) => !open)}
                      aria-label="Git actions"
                      title="Git actions"
                    >
                      <span className="source-control__menu-label">Git</span>
                      <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {gitMenuOpen && (
                      <div className="source-control__menu-list">
                        <button
                          type="button"
                          className="source-control__menu-item"
                          onClick={() => {
                            setCommitDialogValue(commitMessageByPane[activeId] ?? "");
                            setCommitDialogOpen(true);
                            setGitMenuOpen(false);
                          }}
                        >
                          Commit...
                        </button>
                        <button
                          type="button"
                          className="source-control__menu-item"
                          onClick={() => {
                            void handleGitPush();
                            setGitMenuOpen(false);
                          }}
                        >
                          Push
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="source-control__refresh"
                    onClick={() => {
                      const cwd = paneCwd[activeId];
                      if (cwd) {
                        void loadGitStatus(activeId, cwd);
                      }
                    }}
                    aria-label="Refresh status"
                    title="Refresh status"
                  >
                    <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <path d="M21 5v7h-7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="source-control__close"
                    onClick={() => setSidebarMode(null)}
                    aria-label="Close changes"
                    title="Close changes"
                  >
                    <svg className="icon icon--small" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 6l12 12" />
                      <path d="M18 6l-12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              {activeGit.error && (
                <div className="source-control__error">{activeGit.error}</div>
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
                splitPaneAt(contextMenu.targetId, "row");
                setContextMenu(null);
              }}
              disabled={paneCount >= maxPanes}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Split Vertical
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                splitPaneAt(contextMenu.targetId, "column");
                setContextMenu(null);
              }}
              disabled={paneCount >= maxPanes}
              role="menuitem"
              data-tauri-drag-region="false"
            >
              Split Horizontal
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
              Close Pane
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
      </div>
    </div>
  );
}

export default App;
