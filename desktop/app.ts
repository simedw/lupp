import { collapseAttention, encodeMonoWav, summarizeDiff } from "./lib.js";
import { tokenizeLine } from "./highlight.js";
import { VoiceCapture, type SpeechSegment } from "./voice-capture.js";
import { createObservationList } from "./observation-list.js";
import { errorMessage } from "./errors.js";
import { SearchPalette } from "./search-palette.js";
import type { SearchResult } from "./search.js";
import { FileTreeView } from "./file-tree-view.js";
import type { AttentionSample, DiffFile, Repository, Settings } from "./types.js";
import type { AgentProviderId, AgentUsage, Finding, ReviewObservation } from "./agents/types.js";

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
  agentProvider: "codex"
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
  },
  onDiscard: () => {
    document.body.classList.remove("speaking");
    state.speechAttention = [];
    toast("Short sound discarded");
  }
});

async function openRepository() {
  try {
    const repository = await window.reviewAPI.chooseRepository();
    if (!repository) return;
    applyRepository(repository);
  } catch (error) { toast(errorMessage(error), "error"); }
}

function applyRepository(repository: Repository) {
  state.repository = repository;
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
  const totals = summarizeDiff(repository.files);
  const additions = totals.additions.toLocaleString("en");
  const deletions = totals.deletions.toLocaleString("en");
  $("#repo-additions").textContent = `+${additions}`;
  $("#repo-deletions").textContent = `−${deletions}`;
  $("#repo-tally").setAttribute("aria-label", `Total changes: ${additions} lines added, ${deletions} lines deleted`);
  $("#repo-tally").classList.remove("hidden");
  $("#file-count").textContent = String(repository.files.length);
  $("#empty-state").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#review-toggle").disabled = repository.files.length === 0;
  renderFiles();
  renderDiff();
  renderObservations();
  if (state.observations.length) toast(`Restored ${state.observations.length} observation${state.observations.length === 1 ? "" : "s"} for ${repository.branch}`);
  if (!repository.files.length) toast("No committed changes found between base and HEAD", "error");
}

function renderFiles() {
  fileTree.select(state.activeFile?.path || null);
}

function renderDiff() {
  const file = state.activeFile;
  const target = $("#diff");
  target.replaceChildren();
  if (!file) return;
  $("#file-status").textContent = file.status.toUpperCase();
  $("#file-name").textContent = file.path;
  $("#file-additions").textContent = `+${file.additions}`;
  $("#file-deletions").textContent = `−${file.deletions}`;
  if (file.binary) target.append(el("div", "binary-message", "Binary file changed — no textual proof available."));
  for (const hunk of file.hunks) {
    target.append(el("div", "hunk-heading", `@@ −${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.heading}`));
    for (const line of hunk.lines) {
      const row = el("div", `diff-line ${line.type}`);
      row.dataset.file = file.path;
      row.dataset.side = line.newLine ? "RIGHT" : "LEFT";
      row.dataset.line = String(line.newLine || line.oldLine || "");
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
  const lines = visible.map((row) => Number(row.dataset.line)).filter(Boolean);
  return {
    t: performance.now() - state.clockOrigin,
    file: state.activeFile.path,
    side: state.cursorAnchor?.file === state.activeFile.path ? state.cursorAnchor.side : "RIGHT",
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
  const spans = collapseAttention(attention);
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

type CodeLocation = { file: string; startLine: number; endLine: number };
function markAttention(spans: CodeLocation[]) {
  document.querySelectorAll(".diff-line.attended").forEach((node) => node.classList.remove("attended"));
  for (const span of spans) {
    if (span.file !== state.activeFile?.path) continue;
    for (const row of document.querySelectorAll<HTMLElement>(".diff-line[data-line]")) {
      const line = Number(row.dataset.line);
      if (line >= span.startLine && line <= span.endLine) row.classList.add("attended");
    }
  }
}

const cardResults = new WeakMap<HTMLElement, Pick<ReviewObservation, "finding" | "usage">>();
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
      const chip = el("button", "anchor-chip", `${span.file.split("/").at(-1)}:${span.startLine}–${span.endLine}`);
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
    if (previous?.finding !== observation.finding) {
      card.querySelector(".finding")?.remove();
      if (observation.finding) card.append(renderFinding(observation.finding));
    }
    if (previous?.usage !== observation.usage) {
      card.querySelector(".usage-strip")?.remove();
      if (observation.usage) card.append(renderUsage(observation.usage));
    }
    cardResults.set(card, { finding: observation.finding, usage: observation.usage });
  }
});

function renderObservations() {
  $("#observation-count").textContent = String(state.observations.length);
  updateObservationList(state.observations);
}

function renderFinding(finding: Finding) {
  const box = el("div", "finding");
  const head = el("div", "finding-head");
  head.append(el("b", "", finding.severity), el("span", "", `${Math.round((finding.confidence || 0) * 100)}% confidence`));
  box.append(head, el("p", "", finding.summary));
  if (finding.suggestedComment) box.append(el("blockquote", "", finding.suggestedComment));
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

function jumpToSpan(span: CodeLocation) {
  const file = state.repository?.files.find((item) => item.path === span.file);
  if (!file) return;
  if (file !== state.activeFile) { state.activeFile = file; renderDiff(); }
  renderFiles();
  document.querySelector(".file-item.active")?.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll<HTMLElement>(".diff-line[data-line]")].find((item) => Number(item.dataset.line) >= span.startLine);
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
});

const searchPalette = new SearchPalette({
  trigger: $("#file-search"), dialog: $("#search-dialog"), input: $("#search-input"),
  results: $("#search-results"), status: $("#search-status"), onSelect: selectSearchResult
});

$("#open-repo").onclick = openRepository;
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
