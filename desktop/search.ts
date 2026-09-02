import type { DiffFile } from "./types.js";

export type SearchResult =
  | { kind: "file"; file: string }
  | { kind: "code"; file: string; line: number; side: "LEFT" | "RIGHT"; text: string; change: "add" | "delete" | "context" };

export function createSearchIndex(files: readonly DiffFile[]) {
  const paths = files.map((file) => ({ result: { kind: "file", file: file.path } as const, path: file.path.toLowerCase(), name: file.path.split("/").at(-1)!.toLowerCase() }));
  const lines: { result: Extract<SearchResult, { kind: "code" }>; text: string }[] = [];
  for (const file of files) {
    if (file.binary) continue;
    const seen = new Set<string>();
    for (const hunk of file.hunks) {
      for (const row of hunk.lines) {
        if (row.type === "meta") continue;
        const side = row.newLine !== null ? "RIGHT" : "LEFT";
        const line = row.newLine ?? row.oldLine;
        if (line === null || seen.has(`${side}:${line}`)) continue;
        seen.add(`${side}:${line}`);
        lines.push({ result: { kind: "code", file: file.path, line, side, text: row.text, change: row.type }, text: row.text.toLowerCase() });
      }
    }
  }
  return { paths, lines };
}

export type SearchIndex = ReturnType<typeof createSearchIndex>;

export function searchDiff(index: SearchIndex, value: string, limit = 40) {
  const query = value.trim().toLowerCase();
  const paths = index.paths.filter((entry) => entry.path.includes(query));
  if (query) {
    const rank = (entry: typeof paths[number]) => entry.name === query ? 0 : entry.name.startsWith(query) ? 1 : entry.name.includes(query) ? 2 : 3;
    paths.sort((a, b) => rank(a) - rank(b));
  }
  const code: SearchResult[] = [];
  let codeCount = 0;
  if (query) {
    for (const entry of index.lines) {
      if (!entry.text.includes(query)) continue;
      codeCount++;
      if (code.length < limit) code.push(entry.result);
    }
  }
  return {
    results: [...paths.slice(0, limit).map((entry) => entry.result), ...code],
    total: paths.length + codeCount
  };
}

// Keep a long/minified line's matching portion visible without rendering it all.
export function searchExcerpt(text: string, query: string, length = 180) {
  const match = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, match - 55);
  return `${start ? "…" : ""}${text.slice(start, start + length)}${text.length > start + length ? "…" : ""}`;
}
