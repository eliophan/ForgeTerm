export type GitFileStatus = {
  path: string;
  status: string;
};

export type GitStatusPayload = {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

export type GitStatusState = {
  loading: boolean;
  error: string | null;
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

export const EMPTY_GIT_STATUS: GitStatusState = {
  loading: false,
  error: null,
  root: null,
  branch: null,
  ahead: 0,
  behind: 0,
  files: [],
};

export const formatGitStatus = (status: string) => {
  const trimmed = status.trim();
  if (trimmed === "??") {
    return { label: "?", className: "untracked" as const };
  }
  const primary = trimmed[0] ?? status[0] ?? "?";
  switch (primary) {
    case "A":
      return { label: "A", className: "added" as const };
    case "M":
      return { label: "M", className: "modified" as const };
    case "D":
      return { label: "D", className: "deleted" as const };
    case "R":
      return { label: "R", className: "renamed" as const };
    case "U":
      return { label: "U", className: "conflict" as const };
    default:
      return { label: primary, className: "modified" as const };
  }
};
