import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import TerminalPane from "./TerminalPane";

type SplitDirection = "row" | "column";
type LayoutNode =
  | { type: "leaf"; id: string }
  | { type: "split"; direction: SplitDirection; children: [LayoutNode, LayoutNode] };

const createLeaf = (id: string): LayoutNode => ({ type: "leaf", id });

const replaceLeaf = (node: LayoutNode, targetId: string, next: LayoutNode): LayoutNode => {
  if (node.type === "leaf") {
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
      {renderNode(node.children[0], activeId, onFocus)}
      {renderNode(node.children[1], activeId, onFocus)}
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
      const next: LayoutNode = {
        type: "split",
        direction,
        children: [createLeaf(activeId), createLeaf(newId)],
      };
      setLayout((current) => replaceLeaf(current, activeId, next));
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
