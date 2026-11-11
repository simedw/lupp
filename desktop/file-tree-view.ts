import { buildFileTree, revealFileAncestors, visibleTreeRows, type FileTreeNode, type TreeRow } from "./file-tree.js";
import type { DiffFile } from "./types.js";

export class FileTreeView {
  private nodes: FileTreeNode[] = [];
  private collapsed = new Set<string>();
  private active: string | null = null;
  private focused: string | null = null;
  private rows: TreeRow[] = [];
  private reviewed = new Set<string>();
  private savingReview = false;
  private updated = new Set<string>();

  constructor(private readonly container: HTMLElement, private readonly onSelect: (file: DiffFile) => void, private readonly onReview?: (file: DiffFile, reviewed: boolean) => void) {
    container.setAttribute("role", "tree");
    container.setAttribute("aria-label", "Changed files");
  }

  setReviewed(paths: string[], saving = false) {
    this.reviewed = new Set(paths);
    this.savingReview = saving;
    this.render();
  }

  setFiles(files: readonly DiffFile[], preserve = false, updated: string[] = []) {
    this.nodes = buildFileTree(files);
    this.updated = new Set(updated);
    if (preserve) return;
    this.collapsed.clear();
    this.active = null;
    this.focused = null;
    this.container.scrollTop = 0;
    this.container.scrollLeft = 0;
  }

  select(path: string | null, reveal = true) {
    this.active = path;
    if (path && reveal) { revealFileAncestors(path, this.collapsed); this.focused = `file:${path}`; }
    this.render();
  }

  private render() {
    const restoreFocus = this.container.contains(document.activeElement);
    const scrollTop = this.container.scrollTop;
    const scrollLeft = this.container.scrollLeft;
    this.rows = visibleTreeRows(this.nodes, this.collapsed);
    if (!this.rows.some((row) => row.key === this.focused)) this.focused = this.rows[0]?.key || null;
    this.container.replaceChildren();
    for (const row of this.rows) {
      const { node, key } = row;
      const folder = node.kind === "folder";
      const button = document.createElement(folder ? "button" : "div");
      if (button instanceof HTMLButtonElement) button.type = "button";
      button.className = `tree-row ${folder ? "tree-folder" : "file-item"}${!folder && node.path === this.active ? " active" : ""}`;
      button.dataset.treeKey = key;
      button.style.setProperty("--depth", String(row.depth));
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-level", String(row.depth + 1));
      button.setAttribute("aria-posinset", String(row.position));
      button.setAttribute("aria-setsize", String(row.siblings));
      button.tabIndex = key === this.focused ? 0 : -1;
      button.title = node.path;
      const chevron = document.createElement("span");
      chevron.className = folder ? "tree-chevron" : "tree-spacer";
      chevron.setAttribute("aria-hidden", "true");
      if (!folder && this.onReview) {
        chevron.removeAttribute("aria-hidden");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "file-review-check";
        checkbox.tabIndex = -1;
        checkbox.checked = this.reviewed.has(node.path);
        checkbox.disabled = this.savingReview || !node.file.reviewId;
        checkbox.setAttribute("aria-label", `Happy with ${node.path}`);
        checkbox.title = "Mark this file as reviewed (Space)";
        checkbox.onclick = (event) => event.stopPropagation();
        checkbox.onchange = () => { this.focused = key; this.onReview?.(node.file, checkbox.checked); };
        chevron.append(checkbox);
        button.classList.toggle("reviewed", checkbox.checked);
        button.setAttribute("aria-checked", String(checkbox.checked));
      }
      const icon = document.createElement("span");
      icon.className = folder ? "tree-folder-icon" : `file-state ${node.file.status}`;
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "file-path";
      name.textContent = node.name;
      button.append(chevron, icon, name);
      if (folder) {
        button.setAttribute("aria-expanded", String(!this.collapsed.has(node.path)));
        button.setAttribute("aria-label", node.name);
      } else {
        const stats = document.createElement("span");
        stats.className = "file-stats";
        stats.textContent = `+${node.file.additions} −${node.file.deletions}`;
        button.append(stats);
        button.setAttribute("aria-selected", String(node.path === this.active));
        button.setAttribute("aria-label", `${node.path}, ${node.file.status}, ${node.file.additions} lines added, ${node.file.deletions} lines deleted`);
        button.title = `${node.path}\n${node.file.status} · +${node.file.additions} −${node.file.deletions}`;
        if (this.updated.has(node.path)) {
          button.classList.add("file-updated");
          button.title += "\nUpdated from disk";
          button.setAttribute("aria-label", `${button.getAttribute("aria-label")}, updated from disk`);
        }
      }
      button.onfocus = () => this.setFocus(key, false);
      button.onclick = () => {
        this.focused = key;
        if (folder) this.toggle(row);
        else this.onSelect(node.file);
      };
      button.onkeydown = (event) => this.onKey(event, row);
      this.container.append(button);
    }
    this.container.scrollTop = scrollTop;
    this.container.scrollLeft = scrollLeft;
    if (restoreFocus && this.focused) {
      const focused = [...this.container.querySelectorAll<HTMLElement>("[role=treeitem]")].find((item) => item.dataset.treeKey === this.focused);
      focused?.focus({ preventScroll: true });
    }
  }

  private setFocus(key: string, move: boolean) {
    this.focused = key;
    for (const button of this.container.querySelectorAll<HTMLButtonElement>("[role=treeitem]")) {
      const focused = button.dataset.treeKey === key;
      button.tabIndex = focused ? 0 : -1;
      if (focused && move) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }
  }

  private toggle(row: TreeRow) {
    if (row.node.kind !== "folder") return;
    if (!this.collapsed.delete(row.node.path)) this.collapsed.add(row.node.path);
    this.render();
  }

  private onKey(event: KeyboardEvent, row: TreeRow) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const index = this.rows.findIndex((item) => item.key === row.key);
    let target: TreeRow | undefined;
    if (event.key === "ArrowDown") target = this.rows[Math.min(index + 1, this.rows.length - 1)];
    else if (event.key === "ArrowUp") target = this.rows[Math.max(index - 1, 0)];
    else if (event.key === "Home") target = this.rows[0];
    else if (event.key === "End") target = this.rows.at(-1);
    else if (event.key === "ArrowRight") {
      if (row.node.kind === "folder") {
        if (this.collapsed.has(row.node.path)) this.toggle(row);
        else target = this.rows[index + 1];
      }
    } else if (event.key === "ArrowLeft") {
      if (row.node.kind === "folder" && !this.collapsed.has(row.node.path)) this.toggle(row);
      else target = this.rows.find((item) => item.key === row.parent);
    } else if (row.node.kind === "file" && event.key === "Enter") {
      this.onSelect(row.node.file);
    } else if (row.node.kind === "file" && event.key === " " && this.onReview) {
      if (!this.savingReview && row.node.file.reviewId) this.onReview(row.node.file, !this.reviewed.has(row.node.path));
    } else return; // Native buttons handle folder Enter and Space.
    event.preventDefault();
    if (target) this.setFocus(target.key, true);
  }
}
