import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { luppRuntime } from "../scripts/runtime.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lupp-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "Electron.app");
  const binary = path.join(source, "Contents", "MacOS", "Electron");
  const plist = path.join(source, "Contents", "Info.plist");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "runtime", { mode: 0o755 });
  await writeFile(plist, "original plist");
  const calls: { file: string; args: string[] }[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === "/bin/cp") await cp(args[1], args[2], { recursive: true });
    if (file === "/usr/bin/plutil") await writeFile(args.at(-1)!, "branded plist");
  };
  return { root, source, binary, plist, calls, options: { platform: "darwin" as const, cacheRoot: path.join(root, "cache"), run } };
}

test("macOS runtime is branded in a private cache without modifying Electron", async (t) => {
  const { binary, plist, calls, options } = await fixture(t);
  const result = await luppRuntime(binary, options);
  assert.ok(result.endsWith("/Lupp.app/Contents/MacOS/Electron"));
  assert.equal(await readFile(result, "utf8"), "runtime");
  assert.equal(await readFile(plist, "utf8"), "original plist");
  assert.deepEqual(calls.filter(({ file }) => file.endsWith("plutil")).map(({ args }) => args.slice(0, 4)), [
    ["-replace", "CFBundleName", "-string", "Lupp"],
    ["-replace", "CFBundleDisplayName", "-string", "Lupp"]
  ]);
  assert.equal(calls.at(-1)?.file, "/usr/bin/codesign");
  const count = calls.length;
  assert.equal(await luppRuntime(binary, options), result);
  assert.equal(calls.length, count, "Subsequent launches don't copy or sign again");
  await writeFile(plist, "updated runtime");
  assert.notEqual(await luppRuntime(binary, options), result, "Electron updates get a new runtime");
});

test("non-macOS runtimes are unchanged", async () => {
  assert.equal(await luppRuntime("/custom/electron", { platform: "linux" }), "/custom/electron");
});

test("failed signing isn't cached and can be retried", async (t) => {
  const { binary, options } = await fixture(t);
  await assert.rejects(luppRuntime(binary, {
    ...options,
    run: async (file, args) => {
      if (file.endsWith("codesign")) throw new Error("signing failed");
      return options.run(file, args);
    }
  }), /signing failed/);
  assert.ok((await luppRuntime(binary, options)).includes("Lupp.app"));
});

test("simultaneous launches share a complete runtime", async (t) => {
  const { binary, options } = await fixture(t);
  const paths = await Promise.all([luppRuntime(binary, options), luppRuntime(binary, options)]);
  assert.equal(paths[0], paths[1]);
  assert.equal(await readFile(paths[0], "utf8"), "runtime");
});
