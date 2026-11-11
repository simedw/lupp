import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { DiffFile, DiffSource } from "./types.js";
import { isDiffSource } from "./diff-source.js";
import { parseUnifiedDiff } from "./lib.js";
import { hasErrorCode } from "./errors.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[], options: { maxBuffer?: number; raw?: boolean } = {}) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024
  });
  return options.raw ? stdout : stdout.trimEnd();
}

async function refExists(repository: string, ref: string) {
  try { await git(repository, ["rev-parse", "--verify", "--quiet", ref]); return true; }
  catch { return false; }
}

export async function findInitialRepository({ repository = process.env.REVIEW_VOICE_REPOSITORY, cwd = process.cwd() } = {}) {
  // An explicit override still wins; loading it will surface any checkout errors.
  if (repository) return path.resolve(cwd, repository);
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    // Outside a work tree is a normal launch, not an error. Preserve other failures
    // (missing Git, permissions, unsafe ownership) so they can be shown to the user.
    if (hasErrorCode(error, 128) && /not a git repository|must be run in a work tree/i.test(String((error as { stderr?: string }).stderr || ""))) return null;
    throw error;
  }
}

export async function inspectRepository(selectedPath: string) {
  const repository = await git(selectedPath, ["rev-parse", "--show-toplevel"]);
  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const branch = await git(repository, ["branch", "--show-current"]);
  let baseRef = "";
  try { baseRef = await git(repository, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); } catch {}
  for (const candidate of [baseRef, "origin/main", "origin/master", "main", "master", "HEAD~1", "HEAD"].filter(Boolean)) {
    if (await refExists(repository, candidate)) { baseRef = candidate; break; }
  }
  const baseSha = await git(repository, ["merge-base", headSha, baseRef]);
  let remote = "";
  try { remote = await git(repository, ["remote", "get-url", "origin"]); } catch {}
  return { repository: path.resolve(repository), name: path.basename(repository), branch: branch || headSha.slice(0, 8), headSha, baseRef, baseSha, remote };
}

export async function loadRepositoryDiff(repository: string, baseRef: string, diffSource: DiffSource = "branch") {
  if (!isDiffSource(diffSource)) throw new Error("Unknown change source");
  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const baseSha = await git(repository, ["merge-base", headSha, baseRef]);
  const revisions = diffSource === "branch" ? [`${baseSha}...${headSha}`] : diffSource === "staged" ? ["--cached", headSha] : [];
  const source = diffSource === "untracked" ? "" : await git(repository, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--find-renames", "--unified=12", ...revisions], { maxBuffer: 128 * 1024 * 1024, raw: true });
  const files = diffSource === "untracked" ? await loadUntrackedFiles(repository) : parseUnifiedDiff(source);
  const snapshotId = createHash("sha256").update(JSON.stringify({ diffSource, baseSha, headSha, source, files })).digest("hex");
  for (const file of files) {
    // Textual approvals follow this file's displayed diff, not unrelated files.
    // Binary files carry their own full blob identities from the Git index line.
    file.reviewId = createHash("sha256").update(JSON.stringify({ diffSource, file })).digest("hex");
  }
  return { baseSha, headSha, source, files, diffSource, snapshotId, capturedAt: new Date().toISOString() };
}

async function loadUntrackedFiles(repository: string): Promise<DiffFile[]> {
  const names = (await git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true })).split("\0").filter(Boolean);
  const files: DiffFile[] = [];
  let remainingBytes = 16 * 1024 * 1024;
  for (const name of names) {
    if (name.split("/").some((part) => [".lupp", ".code-review-voice", ".review-voice-data"].includes(part))) continue;
    const absolute = path.resolve(repository, name);
    if (!absolute.startsWith(`${path.resolve(repository)}${path.sep}`)) continue;
    const file: DiffFile = { path: name, oldPath: name, status: "added", additions: 0, deletions: 0, hunks: [] };
    try {
      const info = await lstat(absolute);
      file.contentHash = `${info.size}:${info.mtimeMs}:${info.mode}`;
      if (!info.isFile()) file.previewMessage = "Non-regular file — preview omitted (symlinks are not followed).";
      else if (info.size > 1024 * 1024 || info.size > remainingBytes) file.previewMessage = "Preview omitted: 1 MiB per file / 16 MiB per untracked snapshot limit.";
      else {
        // A file can change between enumeration and reading. Don't follow a
        // replacement symlink or read an unbounded file that grew in between.
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
          const buffer = Buffer.alloc(Math.min(1024 * 1024, remainingBytes) + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          bytes = buffer.subarray(0, bytesRead);
        } finally { await handle.close(); }
        if (bytes.length > 1024 * 1024 || bytes.length > remainingBytes) {
          file.previewMessage = "Preview omitted: file grew beyond the snapshot size limit.";
          files.push(file);
          continue;
        }
        remainingBytes -= bytes.length;
        file.contentHash = createHash("sha256").update(bytes).digest("hex");
        if (bytes.includes(0)) file.binary = true;
        else {
          const text = bytes.toString("utf8");
          const lines = text ? text.replace(/\n$/, "").split("\n") : [];
          file.additions = lines.length;
          file.hunks = [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, heading: "Untracked file", lines: lines.map((text, index) => ({ type: "add", oldLine: null, newLine: index + 1, text })) }];
        }
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      file.previewMessage = "Unable to read this untracked file.";
    }
    files.push(file);
  }
  return files;
}
