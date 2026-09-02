import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, hasErrorCode } from "../desktop/errors.js";

const marker = "# Lupp local launcher — managed by install:local";
const quote = (value: string) => `'${String(value).replaceAll("'", "'\\''")}'`;

type LauncherOptions = { projectRoot: string; electronPath: string; version: string };
export function launcherSource({ projectRoot, electronPath, version }: LauncherOptions) {
  const entry = path.join(projectRoot, "dist", "desktop", "main.js");
  return `#!/bin/sh
${marker}
case "\${1-}" in
  --version) printf '%s\\n' ${quote(`Lupp ${version}`)}; exit 0 ;;
  --help) printf '%s\\n' 'Usage: lupp [Electron options]' 'Starts the local Lupp review desk.' 'Update: run npm run install:local from the Lupp checkout.'; exit 0 ;;
esac
if [ ! -x ${quote(electronPath)} ] || [ ! -f ${quote(entry)} ]; then
  printf '%s\\n' ${quote(`Lupp's build is missing. Run npm run install:local in ${projectRoot}`)} >&2
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
exec ${quote(electronPath)} ${quote(entry)} "$@"
`;
}

async function checkTarget(target: string) {
  try {
    const info = await lstat(target);
    if (!info.isFile() || (await readFile(target, "utf8")).split("\n")[1] !== marker) {
      throw new Error(`Refusing to replace an unrelated command: ${target}`);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export async function installLaunchers({ binDir, projectRoot, electronPath, version }: LauncherOptions & { binDir: string }) {
  await access(electronPath, constants.X_OK);
  await access(path.join(projectRoot, "dist", "desktop", "main.js"));
  await mkdir(binDir, { recursive: true });
  const targets = [path.join(binDir, "lupp"), path.join(binDir, "LUPP")];
  // Check both names before writing either; never overwrite another program.
  for (const target of targets) await checkTarget(target);
  const source = launcherSource({ projectRoot, electronPath, version });
  const installed: string[] = [];
  for (const target of targets) {
    if (installed.length) {
      const first = await lstat(installed[0]);
      const current = await lstat(target).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      // macOS commonly uses a case-insensitive filesystem: one file serves both names.
      if (current?.ino === first.ino && current.dev === first.dev) continue;
    }
    const temporary = path.join(binDir, `.lupp-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, source, { mode: 0o755, flag: "wx" });
      await rename(temporary, target);
      installed.push(target);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  return installed;
}

async function main() {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("The local launcher currently supports macOS and Linux.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("Lupp requires Node.js 22.12 or newer.");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--bin-dir")) {
    throw new Error("Usage: npm run install:local [-- --bin-dir /absolute/path]");
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const binDir = path.resolve(args[1] || path.join(os.homedir(), ".local", "bin"));
  for (const name of ["lupp", "LUPP"]) await checkTarget(path.join(binDir, name));

  const require = createRequire(import.meta.url);
  const electronPath = require("electron");
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const installed = await installLaunchers({ binDir, projectRoot, electronPath, version });
  console.log(`\nInstalled ${installed.join(" and ")}.\nRun lupp, or LUPP, from any directory.`);
  console.log("Keep this checkout in place. Re-run npm run install:local after updating or moving it.");
  const onPath = (process.env.PATH || "").split(path.delimiter).some((part) => path.resolve(part) === binDir);
  if (!onPath) {
    console.log(`\nAdd this directory to PATH in your shell configuration (e.g. ~/.zshrc), then reopen your terminal:\nexport PATH=${quote(binDir)}:"$PATH"`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(`Lupp installation failed: ${errorMessage(error)}`); process.exitCode = 1; });
}
