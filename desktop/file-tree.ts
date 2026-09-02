import type { DiffFile } from "./types.js";

export type FileTreeNode =
  | { kind: "folder"; name: string; path: string; children: FileTreeNode[] }
  | { kind: "file"; name: string; path: string; file: DiffFile };

export function buildFileTree(files: readonly DiffFile[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let children = roots;
    let path = "";
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      let folder = children.find((node): node is Extract<FileTreeNode, { kind: "folder" }> => node.kind === "folder" && node.name === part);
      if (!folder) { folder = { kind: "folder", name: part, path, children: [] }; children.push(folder); }
      children = folder.children;
    }
    children.push({ kind: "file", name: parts.at(-1)!, path: file.path, file });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, "en", { numeric: true }));
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  };
  sort(roots);
  return roots;
}

export function treeKey(node: FileTreeNode) { return `${node.kind}:${node.path}`; }

export type TreeRow = { node: FileTreeNode; key: string; parent: string | null; depth: number; position: number; siblings: number };
export function visibleTreeRows(nodes: readonly FileTreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (children: readonly FileTreeNode[], depth: number, parent: string | null) => {
    children.forEach((node, index) => {
      const key = treeKey(node);
      rows.push({ node, key, parent, depth, position: index + 1, siblings: children.length });
      if (node.kind === "folder" && !collapsed.has(node.path)) visit(node.children, depth + 1, key);
    });
  };
  visit(nodes, 0, null);
  return rows;
}

export function revealFileAncestors(path: string, collapsed: Set<string>) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) collapsed.delete(parts.slice(0, i).join("/"));
}
