import type { AttentionSample, DiffFile, DiffHunk } from "./types.js";
import type { AttentionSpan } from "./agents/types.js";

export function parseUnifiedDiff(source: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of String(source || "").split("\n")) {
    const header = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      file = { oldPath: header[1], path: header[2], status: "modified", hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode ")) file.status = "added";
    if (raw.startsWith("deleted file mode ")) file.status = "deleted";
    if (raw.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = raw.slice(12); }
    if (raw.startsWith("rename to ")) file.path = raw.slice(10);
    if (raw === "GIT binary patch" || raw.startsWith("Binary files ")) { file.binary = true; continue; }

    const hunkHeader = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[3]);
      hunk = {
        oldStart: oldLine,
        oldCount: Number(hunkHeader[2] || 1),
        newStart: newLine,
        newCount: Number(hunkHeader[4] || 1),
        heading: hunkHeader[5].trim(),
        lines: []
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "add", oldLine: null, newLine, text: raw.slice(1) });
      file.additions += 1;
      newLine += 1;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ type: "delete", oldLine, newLine: null, text: raw.slice(1) });
      file.deletions += 1;
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ type: "context", oldLine, newLine, text: raw.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ type: "meta", oldLine: null, newLine: null, text: raw });
    }
  }
  return files;
}

export function collapseAttention(samples: AttentionSample[], intervalMs = 250) {
  const spans: (AttentionSpan & { startMs: number; endMs: number; cursorLines: number[] })[] = [];
  for (const sample of samples || []) {
    if (!sample?.file || !Number.isInteger(sample.visibleStart) || !Number.isInteger(sample.visibleEnd)) continue;
    const side = sample.side === "LEFT" ? "LEFT" : "RIGHT";
    const previous = spans.at(-1);
    const overlaps = previous && previous.file === sample.file && previous.side === side && sample.visibleStart <= previous.endLine + 12 && sample.visibleEnd >= previous.startLine - 12;
    if (overlaps) {
      previous.startLine = Math.min(previous.startLine, sample.visibleStart);
      previous.endLine = Math.max(previous.endLine, sample.visibleEnd);
      previous.endMs = sample.t;
      previous.dwellMs += intervalMs;
      if (sample.cursorLine) previous.cursorLines.push(sample.cursorLine);
    } else {
      spans.push({
        file: sample.file,
        side,
        startLine: sample.visibleStart,
        endLine: sample.visibleEnd,
        startMs: sample.t,
        endMs: sample.t,
        dwellMs: intervalMs,
        cursorLines: sample.cursorLine ? [sample.cursorLine] : []
      });
    }
  }
  return spans.map((span) => ({
    ...span,
    cursorLine: span.cursorLines.length ? span.cursorLines.sort((a, b) => a - b)[Math.floor(span.cursorLines.length / 2)] : null,
    cursorLines: undefined
  }));
}

export function encodeMonoWav(frames: Float32Array[], sampleRate: number) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (const value of frame) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

export function safeSegmentId(value: unknown) {
  const id = String(value || "");
  if (!/^n[1-9]\d{0,5}$/.test(id)) throw new Error("Invalid observation ID");
  return id;
}
