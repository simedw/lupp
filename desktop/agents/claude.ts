import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import {
  findingSchema,
  parseFinding,
  reviewPrompt,
  quickPrompt,
  quickSystemPrompt,
  serialQueue,
  type ImplementingAdapter,
  type ImplementEvent,
  type QuickAnswerer,
  type QuickEvent,
  type AgentEvent,
  type AgentSession,
  type AgentUsage,
  type ReviewObservation
} from "./types.js";

type ClaudeAdapterOptions = { apiKey?: string };
const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const clientApp = `lupp/${version}`;

export class ClaudeAdapter implements ImplementingAdapter {
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

  createQuickAnswerer(repository: string): QuickAnswerer {
    return new ClaudeQuickAnswerer(repository, this.options.apiKey);
  }

  async *implement(repository: string, brief: string): AsyncIterable<ImplementEvent> {
    yield { type: "progress", detail: "Starting Claude" };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let result: SDKResultMessage | null = null;
    // File tools only: edits are accepted inside the checkout, with no shell or network.
    for await (const message of query({
      prompt: brief,
      options: {
        cwd: repository,
        env: agentEnv(this.options.apiKey),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "You are implementing code-review actions the reviewer approved. Make the smallest change that satisfies each action."
        },
        settingSources: ["project"],
        tools: ["Read", "Grep", "Glob", "Edit", "Write"],
        allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
        disallowedTools: ["Bash", "NotebookEdit", "WebFetch", "WebSearch"],
        permissionMode: "acceptEdits",
        maxTurns: 40
      }
    })) {
      if (message.type === "assistant") {
        const edit = message.message.content.find((block) => block.type === "tool_use" && (block.name === "Edit" || block.name === "Write"));
        if (edit) yield { type: "progress", detail: "Editing files" };
        else if (message.message.content.some((block) => block.type === "tool_use")) yield { type: "progress", detail: "Reading code" };
      }
      if (message.type === "result") result = message;
    }
    if (!result) throw new Error("Claude returned no result");
    if (result.subtype !== "success") throw new Error(result.errors.join("; ") || `Claude could not apply the action (${result.subtype})`);
    if (result.is_error) throw new Error(result.result || "Claude could not apply the action");
    yield { type: "completed", summary: result.result };
  }
}

function agentEnv(apiKey?: string) {
  return apiKey
    ? { ...process.env, ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp }
    : { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp };
}

class ClaudeSession implements AgentSession {
  private sessionId: string | undefined;

  constructor(private readonly repository: string, private readonly apiKey?: string) {}

  async *analyze(observation: ReviewObservation): AsyncIterable<AgentEvent> {
    yield { type: "progress", detail: this.sessionId ? "Continuing Claude review session" : "Starting Claude Agent SDK" };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let result: SDKResultMessage | null = null;
    const env = agentEnv(this.apiKey);

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

// A small model with no tools, kept running between notes: starting the agent
// process is most of a cold answer's wait, so only the first note pays it.
const QUICK_MODEL = "claude-haiku-5-5";
const QUICK_TURNS_PER_SESSION = 25;

class ClaudeQuickAnswerer implements QuickAnswerer {
  private readonly acquire = serialQueue();
  private stream: Query | null = null;
  private messages: AsyncIterator<SDKMessage> | null = null;
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private turns = 0;
  private disposed = false;

  constructor(private readonly repository: string, private readonly apiKey?: string) {}

  private async *input(stream: { closed: boolean }): AsyncGenerator<SDKUserMessage> {
    while (!stream.closed) {
      const next = this.pending.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private state: { closed: boolean } | null = null;

  private async open() {
    if (this.messages) return;
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    this.state = { closed: false };
    this.stream = query({
      prompt: this.input(this.state),
      options: {
        cwd: this.repository,
        env: agentEnv(this.apiKey),
        model: QUICK_MODEL,
        systemPrompt: quickSystemPrompt,
        settingSources: [],
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        includePartialMessages: true
      }
    });
    this.messages = this.stream[Symbol.asyncIterator]();
    this.turns = 0;
  }

  private close() {
    if (this.state) this.state.closed = true;
    this.wake?.();
    this.stream?.close();
    this.stream = null;
    this.messages = null;
    this.pending = [];
  }

  async *answer(observation: ReviewObservation): AsyncIterable<QuickEvent> {
    const release = await this.acquire();
    try {
      if (this.disposed) throw new Error("Quick answers were stopped");
      // Bound how much earlier code the conversation carries.
      if (this.turns >= QUICK_TURNS_PER_SESSION) this.close();
      await this.open();
      this.turns += 1;
      this.pending.push({ type: "user", message: { role: "user", content: quickPrompt(observation) }, parent_tool_use_id: null });
      this.wake?.();
      let text = "";
      for (;;) {
        const { value: message, done } = await this.messages!.next();
        if (done) throw new Error("Claude stopped before answering");
        if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
          text += message.event.delta.text;
          yield { type: "delta", text: message.event.delta.text };
        }
        if (message.type !== "result") continue;
        if (message.subtype !== "success") throw new Error(message.errors.join("; ") || `Claude could not answer (${message.subtype})`);
        if (message.is_error) throw new Error(message.result || "Claude could not answer");
        yield { type: "completed", text: (message.result || text).trim() };
        return;
      }
    } catch (error) {
      // A broken stream cannot be trusted with the next note.
      this.close();
      throw error;
    } finally { release(); }
  }

  async dispose() {
    this.disposed = true;
    this.close();
  }
}
