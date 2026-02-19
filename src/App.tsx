import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import TerminalPane from "./TerminalPane";

type SplitDirection = "row" | "column";
type LayoutNode =
  | { type: "leaf"; id: string }
  | { type: "branch"; direction: SplitDirection; children: LayoutNode[] };

const createLeaf = (id: string): LayoutNode => ({ type: "leaf", id });

type PathResult = { leafPath: number[] | null; branchPath: number[] | null };

const findPaths = (
  node: LayoutNode,
  targetId: string,
  direction: SplitDirection,
  path: number[] = [],
): PathResult => {
  if (node.type === "leaf") {
    return node.id === targetId ? { leafPath: path, branchPath: null } : { leafPath: null, branchPath: null };
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    const result = findPaths(child, targetId, direction, [...path, i]);
    if (result.leafPath) {
      const branchPath = node.direction === direction ? path : result.branchPath;
      return { leafPath: result.leafPath, branchPath };
    }
  }
  return { leafPath: null, branchPath: null };
};

const updateAtPath = (
  node: LayoutNode,
  path: number[],
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode => {
  if (path.length === 0) return updater(node);
  if (node.type === "leaf") return node;
  const [index, ...rest] = path;
  const nextChildren = node.children.map((child, i) =>
    i === index ? updateAtPath(child, rest, updater) : child,
  );
  return { ...node, children: nextChildren };
};

const splitTree = (
  node: LayoutNode,
  targetId: string,
  direction: SplitDirection,
  newId: string,
): LayoutNode => {
  const { leafPath, branchPath } = findPaths(node, targetId, direction);
  if (!leafPath) return node;
  const newLeaf: LayoutNode = { type: "leaf", id: newId };

  if (branchPath) {
    const targetChildIndex = leafPath[branchPath.length];
    return updateAtPath(node, branchPath, (branchNode) => {
      if (branchNode.type !== "branch") return branchNode;
      const nextChildren = [...branchNode.children];
      nextChildren.splice(targetChildIndex + 1, 0, newLeaf);
      return { ...branchNode, children: nextChildren };
    });
  }

  return updateAtPath(node, leafPath, (leafNode) => ({
    type: "branch",
    direction,
    children: [leafNode, newLeaf],
  }));
};

const renderNode = (
  node: LayoutNode,
  activeId: string,
  onFocus: (id: string) => void,
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
  const className = node.direction === "row" ? "split split--row" : "split split--column";
  return (
    <div className={className}>
      {node.children.map((child) => renderNode(child, activeId, onFocus))}
    </div>
  );
};

function App() {
  const [activeId, setActiveId] = useState("pane-1");
  const [layout, setLayout] = useState<LayoutNode>(() => createLeaf("pane-1"));
  const onFocus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const splitPane = useCallback(
    (direction: SplitDirection) => {
      const newId = `pane-${Date.now().toString(36)}`;
      setLayout((current) => splitTree(current, activeId, direction, newId));
      setActiveId(newId);
    },
    [activeId],
  );

  const root = useMemo(
    () => renderNode(layout, activeId, onFocus),
    [layout, activeId, onFocus],
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
