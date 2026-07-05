// Pure decision for which "after" side a review diff should show — kept
// vscode-free so it can be unit-tested. openDiff renders the result.
//
//   pending  → "disk"   : baseline ↔ current file on disk (the live proposal)
//   accepted → "claude" : baseline ↔ saved accepted content (what you accepted)
//   rejected → "claude" : baseline ↔ saved rejected content (what you discarded)
//
// A reviewed entry with no saved snapshot falls back to "disk".

import type { ReviewStatus } from "./sessionManager";

export type DiffRightSide = "disk" | "claude";

export function chooseRightSide(
  reviewStatus: ReviewStatus,
  hasClaudeSnapshot: boolean
): DiffRightSide {
  const isReviewed = reviewStatus === "accepted" || reviewStatus === "rejected";
  return isReviewed && hasClaudeSnapshot ? "claude" : "disk";
}
