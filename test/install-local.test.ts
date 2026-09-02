import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { installLaunchers } from "../scripts/install-local.js";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lupp-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "checkout with space's");
  const binDir = path.join(root, "bin");
  const electronPath = path.join(projectRoot, "fake electron");
  await mkdir(path.join(projectRoot, "dist", "desktop"), { recursive: true });
  await mkdir(binDir);
  await writeFile(path.join(projectRoot, "dist", "desktop", "main.js"), "// fixture");
  await writeFile(electronPath, `#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),runAsNode:process.env.ELECTRON_RUN_AS_NODE}));\n`, { mode: 0o755 });
  return { root, projectRoot, binDir, electronPath, version: "1.2.3" };
}

test("local launchers work from another directory with spaces, quoting, and arguments", async (t) => {
  const config = await fixture(t);
  await installLaunchers(config);
  for (const name of ["lupp", "LUPP"]) {
    const command = path.join(config.binDir, name);
    const { stdout } = await exec(command, ["two words", "don't interpolate $PATH"], {
      cwd: config.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    assert.deepEqual(JSON.parse(stdout), {
      args: [path.join(config.projectRoot, "dist", "desktop", "main.js"), "two words", "don't interpolate $PATH"],
      cwd: await realpath(config.root)
    });
    assert.equal((await exec(command, ["--version"])).stdout.trim(), "Lupp 1.2.3");
  }
  await installLaunchers({ ...config, version: "1.2.4" });
  assert.equal((await exec(path.join(config.binDir, "lupp"), ["--version"])).stdout.trim(), "Lupp 1.2.4");
});

test("installer refuses unrelated commands and symlinks without overwriting them", async (t) => {
  const config = await fixture(t);
  const target = path.join(config.binDir, "lupp");
  await writeFile(target, "unrelated executable");
  await assert.rejects(installLaunchers(config), /unrelated command/);
  assert.equal(await readFile(target, "utf8"), "unrelated executable");
  await rm(target);
  await symlink(config.electronPath, target);
  await assert.rejects(installLaunchers(config), /unrelated command/);
});

test("launcher explains how to recover when its checkout disappears", async (t) => {
  const config = await fixture(t);
  await installLaunchers(config);
  await rm(path.join(config.projectRoot, "dist", "desktop", "main.js"));
  await assert.rejects(exec(path.join(config.binDir, "lupp")), (error) => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /npm run install:local/);
    return true;
  });
});
