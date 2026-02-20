import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import TerminalPane from "./TerminalPane";

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
  canCloseActive: boolean,
  path: number[] = [],
): JSX.Element => {
  if (node.type === "leaf") {
    return (
      <div key={node.id} className="pane-container">
        <TerminalPane
          id={node.id}
          isActive={node.id === activeId}
          onFocus={onFocus}
          onBusyState={onBusyState}
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
          canCloseActive,
          [...path, 0],
        )}
      </div>
      <div
        className={`splitter ${node.direction === "row" ? "splitter--vertical" : "splitter--horizontal"}`}
        onMouseDown={(event) => {
          event.preventDefault();
          const start = node.direction === "row" ? event.clientX : event.clientY;
          const container = (event.currentTarget.parentElement as HTMLElement) || event.currentTarget;
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
          canCloseActive,
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
  const onFocus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const activatePane = useCallback((id: string) => {
    setLayout((current) => replaceLeaf(current, id, createLeaf(id)));
    setActiveId(id);
  }, []);

  const maxPanes = 15;
  const paneCount = useMemo(() => countLeaves(layout), [layout]);

  const splitPane = useCallback(
    (direction: SplitDirection) => {
      if (paneCount >= maxPanes) return;
      const newId = `pane-${Date.now().toString(36)}`;
      const next: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [createLeaf(activeId), createPlaceholder(newId)],
      };
      setLayout((current) => replaceLeaf(current, activeId, next));
    },
    [activeId, paneCount],
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
    },
    [activeId, paneBusy],
  );

  const canCloseActive = paneCount > 1;

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
        canCloseActive,
      ),
    [
      layout,
      activeId,
      onFocus,
      activatePane,
      onResizeSplit,
      closePane,
      handleBusyState,
      canCloseActive,
    ],
  );

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">VibeCode Terminal</div>
        <div className="subtitle">Tauri v2 + React + xterm.js</div>
        <div className="actions">
          <button
            type="button"
            className="action-button"
            onClick={() => splitPane("row")}
            disabled={paneCount >= maxPanes}
          >
            Split Vertical
          </button>
          <button
            type="button"
            className="action-button"
            onClick={() => splitPane("column")}
            disabled={paneCount >= maxPanes}
          >
            Split Horizontal
          </button>
          <button
            type="button"
            className="action-button"
            onClick={() => closePane(activeId)}
            disabled={!canCloseActive}
          >
            Close Pane
          </button>
        </div>
      </header>
      <div className="terminal-shell">
        <div className="pane-root">{root}</div>
      </div>
    </div>
  );
}

export default App;
