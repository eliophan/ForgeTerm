export type RunnerOption = {
  id: "claude" | "codex" | "opencode";
  label: string;
  command: string;
  badge: string;
};

export const RUNNERS: RunnerOption[] = [
  { id: "claude", label: "Claude Code", command: "claude", badge: "CC" },
  { id: "codex", label: "Codex", command: "codex", badge: "CX" },
  { id: "opencode", label: "OpenCode", command: "opencode", badge: "OC" },
];
