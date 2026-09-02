import type { AgentAdapter, AgentProviderId, AgentSession, AgentUsage, Finding, ReviewObservation } from "./agents/types.js";

export type AnalysisUpdate = {
  id: string;
  status: "queued" | "investigating" | "ready" | "failed";
  detail?: string;
  finding?: Finding;
  usage?: AgentUsage | null;
  provider?: AgentProviderId;
};

export class AgentReviewQueue {
  private pending: ReviewObservation[] = [];
  private running = false;
  private session: AgentSession | null = null;
  private repository = "";

  constructor(
    private readonly send: (update: AnalysisUpdate) => void,
    private adapter: AgentAdapter
  ) {}

  get provider() { return this.adapter.id; }

  async setAdapter(adapter: AgentAdapter) {
    if (this.running || this.pending.length) throw new Error("Wait for queued observations before changing agent");
    await this.session?.dispose();
    this.session = null;
    this.adapter = adapter;
  }

  async setRepository(repository: string) {
    if (repository === this.repository) return;
    await this.session?.dispose();
    this.repository = repository;
    this.session = null;
    this.pending = [];
  }

  enqueue(observation: ReviewObservation) {
    this.pending.push(observation);
    this.send({ id: observation.id, status: "queued", detail: `${this.pending.length} in analysis queue`, provider: this.adapter.id });
    void this.drain();
  }

  private async drain() {
    if (this.running || !this.repository) return;
    this.running = true;
    while (this.pending.length) {
      const observation = this.pending.shift()!;
      try { await this.analyze(observation); }
      catch (error) {
        this.send({
          id: observation.id,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          provider: this.adapter.id
        });
      }
    }
    this.running = false;
  }

  private async analyze(observation: ReviewObservation) {
    if (!this.session) this.session = await this.adapter.createSession(this.repository);
    for await (const event of this.session.analyze(observation)) {
      if (event.type === "progress") {
        this.send({ id: observation.id, status: "investigating", detail: event.detail, provider: this.adapter.id });
      } else {
        this.send({ id: observation.id, status: "ready", finding: event.finding, usage: event.usage, provider: this.adapter.id });
        return;
      }
    }
    throw new Error("Agent stopped without returning a finding. Please try again.");
  }
}
