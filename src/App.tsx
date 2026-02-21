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

const DEFAULT_DRAWER_HEIGHT = 180;

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
          x
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
          x
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
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [paneCwd, setPaneCwd] = useState<Record<string, string>>({});
  const [explorerState, setExplorerState] = useState<Record<string, ExplorerState>>({});
  const [drawerOpenByPane, setDrawerOpenByPane] = useState<Record<string, boolean>>(
    {},
  );
  const [drawerHeightByPane, setDrawerHeightByPane] = useState<Record<string, number>>(
    {},
  );
  const [commandByPane, setCommandByPane] = useState<Record<string, string>>({});
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runDialogValue, setRunDialogValue] = useState("");
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
      const inheritedCwd = paneCwd[targetId];
      const inheritedDrawerHeight = drawerHeightByPane[targetId];
      const next: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [createLeaf(targetId), createLeaf(newId)],
      };
      setLayout((current) => replaceLeaf(current, targetId, next));
      if (inheritedCwd) {
        setPaneCwd((current) => ({ ...current, [newId]: inheritedCwd }));
      }
      if (inheritedDrawerHeight) {
        setDrawerHeightByPane((current) => ({ ...current, [newId]: inheritedDrawerHeight }));
      }
    },
    [paneCount, paneCwd, drawerHeightByPane],
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

  const closePane = useCallback(
    (targetId: string) => {
      let nextActiveId: string | null = null;
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
        return result.node;
      });
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
    if (!explorerOpen) return;
    const cwd = paneCwd[activeId];
    if (!cwd) return;
    const existing = explorerState[activeId];
    if (!existing || existing.cwd !== cwd || existing.entries.length === 0) {
      void loadDirectory(activeId, cwd, null);
    }
  }, [activeId, explorerOpen, explorerState, loadDirectory, paneCwd]);

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
              <span className="explorer-caret">
                {entry.isDir ? (isExpanded ? "v" : ">") : ""}
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-traffic-gap" aria-hidden="true" />
        <div className="topbar-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button${explorerOpen ? " icon-button--active" : ""}`}
            onClick={() => setExplorerOpen((open) => !open)}
            aria-label="Open file explorer"
            title="Open file explorer"
            data-tauri-drag-region="false"
          >
            <svg
              className="icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M2 5a2 2 0 0 1 2-2h3l1 1h4a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
              <path d="M2 6h12" />
            </svg>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`icon-button${
              drawerOpenByPane[activeId] ? " icon-button--active" : ""
            }`}
            onClick={() =>
              setDrawerOpenForPane(activeId, !(drawerOpenByPane[activeId] ?? false))
            }
            aria-label="Toggle workspace terminal"
            title="Toggle workspace terminal"
            data-tauri-drag-region="false"
          >
            <svg
              className="icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M5 6.5l2 1.8-2 1.8" />
              <path d="M8.5 10h2.5" />
            </svg>
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
            <svg className="play-button__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5l7 4.5-7 4.5z" />
            </svg>
          </button>
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
                  onClick={() => setExplorerOpen(false)}
                  aria-label="Close explorer"
                  title="Close explorer"
                >
                  ×
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
      </div>
    </div>
  );
}

export default App;
