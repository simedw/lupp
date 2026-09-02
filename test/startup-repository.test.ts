import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findInitialRepository, inspectRepository, loadRepositoryDiff } from "../desktop/git.js";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lupp-startup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "a checkout with spaces");
  await mkdir(path.join(repository, "src", "nested"), { recursive: true });
  const git = (args: string[]) => exec("git", ["-C", repository, ...args]);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Lupp Test"]);
  await git(["config", "user.email", "lupp@example.test"]);
  await writeFile(path.join(repository, "src", "code.js"), "export const value = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["checkout", "-b", "feature"]);
  await writeFile(path.join(repository, "src", "code.js"), "export const value = 2;\n");
  await git(["commit", "-am", "change"]);
  return { root, repository, git };
}

test("startup discovers the launch checkout from its root and nested directories", async (t) => {
  const { repository } = await fixture(t);
  for (const cwd of [repository, path.join(repository, "src", "nested")]) {
    const detected = await findInitialRepository({ cwd, repository: "" });
    assert.equal(detected, repository);
    const metadata = await inspectRepository(detected);
    assert.equal(metadata.branch, "feature");
    const diff = await loadRepositoryDiff(detected, metadata.baseRef);
    assert.equal(diff.files[0].path, "src/code.js");
  }
});

test("startup works inside a linked Git worktree", async (t) => {
  const { root, git } = await fixture(t);
  const worktree = path.join(root, "linked worktree");
  await git(["worktree", "add", "-b", "linked", worktree]);
  assert.equal(await findInitialRepository({ cwd: path.join(worktree, "src"), repository: "" }), worktree);
});

test("startup leaves the chooser open outside Git and respects explicit overrides", async (t) => {
  const { root, repository } = await fixture(t);
  assert.equal(await findInitialRepository({ cwd: root, repository: "" }), null);
  assert.equal(await findInitialRepository({ cwd: root, repository: path.basename(repository) }), repository);
  // Do not silently fall back to cwd when an explicit repository is invalid.
  const missing = path.join(root, "missing checkout");
  assert.equal(await findInitialRepository({ cwd: repository, repository: missing }), missing);
  await assert.rejects(inspectRepository(missing));
});
