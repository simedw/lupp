import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const command = fileURLToPath(new URL("../scripts/cli.js", import.meta.url));
const entry = fileURLToPath(new URL("../desktop/main.js", import.meta.url));

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lupp-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "Electron.app", "Contents", "MacOS", "Electron");
  await mkdir(path.dirname(binary), { recursive: true });
  // Both possible Electron paths: installed platform binary or deferred download.
  const source = `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE })); process.exit(Number(process.env.LUPP_TEST_EXIT || 0));\n`;
  await writeFile(binary, source, { mode: 0o755 });
  await writeFile(path.join(root, "electron"), source, { mode: 0o755 });
  const link = path.join(root, "lupp");
  await symlink(command, link);
  return { root, link, env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: root, ELECTRON_RUN_AS_NODE: "1" } };
}

test("npm command runs through a symlink and preserves the calling repo and arguments", async (t) => {
  const { root, link, env } = await fixture(t);
  const args = ["two words", "don't interpolate $PATH"];
  const { stdout } = await exec(process.execPath, [link, ...args], { cwd: root, env });
  assert.deepEqual(JSON.parse(stdout), { args: [entry, ...args], cwd: await realpath(root) });
});

test("npm command reports version and help without launching Electron", async (t) => {
  const { root, link, env } = await fixture(t);
  const options = { cwd: root, env: { ...env, ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent-electron" } };
  assert.match((await exec(process.execPath, [link, "--version"], options)).stdout, /^Lupp \d+\.\d+\.\d+\n$/);
  assert.match((await exec(process.execPath, [link, "--help"], options)).stdout, /Git checkout/);
});

test("npm command preserves Electron's exit code", async (t) => {
  const { root, link, env } = await fixture(t);
  await assert.rejects(exec(process.execPath, [link], { cwd: root, env: { ...env, LUPP_TEST_EXIT: "42" } }), (error) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, 42);
    return true;
  });
});

test("npm command fails clearly when Electron cannot start", async (t) => {
  const { root, link, env } = await fixture(t);
  await assert.rejects(exec(process.execPath, [link], { cwd: root, env: { ...env, ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent-electron" } }), (error) => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /Lupp failed to start/);
    return true;
  });
});
