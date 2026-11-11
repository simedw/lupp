import type { AnalysisUpdate } from "./agent-queue.js";
import type { ActionState, AgentAvailability, AgentProviderId, QuickAnswer, ReviewObservation } from "./agents/types.js";
import type { ActionSelection } from "./actions.js";

export type DiffLine = { type: "add" | "delete" | "context" | "meta"; oldLine: number | null; newLine: number | null; text: string };
export type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; heading: string; lines: DiffLine[] };
export type DiffSource = "branch" | "local" | "staged" | "unstaged" | "untracked";
export type RepositoryChange = { repository: string; sources: DiffSource[]; mode: "native" | "fallback" };
export type DiffFile = { oldPath: string; path: string; status: "modified" | "added" | "deleted" | "renamed"; hunks: DiffHunk[]; additions: number; deletions: number; binary?: boolean; previewMessage?: string; contentHash?: string; reviewId?: string };
export type ReviewedFile = { path: string; source: DiffSource; reviewId: string };
export type DiffSnapshot = { files: DiffFile[]; diffSource: DiffSource; snapshotId: string; capturedAt: string; baseSha: string; headSha: string };
// Returned instead of a snapshot when the checkout moved to another branch:
// notes are stored per branch, so the renderer reloads rather than refreshes.
export type BranchChanged = { branchChanged: true; branch: string };
export type ReviewMetadata = { repository: string; branch: string; baseRef: string; baseSha?: string; headSha?: string };
export type Repository = ReviewMetadata & Partial<DiffSnapshot> & { name: string; files: DiffFile[]; review: { observations: ReviewObservation[]; file: string; reviewedFiles?: ReviewedFile[] } };
export type AttentionSample = { t: number; file: string; side: "LEFT" | "RIGHT"; visibleStart: number; visibleEnd: number; cursorLine: number | null; source?: DiffSource; snapshotId?: string };
export type Settings = {
  apiKeyConfigured: boolean;
  apiKeyError?: string | null;
  anthropicApiKeyConfigured: boolean;
  anthropicApiKeyError?: string | null;
  agentProvider: AgentProviderId;
  quickAnswers: QuickSetting;
  availability: AgentAvailability[];
};
// Who gives the fast first reply: the review agent, a named one, or nobody.
export type QuickSetting = "same" | AgentProviderId | "off";
export type QuickUpdate = { id: string; quick: QuickAnswer; timings?: ReviewObservation["timings"] };
export type SettingsInput = { agentProvider: AgentProviderId; quickAnswers: QuickSetting; openaiApiKey: string; anthropicApiKey: string };
export type ActionUpdate = { observationId: string; actionKey: string; state: ActionState };
export type ReviewAPI = {
  chooseRepository(): Promise<Repository | null>;
  initialRepository(): Promise<Repository | null>;
  loadDiff(source: DiffSource): Promise<DiffSnapshot | BranchChanged>;
  reloadRepository(): Promise<Repository>;
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
  rerunAnalysis(id: string): Promise<{ status: "queued"; provider: AgentProviderId }>;
  replyToFinding(payload: { id: string; text: string }): Promise<{ status: "queued"; provider: AgentProviderId; replies: NonNullable<ReviewObservation["replies"]> }>;
  applyAction(selection: ActionSelection): Promise<{ state: ActionState }>;
  onActionUpdate(callback: (update: ActionUpdate) => void): () => void;
  onQuickUpdate(callback: (update: QuickUpdate) => void): () => void;
  dismissAction(selection: ActionSelection & { dismissed: boolean }): Promise<{ dismissedActionKeys: string[] }>;
  copyActions(selection?: ActionSelection): Promise<{ count: number }>;
  onRepositoryChange(callback: (change: RepositoryChange) => void): () => void;
  onAnalysisUpdate(callback: (update: AnalysisUpdate) => void): () => void;
};

declare global {
  interface Window { reviewAPI: ReviewAPI }
}
