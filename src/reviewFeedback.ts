// Pure, vscode-free builders for the "Copy Feedback to AI" export: turn a
// review session into a paste-ready summary of kept / rejected(+reasons) /
// still-pending files. Runs under plain node for unit tests.
import type { Session } from "./reviewModel";

export interface ReviewItemInput {
  relPath: string;                       // workspace-relative, '/'-separated
  status: "pending" | "kept" | "undone";
  reason?: string;                       // undone-only
}

// Build feedback items straight from a Session. Status precedence per path:
// a currently-pending entry wins, else the latest reject, else the latest
// accept. `relPath` maps absolute session paths for display; `inScope`
// filters out-of-workspace/excluded paths.
export function sessionFeedbackItems(
  session: Session,
  relPath: (absPath: string) => string,
  inScope: (absPath: string) => boolean
): ReviewItemInput[] {
  const byPath = new Map<string, ReviewItemInput>();
  const add = (abs: string, status: "pending" | "kept" | "undone", reason?: string) => {
    if (!inScope(abs) || byPath.has(abs)) return;
    byPath.set(abs, { relPath: relPath(abs), status, ...(reason ? { reason } : {}) });
  };
  for (const abs of Object.keys(session.files)) add(abs, "pending");
  for (const [abs, rec] of Object.entries(session.rejected)) add(abs, "undone", rec.reason);
  // accepted[] is append-only; iterate newest-first so the latest record wins.
  for (const rec of [...session.accepted].reverse()) add(rec.path, "kept");
  return [...byPath.values()];
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
