import type { AnalysisUpdate } from "./agent-queue.js";
import type { AgentAvailability, AgentProviderId, ReviewObservation } from "./agents/types.js";

export type DiffLine = { type: "add" | "delete" | "context" | "meta"; oldLine: number | null; newLine: number | null; text: string };
export type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; heading: string; lines: DiffLine[] };
export type DiffFile = { oldPath: string; path: string; status: "modified" | "added" | "deleted" | "renamed"; hunks: DiffHunk[]; additions: number; deletions: number; binary?: boolean };
export type ReviewMetadata = { repository: string; branch: string; baseRef: string; baseSha?: string; headSha?: string };
export type Repository = ReviewMetadata & { name: string; files: DiffFile[]; review: { observations: ReviewObservation[]; file: string } };
export type AttentionSample = { t: number; file: string; side: "LEFT" | "RIGHT"; visibleStart: number; visibleEnd: number; cursorLine: number | null };
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
  getSettings(): Promise<Settings>;
  saveSettings(settings: SettingsInput): Promise<Settings>;
  startSession(metadata: ReviewMetadata): Promise<{ id: string; startedAt: string; agentProvider: AgentProviderId }>;
  saveAndTranscribe(payload: { id: string; wavBase64: string }): Promise<
    { status: "needs-key"; audioPath: string } | { status: "transcribed"; audioPath: string; transcript: string }
  >;
  enqueueAnalysis(observation: ReviewObservation): Promise<{ status: "queued"; provider: AgentProviderId }>;
  updateObservation(observation: { id: string; transcript: string }): Promise<{ status: "saved" }>;
  deleteObservation(id: string): Promise<{ status: "deleted" }>;
  onAnalysisUpdate(callback: (update: AnalysisUpdate) => void): () => void;
};

declare global {
  interface Window { reviewAPI: ReviewAPI }
}
