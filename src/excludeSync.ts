// Hand `claudegate.exclude` to hook.py so excluded files are never captured.
//
// Exclude used to be display-only: the hook captured an excluded file — full
// `originalContent` and all — and the extension merely hid the entry. On a real
// workspace that excluded `.superpowers/sdd`, 154 of 263 pending entries were
// invisible rows that still cost a session-file write, a reload and a reconcile
// on every capture. The hook runs in a separate process and cannot read VS Code
// settings, so the active globs are written to a file it can.
//
// Shape: `{ "<resolved workspace root>": ["<glob>", ...] }`. Every open window
// shares the file, so this MERGES, exactly like workspace-roots.json: a window
// rewriting it whole would erase every other window's patterns. Kept free of
// `vscode` imports so it can be unit-tested under plain node.

import * as fs from "fs";
import * as path from "path";

export const EXCLUDES_FILENAME = "excludes.json";

/** The globs mapped to `true` — the same filter ExcludeMatcher.reload applies. */
export function activeGlobs(excludeMap: Record<string, boolean> | undefined): string[] {
  if (!excludeMap) return [];
  return Object.entries(excludeMap)
    .filter(([, active]) => active === true)
    .map(([glob]) => glob);
}

/**
 * Record `globs` as the exclude set for `workspaceRoot`, keeping every other
 * window's entry whose root still exists on disk. Writes atomically (temp file
 * + rename) because the hook may read it at any moment, and skips the write when
 * nothing changed so a config event that did not touch exclude costs nothing.
 * Never throws: a failure only means the hook falls back to capturing.
 */
export function persistExcludes(claudegateDir: string, workspaceRoot: string, globs: string[]): void {
  try {
    const file = path.join(claudegateDir, EXCLUDES_FILENAME);
    let existing: Record<string, unknown> = {};
    let previousRaw = "";
    try {
      previousRaw = fs.readFileSync(file, "utf-8");
      const parsed: unknown = JSON.parse(previousRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or malformed — start fresh.
    }

    const merged: Record<string, string[]> = {};
    for (const [root, value] of Object.entries(existing)) {
      if (!Array.isArray(value) || !fs.existsSync(root)) continue;
      merged[root] = value.filter((g): g is string => typeof g === "string");
    }
    const key = path.resolve(workspaceRoot);
    if (globs.length > 0) {
      merged[key] = [...globs];
    } else {
      delete merged[key];
    }

    const content = JSON.stringify(merged, null, 2);
    if (content === previousRaw) return;
    fs.mkdirSync(claudegateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    // Fail open: the hook simply keeps capturing excluded files, which the
    // extension still hides.
  }
}
