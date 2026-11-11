import type { AnalysisUpdate } from "./agent-queue.js";
import type { AgentAvailability, AgentProviderId, ReviewObservation } from "./agents/types.js";
import type { ActionSelection } from "./actions.js";

export type DiffLine = { type: "add" | "delete" | "context" | "meta"; oldLine: number | null; newLine: number | null; text: string };
export type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; heading: string; lines: DiffLine[] };
export type DiffSource = "branch" | "staged" | "unstaged" | "untracked";
export type RepositoryChange = { repository: string; sources: DiffSource[]; mode: "native" | "fallback" };
export type DiffFile = { oldPath: string; path: string; status: "modified" | "added" | "deleted" | "renamed"; hunks: DiffHunk[]; additions: number; deletions: number; binary?: boolean; previewMessage?: string; contentHash?: string; reviewId?: string };
export type ReviewedFile = { path: string; source: DiffSource; reviewId: string };
export type DiffSnapshot = { files: DiffFile[]; diffSource: DiffSource; snapshotId: string; capturedAt: string; baseSha: string; headSha: string };
export type ReviewMetadata = { repository: string; branch: string; baseRef: string; baseSha?: string; headSha?: string };
export type Repository = ReviewMetadata & Partial<DiffSnapshot> & { name: string; files: DiffFile[]; review: { observations: ReviewObservation[]; file: string; reviewedFiles?: ReviewedFile[] } };
export type AttentionSample = { t: number; file: string; side: "LEFT" | "RIGHT"; visibleStart: number; visibleEnd: number; cursorLine: number | null; source?: DiffSource; snapshotId?: string };
export type Settings = {
  apiKeyConfigured: boolean;
  apiKeyError?: string | null;
  anthropicApiKeyConfigured: boolean;
  anthropicApiKeyError?: string | null;
  agentProvider: AgentProviderId;
  availability: AgentAvailability[];
};
export type SettingsInput = { agentProvider: AgentProviderId; openaiApiKey: string; anthropicApiKey: string };
export type ReviewAPI = {
  chooseRepository(): Promise<Repository | null>;
  initialRepository(): Promise<Repository | null>;
  loadDiff(source: DiffSource): Promise<DiffSnapshot>;
  setFileReviewed(file: ReviewedFile & { reviewed: boolean }): Promise<{ reviewedFiles: ReviewedFile[] }>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: SettingsInput): Promise<Settings>;
  startSession(metadata: ReviewMetadata): Promise<{ id: string; startedAt: string; agentProvider: AgentProviderId }>;
  saveAndTranscribe(payload: { id: string; wavBase64: string }): Promise<
    { status: "needs-key"; audioPath: string } | { status: "transcribed"; audioPath: string; transcript: string }
  >;
  enqueueAnalysis(observation: ReviewObservation): Promise<{ status: "queued"; provider: AgentProviderId }>;
  updateObservation(observation: { id: string; transcript: string }): Promise<{ status: "saved" }>;
  deleteObservation(id: string): Promise<{ status: "deleted" }>;
  dismissAction(selection: ActionSelection & { dismissed: boolean }): Promise<{ dismissedActionKeys: string[] }>;
  copyActions(selection?: ActionSelection): Promise<{ count: number }>;
  onRepositoryChange(callback: (change: RepositoryChange) => void): () => void;
  onAnalysisUpdate(callback: (update: AnalysisUpdate) => void): () => void;
};

declare global {
  interface Window { reviewAPI: ReviewAPI }
}
