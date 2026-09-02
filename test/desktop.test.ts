import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectRepository, loadRepositoryDiff } from "../desktop/git.js";
import { collapseAttention, encodeMonoWav, parseUnifiedDiff, safeSegmentId, summarizeDiff } from "../desktop/lib.js";
import { resolveCodexExecutable } from "../desktop/codex-path.js";
import { loadReview, reviewFilePath, saveReview } from "../desktop/review-store.js";
import { tokenizeLine } from "../desktop/highlight.js";

const exec = promisify(execFile);

async function makeExecutable(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

test("Codex executable resolver honors an explicit override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-desk-codex-"));
  const executable = path.join(root, "my-codex");
  await makeExecutable(executable);
  assert.equal(await resolveCodexExecutable({ override: executable, pathValue: "", home: root }), executable);
});

test("Codex executable resolver finds asdf shims outside a GUI PATH", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-desk-home-"));
  const executable = path.join(home, ".asdf", "shims", "codex");
  await makeExecutable(executable);
  assert.equal(await resolveCodexExecutable({ pathValue: "", home }), executable);
});

test("Codex executable resolver reports an invalid explicit path", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-desk-home-"));
  await assert.rejects(
    resolveCodexExecutable({ override: path.join(home, "missing"), pathValue: "", home }),
    /REVIEW_VOICE_CODEX_PATH is not executable/
  );
});

test("review observations persist in a branch-specific dot folder", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "review-desk-store-"));
  const metadata = { repository, branch: "feature/voice desk", baseRef: "main", baseSha: "abc", headSha: "def" };
  const observations = [{ id: "n1", transcript: "Check this branch", spans: [] }];
  const saved = await saveReview(metadata, observations);
  assert.match(saved.file, /\.lupp\/reviews\/feature-voice-desk-[a-f0-9]{8}\.json$/);
  assert.equal(reviewFilePath(metadata), saved.file);
  assert.deepEqual((await loadReview(metadata)).observations, observations);
});

test("syntax highlighting preserves source text while classifying code", () => {
  const source = 'const total = calculate("voice", 42); // review note';
  const tokens = tokenizeLine(source, "src/review.ts");
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(
    ["keyword", "function", "string", "number", "comment"].map((type) => tokens.some((token) => token.type === type)),
    [true, true, true, true, true]
  );
});

test("syntax highlighting recognizes Elixir modules and atoms", () => {
  const tokens = tokenizeLine("defmodule Review.Voice do: :ready", "lib/review/voice.ex");
  assert.equal(tokens.map((token) => token.text).join(""), "defmodule Review.Voice do: :ready");
  assert(tokens.some((token) => token.type === "keyword" && token.text === "defmodule"));
  assert(tokens.some((token) => token.type === "type" && token.text === "Review"));
  assert(tokens.some((token) => token.type === "literal" && token.text === ":ready"));
});

test("unified diff parser preserves line identities", () => {
  const files = parseUnifiedDiff(`diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -2,2 +2,3 @@ function run() {
 keep
-old
+new
+extra`);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/a.js");
  assert.deepEqual(files[0].hunks[0].lines.map((line) => [line.type, line.oldLine, line.newLine]), [
    ["context", 2, 2], ["delete", 3, null], ["add", null, 3], ["add", null, 4]
  ]);
});

test("diff totals include all files and handle an empty diff", () => {
  assert.deepEqual(summarizeDiff([]), { additions: 0, deletions: 0 });
  assert.deepEqual(summarizeDiff([
    { additions: 1250, deletions: 3 },
    { additions: 0, deletions: 420 },
    { additions: 12, deletions: 0 },
    { additions: 0, deletions: 0 }
  ]), { additions: 1262, deletions: 423 });
});

test("attention samples collapse into ordered code spans", () => {
  const spans = collapseAttention([
    { t: 0, file: "a.js", side: "RIGHT", visibleStart: 10, visibleEnd: 25, cursorLine: 14 },
    { t: 250, file: "a.js", side: "RIGHT", visibleStart: 18, visibleEnd: 32, cursorLine: 22 },
    { t: 500, file: "b.js", side: "RIGHT", visibleStart: 4, visibleEnd: 8, cursorLine: 6 }
  ]);
  assert.equal(spans.length, 2);
  assert.deepEqual([spans[0].startLine, spans[0].endLine, spans[0].dwellMs], [10, 32, 500]);
  assert.equal(spans[1].file, "b.js");
});

test("WAV encoder writes a valid mono PCM header", () => {
  const wav = encodeMonoWav([new Float32Array([0, .5, -1, 1])], 48_000);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(40, true), 8);
});

test("observation IDs cannot escape the session audio directory", () => {
  assert.equal(safeSegmentId("n42"), "n42");
  assert.throws(() => safeSegmentId("../../key"));
});

test("local Git checkout produces a frozen base-to-head diff", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "review-desk-git-"));
  await exec("git", ["init", "-b", "main"], { cwd: repository });
  await exec("git", ["config", "user.email", "review@example.test"], { cwd: repository });
  await exec("git", ["config", "user.name", "Review Test"], { cwd: repository });
  await writeFile(path.join(repository, "a.js"), "export const value = 1;\n");
  await exec("git", ["add", "a.js"], { cwd: repository });
  await exec("git", ["commit", "-m", "base"], { cwd: repository });
  await exec("git", ["checkout", "-b", "feature"], { cwd: repository });
  await writeFile(path.join(repository, "a.js"), "export const value = 2;\nexport const extra = true;\n");
  await exec("git", ["commit", "-am", "feature"], { cwd: repository });
  const metadata = await inspectRepository(repository);
  const diff = await loadRepositoryDiff(repository, "main");
  assert.equal(metadata.branch, "feature");
  assert.equal(diff.files[0].path, "a.js");
  assert.equal(diff.files[0].additions, 2);
});
