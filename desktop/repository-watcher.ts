import { watch, statSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryChange } from "./types.js";

const exec = promisify(execFile);
const localSources = ["local", "unstaged", "untracked"] as const;
const allSources = ["branch", "staged", ...localSources] as const;

export function ignoredWatchPath(name: string) {
  return name.split(/[\\/]/).some((part) => [".lupp", ".code-review-voice", ".review-voice-data"].includes(part)) || /(?:\.sw[pox]|~)$/.test(name);
}

// Watch directories, not file inodes: editors commonly save by atomic rename.
// Only Git-visible directories and their ancestors are watched, not ignored
// dependency/build trees. Git metadata is watched separately for staging and
// linked-worktree HEAD/index changes. No periodic scan in native-watch mode.
export async function watchRepository(repository: string, notify: (change: RepositoryChange) => void, options: { debounceMs?: number; fallbackMs?: number; maxWatchers?: number } = {}) {
  const watchers = new Map<string, FSWatcher>();
  const identities = new Map<string, string>();
  let stopped = false;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingMetadata = false;
  let pendingStructure = false;
  let busy = false;
  let pending = false;
  const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  let commonDir = "";
  const metadataDirs = new Set<string>();

  const emit = (metadata: boolean) => {
    if (!stopped) notify({ repository, sources: [...(metadata ? allSources : localSources)], mode: fallback ? "fallback" : "native" });
  };
  const useFallback = () => {
    if (stopped || fallback) return;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    identities.clear();
    fallback = setInterval(() => emit(true), options.fallbackMs ?? 30_000);
    fallback.unref();
    emit(true);
  };
  const queue = (metadata: boolean, structure: boolean) => {
    if (stopped || fallback) return;
    pending = true;
    pendingMetadata ||= metadata;
    pendingStructure ||= structure;
    if (!timer && !busy) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, options.debounceMs ?? 1500);
      timer.unref();
    }
  };
  const reconcile = async () => {
    const names = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
    if (stopped || fallback) return;
    const targets = new Map<string, boolean>([[repository, false]]);
    for (const name of names) {
      if (ignoredWatchPath(name)) continue;
      let parent = path.dirname(path.resolve(repository, name));
      while (parent.startsWith(`${repository}${path.sep}`)) { targets.set(parent, false); parent = path.dirname(parent); }
    }
    for (const directory of metadataDirs) targets.set(directory, true);
    targets.set(path.join(commonDir, "info"), true);
    // Ref updates happen below refs/heads and refs/remotes, also in worktrees.
    const refs = (await git("for-each-ref", "--format=%(refname)")).split("\n").filter(Boolean);
    if (stopped || fallback) return;
    for (const ref of [...refs, "refs/heads/placeholder", "refs/remotes/placeholder"]) {
      let parent = path.dirname(path.join(commonDir, ref));
      while (parent.startsWith(`${commonDir}${path.sep}`)) { targets.set(parent, true); parent = path.dirname(parent); }
    }
    if (targets.size > (options.maxWatchers ?? 512)) { useFallback(); return; }
    for (const [directory, watcher] of watchers) {
      if (!targets.has(directory)) { watcher.close(); watchers.delete(directory); identities.delete(directory); }
    }
    for (const [directory, metadata] of targets) {
      try {
        const stat = statSync(directory);
        const identity = `${stat.dev}:${stat.ino}`;
        if (watchers.has(directory) && identities.get(directory) === identity) continue;
        watchers.get(directory)?.close();
        watchers.delete(directory);
        const watcher = watch(directory, { persistent: false }, (event, filename) => {
          const name = filename?.toString() || "";
          if (metadata && (name.endsWith(".lock") || ["objects", "logs", "COMMIT_EDITMSG", "FETCH_HEAD", "ORIG_HEAD"].includes(name))) return;
          if (!metadata && (name === ".git" || ignoredWatchPath(path.relative(repository, path.join(directory, name))))) return;
          queue(metadata, event === "rename" || name === ".gitignore" || (metadata && name === "exclude"));
        });
        watcher.on("error", useFallback);
        watchers.set(directory, watcher);
        identities.set(directory, identity);
      } catch (error) {
        watchers.get(directory)?.close();
        watchers.delete(directory);
        // A removed working directory or a not-yet-created refs folder is
        // covered by its watched parent. Resource/permission errors fall back.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { useFallback(); return; }
      }
    }
  };
  const flush = async () => {
    if (stopped || fallback || busy) return;
    busy = true;
    const metadata = pendingMetadata;
    const structure = pendingStructure;
    pending = pendingMetadata = pendingStructure = false;
    try {
      if (structure) await reconcile();
      if (!fallback) emit(metadata);
    } catch { useFallback(); }
    finally {
      busy = false;
      if (pending) queue(pendingMetadata, pendingStructure);
    }
  };
  try {
    metadataDirs.add((await git("rev-parse", "--absolute-git-dir")).trim());
    commonDir = path.resolve(repository, (await git("rev-parse", "--git-common-dir")).trim());
    metadataDirs.add(commonDir);
    await reconcile();
    // Close the small gap between loading the initial diff and installing watches.
    queue(true, false);
  } catch { useFallback(); }
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(fallback);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      identities.clear();
    }
  };
}
