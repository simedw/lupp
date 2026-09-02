import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findInitialRepository, inspectRepository, loadRepositoryDiff } from "./git.js";
import { safeSegmentId } from "./lib.js";
import { AgentReviewQueue, type AnalysisUpdate } from "./agent-queue.js";
import { CodexAdapter } from "./agents/codex.js";
import { ClaudeAdapter } from "./agents/claude.js";
import type { AgentAdapter, AgentProviderId, ReviewObservation } from "./agents/types.js";
import { resolveCodexExecutable } from "./codex-path.js";
import { loadReview, saveReview } from "./review-store.js";
import { keySettings, unlockSecret } from "./secrets.js";
import type { ReviewMetadata, SettingsInput } from "./types.js";

type Config = {
  apiKey?: string;
  anthropicApiKey?: string;
  agentProvider?: AgentProviderId;
};

type ActiveReview = { metadata: ReviewMetadata; observations: ReviewObservation[] };
type ActiveSession = {
  id: string;
  root: string;
  metadata: ReviewMetadata;
  observations: ReviewObservation[];
  startedAt: string;
};

let mainWindow: BrowserWindow | null = null;
let activeSession: ActiveSession | null = null;
let activeReview: ActiveReview | null = null;
let queue: AgentReviewQueue;
let adapters: Record<AgentProviderId, AgentAdapter>;
let codexPath: string | null = null;
let codexError: string | null = null;
let reviewWrite = Promise.resolve();

app.setName("Lupp");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function desktopAsset(relativePath: string) {
  return path.join(projectRoot, "desktop", relativePath);
}

function configFile() { return path.join(app.getPath("userData"), "config.json"); }
function legacyConfigFile() { return path.join(app.getPath("appData"), "Review Voice Desk", "config.json"); }

async function readConfig(): Promise<Config> {
  try { return JSON.parse(await readFile(configFile(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { return JSON.parse(await readFile(legacyConfigFile(), "utf8")); }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw legacyError;
      }
    }
    throw error;
  }
}

async function writeConfig(config: Config) {
  await mkdir(path.dirname(configFile()), { recursive: true });
  await writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function encryptSecret(value: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure key storage is unavailable on this computer");
  return safeStorage.encryptString(value).toString("base64");
}

async function getOpenAiApiKey() {
  const secret = unlockSecret(safeStorage, (await readConfig()).apiKey, "OpenAI transcription key");
  if (secret.error) throw new Error(secret.error);
  return secret.value;
}

async function createAdapters(config: Config): Promise<Record<AgentProviderId, AgentAdapter>> {
  const secret = unlockSecret(safeStorage, config.anthropicApiKey, "Anthropic key");
  return {
    codex: new CodexAdapter({ codexPath, codexError }),
    // An unreadable optional key must not prevent the app/settings from opening,
    // nor silently switch Claude to a different billing credential.
    claude: secret.error ? {
      id: "claude",
      name: "Claude",
      async probe() { return { provider: "claude", name: "Claude", available: false, detail: secret.error! }; },
      async createSession() { throw new Error(secret.error!); }
    } : new ClaudeAdapter({ apiKey: secret.value || undefined })
  };
}

function persistActiveReview() {
  if (!activeReview) return reviewWrite;
  const review = activeReview;
  const sessionSnapshot = activeSession;
  reviewWrite = reviewWrite.catch(() => {}).then(async () => {
    await saveReview(review.metadata, review.observations);
    if (sessionSnapshot) {
      sessionSnapshot.observations = review.observations;
      await writeFile(path.join(sessionSnapshot.root, "session.json"), `${JSON.stringify(sessionSnapshot, null, 2)}\n`, { mode: 0o600 });
    }
  });
  return reviewWrite;
}

async function loadRepository(repository: string, requestedBaseRef?: string) {
  const metadata = await inspectRepository(repository);
  const baseRef = requestedBaseRef || metadata.baseRef;
  const diff = await loadRepositoryDiff(metadata.repository, baseRef);
  const reviewMetadata = { ...metadata, baseRef };
  const review = await loadReview(reviewMetadata);
  activeReview = { metadata: reviewMetadata, observations: review.observations };
  activeSession = null;
  await queue.setRepository(metadata.repository);
  return { ...metadata, baseRef, ...diff, review: { observations: review.observations, file: review.file }, source: undefined };
}

function handleAnalysisUpdate(update: AnalysisUpdate) {
  const observation = activeReview?.observations.find((item) => item.id === update.id);
  if (observation) {
    observation.status = update.status;
    observation.detail = update.detail || "";
    observation.provider = update.provider;
    if (update.finding) observation.finding = update.finding;
    if (update.usage) observation.usage = update.usage;
    persistActiveReview().catch((error) => console.error(`[review-store] ${error.message}`));
  }
  mainWindow?.webContents.send("analysis:update", update);
}

async function createWindow() {
  try { codexPath = await resolveCodexExecutable(); }
  catch (error) { codexError = error instanceof Error ? error.message : String(error); }
  const config = await readConfig();
  adapters = await createAdapters(config);
  const provider = config.agentProvider === "claude" ? "claude" : "codex";
  queue = new AgentReviewQueue(handleAnalysisUpdate, adapters[provider]);

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#11130f",
    webPreferences: {
      preload: path.join(projectRoot, "dist", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await mainWindow.loadFile(desktopAsset("index.html"));
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(`[renderer] ${details.message}`);
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const trusted = contents.getURL().startsWith("file:");
    callback(trusted && permission === "media");
  });
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("repository:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose a checked-out Git repository",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return loadRepository(result.filePaths[0]);
});

ipcMain.handle("repository:initial", async () => {
  const repository = await findInitialRepository();
  if (!repository) return null;
  return loadRepository(repository, process.env.REVIEW_VOICE_BASE_REF);
});

ipcMain.handle("settings:get", async () => {
  const config = await readConfig();
  const availability = await Promise.all(Object.values(adapters).map((adapter) => adapter.probe()));
  return {
    ...keySettings(safeStorage, config, Boolean(process.env.ANTHROPIC_API_KEY)),
    agentProvider: queue.provider,
    availability
  };
});

ipcMain.handle("settings:save", async (_event, payload: SettingsInput) => {
  const provider: AgentProviderId = payload.agentProvider === "claude" ? "claude" : "codex";
  const config = await readConfig();
  const openaiApiKey = String(payload.openaiApiKey || "").trim();
  const anthropicApiKey = String(payload.anthropicApiKey || "").trim();
  if (openaiApiKey) config.apiKey = encryptSecret(openaiApiKey);
  if (anthropicApiKey) config.anthropicApiKey = encryptSecret(anthropicApiKey);
  config.agentProvider = provider;

  const nextAdapters = await createAdapters(config);
  await queue.setAdapter(nextAdapters[provider]);
  adapters = nextAdapters;
  await writeConfig(config);
  return {
    ...keySettings(safeStorage, config, Boolean(process.env.ANTHROPIC_API_KEY)),
    agentProvider: provider,
    availability: await Promise.all(Object.values(adapters).map((adapter) => adapter.probe()))
  };
});

ipcMain.handle("session:start", async (_event, metadata: ReviewMetadata) => {
  if (!metadata?.repository) throw new Error("Open a repository first");
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(app.getPath("userData"), "sessions", id);
  await mkdir(path.join(root, "audio"), { recursive: true });
  if (!activeReview || activeReview.metadata.repository !== metadata.repository || activeReview.metadata.branch !== metadata.branch) {
    const review = await loadReview(metadata);
    activeReview = { metadata, observations: review.observations };
  }
  activeSession = { id, root, metadata, observations: activeReview.observations, startedAt: new Date().toISOString() };
  await writeFile(path.join(root, "session.json"), `${JSON.stringify(activeSession, null, 2)}\n`, { mode: 0o600 });
  await queue.setRepository(metadata.repository);
  return { id, startedAt: activeSession.startedAt, agentProvider: queue.provider };
});

ipcMain.handle("segment:transcribe", async (_event, payload: { id: string; wavBase64: string }) => {
  if (!activeSession) throw new Error("Start a review session first");
  const id = safeSegmentId(payload.id);
  const audio = Buffer.from(payload.wavBase64, "base64");
  if (!audio.length || audio.length > 25 * 1024 * 1024) throw new Error("Invalid or oversized audio segment");
  const audioPath = path.join(activeSession.root, "audio", `${id}.wav`);
  await writeFile(audioPath, audio, { mode: 0o600 });
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return { status: "needs-key", audioPath };
  const body = new FormData();
  body.append("model", "gpt-transcribe");
  body.append("file", new Blob([audio], { type: "audio/wav" }), `${id}.wav`);
  body.append("prompt", "A spoken software code review. Preserve file names, function names, technical terminology, and code identifiers.");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body
  });
  const result = await response.json().catch(() => ({})) as { text?: string; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(response.status === 401 ? "OpenAI rejected the API key" : result.error?.message || `Transcription failed (${response.status})`);
  }
  return { status: "transcribed", transcript: String(result.text || "").trim(), audioPath };
});

ipcMain.handle("analysis:enqueue", async (_event, observation: ReviewObservation) => {
  if (!activeSession || !activeReview) throw new Error("Start a review session first");
  const clean = { ...observation, id: safeSegmentId(observation.id), provider: queue.provider };
  const existing = activeReview.observations.findIndex((item) => item.id === clean.id);
  if (existing === -1) activeReview.observations.push(clean);
  else activeReview.observations[existing] = clean;
  await persistActiveReview();
  queue.enqueue(clean);
  return { status: "queued", provider: queue.provider };
});

ipcMain.handle("observation:update", async (_event, observation: { id: string; transcript: string }) => {
  if (!activeReview) throw new Error("Open a repository first");
  const id = safeSegmentId(observation.id);
  const existing = activeReview.observations.find((item) => item.id === id);
  if (!existing) throw new Error(`Observation ${id} was not found`);
  existing.transcript = String(observation.transcript || "");
  await persistActiveReview();
  return { status: "saved" };
});

ipcMain.handle("observation:delete", async (_event, idValue: string) => {
  if (!activeReview) throw new Error("Open a repository first");
  const id = safeSegmentId(idValue);
  activeReview.observations = activeReview.observations.filter((item) => item.id !== id);
  if (activeSession) activeSession.observations = activeReview.observations;
  await persistActiveReview();
  return { status: "deleted" };
});
