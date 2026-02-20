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

const removeNodeById = (
  node: LayoutNode,
  targetId: string,
): { node: LayoutNode; removed: boolean; nextActiveId: string | null } => {
  if (node.type === "leaf" || node.type === "placeholder") {
    if (node.id !== targetId) {
      return { node, removed: false, nextActiveId: null };
    }
    return { node, removed: true, nextActiveId: null };
  }

  const left = removeNodeById(node.children[0], targetId);
  if (left.removed) {
    const sibling = node.children[1];
    return {
      node: sibling,
      removed: true,
      nextActiveId: findFirstFocusableId(sibling),
    };
  }

  const right = removeNodeById(node.children[1], targetId);
  if (right.removed) {
    const sibling = node.children[0];
    return {
      node: sibling,
      removed: true,
      nextActiveId: findFirstFocusableId(sibling),
    };
  }

  return {
    node: {
      ...node,
      children: [left.node, right.node],
    },
    removed: false,
    nextActiveId: null,
  };
};

const renderNode = (
  node: LayoutNode,
  activeId: string,
  onFocus: (id: string) => void,
  onActivate: (id: string) => void,
  onResize: (path: number[], ratio: number) => void,
  onClose: (id: string) => void,
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
      <div className="split-pane" style={{ flexBasis: `${ratio * 100}%` }}>
        {renderNode(
          node.children[0],
          activeId,
          onFocus,
          onActivate,
          onResize,
          onClose,
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
      <div className="split-pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {renderNode(
          node.children[1],
          activeId,
          onFocus,
          onActivate,
          onResize,
          onClose,
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

  const closePane = useCallback(
    (targetId: string) => {
      let nextActiveId: string | null = null;
      setLayout((current) => {
        const leafCount = countLeaves(current);
        if (leafCount <= 1 && targetId === activeId) {
          return current;
        }
        const result = removeNodeById(current, targetId);
        if (!result.removed) return current;
        if (targetId === activeId) {
          nextActiveId = result.nextActiveId;
        }
        return result.node;
      });
      if (nextActiveId) {
        setActiveId(nextActiveId);
      }
    },
    [activeId],
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
        canCloseActive,
      ),
    [layout, activeId, onFocus, activatePane, onResizeSplit, closePane, canCloseActive],
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
