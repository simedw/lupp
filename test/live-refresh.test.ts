import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { watchRepository, ignoredWatchPath } from "../desktop/repository-watcher.js";
import { findScrollAnchor } from "../desktop/scroll-anchor.js";
import type { RepositoryChange } from "../desktop/types.js";

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(30); }
  assert.fail("Timed out waiting for filesystem notification");
}

test("scroll anchor follows content through inserted lines, with nearest-line fallback", () => {
  const line = (text: string, number: number, side = "RIGHT") => ({ text, line: number, side });
  const anchor = line("unique content", 40);
  assert.equal(findScrollAnchor([line("inserted", 1), line("unique content", 45)], anchor), 1);
  assert.equal(findScrollAnchor([line("unique content", 10), line("unique content", 42)], anchor), 1);
  assert.equal(findScrollAnchor([line("unique content", 40, "LEFT"), line("edited content", 41)], anchor), 1);
  assert.equal(findScrollAnchor([], anchor), -1);
});

test("watching ignores Lupp data and editor swap/backup files", () => {
  for (const name of [".lupp/reviews/a.json", "src/a.ts.swp", "src/a.ts~", ".code-review-voice/data", "src/.a.swo"]) assert.equal(ignoredWatchPath(name), true, name);
  assert.equal(ignoredWatchPath("src/a.ts"), false);
});

test("native directory watches debounce edits, survive replacement, discover directories, and track staging", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-watch-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  await git("init", "-b", "main");
  await mkdir(path.join(repository, "src"));
  await mkdir(path.join(repository, ".lupp"));
  await writeFile(path.join(repository, "src/a.ts"), "first\n");
  await git("add", "src");
  const events: RepositoryChange[] = [];
  const watcher = await watchRepository(repository, (change) => events.push(change), { debounceMs: 80 });
  t.after(() => watcher.close());
  await until(() => events.length > 0); // Initial invalidation closes startup races.
  await pause(150); events.length = 0;
  await writeFile(path.join(repository, ".lupp/notes.json"), "{}");
  await writeFile(path.join(repository, "src/a.ts.swp"), "temporary");
  await pause(200);
  assert.equal(events.length, 0);
  for (let i = 0; i < 3; i++) await writeFile(path.join(repository, "src/a.ts"), `edit ${i}\n`);
  await until(() => events.length > 0);
  await pause(150);
  assert.equal(events.length, 1, "burst should be coalesced");
  assert.equal(events[0].mode, "native");
  assert.deepEqual(events[0].sources, ["unstaged", "untracked"]);
  events.length = 0;
  await writeFile(path.join(repository, "src/temp.ts"), "atomic\n");
  await rename(path.join(repository, "src/temp.ts"), path.join(repository, "src/a.ts"));
  await until(() => events.length > 0); await pause(150); events.length = 0;
  await mkdir(path.join(repository, "fresh/nested"), { recursive: true });
  await writeFile(path.join(repository, "fresh/nested/new.ts"), "new\n");
  await until(() => events.length > 0); await pause(150); events.length = 0;
  await writeFile(path.join(repository, "fresh/nested/new.ts"), "changed\n");
  await until(() => events.length > 0); await pause(150); events.length = 0;
  // A replaced directory has a new inode; subsequent saves must still notify.
  await rename(path.join(repository, "src"), path.join(repository, "previous"));
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src/a.ts"), "replacement\n");
  await until(() => events.length > 0); await pause(150); events.length = 0;
  await writeFile(path.join(repository, "src/a.ts"), "after replacement\n");
  await until(() => events.length > 0); await pause(150); events.length = 0;
  await git("add", "src/a.ts");
  await until(() => events.some((event) => event.sources.includes("staged")));
  watcher.close(); events.length = 0;
  await writeFile(path.join(repository, "src/a.ts"), "after close\n");
  await pause(200); assert.equal(events.length, 0);
});

test("watch resource limit switches to bounded fallback and close stops it", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "lupp-watch-fallback-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await exec("git", ["-C", repository, "init", "-b", "main"]);
  const events: RepositoryChange[] = [];
  const watcher = await watchRepository(repository, (event) => events.push(event), { maxWatchers: 0, fallbackMs: 100 });
  t.after(() => watcher.close());
  assert.equal(events[0].mode, "fallback");
  await until(() => events.length >= 2);
  watcher.close(); const count = events.length;
  await pause(220); assert.equal(events.length, count);
});

test("linked worktree watches its own index and the shared refs", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lupp-watch-worktree-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repository = path.join(scratch, "main");
  const worktree = path.join(scratch, "worktree");
  await mkdir(repository);
  const git = (...args: string[]) => exec("git", ["-C", repository, ...args]);
  await git("init", "-b", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "base");
  await git("worktree", "add", "-b", "feature", worktree);
  const events: RepositoryChange[] = [];
  const watcher = await watchRepository(worktree, (event) => events.push(event), { debounceMs: 80 });
  t.after(() => watcher.close());
  await until(() => events.length > 0); await pause(150); events.length = 0;
  await writeFile(path.join(worktree, "a.ts"), "local\n");
  await exec("git", ["-C", worktree, "add", "a.ts"]);
  await until(() => events.some((event) => event.sources.includes("staged")));
  await pause(150); events.length = 0;
  await git("update-ref", "refs/heads/new-ref", "HEAD");
  await until(() => events.some((event) => event.sources.includes("branch")));
});
