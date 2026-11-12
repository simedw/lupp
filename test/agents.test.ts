import test from "node:test";
import assert from "node:assert/strict";
import { AgentReviewQueue, type AnalysisUpdate } from "../desktop/agent-queue.js";
import { parseFinding, reviewPrompt, type AgentAdapter, type Finding } from "../desktop/agents/types.js";
import { CodexQuickAnswerer } from "../desktop/agents/codex-quick.js";
import type { QuickEvent } from "../desktop/agents/types.js";

const finding: Finding = {
  severity: "question",
  summary: "Check the boundary",
  confidence: 0.8,
  worthRaising: true,
  evidence: [{ file: "src/a.ts", startLine: 12, endLine: 14, reason: "The value crosses the boundary" }],
  suggestedComment: "Should this be validated?"
};

test("agent queue reuses a provider session and normalizes updates", async () => {
  const updates: AnalysisUpdate[] = [];
  let sessions = 0;
  const adapter: AgentAdapter = {
    id: "claude",
    name: "Claude",
    async probe() { return { provider: "claude", name: "Claude", available: true, detail: "ready" }; },
    async createSession() {
      sessions += 1;
      return {
        async *analyze() {
          yield { type: "progress", detail: "Reading code" };
          yield { type: "completed", finding, usage: { provider: "claude", input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, cost_usd: 0.01 } };
        },
        async dispose() {}
      };
    }
  };
  const completed = new Promise<void>((resolve) => {
    const queue = new AgentReviewQueue((update) => {
      updates.push(update);
      if (updates.filter((item) => item.status === "ready").length === 2) resolve();
    }, adapter);
    queue.setRepository("/tmp/repository").then(() => {
      queue.enqueue({ id: "n1", transcript: "first", spans: [] });
      queue.enqueue({ id: "n2", transcript: "second", spans: [] });
    });
  });
  await completed;
  assert.equal(sessions, 1);
  assert.equal(updates.at(-1)?.provider, "claude");
  assert.deepEqual(updates.at(-1)?.finding, finding);
});

test("agent prompt and finding parser preserve multi-file evidence", () => {
  const prompt = reviewPrompt({
    id: "n4",
    transcript: "Follow this into the caller",
    spans: [
      { file: "src/a.ts", side: "RIGHT", startLine: 10, endLine: 20, cursorLine: 14, dwellMs: 750 },
      { file: "src/b.ts", side: "RIGHT", startLine: 30, endLine: 35, dwellMs: 500 }
    ]
  });
  assert.match(prompt, /src\/a\.ts:10-20/);
  assert.match(prompt, /src\/b\.ts:30-35/);
  assert.deepEqual(parseFinding(`\`\`\`json\n${JSON.stringify(finding)}\n\`\`\``), finding);
});

test("a completed note cannot regress when later notes or progress arrive", async () => {
  const updates: AnalysisUpdate[] = [];
  const adapter: AgentAdapter = {
    id: "codex",
    name: "Codex",
    async probe() { return { provider: "codex", name: "Codex", available: true, detail: "Test adapter" }; },
    async createSession() {
      return {
        async *analyze() {
          yield { type: "progress", detail: "Reading code" };
          yield { type: "completed", finding, usage: null };
          yield { type: "progress", detail: "Late progress" };
        },
        async dispose() {}
      };
    }
  };
  const queue = new AgentReviewQueue((update) => updates.push(update), adapter);
  await queue.setRepository("/tmp/repository");
  queue.enqueue({ id: "n1", transcript: "first", spans: [] });
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue({ id: "n2", transcript: "second", spans: [] });
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of ["n1", "n2"]) {
    assert.deepEqual(updates.filter((update) => update.id === id).map((update) => update.status), ["queued", "investigating", "ready"]);
  }
});

test("an incomplete stream fails visibly and the next queued note still runs", async () => {
  const updates: AnalysisUpdate[] = [];
  const queue = new AgentReviewQueue((update) => updates.push(update), {
    id: "codex",
    name: "Codex",
    async probe() { return { provider: "codex", name: "Codex", available: true, detail: "Test adapter" }; },
    async createSession() {
      return {
        async *analyze(observation) {
          yield { type: "progress", detail: "Reading code" };
          if (observation.id === "n2") yield { type: "completed", finding, usage: null };
        },
        async dispose() {}
      };
    }
  });
  await queue.setRepository("/tmp/repository");
  queue.enqueue({ id: "n1", transcript: "first", spans: [] });
  queue.enqueue({ id: "n2", transcript: "second", spans: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.filter((update) => update.id === "n1").at(-1)?.status, "failed");
  assert.match(updates.find((update) => update.status === "failed")?.detail || "", /without returning a finding/);
  assert.equal(updates.at(-1)?.id, "n2");
  assert.equal(updates.at(-1)?.status, "ready");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const outcome of ["completed", "error", "creating", "reopened"] as const) {
  test(`switching reviews discards stale ${outcome} updates and starts new work immediately`, async () => {
    const updates: AnalysisUpdate[] = [];
    const gate = deferred();
    const started = deferred();
    let sessions = 0;
    const queue = new AgentReviewQueue((update) => updates.push(update), {
      id: "codex", name: "Test",
      async probe() { return { provider: "codex", name: "Test", available: true, detail: "" }; },
      async createSession(repository) {
        const first = ++sessions === 1;
        if (first && outcome === "creating") { started.resolve(); await gate.promise; }
        return {
          async *analyze() {
            if (first) {
              started.resolve();
              await gate.promise;
              if (outcome === "error") throw new Error("Old review failed");
              yield { type: "progress", detail: "Old progress" };
            }
            yield { type: "completed", finding: { ...finding, summary: `${repository}:${first ? "old" : "new"}` }, usage: null };
          },
          async dispose() {}
        };
      }
    });
    await queue.setRepository("/repo-a");
    queue.enqueue({ id: "n1", transcript: "old", spans: [] });
    await started.promise;
    const nextRepository = outcome === "reopened" ? "/repo-a" : "/repo-b";
    await queue.setRepository(nextRepository, outcome === "reopened");
    updates.length = 0;
    queue.enqueue({ id: "n1", transcript: "new", spans: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = [...updates];
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beforeRelease.at(-1)?.finding?.summary, `${nextRepository}:new`, "new review must not wait for old work");
    assert.deepEqual(updates, beforeRelease, "old work must not update the new note with the same ID");
    queue.enqueue({ id: "n2", transcript: "next", spans: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates.at(-1)?.finding?.summary, `${nextRepository}:new`);
    assert.equal(sessions, 2, "stale session creation must not replace the current session");
  });
}

test("a queued note can be cancelled, and a note in flight is reported as busy", async () => {
  const updates: AnalysisUpdate[] = [];
  const gate = deferred();
  const queue = new AgentReviewQueue((update) => updates.push(update), {
    id: "codex", name: "Test",
    async probe() { return { provider: "codex", name: "Test", available: true, detail: "" }; },
    async createSession() {
      return { async *analyze() { await gate.promise; yield { type: "completed", finding, usage: null }; }, async dispose() {} };
    }
  });
  await queue.setRepository("/repo");
  queue.enqueue({ id: "n1", transcript: "first", spans: [] });
  queue.enqueue({ id: "n2", transcript: "second", spans: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.has("n1"), true);
  assert.equal(queue.has("n2"), true);
  queue.cancel("n2");
  assert.equal(queue.has("n2"), false);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.has("n1"), false, "a finished note can be investigated again");
  assert.deepEqual(updates.filter((update) => update.id === "n2").map((update) => update.status), ["queued"]);
  queue.enqueue({ id: "n1", transcript: "first, edited", spans: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates.filter((update) => update.id === "n1").map((update) => update.status), ["queued", "ready", "queued", "ready"]);
});

test("Codex quick answers stream from one long-lived app server", async () => {
  // Stands in for `codex app-server`: one JSON message per line, both ways.
  const server = `
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    let threads = 0, turns = 0;
    require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize") send({ id: m.id, result: {} });
      if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "t" + (++threads) }, instructions: m.params.baseInstructions } });
      if (m.method === "turn/start") {
        turns += 1;
        send({ id: m.id, result: {} });
        send({ id: 900 + turns, method: "item/commandExecution/requestApproval", params: {} });
        send({ method: "item/agentMessage/delta", params: { threadId: "other", delta: "ignored" } });
        if (m.params.input[0].text.includes("explode")) return send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { status: "failed", error: { message: JSON.stringify({ error: { message: "model unavailable" } }) } } } });
        for (const delta of ["pid " + process.pid, " turn ", String(turns)]) send({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, delta } });
        send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { status: "completed" } } });
      }
    });`;
  const answerer = new CodexQuickAnswerer(process.execPath, ["-e", server], process.cwd());
  const ask = async (transcript: string) => {
    const events: QuickEvent[] = [];
    for await (const event of answerer.answer({ id: "n1", transcript, spans: [] })) events.push(event);
    return events;
  };
  try {
    const first = await ask("what is this?");
    assert.deepEqual(first.map((event) => event.type), ["delta", "delta", "delta", "completed"]);
    const second = await ask("and this?");
    const pid = first.at(-1)!.text.split(" ")[1];
    assert.equal(second.at(-1)!.text, `pid ${pid} turn 2`, "the same process answers the next note");
    await assert.rejects(ask("explode"), /model unavailable/);
    const recovered = await ask("still there?");
    assert.match(recovered.at(-1)!.text, /turn 1$/, "a failure starts a fresh server");
    assert.notEqual(recovered.at(-1)!.text.split(" ")[1], pid);
  } finally { await answerer.dispose(); }
  await assert.rejects(ask("after dispose"), /stopped/);
});
