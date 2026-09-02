import test from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, revealFileAncestors, visibleTreeRows } from "../desktop/file-tree.js";
import type { DiffFile } from "../desktop/types.js";

const file = (path: string, status: DiffFile["status"] = "modified"): DiffFile => ({ path, oldPath: path, status, hunks: [], additions: 2, deletions: 1 });

test("tree contains only supplied changed files and their ancestors, sorted folders first", () => {
  const files = [file("README.md"), file("src/a10.ts"), file("src/a2.ts", "added"), file("config/app.ts", "deleted"), { ...file("logo.png"), binary: true }];
  const tree = buildFileTree(files);
  assert.deepEqual(tree.map((node) => node.name), ["config", "src", "logo.png", "README.md"]);
  const rows = visibleTreeRows(tree, new Set());
  assert.deepEqual(rows.filter((row) => row.node.kind === "file").map((row) => row.node.path), ["config/app.ts", "src/a2.ts", "src/a10.ts", "logo.png", "README.md"]);
  const child = rows.find((row) => row.node.path === "config/app.ts")!;
  assert.equal(child.depth, 1);
  assert.equal(child.parent, "folder:config");
  assert.equal(child.node.kind === "file" && child.node.file, files[3]);
});

test("collapsing a folder hides descendants, not sibling changes", () => {
  const tree = buildFileTree([file("src/deep/nested/a.ts"), file("test/a.test.ts")]);
  const rows = visibleTreeRows(tree, new Set(["src"]));
  assert.deepEqual(rows.map((row) => row.node.path), ["src", "test", "test/a.test.ts"]);
  assert.equal(visibleTreeRows(tree, new Set()).length, 6);
});

test("revealing a destination expands only its ancestors", () => {
  const collapsed = new Set(["src", "src/deep", "src/other", "test"]);
  revealFileAncestors("src/deep/a.ts", collapsed);
  assert.deepEqual([...collapsed], ["src/other", "test"]);
  revealFileAncestors("README.md", collapsed);
  assert.equal(collapsed.size, 2);
});

test("a deleted file replaced by a directory has separate, stable row keys", () => {
  const tree = buildFileTree([file("config", "deleted"), file("config/app.ts", "added")]);
  assert.deepEqual(visibleTreeRows(tree, new Set()).map((row) => row.key), ["folder:config", "file:config/app.ts", "file:config"]);
});

test("empty trees and unusual path characters do not add synthetic files", () => {
  assert.deepEqual(buildFileTree([]), []);
  const name = "src/<example> file.ts";
  const rows = visibleTreeRows(buildFileTree([file(name, "renamed")]), new Set());
  assert.equal(rows.at(-1)?.node.name, "<example> file.ts");
  assert.equal(rows.at(-1)?.node.path, name);
});
