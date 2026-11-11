import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewedFile, ReviewMetadata } from "./types.js";
import { isDiffSource } from "./diff-source.js";
import type { ReviewObservation } from "./agents/types.js";
import { errorMessage, hasErrorCode } from "./errors.js";

function branchFileName(branch: string) {
  const value = String(branch || "detached");
  const slug = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "detached";
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${slug}-${suffix}.json`;
}

export function reviewFilePath(metadata: ReviewMetadata) {
  if (!path.isAbsolute(metadata?.repository || "")) throw new Error("A repository path is required");
  return path.join(metadata.repository, ".lupp", "reviews", branchFileName(metadata.branch));
}

export async function loadReview(metadata: ReviewMetadata): Promise<{ observations: ReviewObservation[]; file: string; reviewedFiles: ReviewedFile[] }> {
  const file = reviewFilePath(metadata);
  try {
    const review = JSON.parse(await readFile(file, "utf8"));
    const reviewedFiles = Array.isArray(review.reviewedFiles) ? review.reviewedFiles.filter((item: ReviewedFile) => item && typeof item.path === "string" && typeof item.reviewId === "string" && isDiffSource(item.source)) : [];
    return { ...review, observations: Array.isArray(review.observations) ? review.observations : [], reviewedFiles, file };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { observations: [], reviewedFiles: [], file };
    throw new Error(`Could not read saved review ${file}: ${errorMessage(error)}`);
  }
}

export async function saveReview(metadata: ReviewMetadata, observations: ReviewObservation[], reviewedFiles: ReviewedFile[] = []) {
  const file = reviewFilePath(metadata);
  await mkdir(path.dirname(file), { recursive: true });
  const review = {
    version: 1,
    repository: metadata.repository,
    branch: metadata.branch,
    baseRef: metadata.baseRef,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    updatedAt: new Date().toISOString(),
    observations,
    reviewedFiles
  };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return { ...review, file };
}
