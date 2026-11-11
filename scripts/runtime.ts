import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type RuntimeOptions = {
  platform?: NodeJS.Platform;
  cacheRoot?: string;
  run?: (file: string, args: string[]) => Promise<unknown>;
};

// setName() doesn't change the macOS Dock/app-switcher name. Keep a private,
// branded copy instead of modifying Electron's installed, signed bundle.
export async function luppRuntime(electronPath: string, options: RuntimeOptions = {}): Promise<string> {
  if ((options.platform ?? process.platform) !== "darwin") return electronPath;
  const source = path.resolve(electronPath, "../../..");
  if (path.extname(source) !== ".app") throw new Error(`Expected an Electron app bundle: ${electronPath}`);
  const plist = await readFile(path.join(source, "Contents", "Info.plist"));
  const binary = await stat(electronPath);
  const key = createHash("sha256").update("lupp-runtime-v1").update(source).update(plist)
    .update(`${binary.size}:${binary.mtimeMs}`).digest("hex").slice(0, 20);
  const cacheRoot = options.cacheRoot ?? path.join(os.homedir(), "Library", "Caches", "Lupp", "runtimes");
  const destination = path.join(cacheRoot, key);
  const executable = path.join(destination, "Lupp.app", "Contents", "MacOS", path.basename(electronPath));
  const ready = async () => {
    try {
      await access(path.join(destination, "ready"));
      await access(executable);
      return true;
    } catch { return false; }
  };
  if (await ready()) return executable;

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(cacheRoot, ".prepare-"));
  const bundle = path.join(temporary, "Lupp.app");
  const run = options.run ?? ((file, args) => exec(file, args));
  try {
    // APFS clones share unchanged data; fall back for other filesystem types.
    await run("/bin/cp", ["-cR", source, bundle]).catch(async () => {
      await rm(bundle, { recursive: true, force: true });
      await run("/bin/cp", ["-R", source, bundle]);
    });
    const targetPlist = path.join(bundle, "Contents", "Info.plist");
    for (const field of ["CFBundleName", "CFBundleDisplayName"]) {
      await run("/usr/bin/plutil", ["-replace", field, "-string", "Lupp", targetPlist]);
    }
    // Preserve identity and entitlements, including existing microphone/keychain
    // behavior. Only the outer bundle changed; nested helpers remain untouched.
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags,runtime", bundle]);
    await writeFile(path.join(temporary, "ready"), "Lupp\n", { flag: "wx" });
    try { await rename(temporary, destination); }
    catch (error) {
      // Another launcher may have finished preparing this version first.
      if (!(await ready())) throw error;
    }
    return executable;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
