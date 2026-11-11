import type { DiffSource } from "./types.js";

export const diffSources: Record<DiffSource, { label: string; comparison: string; empty: string }> = {
  branch: { label: "Branch · committed", comparison: "Merge base → HEAD", empty: "No committed branch changes. Choose another view to review local edits." },
  local: { label: "Local · all uncommitted", comparison: "HEAD → working tree, with new files", empty: "No uncommitted changes." },
  staged: { label: "Staged · uncommitted", comparison: "HEAD → index", empty: "No staged changes." },
  unstaged: { label: "Unstaged · uncommitted", comparison: "Index → working tree", empty: "No unstaged changes to tracked files." },
  untracked: { label: "Untracked · new files", comparison: "New files · not in Git", empty: "No untracked files. Ignored files and Lupp's own notes are excluded." }
};

export function isDiffSource(value: unknown): value is DiffSource {
  return typeof value === "string" && Object.hasOwn(diffSources, value);
}
