export type AgentProviderId = "codex" | "claude";

export type AttentionSpan = {
  file: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  cursorLine?: number | null;
  dwellMs: number;
};

export type ReviewObservation = {
  id: string;
  transcript: string;
  spans: AttentionSpan[];
  durationMs?: number;
  audioPath?: string;
  status?: "transcribing" | "saved" | "queued" | "investigating" | "ready" | "failed";
  detail?: string;
  provider?: AgentProviderId;
  finding?: Finding | null;
  usage?: AgentUsage | null;
  audioUrl?: string;
};

export type Finding = {
  severity: "resolved" | "concern" | "question";
  summary: string;
  confidence: number;
  worthRaising: boolean;
  evidence: Array<{ file: string; startLine: number; endLine: number; reason: string }>;
  suggestedComment: string;
};

export type AgentUsage = {
  provider: AgentProviderId;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
};

export type AgentAvailability = {
  provider: AgentProviderId;
  name: string;
  available: boolean;
  detail: string;
};

export type AgentEvent =
  | { type: "progress"; detail: string }
  | { type: "completed"; finding: Finding; usage: AgentUsage | null };

export interface AgentSession {
  analyze(observation: ReviewObservation): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: AgentProviderId;
  readonly name: string;
  probe(): Promise<AgentAvailability>;
  createSession(repository: string): Promise<AgentSession>;
}

export const findingSchema = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["resolved", "concern", "question"] },
    summary: { type: "string" },
    confidence: { type: "number" },
    worthRaising: { type: "boolean" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          reason: { type: "string" }
        },
        required: ["file", "startLine", "endLine", "reason"],
        additionalProperties: false
      }
    },
    suggestedComment: { type: "string" }
  },
  required: ["severity", "summary", "confidence", "worthRaising", "evidence", "suggestedComment"],
  additionalProperties: false
} as const;

export function reviewPrompt(observation: ReviewObservation): string {
  const anchors = observation.spans
    .map((span) => `- ${span.file}:${span.startLine}-${span.endLine} (${span.dwellMs}ms attention${span.cursorLine ? `, cursor near ${span.cursorLine}` : ""})`)
    .join("\n");
  return `Investigate this spoken code-review observation in the checked-out repository. Do not modify files. Follow relevant call sites and tests. Decide whether the concern is supported by the code.\n\nObservation ${observation.id}: ${JSON.stringify(observation.transcript)}\nAttention spans:\n${anchors || "- No reliable code span captured"}\n\nReturn the requested structured finding. Evidence must use repository-relative paths and precise line ranges.`;
}

export function parseFinding(value: unknown): Finding {
  const parsed = typeof value === "string"
    ? JSON.parse(value.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || value)
    : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Agent returned an invalid finding");
  return parsed as Finding;
}
