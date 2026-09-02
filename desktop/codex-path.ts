import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

async function isExecutable(candidate: string) {
  if (!candidate) return false;
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(platform: string) {
  return platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
}

async function nativeNpmExecutable(candidate: string, platform: string, arch: string) {
  const entry = await realpath(candidate);
  if (path.basename(entry) !== "codex.js") return candidate;
  const packageRoot = path.resolve(path.dirname(entry), "..");
  const manifestPath = path.join(packageRoot, "package.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { return candidate; }
  if (manifest.name !== "@openai/codex") return candidate;

  // Match the installed CLI's platform-package layout, including older bundles.
  const cpus: Record<string, string> = { arm64: "aarch64", x64: "x86_64" };
  const targets: Record<string, string> = { darwin: "apple-darwin", linux: "unknown-linux-musl", win32: "pc-windows-msvc" };
  const cpu = cpus[arch];
  const target = targets[platform];
  if (!cpu || !target) throw new Error(`Unsupported Codex platform: ${platform}/${arch}`);
  const triple = `${cpu}-${target}`;
  const vendorRoots = [];
  try {
    const require = createRequire(manifestPath);
    const platformManifest = require.resolve(`@openai/codex-${platform === "win32" ? "win32" : platform}-${arch}/package.json`);
    vendorRoots.push(path.join(path.dirname(platformManifest), "vendor"));
  } catch { /* Older releases carry vendor binaries in the main package. */ }
  vendorRoots.push(path.join(packageRoot, "vendor"));
  for (const vendor of vendorRoots) {
    for (const directory of ["bin", "codex"]) {
      const binary = path.join(vendor, triple, directory, platform === "win32" ? "codex.exe" : "codex");
      if (await isExecutable(binary)) return binary;
    }
  }
  throw new Error(`The installed Codex package has no native binary for ${platform}/${arch}. Reinstall Codex or set REVIEW_VOICE_CODEX_PATH to a native Codex executable.`);
}

type ExecutableEnvironment = { home: string; platform: string; arch: string; pathValue: string };
async function stableExecutable(candidate: string, { home, platform, arch, pathValue }: ExecutableEnvironment) {
  // Only unwrap recognized asdf shims, leaving custom launchers untouched.
  if (path.basename(path.dirname(candidate)) === "shims") {
    const source = await readFile(candidate, "utf8");
    if (/^# asdf-plugin:/m.test(source)) {
      const asdfCandidates = [
        path.join(path.dirname(path.dirname(candidate)), "bin", "asdf"),
        path.join(home, ".asdf", "bin", "asdf"),
        ...pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "asdf"))
      ];
      let asdf = null;
      for (const executable of new Set(asdfCandidates)) {
        if (await isExecutable(executable)) { asdf = executable; break; }
      }
      if (!asdf) throw new Error("Found a Codex asdf shim but could not find asdf. Set REVIEW_VOICE_CODEX_PATH to a native Codex executable.");
      let installed;
      try {
        // Resolve the user's default installation, not the reviewed project's
        // .tool-versions. Do not pin Node or alter the agent's environment.
        const result = await exec(asdf, ["which", "codex"], { cwd: home, timeout: 5000, maxBuffer: 64 * 1024 });
        installed = result.stdout.trim();
      } catch {
        throw new Error("Could not resolve Codex through asdf from your home directory. Check 'asdf which codex' there or set REVIEW_VOICE_CODEX_PATH to a native Codex executable.");
      }
      if (!path.isAbsolute(installed) || installed === candidate || !(await isExecutable(installed))) {
        throw new Error("asdf did not resolve an installed Codex executable. Set REVIEW_VOICE_CODEX_PATH to a native Codex executable.");
      }
      return nativeNpmExecutable(installed, platform, arch);
    }
  }
  return nativeNpmExecutable(candidate, platform, arch);
}

export async function resolveCodexExecutable({
  override = process.env.REVIEW_VOICE_CODEX_PATH,
  pathValue = process.env.PATH || "",
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch
}: Partial<ExecutableEnvironment> & { override?: string } = {}) {
  if (override) {
    const explicit = path.resolve(override.replace(/^~(?=$|[\\/])/, home));
    if (await isExecutable(explicit)) return stableExecutable(explicit, { home, platform, arch, pathValue });
    throw new Error(`REVIEW_VOICE_CODEX_PATH is not executable: ${explicit}`);
  }

  const names = executableNames(platform);
  const candidates = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory, name));
  }
  for (const directory of [
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ]) {
    for (const name of names) candidates.push(path.join(directory, name));
  }

  for (const candidate of new Set(candidates)) {
    if (await isExecutable(candidate)) return stableExecutable(path.resolve(candidate), { home, platform, arch, pathValue });
  }
  return null;
}
