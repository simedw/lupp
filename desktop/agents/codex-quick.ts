import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { quickPrompt, quickSystemPrompt, serialQueue, type QuickAnswerer, type QuickEvent, type ReviewObservation } from "./types.js";

// Bound how much earlier code the conversation carries.
const TURNS_PER_THREAD = 25;
const TURN_TIMEOUT_MS = 45_000;

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message?: string } };
type Turn = { push(event: QuickEvent): void; finish(error?: Error): void };

// `codex exec` starts a process per question and reports an answer only once it
// is complete. The app server stays running, keeps the conversation, and
// streams the answer as it is written, which is where the seconds go.
export class CodexQuickAnswerer implements QuickAnswerer {
  private readonly acquire = serialQueue();
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private threadId: string | null = null;
  private turns = 0;
  private turn: Turn | null = null;
  private disposed = false;

  constructor(private readonly command: string, private readonly args: string[], private readonly repository: string) {}

  // Opening the process and thread ahead of the first note takes them off its clock.
  warm() {
    void this.acquire().then(async (release) => {
      try { if (!this.disposed) await this.open(); } catch { this.close(); } finally { release(); }
    });
  }

  private request(method: string, params: unknown): Promise<any> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("Codex is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private receive(message: Message) {
    if (message.id !== undefined && !message.method) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message || "Codex refused the request"));
      else waiting?.resolve(message.result);
      return;
    }
    // A quick answer never gets approvals or input; refuse instead of hanging.
    if (message.id !== undefined) {
      this.child?.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Not available for quick answers" } })}\n`);
      return;
    }
    if (message.params?.threadId && message.params.threadId !== this.threadId) return;
    if (message.method === "item/agentMessage/delta" && typeof message.params?.delta === "string") {
      this.turn?.push({ type: "delta", text: message.params.delta });
    } else if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      this.turn?.finish(turn?.status === "completed" ? undefined : new Error(readableError(turn?.error?.message) || "Codex could not answer"));
    }
  }

  private fail(error: Error) {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.turn?.finish(error);
  }

  private async open() {
    if (!this.child) {
      const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.stdin!.on("error", () => {});
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (this.child !== child) return;
        try { this.receive(JSON.parse(line)); } catch { /* not protocol output */ }
      });
      const ended = (error: Error) => {
        if (this.child !== child) return;
        this.child = null;
        this.threadId = null;
        this.fail(error);
      };
      child.on("error", (error) => ended(error));
      child.on("exit", () => ended(new Error(`Codex stopped unexpectedly${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)));
      await this.request("initialize", { clientInfo: { name: "lupp", title: "Lupp", version: "1" } });
      child.stdin!.write(`${JSON.stringify({ method: "initialized" })}\n`);
    }
    if (!this.threadId) {
      const started = await this.request("thread/start", {
        cwd: this.repository,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        // Replaces the coding-agent instructions: nothing here needs them.
        baseInstructions: quickSystemPrompt
      });
      this.threadId = started.thread.id;
      this.turns = 0;
    }
  }

  private close() {
    const child = this.child;
    this.child = null;
    this.threadId = null;
    child?.kill();
    this.fail(new Error("Quick answers were stopped"));
  }

  async *answer(observation: ReviewObservation): AsyncIterable<QuickEvent> {
    const release = await this.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.disposed) throw new Error("Quick answers were stopped");
      if (this.turns >= TURNS_PER_THREAD) this.threadId = null;
      await this.open();
      this.turns += 1;

      const events: QuickEvent[] = [];
      let done = false;
      let failure: Error | undefined;
      let wake: (() => void) | null = null;
      this.turn = {
        push: (event) => { events.push(event); wake?.(); },
        finish: (error) => { done = true; failure ||= error; wake?.(); }
      };
      timer = setTimeout(() => this.turn?.finish(new Error("Codex took too long to answer")), TURN_TIMEOUT_MS);
      this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text: quickPrompt(observation) }], effort: "low" })
        .catch((error) => this.turn?.finish(error));

      let text = "";
      while (true) {
        const event = events.shift();
        if (event) {
          if (event.type === "delta") text += event.text;
          yield event;
        } else if (done) break;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      if (failure) throw failure;
      if (!text.trim()) throw new Error("Codex returned no answer");
      yield { type: "completed", text: text.trim() };
    } catch (error) {
      // Start clean next time rather than reuse a conversation in an unknown state.
      this.turn = null;
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      this.turn = null;
      release();
    }
  }

  async dispose() {
    this.disposed = true;
    this.close();
  }
}

// The server wraps API errors as JSON inside the message.
function readableError(message: unknown) {
  if (typeof message !== "string") return "";
  try { return JSON.parse(message)?.error?.message || message; } catch { return message; }
}
