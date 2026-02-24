import { useTerminalPaneRuntime } from "@/features/terminal/hooks/useTerminalPaneRuntime";
import type { TerminalPaneProps } from "@/features/terminal/types";

const DEFAULT_DRAWER_HEIGHT = 180;

export type { TerminalPaneActions } from "@/features/terminal/types";

export default function TerminalPane({
  id,
  isActive,
  cwd,
  drawerOpen = false,
  drawerHeight = DEFAULT_DRAWER_HEIGHT,
  onResizeDrawer,
  onCloseDrawer,
  onFocus,
  onBusyState,
  onCwdChange,
  initialCwd,
  onContextMenu,
  onRegisterActions,
  onUnregisterActions,
}: TerminalPaneProps) {
  const {
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
  } = useTerminalPaneRuntime({
    id,
    isActive,
    cwd,
    drawerOpen,
    drawerHeight,
    onResizeDrawer,
    onFocus,
    onBusyState,
    onCwdChange,
    initialCwd,
    onRegisterActions,
    onUnregisterActions,
  });

  return (
    <div
      ref={containerRef}
      className={`terminal ${isActive ? "terminal--active" : ""}`}
      onMouseDown={() => onFocus(id)}
      onTouchStart={() => onFocus(id)}
      onContextMenu={(event) => {
        onContextMenu?.(id, event);
      }}
    >
      <div className="terminal-header">
        <div className="terminal-header__title">{cwdTitle}</div>
        <span className="terminal-header__divider">•</span>
        <div className="terminal-header__subtitle" title={cwd ?? undefined}>
          {cwdSubtitle}
        </div>
      </div>
      <div className="terminal-body">
        {!isReady && !sessionStarted && <div className="terminal-placeholder">Starting shell…</div>}
        {showRetry && (
          <div className="terminal-placeholder terminal-placeholder--retry">
            <div className="terminal-placeholder__content">
              <div>Shell did not start.</div>
              <button type="button" className="terminal-retry" onClick={retryShell}>
                Retry shell
              </button>
            </div>
          </div>
        )}
        <div ref={terminalRef} tabIndex={0} className="terminal-inner" />
      </div>
      <div
        className={`terminal-drawer${drawerOpen ? " terminal-drawer--open" : ""}`}
        aria-hidden={!drawerOpen}
        style={{ height: drawerOpen ? `${drawerHeight}px` : "0px" }}
      >
        <div className="terminal-drawer__resize" onMouseDown={handleResizeStart} />
        <div className="terminal-drawer__header">
          <div className="terminal-drawer__title">Terminal</div>
          {drawerOpen && (
            <div className="terminal-drawer__path" title="/bin/zsh">
              /bin/zsh
            </div>
          )}
          <button
            type="button"
            className="terminal-drawer__close"
            onClick={() => onCloseDrawer?.()}
            aria-label="Close workspace terminal"
            title="Close workspace terminal"
          >
            ×
          </button>
        </div>
        <div ref={drawerRef} tabIndex={0} className="terminal-drawer__body" />
      </div>
    </div>
  );
}
