import type { DiffMode } from "./types";

interface Props {
  reviewedCount: number; totalCount: number;
  counts: { kept: number; rejected: number; pending: number };
  diffMode: DiffMode;
  onDiffMode(m: DiffMode): void;
  onFeedback(): void; onKeepAll(): void; onRejectAll(): void;
}

export function Toolbar(p: Props) {
  const total = Math.max(1, p.counts.kept + p.counts.rejected + p.counts.pending);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div class="cg-toolbar">
      <span class="cg-title">◈ Claude <b>Gate</b> — Review</span>
      <div class="cg-rail" role="img"
           aria-label={`${p.counts.kept} kept, ${p.counts.rejected} rejected, ${p.counts.pending} pending`}>
        <i class="k" style={{ width: pct(p.counts.kept) }} />
        <i class="r" style={{ width: pct(p.counts.rejected) }} />
        <i class="p" style={{ width: pct(p.counts.pending) }} />
      </div>
      <span class="cg-tally">{p.reviewedCount} of {p.totalCount} reviewed</span>
      <span class="cg-spacer" />
      <div class="cg-seg" role="group" aria-label="Diff layout">
        <button class={p.diffMode === "unified" ? "on" : ""} aria-pressed={p.diffMode === "unified"}
                onClick={() => p.onDiffMode("unified")}>Unified</button>
        <button class={p.diffMode === "split" ? "on" : ""} aria-pressed={p.diffMode === "split"}
                onClick={() => p.onDiffMode("split")}>Split</button>
      </div>
      <button class="cg-btn" onClick={p.onFeedback}>💬 Feedback to AI</button>
      <button class="cg-btn undo" onClick={p.onRejectAll}>Reject all</button>
      <button class="cg-btn keep" onClick={p.onKeepAll}>Keep all</button>
    </div>
  );
}
