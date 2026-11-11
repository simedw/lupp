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
  private generation = 0;
  private current: string | null = null;

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

  async setRepository(repository: string, reset = false) {
    if (repository === this.repository && !reset) return;
    const previous = this.session;
    // Invalidate before awaiting disposal: providers may still finish a stream,
    // and a session may even still be in the process of being created.
    this.generation++;
    this.repository = repository;
    this.session = null;
    this.pending = [];
    this.running = false;
    this.current = null;
    await previous?.dispose();
  }

  has(id: string) { return this.current === id || this.pending.some((item) => item.id === id); }

  // A note already with the agent runs to completion; its result is ignored by the caller.
  cancel(id: string) { this.pending = this.pending.filter((item) => item.id !== id); }

  enqueue(observation: ReviewObservation) {
    this.pending.push(observation);
    this.send({ id: observation.id, status: "queued", detail: `${this.pending.length} in analysis queue`, provider: this.adapter.id });
    void this.drain();
  }

  private async drain() {
    if (this.running || !this.repository) return;
    this.running = true;
    const generation = this.generation;
    while (generation === this.generation && this.pending.length) {
      const observation = this.pending.shift()!;
      this.current = observation.id;
      try { await this.analyze(observation, generation); }
      catch (error) {
        if (generation !== this.generation) return;
        this.send({
          id: observation.id,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          provider: this.adapter.id
        });
      } finally {
        if (generation === this.generation) this.current = null;
      }
    }
    if (generation === this.generation) this.running = false;
  }

  private async analyze(observation: ReviewObservation, generation: number) {
    if (!this.session) {
      const session = await this.adapter.createSession(this.repository);
      if (generation !== this.generation) { await session.dispose(); return; }
      this.session = session;
    }
    for await (const event of this.session.analyze(observation)) {
      if (generation !== this.generation) return;
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
