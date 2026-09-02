import type { DiffFile } from "./types.js";
import { createSearchIndex, searchDiff, searchExcerpt, type SearchResult } from "./search.js";

type Options = {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
  onSelect(result: SearchResult): void;
};

export class SearchPalette {
  private index = createSearchIndex([]);
  private matches: SearchResult[] = [];
  private selected = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ui: Options) {
    const shortcut = /Mac/i.test(navigator.platform) ? "⌘ K" : "Ctrl K";
    ui.trigger.querySelector("kbd")!.textContent = shortcut;
    ui.trigger.title = `Search changed files and diff contents (${shortcut})`;
    ui.trigger.onclick = () => this.open();
    ui.input.oninput = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.render(), 80);
    };
    ui.dialog.addEventListener("close", () => {
      clearTimeout(this.timer);
      ui.input.setAttribute("aria-expanded", "false");
    });
    ui.dialog.querySelector<HTMLButtonElement>(".search-close")!.onclick = () => ui.dialog.close();
    ui.dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        ui.dialog.close();
      }
    });
    ui.dialog.addEventListener("click", (event) => {
      const bounds = ui.dialog.getBoundingClientRect();
      if (event.target === ui.dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) ui.dialog.close();
    });
    ui.input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
      event.preventDefault();
      // A quick Enter must act on the current query, not debounced old results.
      if (this.timer) { clearTimeout(this.timer); this.render(); }
      if (event.key === "Enter") { this.activate(); return; }
      if (!this.matches.length) return;
      this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length;
      this.updateSelection();
    });
    document.addEventListener("keydown", (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.code !== "KeyK" || event.isComposing) return;
      event.preventDefault();
      if (ui.dialog.open) ui.dialog.close();
      else if (document.querySelector("#settings-modal.hidden")) this.open();
    });
  }

  setFiles(files: readonly DiffFile[]) {
    if (this.ui.dialog.open) this.ui.dialog.close();
    this.index = createSearchIndex(files);
    this.ui.trigger.disabled = files.length === 0;
    this.ui.input.value = "";
  }

  private open() {
    if (this.ui.trigger.disabled) return;
    this.render();
    this.ui.dialog.showModal();
    this.ui.input.setAttribute("aria-expanded", "true");
    this.ui.input.focus();
    this.ui.input.select();
  }

  private render() {
    this.timer = undefined;
    const query = this.ui.input.value.trim();
    const { results, total } = searchDiff(this.index, query);
    this.matches = results;
    this.selected = 0;
    this.ui.results.replaceChildren();
    this.ui.results.scrollTop = 0;
    this.ui.status.textContent = total > results.length ? `Showing ${results.length} of ${total} matches · Keep typing to narrow` : `${total} ${query ? "matches" : "files"}`;
    let previousKind = "";
    results.forEach((result, index) => {
      if (result.kind !== previousKind) {
        const heading = document.createElement("div");
        heading.className = "search-section";
        heading.setAttribute("role", "presentation");
        heading.textContent = result.kind === "file" ? "FILES" : "IN THE DIFF";
        this.ui.results.append(heading);
        previousKind = result.kind;
      }
      const option = document.createElement("div");
      option.className = "search-result";
      option.id = `search-result-${index}`;
      option.setAttribute("role", "option");
      option.title = result.file;
      const label = document.createElement("div");
      label.className = "search-result-path";
      this.highlight(label, result.file, query);
      if (result.kind === "code") {
        const location = document.createElement("span");
        location.className = `search-result-location ${result.change}`;
        location.textContent = `:${result.line} · ${result.change === "delete" ? "deleted" : result.change === "add" ? "added" : "context"}`;
        label.append(location);
      }
      option.append(label);
      if (result.kind === "code") {
        const excerpt = document.createElement("div");
        excerpt.className = "search-result-code";
        this.highlight(excerpt, searchExcerpt(result.text, query), query);
        option.append(excerpt);
      }
      option.onmousedown = (event) => event.preventDefault();
      option.onclick = () => { this.selected = index; this.activate(); };
      this.ui.results.append(option);
    });
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No matching files or code in this diff.";
      this.ui.results.append(empty);
    }
    this.updateSelection();
  }

  private highlight(node: HTMLElement, text: string, query: string) {
    const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (start === -1) { node.textContent = text; return; }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, start + query.length);
    node.append(document.createTextNode(text.slice(0, start)), mark, document.createTextNode(text.slice(start + query.length)));
  }

  private updateSelection() {
    const options = this.ui.results.querySelectorAll<HTMLElement>("[role=option]");
    options.forEach((option, index) => option.setAttribute("aria-selected", String(index === this.selected)));
    const active = options[this.selected];
    if (active) {
      this.ui.input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else this.ui.input.removeAttribute("aria-activedescendant");
  }

  private activate() {
    const result = this.matches[this.selected];
    if (!result) return;
    this.ui.dialog.close();
    this.ui.onSelect(result);
  }
}
