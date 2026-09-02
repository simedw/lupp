import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  findingSchema,
  parseFinding,
  reviewPrompt,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type AgentUsage,
  type ReviewObservation
} from "./types.js";

type ClaudeAdapterOptions = { apiKey?: string };

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude";

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async probe() {
    const authenticated = Boolean(this.options.apiKey || process.env.ANTHROPIC_API_KEY);
    return {
      provider: this.id,
      name: this.name,
      available: true,
      detail: authenticated ? "Agent SDK ready; API key configured" : "Agent SDK ready; will use existing Claude authentication"
    };
  }

  async createSession(repository: string): Promise<AgentSession> {
    return new ClaudeSession(repository, this.options.apiKey);
  }
}

class ClaudeSession implements AgentSession {
  private sessionId: string | undefined;

  constructor(private readonly repository: string, private readonly apiKey?: string) {}

  async *analyze(observation: ReviewObservation): AsyncIterable<AgentEvent> {
    yield { type: "progress", detail: this.sessionId ? "Continuing Claude review session" : "Starting Claude Agent SDK" };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let result: SDKResultMessage | null = null;
    const env = this.apiKey
      ? { ...process.env, ANTHROPIC_API_KEY: this.apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: "lupp/0.5.1" }
      : { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "lupp/0.5.1" };

    for await (const message of query({
      prompt: reviewPrompt(observation),
      options: {
        cwd: this.repository,
        resume: this.sessionId,
        env,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "You are investigating spoken code-review observations. Operate read-only and return concise, evidence-backed structured findings."
        },
        settingSources: ["project"],
        tools: ["Read", "Grep", "Glob"],
        allowedTools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
        permissionMode: "dontAsk",
        maxTurns: 12,
        outputFormat: { type: "json_schema", schema: findingSchema }
      }
    })) {
      if (message.type === "assistant" && message.message.content.some((block) => block.type === "tool_use")) {
        yield { type: "progress", detail: "Following code and tests" };
      }
      if (message.type === "result") result = message;
    }

    if (!result) throw new Error("Claude returned no result");
    this.sessionId = result.session_id;
    if (result.subtype !== "success") throw new Error(result.errors.join("; ") || `Claude analysis failed (${result.subtype})`);
    if (result.is_error) throw new Error(result.result || "Claude analysis failed");

    const totals = Object.values(result.modelUsage).reduce(
      (usage, model) => ({
        input_tokens: usage.input_tokens + model.inputTokens,
        cached_input_tokens: usage.cached_input_tokens + model.cacheReadInputTokens,
        output_tokens: usage.output_tokens + model.outputTokens
      }),
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
    );
    const usage: AgentUsage = { provider: "claude", ...totals, cost_usd: result.total_cost_usd };
    yield { type: "completed", finding: parseFinding(result.structured_output ?? result.result), usage };
  }

  async dispose() {}
}
