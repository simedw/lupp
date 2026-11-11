import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { actionKey, collectActions, formatActionBrief, recommendedActions, setActionDismissed } from "../desktop/actions.js";
import { findingSchema, parseFinding, reviewPrompt, type Finding, type RecommendedAction, type ReviewObservation } from "../desktop/agents/types.js";
import { loadReview, saveReview } from "../desktop/review-store.js";

const action: RecommendedAction = { kind: "cleanup", title: "Remove the unused handler", rationale: "No callers remain after the routing change.", locations: [{ file: "src/router.ts", startLine: 42, endLine: 61 }] };
const finding: Finding = { severity: "concern", summary: "The fallback is unused.", confidence: .9, worthRaising: true, evidence: [{ ...action.locations[0], reason: action.rationale }], suggestedComment: "", decision: "action-recommended", actions: [action] };
const observation = (id = "n1"): ReviewObservation => ({ id, transcript: "Private spoken context", status: "ready", finding, audioPath: "/private/audio.wav", spans: [{ file: "src/router.ts", side: "RIGHT", source: "staged", snapshotId: "snapshot-before-edits", startLine: 42, endLine: 61, dwellMs: 1000, excerpt: "-/42 add: function unused() {}" }] });
const metadata = { repository: "/tmp/example", branch: "feature/router", baseRef: "main", headSha: "head-before-edits" };

test("new schema and prompt classify investigated outcomes in the same agent call", () => {
  assert.ok(findingSchema.required.includes("actions"));
  assert.ok(findingSchema.required.includes("decision"));
  assert.match(reviewPrompt(observation()), /Classify the investigated outcome, not the user's wording/);
  assert.deepEqual(parseFinding(JSON.stringify(finding)), finding);
  assert.deepEqual(parseFinding({ ...finding, decision: "answered", actions: [] }).actions, []);
  assert.deepEqual(parseFinding({ ...finding, decision: "needs-decision", actions: [] }).actions, []);
});

test("invalid, speculative or inconsistent actions cannot pass the finding parser", () => {
  for (const value of [
    { ...finding, decision: "answered" },
    { ...finding, decision: "needs-decision" },
    { ...finding, actions: [] },
    { ...finding, decision: "unknown" },
    { ...finding, actions: [null] },
    { ...finding, actions: [{ ...action, rationale: "" }] },
    { ...finding, actions: [{ ...action, locations: [] }] },
    { ...finding, actions: [{ ...action, locations: [{ file: "../secret", startLine: 1, endLine: 2 }] }] },
    { ...finding, actions: [{ ...action, locations: [{ file: "/private/file", startLine: 1, endLine: 2 }] }] },
    { ...finding, actions: [{ ...action, locations: [{ file: "a.ts", startLine: 3, endLine: 2 }] }] }
  ]) assert.throws(() => parseFinding(value), /invalid|inconsistent/);
});

test("legacy findings never become actions because of severity or suggested comments", () => {
  const { actions: _actions, decision: _decision, ...legacy } = finding;
  const result = parseFinding(legacy);
  assert.deepEqual(result, legacy);
  assert.deepEqual(collectActions([{ ...observation(), finding: result }]), []);
});

test("copy excludes questions, pending decisions, incomplete and dismissed actions", () => {
  const notes = [
    observation(),
    { ...observation("n2"), finding: { ...finding, decision: "answered" as const, actions: [] } },
    { ...observation("n3"), finding: { ...finding, decision: "needs-decision" as const, actions: [] } },
    { ...observation("n4"), status: "investigating" as const },
    { ...observation("n5"), status: "failed" as const },
    { ...observation("n6"), dismissedActionKeys: [actionKey(action)] }
  ];
  assert.deepEqual(collectActions(notes).map(({ observation }) => observation.id), ["n1"]);
  const brief = formatActionBrief(metadata, notes);
  assert.match(brief, /Remove the unused handler/);
  assert.match(brief, /No callers remain/);
  assert.match(brief, /src\/router.ts/);
  assert.match(brief, /staged/);
  assert.match(brief, /snapshot-before-edits/);
  assert.match(brief, /head-before-edits/);
  assert.match(brief, /First verify each action/);
  assert.doesNotMatch(brief, /Private spoken context|private\/audio|"n[2-6]"/);
});

test("individual selection is exact and duplicate actions within a note are collapsed", () => {
  const another: RecommendedAction = { ...action, title: "Add a routing regression test", kind: "test" };
  const note = { ...observation(), finding: { ...finding, actions: [action, { ...action }, another] } };
  assert.equal(recommendedActions(note).length, 2);
  const brief = formatActionBrief(metadata, [note], { observationId: "n1", actionKey: actionKey(another) });
  assert.match(brief, /Add a routing regression test/);
  assert.doesNotMatch(brief, /Remove the unused handler/);
  assert.throws(() => formatActionBrief(metadata, [note], { observationId: "n2", actionKey: actionKey(another) }), /No recommended actions/);
  assert.throws(() => formatActionBrief(metadata, []), /No recommended actions/);
});

test("dismiss and restore persist, and don't dismiss a different action after reinvestigation", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-actions-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const note = observation();
  setActionDismissed(note, actionKey(action), true);
  assert.equal(collectActions([note]).length, 0);
  await saveReview({ ...metadata, repository }, [note]);
  const restored = (await loadReview({ ...metadata, repository })).observations[0];
  assert.equal(collectActions([restored]).length, 0);
  assert.throws(() => formatActionBrief(metadata, [restored], { observationId: note.id, actionKey: actionKey(action) }), /No recommended actions/);
  setActionDismissed(restored, actionKey(action), false);
  assert.equal(collectActions([restored]).length, 1);
  assert.throws(() => setActionDismissed(restored, "stale-key", true), /no longer available/);
  note.finding = { ...finding, actions: [{ ...action, title: "Keep the handler but fix routing" }] };
  assert.equal(collectActions([note]).length, 1);
});
