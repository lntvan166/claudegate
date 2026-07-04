// Classify which CURRENT-document lines changed vs a baseline. vscode-free so
// it bundles+runs under Node for unit tests.
import { diffLines } from "diff";

export interface ChangedLines {
  added: number[];
  modified: number[];
  deleted: number[];
}

// removed-block immediately followed by added-block → those added lines are `modified`;
// lone added-block → `added`; lone removed-block → `deleted` (boundary line, clamped).
// Line indices are 0-based positions in `current`.
export function classifyChangedLines(original: string, current: string): ChangedLines {
  const added: number[] = [];
  const modified: number[] = [];
  const deleted: number[] = [];
  const parts = diffLines(original, current);
  const lastLine = Math.max(0, current.split("\n").length - 1);
  let cur = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        const n = next.count ?? 0;
        for (let k = 0; k < n; k++) modified.push(cur + k);
        cur += n;
        i++; // consume the paired added part
      } else {
        deleted.push(Math.min(cur, lastLine));
      }
    } else if (p.added) {
      const n = p.count ?? 0;
      for (let k = 0; k < n; k++) added.push(cur + k);
      cur += n;
    } else {
      cur += p.count ?? 0;
    }
  }
  return { added, modified, deleted };
}
