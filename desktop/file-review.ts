import type { DiffFile, DiffSource, ReviewedFile } from "./types.js";

export function isFileReviewed(files: readonly ReviewedFile[], file: DiffFile, source: DiffSource) {
  return Boolean(file.reviewId && files.some((item) => item.path === file.path && item.source === source && item.reviewId === file.reviewId));
}

export function updateReviewedFiles(files: readonly ReviewedFile[], file: ReviewedFile, reviewed: boolean): ReviewedFile[] {
  const remaining = files.filter((item) => item.path !== file.path || item.source !== file.source);
  return reviewed ? [...remaining, { path: file.path, source: file.source, reviewId: file.reviewId }] : remaining;
}
