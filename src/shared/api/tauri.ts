import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ExplorerEntry } from "@/features/explorer/types";
import type { GitStatusPayload } from "@/features/git/types";

export type PtyOutputPayload = {
  session_id: string;
  data: string;
};

export type PtyExitPayload = {
  session_id: string;
  code?: number;
};

export const ptySpawn = (args: {
  cols: number;
  rows: number;
  cwd?: string | null;
}) => invoke<string>("pty_spawn", args);

export const ptyWrite = (sessionId: string, data: string) =>
  invoke("pty_write", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke("pty_resize", { sessionId, cols, rows });

export const ptyKill = (sessionId: string) => invoke("pty_kill", { sessionId });

export const onPtyOutput = (handler: (payload: PtyOutputPayload) => void) =>
  listen<PtyOutputPayload>("pty-output", (event) => handler(event.payload));

export const onPtyExit = (handler: (payload: PtyExitPayload) => void) =>
  listen<PtyExitPayload>("pty-exit", (event) => handler(event.payload));

export const fsReadDir = (path: string) =>
  invoke<ExplorerEntry[]>("fs_read_dir", { path });

export const gitStatus = (path: string) =>
  invoke<GitStatusPayload>("git_status", { path });

export const gitCommit = (path: string, message: string) =>
  invoke<string>("git_commit", { path, message });

export const gitPush = (path: string) => invoke<string>("git_push", { path });
export const gitPull = (path: string) => invoke<string>("git_pull", { path });
export const openTarget = (path: string, app?: string) =>
  invoke<void>("open_target", { path, app });
