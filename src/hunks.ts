// Hunk model for per-hunk revert. Kept free of `vscode` imports so it bundles+runs
// under Node for unit tests.
import { diffLines } from "diff";

export interface Hunk {
  startLine: number; // 0-based current-doc line where the hunk begins (for the CodeLens)
  label: string;     // "+A -R" summary
}

// A hunk = a maximal run of consecutive changed diff parts (added/removed),
// bounded by unchanged runs.
export function computeHunks(original: string, current: string): Hunk[] {
  const parts = diffLines(original, current);
  const lastLine = Math.max(0, current.split("\n").length - 1);
  const hunks: Hunk[] = [];
  let cur = 0;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) { cur += p.count ?? 0; i++; continue; }
    const start = cur;
    let added = 0;
    let removed = 0;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      const n = q.count ?? 0;
      if (q.added) { added += n; cur += n; } else { removed += n; }
      i++;
    }
    hunks.push({ startLine: Math.min(start, lastLine), label: `+${added} -${removed}` });
  }
  return hunks;
}

// Rebuild the full file text with the Nth hunk reverted to baseline: emit the
// CURRENT side for every part except the target hunk's parts, which emit the
// ORIGINAL side. Part values carry their own newlines, so this is newline-safe.
export function revertHunkText(original: string, current: string, hunkIndex: number): string {
  const parts = diffLines(original, current);
  let out = "";
  let hunk = -1;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) { out += p.value; i++; continue; }
    hunk++;
    const target = hunk === hunkIndex;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      if (target) {
        if (q.removed) out += q.value; // revert → original side
      } else {
        if (q.added) out += q.value;   // keep → current side
      }
      i++;
    }
  }
  return out;
}
