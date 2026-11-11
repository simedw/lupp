import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectRepository, loadInitialDiff, loadRepositoryDiff } from "../desktop/git.js";
import { collapseAttention } from "../desktop/lib.js";
import { reviewPrompt } from "../desktop/agents/types.js";
import { loadReview, saveReview } from "../desktop/review-store.js";

const exec = promisify(execFile);

test("branch, staged, unstaged and untracked snapshots are independent and read-only", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-diff-sources-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  const write = (name: string, value: string | Buffer) => writeFile(path.join(repository, name), value);
  await git("init", "-b", "main");
  await git("config", "user.name", "Lupp Test");
  await git("config", "user.email", "test@example.test");
  await write("same.ts", "base\n");
  await write("deleted.ts", "delete me\n");
  await write(".gitignore", "ignored.txt\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await git("checkout", "-b", "feature");
  await write("same.ts", "committed\n");
  await git("commit", "-am", "branch");
  await write("same.ts", "staged\n");
  await git("add", "same.ts");
  await write("same.ts", "unstaged\n");
  await rm(path.join(repository, "deleted.ts"));
  await write("new ü file.ts", "new\nsecond\n");
  await write("empty.ts", "");
  await write("binary.bin", Buffer.from([0, 1, 2]));
  await write("ignored.txt", "not visible");
  await mkdir(path.join(repository, ".lupp"));
  await write(".lupp/notes.json", "private notes");
  await symlink("same.ts", path.join(repository, "link"));
  const indexBefore = await readFile(path.join(repository, ".git/index"));
  const branch = await loadRepositoryDiff(repository, "main");
  const staged = await loadRepositoryDiff(repository, "main", "staged");
  const unstaged = await loadRepositoryDiff(repository, "main", "unstaged");
  const untracked = await loadRepositoryDiff(repository, "main", "untracked");
  const changes = (snapshot: typeof branch) => snapshot.files.find((file) => file.path === "same.ts")!.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.type, line.text]);
  assert.deepEqual(changes(branch), [["delete", "base"], ["add", "committed"]]);
  assert.deepEqual(changes(staged), [["delete", "committed"], ["add", "staged"]]);
  assert.deepEqual(changes(unstaged), [["delete", "staged"], ["add", "unstaged"]]);
  assert.equal(unstaged.files.find((file) => file.path === "deleted.ts")?.status, "deleted");
  assert.deepEqual(untracked.files.map((file) => file.path).sort(), ["binary.bin", "empty.ts", "link", "new ü file.ts"]);
  assert.equal(untracked.files.find((file) => file.path === "binary.bin")?.binary, true);
  assert.equal(untracked.files.find((file) => file.path === "empty.ts")?.additions, 0);
  assert.match(untracked.files.find((file) => file.path === "link")?.previewMessage || "", /symlinks are not followed/);
  assert.equal(untracked.files.find((file) => file.path === "new ü file.ts")?.additions, 2);
  // Local is everything uncommitted in one view: tracked edits against HEAD, then new files.
  const local = await loadRepositoryDiff(repository, "main", "local");
  assert.deepEqual(changes(local), [["delete", "committed"], ["add", "unstaged"]]);
  assert.deepEqual(local.files.map((file) => file.path).sort(), ["binary.bin", "deleted.ts", "empty.ts", "link", "new ü file.ts", "same.ts"]);
  assert.equal((await loadInitialDiff(repository, "main")).diffSource, "branch");
  assert.deepEqual(await readFile(path.join(repository, ".git/index")), indexBefore);
  await write("same.ts", "later local edit\n");
  assert.notEqual((await loadRepositoryDiff(repository, "main", "unstaged")).snapshotId, unstaged.snapshotId);
  assert.equal((await loadRepositoryDiff(repository, "main", "staged")).snapshotId, staged.snapshotId);
  assert.equal((await loadRepositoryDiff(repository, "main")).snapshotId, branch.snapshotId);
  assert.deepEqual(changes(unstaged), [["delete", "staged"], ["add", "unstaged"]]);
  await assert.rejects(loadRepositoryDiff(repository, "main", "invalid" as "branch"), /Unknown change source/);
});

test("notes retain source, snapshot and captured code across saving and agent prompts", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-source-notes-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const sample = { t: 0, file: "same.ts", side: "RIGHT" as const, visibleStart: 1, visibleEnd: 3, cursorLine: 2 };
  const spans = collapseAttention([
    { ...sample, source: "branch", snapshotId: "a" },
    { ...sample, t: 250, source: "staged", snapshotId: "b" },
    { ...sample, t: 500, source: "staged", snapshotId: "c" }
  ]);
  assert.equal(spans.length, 3);
  const observation = { id: "n1", transcript: "Check the local change", spans: spans.map((span) => ({ ...span, excerpt: "-/2 add: const value = 42;" })) };
  const metadata = { repository, branch: "feature", baseRef: "main" };
  await saveReview(metadata, [observation]);
  assert.deepEqual((await loadReview(metadata)).observations, JSON.parse(JSON.stringify([observation])));
  assert.match(reviewPrompt(observation), /staged, RIGHT, snapshot b/);
  assert.match(reviewPrompt(observation), /const value = 42/);
});

test("single-commit repositories still support local changes with HEAD as fallback", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-first-commit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await exec("git", ["init", "-b", "trunk", repository]);
  await exec("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
  const metadata = await inspectRepository(repository);
  assert.equal(metadata.baseRef, "HEAD");
  assert.deepEqual((await loadRepositoryDiff(repository, metadata.baseRef)).files, []);
  assert.equal((await loadInitialDiff(repository, metadata.baseRef)).diffSource, "branch");
  await writeFile(path.join(repository, "new.ts"), "new code\n");
  // With nothing committed on the branch, open on the uncommitted work instead.
  const initial = await loadInitialDiff(repository, metadata.baseRef);
  assert.equal(initial.diffSource, "local");
  assert.deepEqual(initial.files.map((file) => file.path), ["new.ts"]);
  assert.equal((await loadRepositoryDiff(repository, metadata.baseRef, "untracked")).files.length, 1);
  // Committing moves HEAD; the same checkout keeps loading against the new commit.
  await exec("git", ["-C", repository, "add", "new.ts"]);
  await exec("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "second"]);
  const after = await loadRepositoryDiff(repository, metadata.baseRef, "local");
  assert.notEqual(after.headSha, initial.headSha);
  assert.deepEqual(after.files, []);
});
