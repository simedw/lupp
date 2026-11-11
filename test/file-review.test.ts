import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { isFileReviewed, updateReviewedFiles } from "../desktop/file-review.js";
import { loadRepositoryDiff } from "../desktop/git.js";
import { loadReview, saveReview } from "../desktop/review-store.js";
import type { DiffFile } from "../desktop/types.js";

const exec = promisify(execFile);
const file: DiffFile = { path: "a.ts", oldPath: "a.ts", status: "modified", hunks: [], additions: 1, deletions: 1, reviewId: "original-diff" };

test("file checks are independent per source, replace older revisions, and toggle off", () => {
  const check = { path: file.path, source: "branch" as const, reviewId: file.reviewId! };
  const files = updateReviewedFiles([], check, true);
  assert.equal(isFileReviewed(files, file, "branch"), true);
  assert.equal(isFileReviewed(files, file, "unstaged"), false);
  assert.equal(isFileReviewed(files, { ...file, reviewId: "changed" }, "branch"), false);
  assert.equal(isFileReviewed(files, { ...file, reviewId: undefined }, "branch"), false);
  assert.equal(updateReviewedFiles(files, check, true).length, 1);
  const revised = updateReviewedFiles(files, { ...check, reviewId: "changed" }, true);
  assert.equal(revised.length, 1);
  assert.equal(isFileReviewed(revised, file, "branch"), false);
  const both = updateReviewedFiles(files, { ...check, source: "staged" }, true);
  assert.equal(both.length, 2);
  assert.equal(updateReviewedFiles(both, check, false).length, 1);
});

test("file checks persist alongside observations and are isolated by branch", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-reviewed-store-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const metadata = { repository, branch: "feature", baseRef: "main" };
  const checks = [{ path: "a.ts", source: "staged" as const, reviewId: "checked-revision" }];
  assert.deepEqual((await loadReview(metadata)).reviewedFiles, []);
  const notes = [{ id: "n1", transcript: "Keep my note", spans: [], dismissedActionKeys: ["dismissed"] }];
  const saved = await saveReview(metadata, notes, checks);
  const loaded = await loadReview(metadata);
  assert.deepEqual(loaded.reviewedFiles, checks);
  assert.deepEqual(loaded.observations, notes);
  await saveReview(metadata, [{ ...notes[0], transcript: "Updated note" }], loaded.reviewedFiles);
  assert.deepEqual((await loadReview(metadata)).reviewedFiles, checks);
  assert.deepEqual((await loadReview({ ...metadata, branch: "different" })).reviewedFiles, []);
  const legacy = JSON.parse(await readFile(saved.file, "utf8"));
  delete legacy.reviewedFiles;
  await writeFile(saved.file, JSON.stringify(legacy));
  assert.deepEqual((await loadReview(metadata)).reviewedFiles, []);
});

test("review IDs change with file content, not unrelated text files or snapshot timestamps", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-reviewed-git-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  const write = (name: string, value: string | Buffer) => writeFile(path.join(repository, name), value);
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await write("a.ts", "old\n");
  await write("b.ts", "old\n");
  await git("add", "."); await git("commit", "-m", "base");
  await write("a.ts", "new\n");
  const first = (await loadRepositoryDiff(repository, "main", "unstaged")).files[0];
  const approved = [{ path: first.path, source: "unstaged" as const, reviewId: first.reviewId! }];
  await write("b.ts", "unrelated\n");
  const second = (await loadRepositoryDiff(repository, "main", "unstaged")).files.find((file) => file.path === "a.ts")!;
  assert.equal(isFileReviewed(approved, second, "unstaged"), true);
  await write("a.ts", "changed again\n");
  const changed = (await loadRepositoryDiff(repository, "main", "unstaged")).files.find((file) => file.path === "a.ts")!;
  assert.equal(isFileReviewed(approved, changed, "unstaged"), false);
  await git("add", "a.ts");
  const staged = (await loadRepositoryDiff(repository, "main", "staged")).files[0];
  assert.notEqual(staged.reviewId, changed.reviewId);
  await write("new.bin", Buffer.from([0, 1, 2]));
  const binary = (await loadRepositoryDiff(repository, "main", "untracked")).files[0];
  await write("new.bin", Buffer.from([0, 3, 4]));
  assert.notEqual((await loadRepositoryDiff(repository, "main", "untracked")).files[0].reviewId, binary.reviewId);
});

test("tracked binary checks survive unrelated edits but expire when their own bytes change", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-binary-review-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  await git("init", "-b", "main");
  await writeFile(path.join(repository, "a.bin"), Buffer.from([0, 1]));
  await writeFile(path.join(repository, "b.txt"), "base\n");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base");
  for (const source of ["unstaged", "staged"] as const) {
    await git("reset", "--hard", "HEAD");
    const snapshot = async () => (await loadRepositoryDiff(repository, "HEAD", source)).files.find((file) => file.path === "a.bin")!;
    await writeFile(path.join(repository, "a.bin"), Buffer.from([0, 2]));
    if (source === "staged") await git("add", ".");
    const first = await snapshot();
    const checks = [{ path: first.path, source, reviewId: first.reviewId! }];
    await writeFile(path.join(repository, "b.txt"), "unrelated\n");
    if (source === "staged") await git("add", ".");
    assert.equal(isFileReviewed(checks, await snapshot(), source), true);
    await writeFile(path.join(repository, "a.bin"), Buffer.from([0, 3]));
    if (source === "staged") await git("add", ".");
    assert.equal(isFileReviewed(checks, await snapshot(), source), false);
  }
});

test("Git quoted paths retain their own hunks and decode escaped UTF-8 names", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-quoted-path-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  const names = ["a.txt", 'quote"name.ts', "tab\tname.ts", "back\\slash.ts", 'é"name.ts', "z.txt"];
  await git("init", "-b", "main");
  for (const name of names) await writeFile(path.join(repository, name), "base\n");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base");
  for (const [index, name] of names.entries()) await writeFile(path.join(repository, name), `edited ${index}\n`);
  const snapshot = await loadRepositoryDiff(repository, "HEAD", "unstaged");
  assert.equal(snapshot.files.length, names.length);
  for (const [index, name] of names.entries()) {
    const file = snapshot.files.find((item) => item.path === name)!;
    assert.ok(file, name);
    assert.equal(file.oldPath, name);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.deepEqual(file.hunks.flatMap((hunk) => hunk.lines).map((line) => line.text), ["base", `edited ${index}`]);
  }
});
