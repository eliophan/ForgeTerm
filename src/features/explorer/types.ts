export type ExplorerEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

export type ExplorerState = {
  cwd: string | null;
  entries: ExplorerEntry[];
  children: Record<string, ExplorerEntry[]>;
  expanded: string[];
  loading: string[];
  error: string | null;
};
