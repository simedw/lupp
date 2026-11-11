export type ScrollLine = { text: string; side: string; line: number };

export function findScrollAnchor(lines: ScrollLine[], anchor: ScrollLine): number {
  let best = -1;
  let distance = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i];
    if (item.text !== anchor.text || item.side !== anchor.side) continue;
    const delta = Math.abs(item.line - anchor.line);
    if (delta < distance) { best = i; distance = delta; }
  }
  if (best !== -1) return best;
  // If the actual line was removed/edited, keep the nearest line on that side.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].side !== anchor.side) continue;
    const delta = Math.abs(lines[i].line - anchor.line);
    if (delta < distance) { best = i; distance = delta; }
  }
  return best;
}
