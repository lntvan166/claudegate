// Pure navigation math for the one-at-a-time review stepper. No VS Code deps,
// so it unit-tests without a host. The caller supplies already-resolved paths;
// comparison here is exact-string.

export function orderPending(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export type Step =
  | { target: string }
  | { atEnd: "first" | "last" }
  | { empty: true };

// Given the ordered pending list, the currently-open pending path (or undefined),
// and a direction (+1 next / -1 prev), decide where to go.
export function stepPending(ordered: string[], current: string | undefined, dir: 1 | -1): Step {
  if (ordered.length === 0) return { empty: true };
  const i = current === undefined ? -1 : ordered.indexOf(current);
  if (i === -1) return { target: dir === 1 ? ordered[0] : ordered[ordered.length - 1] };
  const j = i + dir;
  if (j < 0) return { atEnd: "first" };
  if (j >= ordered.length) return { atEnd: "last" };
  return { target: ordered[j] };
}

// Resolve `current` to the matching entry in `ordered`. Exact match first; when
// caseInsensitive (win32), fall back to a case-folded match so a drive-letter /
// case mismatch between the editor path and the session key still finds the
// neighbor. Returns undefined if absent (callers then start from first/last).
export function resolveCurrent(
  ordered: string[],
  current: string | undefined,
  caseInsensitive: boolean
): string | undefined {
  if (current === undefined) return undefined;
  if (ordered.includes(current)) return current;
  if (!caseInsensitive) return undefined;
  const lc = current.toLowerCase();
  return ordered.find((p) => p.toLowerCase() === lc);
}

// 1-based position of `path` within the ordered list, plus the total.
export function pendingProgress(
  ordered: string[],
  path: string
): { index: number; total: number } | undefined {
  const i = ordered.indexOf(path);
  return i === -1 ? undefined : { index: i + 1, total: ordered.length };
}
