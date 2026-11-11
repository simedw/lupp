import { collapseAttention, encodeMonoWav, summarizeDiff } from "./lib.js";
import { tokenizeLine } from "./highlight.js";
import { VoiceCapture, type SpeechSegment } from "./voice-capture.js";
import { createObservationList } from "./observation-list.js";
import { errorMessage } from "./errors.js";
import { SearchPalette } from "./search-palette.js";
import type { SearchResult } from "./search.js";
import { FileTreeView } from "./file-tree-view.js";
import type { AttentionSample, DiffFile, DiffSnapshot, DiffSource, Repository, ReviewedFile, Settings } from "./types.js";
import { isFileReviewed } from "./file-review.js";
import { findScrollAnchor, type ScrollLine } from "./scroll-anchor.js";
import { diffSources, isDiffSource } from "./diff-source.js";
import type { AgentProviderId, AgentUsage, ReviewObservation } from "./agents/types.js";
import { actionKey, collectActions, recommendedActions, type ActionSelection } from "./actions.js";

type State = {
  repository: Repository | null;
  activeFile: DiffFile | null;
  observations: ReviewObservation[];
  reviewing: boolean;
  muted: boolean;
  clockOrigin: number;
  cursorAnchor: { file: string; line: number; side: "LEFT" | "RIGHT"; pinned: boolean } | null;
  attentionRing: AttentionSample[];
  speechAttention: AttentionSample[];
  nextObservation: number;
  selectedObservation: string | null;
  apiKeyConfigured: boolean;
  agentProvider: AgentProviderId;
  diffSource: DiffSource;
  snapshots: Map<DiffSource, DiffSnapshot>;
  loadingDiff: boolean;
  reviewedFiles: ReviewedFile[];
  savingFileReview: boolean;
  dirtySources: Set<DiffSource>;
  changeVersion: number;
  autoBlocked: boolean;
  watchMode: "native" | "fallback";
  attentionTimer?: ReturnType<typeof setInterval>;
  clockTimer?: ReturnType<typeof setInterval>;
};
const state: State = {
  repository: null,
  activeFile: null,
  observations: [],
  reviewing: false,
  muted: true,
  clockOrigin: 0,
  cursorAnchor: null,
  attentionRing: [],
  speechAttention: [],
  nextObservation: 1,
  selectedObservation: null,
  apiKeyConfigured: false,
  agentProvider: "codex",
  diffSource: "branch",
  snapshots: new Map(),
  loadingDiff: false,
  reviewedFiles: [],
  savingFileReview: false,
  dirtySources: new Set(),
  changeVersion: 0,
  autoBlocked: false,
  watchMode: "native"
};

type Controls = {
  "#review-toggle": HTMLButtonElement;
  "#mute": HTMLButtonElement;
  "#agent-provider": HTMLSelectElement;
  "#api-key": HTMLInputElement;
  "#anthropic-api-key": HTMLInputElement;
  "#file-search": HTMLButtonElement;
  "#search-dialog": HTMLDialogElement;
  "#search-input": HTMLInputElement;
  "#diff-source": HTMLSelectElement;
  "#diff-refresh": HTMLButtonElement;
  "#copy-actions": HTMLButtonElement;
  "#live-update": HTMLButtonElement;
};
function $<K extends keyof Controls>(selector: K): Controls[K];
function $(selector: string): HTMLElement;
function $(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing UI element: ${selector}`);
  return node;
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string | number): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, kind = "") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3600);
}

function formatClock(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const voice = new VoiceCapture({
  now: () => state.reviewing ? performance.now() - state.clockOrigin : 0,
  onLevel: (level) => { $("#level-meter i").style.width = `${Math.max(2, level * 100)}%`; },
  onSpeechStart: ({ startedAt }) => {
    document.body.classList.add("speaking");
    state.speechAttention = state.attentionRing.filter((sample) => sample.t >= startedAt - 750);
    $("#attention-label").textContent = "Speech segment open";
  },
  onSpeechEnd: (segment) => {
    document.body.classList.remove("speaking");
    $("#attention-label").textContent = state.muted ? "Microphone muted" : "Listening for speech";
    processSegment(segment, [...state.speechAttention]);
    state.speechAttention = [];
    scheduleAutoRefresh();
  },
  onDiscard: () => {
    document.body.classList.remove("speaking");
    state.speechAttention = [];
    toast("Short sound discarded");
    scheduleAutoRefresh();
  }
});

async function openRepository() {
  if (state.loadingDiff || state.savingFileReview) return;
  if (state.reviewing) { toast("End the review before changing repositories", "error"); return; }
  try {
    const repository = await window.reviewAPI.chooseRepository();
    if (!repository) return;
    applyRepository(repository);
  } catch (error) { toast(errorMessage(error), "error"); }
}

function applyRepository(repository: Repository) {
  state.changeVersion++;
  state.dirtySources.clear();
  state.autoBlocked = false;
  state.watchMode = "native";
  setUpdateStatus("Watching local edits");
  state.repository = repository;
  state.reviewedFiles = repository.review.reviewedFiles || [];
  state.diffSource = "branch";
  state.snapshots.clear();
  state.snapshots.set("branch", { files: repository.files, baseSha: repository.baseSha || "", headSha: repository.headSha || "", diffSource: "branch", snapshotId: repository.snapshotId || "", capturedAt: repository.capturedAt || new Date().toISOString() });
  searchPalette.setFiles(repository.files);
  fileTree.setFiles(repository.files);
  state.activeFile = repository.files[0] || null;
  state.observations = (repository.review?.observations || []).map((observation) => {
    if (["transcribing", "queued", "investigating"].includes(observation.status || "")) {
      return { ...observation, status: "saved", detail: "Restored from an earlier session" };
    }
    return observation;
  });
  state.nextObservation = Math.max(0, ...state.observations.map((item) => Number(item.id?.slice(1)) || 0)) + 1;
  state.selectedObservation = null;
  $("#repo-name").textContent = repository.name;
  $("#repo-meta").textContent = repository.repository;
  $("#base-ref").textContent = repository.baseRef;
  $("#head-ref").textContent = repository.branch;
  renderDiffSummary();
  $("#empty-state").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  renderFiles();
  renderDiff();
  renderObservations();
  if (state.observations.length) toast(`Restored ${state.observations.length} observation${state.observations.length === 1 ? "" : "s"} for ${repository.branch}`);
}

function renderDiffSummary() {
  const files = state.repository?.files || [];
  const source = diffSources[state.diffSource];
  $("#diff-source").value = state.diffSource;
  $("#diff-source-label").textContent = source.label;
  $("#diff-comparison").textContent = source.comparison;
  $("#diff-provenance").dataset.source = state.diffSource;
  const capturedAt = state.snapshots.get(state.diffSource)?.capturedAt;
  $("#diff-captured").textContent = capturedAt ? `Snapshot ${new Date(capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  $(".search-scope").textContent = `${source.label} · displayed files and diff contents`;
  const totals = summarizeDiff(files);
  const additions = totals.additions.toLocaleString("en");
  const deletions = totals.deletions.toLocaleString("en");
  $("#repo-additions").textContent = `+${additions}`;
  $("#repo-deletions").textContent = `−${deletions}`;
  $("#repo-tally").setAttribute("aria-label", `${source.label}: ${additions} lines added, ${deletions} lines deleted`);
  $("#repo-tally").title = `Totals for ${source.label.toLowerCase()} only`;
  $(".tally-label").textContent = state.diffSource.toUpperCase();
  $("#repo-tally").classList.remove("hidden");
  $("#file-count").textContent = String(files.length);
  $("#review-toggle").disabled = !state.reviewing && files.length === 0;
}

async function switchDiff(source: DiffSource, refresh = false, automatic = false): Promise<boolean> {
  if (!state.repository || state.loadingDiff || state.savingFileReview) return false;
  refresh ||= state.dirtySources.has(source);
  if (refresh && voice.speaking) {
    if (!automatic) toast("Finish speaking or mute before refreshing this code snapshot", "error");
    return false;
  }
  const repository = state.repository;
  const version = state.changeVersion;
  state.loadingDiff = true;
  $("#diff-source").disabled = true;
  $("#diff-refresh").disabled = true;
  try {
    const snapshot = !refresh && state.snapshots.get(source) || await window.reviewAPI.loadDiff(source);
    if (state.repository !== repository) return false;
    if (automatic && autoRefreshPaused()) return false;
    const previous = state.snapshots.get(source);
    if (version === state.changeVersion) state.dirtySources.delete(source);
    if (automatic && previous?.snapshotId === snapshot.snapshotId) {
      if ($("#live-update").textContent?.startsWith("Update pending")) setUpdateStatus("Watching local edits");
      return true;
    }
    const preserve = refresh && source === state.diffSource;
    const scroll = preserve ? captureDiffScroll() : null;
    const oldActive = state.activeFile;
    const updated = snapshot.files.filter((file) => previous?.files.find((old) => old.path === file.path)?.reviewId !== file.reviewId).map((file) => file.path);
    state.snapshots.set(source, snapshot);
    state.diffSource = source;
    const activePath = state.activeFile?.path;
    state.repository.files = snapshot.files;
    state.activeFile = snapshot.files.find((file) => file.path === activePath) || (preserve && oldActive ? null : snapshot.files[0] || null);
    searchPalette.setFiles(snapshot.files);
    fileTree.setFiles(snapshot.files, preserve, preserve ? updated : []);
    renderDiffSummary();
    renderFiles(!preserve);
    if (!preserve || !oldActive?.reviewId || oldActive.reviewId !== state.activeFile?.reviewId) {
      renderDiff();
      if (preserve && oldActive && !state.activeFile) $("#diff").replaceChildren(el("div", "diff-empty", `${oldActive.path} is no longer in this diff. It may have been staged, removed, or reverted. Choose a file to continue.`));
      if (scroll && state.activeFile?.path === activePath) restoreDiffScroll(scroll);
    }
    if (refresh) {
      state.attentionRing = [];
      setUpdateStatus(`Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, updated.length ? `Updated from disk: ${updated.join(", ")}. Changed diffs become unchecked.` : "Snapshot refreshed; notes are unchanged.");
      if (!automatic) toast("Snapshot refreshed; saved observations are unchanged");
    } else setUpdateStatus("Watching local edits");
    return true;
  } catch (error) {
    if (automatic) {
      state.autoBlocked = true;
      setUpdateStatus("Auto-update paused", errorMessage(error));
    } else toast(`Could not load changes: ${errorMessage(error)}`, "error");
    return false;
  } finally {
    state.loadingDiff = false;
    $("#diff-source").value = state.diffSource;
    $("#diff-source").disabled = false;
    $("#diff-refresh").disabled = false;
    if (!automatic) state.autoBlocked = false;
    scheduleAutoRefresh();
  }
}

function renderFiles(reveal = true) {
  renderFileChecks();
  fileTree.select(state.activeFile?.path || null, reveal);
}

function scrollLines() { return [...document.querySelectorAll<HTMLElement>(".diff-line[data-line]")].filter((row) => Number(row.dataset.line)); }
function scrollLine(row: HTMLElement): ScrollLine { return { text: row.querySelector(".line-code")?.textContent || "", side: row.dataset.side || "RIGHT", line: Number(row.dataset.line) }; }
function captureDiffScroll() {
  const viewport = $("#diff-scroll");
  const top = viewport.getBoundingClientRect().top;
  const row = scrollLines().find((row) => row.getBoundingClientRect().bottom > top);
  return { top: viewport.scrollTop, left: viewport.scrollLeft, anchor: row ? scrollLine(row) : null, offset: row ? row.getBoundingClientRect().top - top : 0 };
}
function restoreDiffScroll(saved: ReturnType<typeof captureDiffScroll>) {
  const viewport = $("#diff-scroll");
  const rows = scrollLines();
  const index = saved.anchor ? findScrollAnchor(rows.map(scrollLine), saved.anchor) : -1;
  viewport.scrollTop = index === -1 ? saved.top : viewport.scrollTop + rows[index].getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset;
  viewport.scrollLeft = saved.left;
}

let autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function setUpdateStatus(text: string, detail = "Native filesystem notifications; updates pause while speaking or searching.") {
  $("#live-update").textContent = text;
  $("#live-update").title = detail + (state.watchMode === "fallback" ? " Native watching unavailable: fallback checks every 30 seconds; hidden views defer refreshes." : "");
}
function autoRefreshPaused() {
  return voice.speaking || document.hidden || $("#search-dialog").open || !$("#settings-modal").classList.contains("hidden");
}
function scheduleAutoRefresh() {
  if (autoRefreshTimer || !state.dirtySources.has(state.diffSource) || state.autoBlocked || document.hidden) return;
  autoRefreshTimer = setTimeout(async () => {
    autoRefreshTimer = undefined;
    if (!state.dirtySources.has(state.diffSource) || state.autoBlocked) return;
    if (autoRefreshPaused() || state.loadingDiff || state.savingFileReview) {
      setUpdateStatus(voice.speaking ? "Update pending · speaking" : "Update pending");
      scheduleAutoRefresh();
      return;
    }
    await switchDiff(state.diffSource, true, true);
  }, 1000);
}

window.reviewAPI.onRepositoryChange((change) => {
  if (change.repository !== state.repository?.repository) return;
  state.changeVersion++;
  state.watchMode = change.mode;
  for (const source of change.sources) state.dirtySources.add(source);
  if (state.autoBlocked) return;
  if (change.mode === "fallback") setUpdateStatus($("#live-update").textContent || "Watching local edits");
  if (state.dirtySources.has(state.diffSource)) scheduleAutoRefresh();
  else setUpdateStatus("Local edits changed", "This change view is unchanged. Choose Unstaged or Untracked to see local edits.");
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleAutoRefresh(); });

function renderFileChecks() {
  const files = state.repository?.files || [];
  const checked = files.filter((file) => isFileReviewed(state.reviewedFiles, file, state.diffSource));
  fileTree.setReviewed(checked.map((file) => file.path), state.savingFileReview);
  $("#file-review-count").textContent = `${checked.length} / ${files.length} reviewed`;
}

async function toggleFileReview(file: DiffFile, reviewed: boolean) {
  if (state.savingFileReview || state.loadingDiff || !file.reviewId) return;
  state.savingFileReview = true;
  renderFileChecks();
  try {
    const result = await window.reviewAPI.setFileReviewed({ path: file.path, source: state.diffSource, reviewId: file.reviewId, reviewed });
    state.reviewedFiles = result.reviewedFiles;
  } catch (error) { toast(`Could not save file check: ${errorMessage(error)}`, "error"); }
  finally { state.savingFileReview = false; renderFileChecks(); }
}

function renderDiff() {
  const file = state.activeFile;
  const target = $("#diff");
  target.replaceChildren();
  state.cursorAnchor = null;
  $("#attention-location").textContent = "No active line";
  if (!file) {
    $("#file-status").textContent = "NO CHANGES";
    $("#file-name").textContent = "—";
    $("#file-additions").textContent = "+0";
    $("#file-deletions").textContent = "−0";
    target.append(el("div", "diff-empty", diffSources[state.diffSource].empty));
    return;
  }
  $("#file-status").textContent = file.status.toUpperCase();
  $("#file-name").textContent = file.path;
  $("#file-additions").textContent = `+${file.additions}`;
  $("#file-deletions").textContent = `−${file.deletions}`;
  if (file.binary) target.append(el("div", "binary-message", "Binary file changed — no textual proof available."));
  if (file.previewMessage) target.append(el("div", "binary-message", file.previewMessage));
  for (const hunk of file.hunks) {
    target.append(el("div", "hunk-heading", `@@ −${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.heading}`));
    for (const line of hunk.lines) {
      const row = el("div", `diff-line ${line.type}`);
      row.dataset.file = file.path;
      row.dataset.side = line.newLine ? "RIGHT" : "LEFT";
      row.dataset.line = String(line.newLine || line.oldLine || "");
      row.dataset.oldLine = String(line.oldLine ?? "");
      row.dataset.newLine = String(line.newLine ?? "");
      row.append(el("span", "line-no", line.oldLine ?? ""));
      row.append(el("span", "line-no", line.newLine ?? ""));
      const code = el("span", "line-code");
      for (const token of tokenizeLine(line.text, file.path)) {
        if (token.type === "plain") code.append(document.createTextNode(token.text));
        else code.append(el("span", `syntax-${token.type}`, token.text));
      }
      row.append(code);
      row.onpointermove = () => setCursorAnchor(row);
      row.onclick = () => setCursorAnchor(row, true);
      target.append(row);
    }
  }
  $("#diff-scroll").scrollTop = 0;
}

function setCursorAnchor(row: HTMLElement, pin = false) {
  document.querySelectorAll(".diff-line.cursor").forEach((node) => node.classList.remove("cursor"));
  row.classList.add("cursor");
  state.cursorAnchor = { file: row.dataset.file || "", line: Number(row.dataset.line), side: row.dataset.side === "LEFT" ? "LEFT" : "RIGHT", pinned: pin };
  $("#attention-location").textContent = `${state.cursorAnchor.file}:${state.cursorAnchor.line}`;
}

function attentionSnapshot(): AttentionSample | null {
  const viewport = $("#diff-scroll").getBoundingClientRect();
  const visible = [...document.querySelectorAll<HTMLElement>(".diff-line[data-line]")].filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom && Number(row.dataset.line);
  });
  if (!visible.length || !state.activeFile) return null;
  const side = state.cursorAnchor?.file === state.activeFile.path ? state.cursorAnchor.side : state.activeFile.status === "deleted" ? "LEFT" : "RIGHT";
  const lines = visible.map((row) => Number(side === "LEFT" ? row.dataset.oldLine : row.dataset.newLine)).filter(Boolean);
  if (!lines.length) return null;
  return {
    t: performance.now() - state.clockOrigin,
    file: state.activeFile.path,
    source: state.diffSource,
    snapshotId: state.snapshots.get(state.diffSource)?.snapshotId,
    side,
    visibleStart: Math.min(...lines),
    visibleEnd: Math.max(...lines),
    cursorLine: state.cursorAnchor?.file === state.activeFile.path ? state.cursorAnchor.line : null
  };
}

function sampleAttention() {
  if (!state.reviewing) return;
  const sample = attentionSnapshot();
  if (!sample) return;
  state.attentionRing.push(sample);
  state.attentionRing = state.attentionRing.filter((item) => item.t >= sample.t - 3000);
  if (voice.speaking) state.speechAttention.push(sample);
}

async function toggleReview() {
  if (state.reviewing) return stopReview();
  if (!state.repository) return;
  const settings = await window.reviewAPI.getSettings();
  applySettings(settings);
  if (!state.apiKeyConfigured) {
    openSettings();
    toast(settings.apiKeyError || "Add an OpenAI key before starting the review", "error");
    return;
  }
  try {
    const session = await window.reviewAPI.startSession({ repository: state.repository.repository, baseSha: state.repository.baseSha, headSha: state.repository.headSha, baseRef: state.repository.baseRef, branch: state.repository.branch });
    state.agentProvider = session.agentProvider;
    await voice.start();
    state.reviewing = true;
    state.muted = false;
    state.clockOrigin = performance.now();
    state.attentionRing = [];
    document.body.classList.add("reviewing");
    $("#review-toggle").classList.add("active");
    $("#review-toggle span:last-child").textContent = "End review";
    $("#mute").disabled = false;
    $("#mute").classList.add("live");
    $("#mute span:last-child").textContent = "LIVE";
    $("#attention-label").textContent = "Listening for speech";
    state.attentionTimer = setInterval(sampleAttention, 250);
    state.clockTimer = setInterval(() => { $("#clock").textContent = formatClock(performance.now() - state.clockOrigin); }, 250);
    toast("Review session started — microphone live");
  } catch (error) { toast(`Could not start review: ${errorMessage(error)}`, "error"); }
}

async function stopReview() {
  state.reviewing = false;
  clearInterval(state.attentionTimer);
  clearInterval(state.clockTimer);
  await voice.stop();
  state.muted = true;
  document.body.classList.remove("reviewing", "speaking");
  $("#review-toggle").classList.remove("active");
  $("#review-toggle span:last-child").textContent = "Start review";
  $("#mute").disabled = true;
  $("#mute").classList.remove("live");
  $("#mute span:last-child").textContent = "MUTED";
  $("#attention-label").textContent = "Session complete";
  toast("Review session ended; background investigations continue");
  renderDiffSummary();
}

function toggleMute() {
  if (!state.reviewing) return;
  state.muted = !state.muted;
  voice.setMuted(state.muted);
  $("#mute").classList.toggle("live", !state.muted);
  $("#mute span:last-child").textContent = state.muted ? "MUTED" : "LIVE";
  $("#attention-label").textContent = state.muted ? "Microphone muted" : "Listening for speech";
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  let codes = [];
  for (const byte of bytes) {
    codes.push(byte);
    if (codes.length === 0x8000) { binary += String.fromCharCode(...codes); codes = []; }
  }
  if (codes.length) binary += String.fromCharCode(...codes);
  return btoa(binary);
}

async function processSegment(segment: SpeechSegment, attention: AttentionSample[]) {
  const id = `n${state.nextObservation++}`;
  const wav = encodeMonoWav(segment.frames, segment.sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  const spans = collapseAttention(attention).map((span) => {
    const snapshot = state.snapshots.get(span.source || "branch");
    const file = snapshot && snapshot.snapshotId === span.snapshotId ? snapshot.files.find((file) => file.path === span.file) : null;
    const excerpt = file?.hunks.flatMap((hunk) => hunk.lines).filter((line) => {
      const number = span.side === "LEFT" ? line.oldLine : line.newLine;
      return number !== null && number >= span.startLine && number <= span.endLine;
    }).slice(0, 160).map((line) => `${line.oldLine ?? "-"}/${line.newLine ?? "-"} ${line.type}: ${line.text}`).join("\n").slice(0, 16000);
    return { ...span, excerpt };
  });
  const observation: ReviewObservation = { id, transcript: "", status: "transcribing", detail: "Sending speech to OpenAI", spans, audioUrl: URL.createObjectURL(blob), durationMs: segment.durationMs, finding: null };
  state.observations.push(observation);
  renderObservations();
  markAttention(spans);
  try {
    const result = await window.reviewAPI.saveAndTranscribe({ id, wavBase64: arrayBufferToBase64(wav) });
    if (result.status === "needs-key") throw new Error("Add an OpenAI API key in settings");
    observation.transcript = result.transcript;
    observation.audioPath = result.audioPath;
    observation.status = "queued";
    observation.detail = `Waiting for ${state.agentProvider === "claude" ? "Claude" : "Codex"}`;
    renderObservations();
    await window.reviewAPI.enqueueAnalysis({ id, transcript: observation.transcript, spans, durationMs: observation.durationMs, audioPath: observation.audioPath });
  } catch (error) {
    observation.status = "failed";
    observation.detail = errorMessage(error);
    renderObservations();
  }
}

type CodeLocation = { file: string; startLine: number; endLine: number; source?: DiffSource; snapshotId?: string; side?: "LEFT" | "RIGHT" };
function markAttention(spans: CodeLocation[]) {
  document.querySelectorAll(".diff-line.attended").forEach((node) => node.classList.remove("attended"));
  for (const span of spans) {
    if (span.file !== state.activeFile?.path) continue;
    if ((span.source || "branch") !== state.diffSource) continue;
    for (const row of document.querySelectorAll<HTMLElement>(".diff-line[data-line]")) {
      const line = Number(span.side === "LEFT" ? row.dataset.oldLine : span.side === "RIGHT" ? row.dataset.newLine : row.dataset.line);
      if (line >= span.startLine && line <= span.endLine) row.classList.add("attended");
    }
  }
}

const cardResults = new WeakMap<HTMLElement, Pick<ReviewObservation, "finding" | "usage" | "dismissedActionKeys" | "status">>();
const updateObservationList = createObservationList<ReviewObservation, HTMLElement>($("#observation-list"), {
  createEmpty() {
    const empty = el("div", "ledger-empty");
    empty.append(el("span", "", "◌"), el("p", "", "Spoken segments will collect here while you review."));
    return empty;
  },
  createCard(observation) {
    const card = el("article", `observation ${state.selectedObservation === observation.id ? "selected" : ""}`);
    card.tabIndex = 0;
    card.title = "Jump to where this observation was captured";
    card.onclick = (event) => {
      if (event.target instanceof Element && event.target.closest("button, textarea, audio")) return;
      jumpToObservation(observation, card);
    };
    card.onkeydown = (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === card) {
        event.preventDefault();
        jumpToObservation(observation, card);
      }
    };
    const top = el("div", "observation-top");
    top.append(el("span", "observation-id", observation.id));
    top.append(el("span", `observation-status ${observation.status}`, `${observation.status} · ${observation.detail || ""}`));
    const remove = el("button", "observation-delete", "×");
    remove.title = "Delete local observation";
    remove.onclick = async () => {
      try {
        await window.reviewAPI.deleteObservation(observation.id);
        if (observation.audioUrl) URL.revokeObjectURL(observation.audioUrl);
        state.observations = state.observations.filter((item) => item !== observation);
        renderObservations();
      } catch (error) { toast(`Could not delete observation: ${errorMessage(error)}`, "error"); }
    };
    top.append(remove); card.append(top);
    const transcript = el("textarea"); transcript.placeholder = observation.status === "transcribing" ? "Transcribing…" : "No transcript"; transcript.value = observation.transcript;
    transcript.onchange = async () => {
      observation.transcript = transcript.value;
      try { await window.reviewAPI.updateObservation({ id: observation.id, transcript: observation.transcript }); }
      catch (error) { toast(`Could not save transcript: ${errorMessage(error)}`, "error"); }
    };
    card.append(transcript);
    if (observation.audioUrl) {
      const audio = el("audio"); audio.controls = true; audio.src = observation.audioUrl; card.append(audio);
    }
    const anchors = el("div", "anchor-list");
    for (const span of observation.spans) {
      const sourceLabel = span.source && span.source !== "branch" ? `${span.source} · ` : "";
      const chip = el("button", "anchor-chip", `${sourceLabel}${span.file.split("/").at(-1)}:${span.startLine}–${span.endLine}`);
      chip.title = `${diffSources[span.source || "branch"].label} · ${span.side} · ${span.file}`;
      chip.onclick = () => jumpToSpan(span);
      anchors.append(chip);
    }
    card.append(anchors);
    return card;
  },
  updateCard(card, observation) {
    card.classList.toggle("selected", state.selectedObservation === observation.id);
    const status = card.querySelector<HTMLElement>(".observation-status")!;
    status.className = `observation-status ${observation.status}`;
    status.textContent = `${observation.status} · ${observation.detail || ""}`;
    const transcript = card.querySelector("textarea")!;
    transcript.placeholder = observation.status === "transcribing" ? "Transcribing…" : "No transcript";
    // Progress updates must not overwrite an in-progress transcript edit.
    if (document.activeElement !== transcript && transcript.value !== observation.transcript) {
      transcript.value = observation.transcript;
    }
    const previous = cardResults.get(card);
    if (previous?.finding !== observation.finding || previous?.dismissedActionKeys !== observation.dismissedActionKeys || previous?.status !== observation.status) {
      card.querySelector(".finding")?.remove();
      if (observation.finding) card.append(renderFinding(observation));
    }
    card.classList.toggle("has-actions", collectActions([observation]).length > 0);
    card.classList.toggle("needs-decision", observation.finding?.decision === "needs-decision");
    if (previous?.usage !== observation.usage) {
      card.querySelector(".usage-strip")?.remove();
      if (observation.usage) card.append(renderUsage(observation.usage));
    }
    cardResults.set(card, { finding: observation.finding, usage: observation.usage, dismissedActionKeys: observation.dismissedActionKeys, status: observation.status });
  }
});

function renderObservations() {
  $("#observation-count").textContent = String(state.observations.length);
  const count = collectActions(state.observations).length;
  $("#action-count").textContent = `${count} action${count === 1 ? "" : "s"}`;
  $("#copy-actions").disabled = count === 0;
  updateObservationList(state.observations);
}

async function copyActions(selection?: ActionSelection) {
  try {
    const { count } = await window.reviewAPI.copyActions(selection);
    toast(`Copied ${count} action${count === 1 ? "" : "s"} — paste into your coding agent`);
  } catch (error) { toast(`Could not copy actions: ${errorMessage(error)}`, "error"); }
}

function renderFinding(observation: ReviewObservation) {
  const finding = observation.finding!;
  const box = el("div", "finding");
  const head = el("div", "finding-head");
  const label = finding.decision === "action-recommended" ? "Action recommended" : finding.decision === "needs-decision" ? "Needs your decision" : finding.decision === "answered" ? "Answered" : finding.severity;
  head.append(el("b", "", label), el("span", "", `${Math.round((finding.confidence || 0) * 100)}% confidence`));
  box.append(head, el("p", "", finding.summary));
  if (finding.suggestedComment) box.append(el("blockquote", "", finding.suggestedComment));
  for (const action of recommendedActions(observation)) {
    const key = actionKey(action);
    const dismissed = observation.dismissedActionKeys?.includes(key) || false;
    const block = el("section", `recommended-action${dismissed ? " dismissed" : ""}`);
    block.dataset.actionKey = key;
    block.append(el("span", "action-kind", `${dismissed ? "Dismissed" : "Recommended action"} · ${action.kind}`), el("h3", "", action.title), el("p", "action-rationale", action.rationale));
    const locations = el("div", "action-locations");
    for (const location of action.locations) locations.append(el("div", "", `${location.file}:${location.startLine}–${location.endLine}`));
    block.append(locations);
    const buttons = el("div", "action-buttons");
    const copy = el("button", "action-copy", "Copy action");
    copy.type = "button";
    copy.disabled = dismissed;
    copy.onclick = () => { void copyActions({ observationId: observation.id, actionKey: key }); };
    const dismiss = el("button", "action-dismiss", dismissed ? "Restore" : "Dismiss");
    dismiss.type = "button";
    dismiss.title = dismissed ? "Include in the implementation brief again" : "Keep in this note, but exclude from copied actions";
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      try {
        const result = await window.reviewAPI.dismissAction({ observationId: observation.id, actionKey: key, dismissed: !dismissed });
        observation.dismissedActionKeys = result.dismissedActionKeys;
        renderObservations();
        const replacement = [...document.querySelectorAll<HTMLElement>(".recommended-action")].find((node) => node.dataset.actionKey === key && node.closest(".observation")?.querySelector(".observation-id")?.textContent === observation.id);
        replacement?.querySelector<HTMLButtonElement>(".action-dismiss")?.focus({ preventScroll: true });
      } catch (error) { dismiss.disabled = false; toast(`Could not save action: ${errorMessage(error)}`, "error"); }
    };
    buttons.append(copy, dismiss);
    block.append(buttons);
    box.append(block);
  }
  return box;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat("en", { notation: Number(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function renderUsage(usage: AgentUsage) {
  const totalInput = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRate = totalInput ? Math.round(cached / totalInput * 100) : 0;
  const box = el("div", "usage-strip");
  box.append(
    el("span", "", usage.provider || "agent"),
    el("span", "", `${formatTokens(totalInput)} input`),
    el("span", "", `${formatTokens(cached)} cached (${cacheRate}%)`),
    el("span", "", `${formatTokens(output)} output`)
  );
  if (Number.isFinite(usage.cost_usd)) box.append(el("span", "", `$${Number(usage.cost_usd).toFixed(4)} est.`));
  return box;
}

function jumpToObservation(observation: ReviewObservation, card?: HTMLElement) {
  state.selectedObservation = observation.id;
  document.querySelectorAll(".observation.selected").forEach((node) => node.classList.remove("selected"));
  card?.classList.add("selected");
  const span = observation.spans?.[0] || observation.finding?.evidence?.[0];
  if (span) jumpToSpan(span);
  else toast("This observation has no captured code location", "error");
}

async function jumpToSpan(span: CodeLocation) {
  if ((span.source || "branch") !== state.diffSource && !await switchDiff(span.source || "branch")) return;
  if (span.snapshotId && span.snapshotId !== state.snapshots.get(state.diffSource)?.snapshotId) {
    toast("Code changed since this note. Showing its original view; line positions may have moved.", "error");
  }
  const file = state.repository?.files.find((item) => item.path === span.file);
  if (!file) { toast("This file is no longer in the selected diff snapshot", "error"); return; }
  if (file !== state.activeFile) { state.activeFile = file; renderDiff(); }
  renderFiles();
  document.querySelector(".file-item.active")?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLElement>(".diff-line[data-line]")].find((item) => Number(span.side === "LEFT" ? item.dataset.oldLine : span.side === "RIGHT" ? item.dataset.newLine : item.dataset.line) >= span.startLine);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    markAttention([span]);
  });
}

function openSettings() { $("#settings-modal").classList.remove("hidden"); $("#agent-provider").focus(); }
function closeSettings() { $("#settings-modal").classList.add("hidden"); }

function selectSearchResult(result: SearchResult) {
  const file = state.repository?.files.find((item) => item.path === result.file);
  if (!file) return;
  state.activeFile = file;
  renderFiles();
  renderDiff();
  document.querySelector(".file-item.active")?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => {
    if (result.kind === "file") { $("#diff-scroll").focus({ preventScroll: true }); return; }
    const row = [...document.querySelectorAll<HTMLElement>(".diff-line[data-line]")].find((item) => item.dataset.side === result.side && Number(item.dataset.line) === result.line);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    row.classList.add("search-hit");
    setCursorAnchor(row, true);
  });
}

const fileTree = new FileTreeView($("#file-list"), (file) => {
  state.activeFile = file;
  renderFiles();
  renderDiff();
}, (file, reviewed) => { void toggleFileReview(file, reviewed); });

const searchPalette = new SearchPalette({
  trigger: $("#file-search"), dialog: $("#search-dialog"), input: $("#search-input"),
  results: $("#search-results"), status: $("#search-status"), onSelect: selectSearchResult
});

$("#open-repo").onclick = openRepository;
$("#copy-actions").onclick = () => { void copyActions(); };
$("#live-update").onclick = () => { if (state.autoBlocked) toast($("#live-update").title, "error"); else { state.dirtySources.add(state.diffSource); scheduleAutoRefresh(); } };
$("#diff-source").onchange = async () => { const source = $("#diff-source").value; if (isDiffSource(source) && !await switchDiff(source)) $("#diff-source").value = state.diffSource; };
$("#diff-refresh").onclick = () => { void switchDiff(state.diffSource, true); };
$("#empty-open").onclick = openRepository;
$("#review-toggle").onclick = toggleReview;
$("#mute").onclick = toggleMute;
$("#settings").onclick = openSettings;
$("#settings-close").onclick = closeSettings;
$("#settings-modal").onclick = (event) => { if (event.target === $("#settings-modal")) closeSettings(); };
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await window.reviewAPI.saveSettings({
      agentProvider: $("#agent-provider").value === "claude" ? "claude" : "codex",
      openaiApiKey: $("#api-key").value,
      anthropicApiKey: $("#anthropic-api-key").value
    });
    applySettings(result);
    $("#api-key").value = "";
    $("#anthropic-api-key").value = "";
    const keyError = result.apiKeyError || result.anthropicApiKeyError;
    toast(keyError || "Settings saved securely", keyError ? "error" : "");
  } catch (error) {
    $("#key-status").className = "settings-status";
    $("#key-status").textContent = errorMessage(error);
  }
};

window.reviewAPI.onAnalysisUpdate((update) => {
  const observation = state.observations.find((item) => item.id === update.id);
  if (!observation) return;
  observation.status = update.status;
  observation.detail = update.detail || "";
  observation.provider = update.provider || observation.provider;
  if (update.finding) observation.finding = update.finding;
  if (update.usage) observation.usage = update.usage;
  renderObservations();
});

function applySettings(settings: Settings) {
  state.apiKeyConfigured = settings.apiKeyConfigured;
  state.agentProvider = settings.agentProvider;
  $("#agent-provider").value = settings.agentProvider;
  const hasError = settings.apiKeyError || settings.anthropicApiKeyError;
  $("#key-status").className = `settings-status ${settings.apiKeyConfigured && !hasError ? "ok" : ""}`;
  const keyParts = [settings.apiKeyError || (settings.apiKeyConfigured ? "OpenAI transcription key configured." : "OpenAI transcription key missing.")];
  if (settings.anthropicApiKeyError) keyParts.push(settings.anthropicApiKeyError);
  if (settings.anthropicApiKeyConfigured) keyParts.push("Anthropic key configured.");
  $("#key-status").textContent = keyParts.join(" ");
  $("#provider-status").textContent = settings.availability.map((item) => `${item.available ? "●" : "○"} ${item.name}: ${item.detail}`).join(" · ");
}

window.reviewAPI.getSettings().then((settings) => {
  applySettings(settings);
  if (settings.apiKeyError || settings.anthropicApiKeyError) openSettings();
}).catch((error) => toast(`Could not read settings: ${error.message}`, "error"));

window.reviewAPI.initialRepository().then((repository) => { if (repository) applyRepository(repository); }).catch((error) => toast(error.message, "error"));
