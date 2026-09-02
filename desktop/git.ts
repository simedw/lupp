import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { parseUnifiedDiff } from "./lib.js";
import { hasErrorCode } from "./errors.js";

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[], options: { maxBuffer?: number } = {}) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024
  });
  return stdout.trimEnd();
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
  for (const candidate of [baseRef, "origin/main", "origin/master", "main", "master", "HEAD~1"].filter(Boolean)) {
    if (await refExists(repository, candidate)) { baseRef = candidate; break; }
  }
  const baseSha = await git(repository, ["merge-base", headSha, baseRef]);
  let remote = "";
  try { remote = await git(repository, ["remote", "get-url", "origin"]); } catch {}
  return { repository: path.resolve(repository), name: path.basename(repository), branch: branch || headSha.slice(0, 8), headSha, baseRef, baseSha, remote };
}

export async function loadRepositoryDiff(repository: string, baseRef: string) {
  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const baseSha = await git(repository, ["merge-base", headSha, baseRef]);
  const source = await git(repository, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=12", `${baseSha}...${headSha}`], { maxBuffer: 128 * 1024 * 1024 });
  return { baseSha, headSha, source, files: parseUnifiedDiff(source) };
}
