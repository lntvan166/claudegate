// Pure, vscode-free model for the Review Changes webview. Bundled and run under
// plain Node for unit tests (mirrors changeCount.ts) — must NOT import "vscode".
//
// The webview is a review QUEUE: a per-file summary (name, +/- counts, status).
// The actual diff is shown in VS Code's native diff editor (see diffProvider),
// so this model never produces rendered diff content — only summary metadata.
import { countChanges } from "./changeCount";

export interface ReviewItemInput {
  relPath: string;                       // workspace-relative, '/'-separated (display + feedback)
  before: string | null;                 // baseline; null ⇒ Claude created the file
  after: string | null;                  // current disk content (pending) or record.after (decided); null ⇒ missing on disk
  status: "pending" | "kept" | "undone";
  isNew: boolean;
  isProtected: boolean;
  reason?: string;                       // undone-only
}

export interface FileDiff {
  relPath: string;
  isProtected: boolean;
  isNew: boolean;
  missing: boolean;                      // after === null
  noChange: boolean;                     // before === after (transient no-op)
  added: number;
  removed: number;
  status: "pending" | "kept" | "undone";
  reason?: string;
}

export interface ReviewModel { files: FileDiff[]; reviewedCount: number; totalCount: number; }

export function buildReviewModel(items: ReviewItemInput[]): ReviewModel {
  const files: FileDiff[] = items.map((it) => {
    const missing = it.after === null;
    const before = it.before ?? "";
    const after = it.after ?? "";
    const noChange = !missing && before === after;
    const counts = missing ? { added: 0, removed: 0 } : countChanges(before, after);
    return {
      relPath: it.relPath,
      isProtected: it.isProtected,
      isNew: it.isNew,
      missing,
      noChange,
      added: counts.added,
      removed: counts.removed,
      status: it.status,
      ...(it.reason ? { reason: it.reason } : {}),
    };
  });
  const reviewedCount = items.filter((i) => i.status !== "pending").length;
  return { files, reviewedCount, totalCount: items.length };
}

export function buildFeedbackText(items: ReviewItemInput[]): string {
  const kept = items.filter((i) => i.status === "kept");
  const undone = items.filter((i) => i.status === "undone");
  const pending = items.filter((i) => i.status === "pending");
  const blocks: string[] = ["I reviewed your changes. Per file:"];
  if (kept.length) blocks.push("KEPT:\n" + kept.map((i) => `- ${i.relPath}`).join("\n"));
  if (undone.length) {
    blocks.push(
      "REVERTED (don't re-apply as-is):\n" +
      undone.map((i) => (i.reason ? `- ${i.relPath} — ${i.reason}` : `- ${i.relPath}`)).join("\n")
    );
  }
  if (pending.length) blocks.push("Still reviewing:\n" + pending.map((i) => `- ${i.relPath}`).join("\n"));
  return blocks.join("\n\n") + "\n";
}
