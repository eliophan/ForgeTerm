import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { X } from "lucide-react";
import TerminalPane from "@/TerminalPane";
import type { TerminalPaneActions } from "@/TerminalPane";
import type { LayoutNode } from "../types";

const DEFAULT_DRAWER_HEIGHT = 180;

type LayoutTreeProps = {
  node: LayoutNode;
  activeId: string;
  onFocus: (id: string) => void;
  onActivate: (id: string) => void;
  onResize: (path: number[], ratio: number) => void;
  onClose: (id: string) => void;
  onBusyState: (id: string, isBusy: boolean) => void;
  onCwdChange: (id: string, cwd: string) => void;
  paneCwd: Record<string, string>;
  drawerOpenByPane: Record<string, boolean>;
  onSetDrawerOpen: (id: string, open: boolean) => void;
  drawerHeightByPane: Record<string, number>;
  onSetDrawerHeight: (id: string, height: number) => void;
  canCloseActive: boolean;
  onContextMenu: (id: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onRegisterActions: (id: string, actions: TerminalPaneActions) => void;
  onUnregisterActions: (id: string) => void;
  path?: number[];
};

export function LayoutTree({
  node,
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
  path = [],
}: LayoutTreeProps): ReactElement {
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
          <X className="icon icon--small" aria-hidden="true" />
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
          <X className="icon icon--small" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const className = node.direction === "row" ? "split split--row" : "split split--column";
  const ratio = Math.min(0.9, Math.max(0.1, node.ratio));
  return (
    <div className={className}>
      <div className="split-pane" style={{ flex: `${ratio} 1 0%` }}>
        <LayoutTree
          node={node.children[0]}
          activeId={activeId}
          onFocus={onFocus}
          onActivate={onActivate}
          onResize={onResize}
          onClose={onClose}
          onBusyState={onBusyState}
          onCwdChange={onCwdChange}
          paneCwd={paneCwd}
          drawerOpenByPane={drawerOpenByPane}
          onSetDrawerOpen={onSetDrawerOpen}
          drawerHeightByPane={drawerHeightByPane}
          onSetDrawerHeight={onSetDrawerHeight}
          canCloseActive={canCloseActive}
          onContextMenu={onContextMenu}
          onRegisterActions={onRegisterActions}
          onUnregisterActions={onUnregisterActions}
          path={[...path, 0]}
        />
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
        <LayoutTree
          node={node.children[1]}
          activeId={activeId}
          onFocus={onFocus}
          onActivate={onActivate}
          onResize={onResize}
          onClose={onClose}
          onBusyState={onBusyState}
          onCwdChange={onCwdChange}
          paneCwd={paneCwd}
          drawerOpenByPane={drawerOpenByPane}
          onSetDrawerOpen={onSetDrawerOpen}
          drawerHeightByPane={drawerHeightByPane}
          onSetDrawerHeight={onSetDrawerHeight}
          canCloseActive={canCloseActive}
          onContextMenu={onContextMenu}
          onRegisterActions={onRegisterActions}
          onUnregisterActions={onUnregisterActions}
          path={[...path, 1]}
        />
      </div>
    </div>
  );
}
