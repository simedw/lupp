import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveCodexExecutable } from "../desktop/codex-path.js";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function executable(file: string, source: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, { mode: 0o755 });
}

async function fixture(t: TestContext, { optionalPackage = true } = {}) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "lupp-asdf-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "node install with space's", "lib", "node_modules", "@openai", "codex");
  const entry = path.join(root, "bin", "codex.js");
  await executable(entry, "#!/usr/bin/env node\nthrow new Error('Node wrapper must not run');\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  const platformRoot = optionalPackage ? path.join(root, "node_modules", "@openai", "codex-darwin-arm64") : root;
  const binary = path.join(platformRoot, "vendor", "aarch64-apple-darwin", optionalPackage ? "bin" : "codex", "codex");
  await executable(binary, "#!/bin/sh\nprintf '%s\\n' 'codex-cli fixture'\n");
  if (optionalPackage) await writeFile(path.join(platformRoot, "package.json"), JSON.stringify({ name: "@openai/codex-darwin-arm64" }));

  const installed = path.join(home, "npm bin", "codex");
  await mkdir(path.dirname(installed));
  await symlink(entry, installed);
  const shim = path.join(home, ".asdf", "shims", "codex");
  await executable(shim, "#!/bin/sh\n# asdf-plugin: nodejs 24.12.0\nexit 126\n");
  await executable(path.join(home, ".asdf", "shims", "node"), "#!/bin/sh\nexit 126\n");
  const asdf = path.join(home, ".asdf", "bin", "asdf");
  await executable(asdf, `#!/bin/sh\n[ "$PWD" = ${quote(home)} ] || exit 126\n[ "$1 $2" = 'which codex' ] || exit 1\nprintf '%s\\n' ${quote(installed)}\n`);
  const repository = path.join(home, "reviewed repo");
  await mkdir(repository);
  await writeFile(path.join(repository, ".tool-versions"), "nodejs 24.15.0\n");
  return { home, root, installed, shim, asdf, binary, repository, options: { home, override: "", pathValue: path.dirname(shim), platform: "darwin", arch: "arm64" } };
}

test("asdf resolution bypasses both the Codex and Node shims inside a conflicting repository", async (t) => {
  const f = await fixture(t);
  const resolved = await resolveCodexExecutable(f.options);
  assert.equal(resolved, f.binary);
  const { stdout } = await exec(resolved, ["--version"], { cwd: f.repository, env: { ...process.env, PATH: path.dirname(f.shim) } });
  assert.equal(stdout.trim(), "codex-cli fixture");
  assert.equal(await readFile(path.join(f.repository, ".tool-versions"), "utf8"), "nodejs 24.15.0\n");
  assert.equal(await resolveCodexExecutable({ ...f.options, override: f.shim }), f.binary);
});

test("npm resolution supports older bundled native binaries and direct npm overrides", async (t) => {
  const f = await fixture(t, { optionalPackage: false });
  assert.equal(await resolveCodexExecutable({ ...f.options, override: f.installed }), f.binary);
});

test("broken asdf resolution reports actionable setup guidance rather than returning the shim", async (t) => {
  const f = await fixture(t);
  await writeFile(f.asdf, "#!/bin/sh\nexit 126\n");
  await assert.rejects(resolveCodexExecutable(f.options), /asdf from your home directory/);
});

test("missing native package does not fall back to a Node wrapper", async (t) => {
  const f = await fixture(t);
  await rm(f.binary);
  await assert.rejects(resolveCodexExecutable(f.options), /no native binary/);
});
