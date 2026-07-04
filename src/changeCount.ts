// Line-level change counting for ClaudeGate. Kept free of `vscode` imports so
// it can be bundled and run under plain Node for unit tests.
import { diffLines } from "diff";

export interface ChangeCount {
  added: number;
  removed: number;
}

// Count added/removed lines between two versions.
export function countChanges(original: string, current: string): ChangeCount {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(original, current)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

// "+12 -3" / "+7" / "-4" / "no changes".
export function formatChangeCount(c: ChangeCount): string {
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added}`);
  if (c.removed) parts.push(`-${c.removed}`);
  return parts.length ? parts.join(" ") : "no changes";
}
