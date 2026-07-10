// Pure, vscode-free model for the Review Changes webview. Bundled and run under
// plain Node for unit tests (mirrors changeCount.ts) — must NOT import "vscode".
import { diffLines } from "diff";
import { countChanges } from "./changeCount";

export type LineKind = "context" | "add" | "del";
export interface DiffLine { type: "line"; kind: LineKind; oldNum: number | null; newNum: number | null; text: string; }
export interface Fold { type: "fold"; hidden: number; }
export type DiffPiece = DiffLine | Fold;

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
  pieces: DiffPiece[];
  status: "pending" | "kept" | "undone";
  reason?: string;
}

export interface ReviewModel { files: FileDiff[]; reviewedCount: number; totalCount: number; }

// Split diffLines output into a stream of line/fold pieces, collapsing unchanged
// runs longer than 2*contextLines into a single fold marker (keeping contextLines
// of context on each side of every change).
export function computeDiffPieces(before: string, after: string, contextLines = 3): DiffPiece[] {
  const parts = diffLines(before, after);
  // First, expand to a flat list of tagged lines with old/new line numbers.
  const flat: DiffLine[] = [];
  let oldNum = 1, newNum = 1;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing empty from final "\n"
    for (const text of lines) {
      if (part.added) flat.push({ type: "line", kind: "add", oldNum: null, newNum: newNum++, text });
      else if (part.removed) flat.push({ type: "line", kind: "del", oldNum: oldNum++, newNum: null, text });
      else flat.push({ type: "line", kind: "context", oldNum: oldNum++, newNum: newNum++, text });
    }
  }
  // Then fold long context runs. A run of context lines longer than 2*ctx gets
  // its middle replaced by a fold; ctx lines are retained adjacent to changes.
  const changedIdx = new Set<number>();
  flat.forEach((l, i) => { if (l.kind !== "context") changedIdx.add(i); });
  const keep = new Array(flat.length).fill(false);
  if (changedIdx.size === 0) {
    // No changes at all — nothing to render (caller treats as noChange).
    return [];
  }
  for (const i of changedIdx) {
    for (let j = Math.max(0, i - contextLines); j <= Math.min(flat.length - 1, i + contextLines); j++) keep[j] = true;
  }
  const out: DiffPiece[] = [];
  let hidden = 0;
  for (let i = 0; i < flat.length; i++) {
    if (keep[i]) {
      if (hidden > 0) { out.push({ type: "fold", hidden }); hidden = 0; }
      out.push(flat[i]);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push({ type: "fold", hidden });
  return out;
}

export function buildReviewModel(items: ReviewItemInput[], contextLines = 3): ReviewModel {
  const files: FileDiff[] = items.map((it) => {
    const missing = it.after === null;
    const before = it.before ?? "";
    const after = it.after ?? "";
    const noChange = !missing && before === after;
    const counts = missing ? { added: 0, removed: 0 } : countChanges(before, after);
    const pieces = missing || noChange ? [] : computeDiffPieces(before, after, contextLines);
    return {
      relPath: it.relPath,
      isProtected: it.isProtected,
      isNew: it.isNew,
      missing,
      noChange,
      added: counts.added,
      removed: counts.removed,
      pieces,
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
