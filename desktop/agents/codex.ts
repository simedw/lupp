import type { Thread } from "@openai/codex-sdk";
import {
  findingSchema,
  parseFinding,
  reviewPrompt,
  type ImplementingAdapter,
  type ImplementEvent,
  type AgentEvent,
  type AgentSession,
  type ReviewObservation
} from "./types.js";

type CodexAdapterOptions = { codexPath: string | null; codexError?: string | null };

export class CodexAdapter implements ImplementingAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";

  constructor(private readonly options: CodexAdapterOptions) {}

  async probe() {
    return {
      provider: this.id,
      name: this.name,
      available: Boolean(this.options.codexPath),
      detail: this.options.codexPath || this.options.codexError || "Codex CLI not found"
    };
  }

  async createSession(repository: string): Promise<AgentSession> {
    if (!this.options.codexPath) {
      throw new Error(this.options.codexError || "Codex CLI not found. Install Codex or set REVIEW_VOICE_CODEX_PATH.");
    }
    const { Codex } = await import("@openai/codex-sdk");
    const thread = new Codex({ codexPathOverride: this.options.codexPath }).startThread({
      model: "gpt-6.1",
      workingDirectory: repository,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "low"
    });
    return new CodexSession(thread, this.options.codexPath);
  }

  async *implement(repository: string, brief: string): AsyncIterable<ImplementEvent> {
    if (!this.options.codexPath) {
      throw new Error(this.options.codexError || "Codex CLI not found. Install Codex or set REVIEW_VOICE_CODEX_PATH.");
    }
    yield { type: "progress", detail: "Starting Codex" };
    const { Codex } = await import("@openai/codex-sdk");
    // Writes are confined to the checkout; still no network or approvals.
    const thread = new Codex({ codexPathOverride: this.options.codexPath }).startThread({
      model: "gpt-6.1",
      workingDirectory: repository,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "medium"
    });
    const { events } = await thread.runStreamed(brief);
    let summary = "";
    for await (const event of events) {
      if (event.type === "item.completed" && event.item.type === "agent_message") summary = event.item.text;
      if (event.type === "item.completed" && event.item.type === "file_change") yield { type: "progress", detail: "Editing files" };
      if (event.type === "item.completed" && event.item.type === "command_execution") yield { type: "progress", detail: "Reading code and running checks" };
      if (event.type === "turn.failed") throw new Error(event.error.message || "Codex could not apply the action");
      if (event.type === "error") throw new Error(event.message || "Codex could not apply the action");
    }
    yield { type: "completed", summary: summary || "Codex finished without a summary." };
  }
}

class CodexSession implements AgentSession {
  constructor(private readonly thread: Thread, private readonly executable: string) {}

  async *analyze(observation: ReviewObservation): AsyncIterable<AgentEvent> {
    yield { type: "progress", detail: `Starting Codex via ${this.executable}` };
    const { events } = await this.thread.runStreamed(reviewPrompt(observation), { outputSchema: findingSchema });
    let finalResponse = "";
    let usage = null;
    for await (const event of events) {
      if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
      if (event.type === "turn.completed") {
        usage = {
          provider: "codex" as const,
          input_tokens: event.usage.input_tokens,
          cached_input_tokens: event.usage.cached_input_tokens,
          output_tokens: event.usage.output_tokens
        };
      }
      if (event.type === "item.completed" && event.item.type === "command_execution") {
        yield { type: "progress", detail: "Following code and tests" };
      }
      if (event.type === "turn.failed") throw new Error(event.error.message || "Codex analysis failed");
      if (event.type === "error") throw new Error(event.message || "Codex analysis failed");
    }
    if (!finalResponse) throw new Error("Codex returned no finding");
    yield { type: "completed", finding: parseFinding(finalResponse), usage };
  }

  async dispose() {}
}
