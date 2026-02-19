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

const renderNode = (
  node: LayoutNode,
  activeId: string,
  onFocus: (id: string) => void,
  onActivate: (id: string) => void,
  onResize: (path: number[], ratio: number) => void,
  path: number[] = [],
): JSX.Element => {
  if (node.type === "leaf") {
    return (
      <TerminalPane
        key={node.id}
        id={node.id}
        isActive={node.id === activeId}
        onFocus={onFocus}
      />
    );
  }
  if (node.type === "placeholder") {
    return (
      <div
        key={node.id}
        className="terminal terminal--placeholder"
        onClick={() => onActivate(node.id)}
      >
        <div className="terminal-placeholder">Click to start shell</div>
      </div>
    );
  }
  const className = node.direction === "row" ? "split split--row" : "split split--column";
  const ratio = Math.min(0.9, Math.max(0.1, node.ratio));
  return (
    <div className={className}>
      <div className="split-pane" style={{ flexBasis: `${ratio * 100}%` }}>
        {renderNode(node.children[0], activeId, onFocus, onActivate, onResize, [...path, 0])}
      </div>
      <div
        className={`splitter ${node.direction === "row" ? "splitter--vertical" : "splitter--horizontal"}`}
        onMouseDown={(event) => {
          event.preventDefault();
          const start = node.direction === "row" ? event.clientX : event.clientY;
          const container = (event.currentTarget.parentElement as HTMLElement) || event.currentTarget;
          const size = node.direction === "row" ? container.clientWidth : container.clientHeight;
          const handleMove = (moveEvent: MouseEvent) => {
            const current = node.direction === "row" ? moveEvent.clientX : moveEvent.clientY;
            const delta = (current - start) / Math.max(size, 1);
            onResize(path, Math.min(0.9, Math.max(0.1, ratio + delta)));
          };
          const handleUp = () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);
          };
          window.addEventListener("mousemove", handleMove);
          window.addEventListener("mouseup", handleUp);
        }}
      />
      <div className="split-pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {renderNode(node.children[1], activeId, onFocus, onActivate, onResize, [...path, 1])}
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

  const splitPane = useCallback(
    (direction: SplitDirection) => {
      const startedAt = performance.now();
      console.log(`[split] start ${direction}`, { activeId });
      const newId = `pane-${Date.now().toString(36)}`;
      const next: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [createLeaf(activeId), createPlaceholder(newId)],
      };
      setLayout((current) => replaceLeaf(current, activeId, next));
      window.requestAnimationFrame(() => {
        const elapsed = Math.round(performance.now() - startedAt);
        console.log(`[split] frame ${direction} in ${elapsed}ms`);
      });
    },
    [activeId],
  );

  const onResizeSplit = useCallback((path: number[], ratio: number) => {
    setLayout((current) =>
      updateAtPath(current, path, (node) =>
        node.type === "split" ? { ...node, ratio } : node,
      ),
    );
  }, []);

  const root = useMemo(
    () => renderNode(layout, activeId, onFocus, activatePane, onResizeSplit),
    [layout, activeId, onFocus, activatePane, onResizeSplit],
  );

  useEffect(() => {
    console.log("[layout] updated", layout);
  }, [layout]);

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
          >
            Split Vertical
          </button>
          <button
            type="button"
            className="action-button"
            onClick={() => splitPane("column")}
          >
            Split Horizontal
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
