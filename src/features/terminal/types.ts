import type { MouseEvent } from "react";
import type { ImeMode } from "@/shared/ime";

export type TerminalPaneActions = {
  focus: () => void;
  getSelection: () => string;
  clearSelection: () => void;
  selectAll: () => void;
  paste: (text: string) => void;
  clearBuffer: () => void;
  dispose: () => void;
};

export type TerminalPaneProps = {
  id: string;
  isActive: boolean;
  cwd?: string | null;
  drawerOpen?: boolean;
  drawerHeight?: number;
  imeMode?: ImeMode;
  onResizeDrawer?: (height: number) => void;
  onCloseDrawer?: () => void;
  onFocus: (id: string) => void;
  onBusyState?: (id: string, isBusy: boolean) => void;
  onCwdChange?: (id: string, cwd: string) => void;
  initialCwd?: string | null;
  onContextMenu?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
  onRegisterActions?: (id: string, actions: TerminalPaneActions) => void;
  onUnregisterActions?: (id: string) => void;
};
