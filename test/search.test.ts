import test from "node:test";
import assert from "node:assert/strict";
import { createSearchIndex, searchDiff, searchExcerpt } from "../desktop/search.js";
import { parseUnifiedDiff } from "../desktop/lib.js";

const files = parseUnifiedDiff(`diff --git a/src/store.ts b/src/store.ts
--- a/src/store.ts
+++ b/src/store.ts
@@ -10,3 +10,3 @@
 export function load() {
-  return oldStore.load("literal.*");
+  return newStore.load("literal.*");
 }
diff --git a/test/store.test.ts b/test/store.test.ts
--- a/test/store.test.ts
+++ b/test/store.test.ts
@@ -1 +1 @@
-oldTest();
+storeTest();
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ`);
const index = createSearchIndex(files);

test("empty search lists files, including binary files, without dumping code", () => {
  const result = searchDiff(index, "  ");
  assert.equal(result.total, 3);
  assert.ok(result.results.every((match) => match.kind === "file"));
  assert.equal(result.results.at(-1)?.file, "logo.png");
});

test("one case-insensitive query finds both paths and code", () => {
  const result = searchDiff(index, "STORE");
  assert.equal(result.total, 5);
  assert.equal(result.results[0].file, "src/store.ts");
  assert.equal(result.results.filter((match) => match.kind === "file").length, 2);
  assert.equal(result.results.filter((match) => match.kind === "code").length, 3);
});

test("code matches keep the exact old/new line identity and literal punctuation", () => {
  const result = searchDiff(index, "literal.*").results;
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((match) => match.kind === "code" && [match.line, match.side, match.change]), [[11, "LEFT", "delete"], [11, "RIGHT", "add"]]);
  const context = searchDiff(index, "export function").results[0];
  assert.ok(context.kind === "code");
  assert.deepEqual([context.line, context.side, context.change], [10, "RIGHT", "context"]);
});

test("file names rank ahead of parent-directory matches", () => {
  const index = createSearchIndex(["store/helpers.ts", "src/store.ts", "src/store.test.ts"].map((path) => ({ ...files[0], path, hunks: [] })));
  assert.equal(searchDiff(index, "store").results[0].file, "src/store.ts");
  assert.equal(searchDiff(index, "store.test.ts").results[0].file, "src/store.test.ts");
});

test("result limits leave room for both files and code and expose the full count", () => {
  const result = searchDiff(index, "store", 1);
  assert.equal(result.total, 5);
  assert.deepEqual(result.results.map((match) => match.kind), ["file", "code"]);
  assert.deepEqual(searchDiff(index, "no such identifier"), { results: [], total: 0 });
});

test("overlapping hunks do not duplicate a line", () => {
  const repeated = { ...files[0], hunks: [...files[0].hunks, ...files[0].hunks] };
  assert.equal(searchDiff(createSearchIndex([repeated]), "literal.*").total, 2);
});

test("long-line excerpts include the matching portion and remain bounded", () => {
  const text = `${"x".repeat(1000)}findMe${"y".repeat(1000)}`;
  const excerpt = searchExcerpt(text, "FINDME");
  assert.ok(excerpt.includes("findMe"));
  assert.ok(excerpt.length <= 182);
  assert.ok(excerpt.startsWith("…") && excerpt.endsWith("…"));
});

test("rebuilding the index does not carry matches from the previous repository", () => {
  assert.equal(searchDiff(createSearchIndex([]), "store").total, 0);
});
