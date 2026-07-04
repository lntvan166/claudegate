# ClaudeGate Configuration: Watcher Toggle & Exclude Patterns

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Related:** `src/extension.ts`, `src/documentTracker.ts`, `src/sessionManager.ts`, `src/reviewPanel.ts`, `src/decorationProvider.ts`, `src/workspaceScope.ts`, `package.json`, `readme.md`

## Problem

ClaudeGate has two capture paths: the CLI `PreToolUse` hook (`hook.py`) and the GUI `DocumentTracker` file watcher. The file watcher only observes *filesystem changes* — it cannot tell who caused them, so manual edits, formatters, codegen, and git operations can surface as spurious review items. Two concrete gaps:

1. **No way to disable the watcher.** A terminal-CLI user, fully covered by the authoritative hook, cannot turn the watcher off to avoid its false positives.
2. **No way to exclude files.** Generated files (`*.pb.go`, `dist/**`, etc.) always appear in the review, cluttering the panel and counts, with no per-project pattern control like VS Code's `search.exclude`.

## Non-Goals

- **Fixing GUI watcher attribution** (distinguishing Claude edits from manual/tool/git edits for GUI/Codex/Cursor users) — tracked as a separate future design. This spec only adds a toggle and exclude filtering.
- **Teaching the Python hook about excludes** — excludes are enforced in the extension only (see Product Decisions). The hook is untouched.
- **Destructive session cleanup** — exclusion is non-destructive; no entries are deleted.

## Product Decisions

- **Watcher default ON** (`claudegate.fileWatcher.enabled: true`) so existing GUI users are not broken by the change.
- **Exclusion is non-destructive and enforced in the extension.** Excluded files are hidden from the panel, counts, badges, and bulk actions, and skipped by the watcher at capture time — but never deleted from the session file. Clearing a pattern makes them reappear on the next refresh. This covers both capture paths (hook-captured excluded files are hidden at display time) without syncing patterns into the Python hook.
- **Exclude config shape mirrors `search.exclude`** — a glob→boolean object map, familiar to VS Code users.
- **Settings apply live** (via `onDidChangeConfiguration`), no window reload required.

## Settings (`contributes.configuration`)

```jsonc
"claudegate.fileWatcher.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Capture Claude Code GUI-extension edits by watching the filesystem. Disable if you use only the terminal CLI (the PreToolUse hook) — the hook is more accurate and the watcher can surface manual edits, formatter/codegen output, and git operations as false review items."
},
"claudegate.exclude": {
  "type": "object",
  "default": {},
  "additionalProperties": { "type": "boolean" },
  "markdownDescription": "Glob patterns whose matching files are hidden from ClaudeGate review (shaped like `search.exclude`). Matching files are skipped by the file watcher and hidden from the panel, counts, and badges even if captured by the CLI hook — nothing is deleted. Example: `{ \"**/*.pb.go\": true, \"**/dist/**\": true }`."
}
```

An entry mapped to `false` is inactive (same semantics as `search.exclude`).

## Architecture

```
Settings (claudegate.fileWatcher.enabled, claudegate.exclude)
        │
        ├─ extension.ts activate / onDidChangeConfiguration
        │     ├─ fileWatcher.enabled → documentTracker.start() / stop()   ← NEW (live)
        │     └─ claudegate.exclude  → excludeMatcher.reload() + refresh   ← NEW (live)
        │
        ├─ excludeMatcher.ts: isExcluded(filePath)   ← NEW module
        │
        ├─ DocumentTracker.processFsEventBatch: skip if isExcluded         ← NEW (capture-time)
        │
        └─ display/action layer (both capture paths):                      ← NEW (isExcluded ∧ isInWorkspace)
              SessionManager.getPendingCount / acceptAll / rejectAll
              reviewPanel trees, extension.ts counts, decorationProvider
```

## Components

### New: `src/excludeMatcher.ts`

A small, `vscode`-free-at-core module for glob exclusion.

```typescript
// Compiles claudegate.exclude globs to RegExp once; re-run reload() on config change.
export class ExcludeMatcher {
  private patterns: RegExp[] = [];
  reload(excludeMap: Record<string, boolean>): void; // build RegExp[] from active (true) globs
  isExcluded(filePath: string): boolean;              // test workspace-relative + absolute path
}
// Pure glob→RegExp helper (no dependency): supports ** (any depth), * (segment), ? (one char).
export function globToRegExp(glob: string): RegExp;
```

- `isExcluded` normalizes the path (POSIX separators) and tests it against each compiled pattern; matching is against the path as seen relative to the workspace root, and also the absolute path, so `**/*.pb.go` and `**/dist/**` behave intuitively.
- Empty/all-`false` map → `patterns` empty → `isExcluded` always `false`.
- `globToRegExp`: escape regex metachars, then translate `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`. Anchored full-match.
- A single module-level instance is created in `extension.ts` and shared; `workspaceScope.ts` gains a thin `isExcluded(filePath)` that delegates to it, so call sites read `isInWorkspace(fp) && !isExcluded(fp)`.

### Modified: `src/workspaceScope.ts`

Add `isExcluded(filePath: string): boolean` delegating to the shared `ExcludeMatcher`, and a setter/inject point so `extension.ts` can wire the instance. Keeps a single source of truth for scope + exclusion, mirroring the existing `isInWorkspace` pattern.

### Modified: `src/extension.ts`

- On activate: construct the `ExcludeMatcher`, load `claudegate.exclude`, wire it into `workspaceScope`.
- Gate `documentTracker.start()` behind `claudegate.fileWatcher.enabled` (default `true`).
- Register `vscode.workspace.onDidChangeConfiguration`:
  - `claudegate.fileWatcher.enabled` changed → `start()` or `stop()` the tracker accordingly.
  - `claudegate.exclude` changed → `excludeMatcher.reload(...)`, then refresh the review panel + recompute counts/badges (fire the existing session-change path).
- Where session-change counts are computed for badges/status bar/context keys, count only `isInWorkspace(fp) && !isExcluded(fp)`.
- Log a one-line INFO when the watcher is disabled by config.

### Modified: `src/documentTracker.ts`

In `processFsEventBatch`, extend the per-candidate skip (next to `isIgnoredPath`) to also skip `isExcluded(filePath)`, so excluded files never enter the session via the watcher. (The `isIgnoredPath` hardcoded `IGNORED_DIRS` remains as a baseline; `claudegate.exclude` is additive and user-controlled.)

### Modified: `src/sessionManager.ts`

`getPendingCount`, `acceptAll`, `rejectAll` already filter with `isInWorkspace`; extend each to `isInWorkspace(fp) && !isExcluded(fp)` so excluded files are neither counted nor mutated by bulk actions.

### Modified: `src/reviewPanel.ts`

The three trees (Pending / Accepted / Rejected) filter displayed entries with `isInWorkspace`; extend to also drop `isExcluded(fp)`.

### Modified: `src/decorationProvider.ts`

Do not decorate excluded files (they are not shown as pending), consistent with the display filter.

### Modified: `package.json`

- Add the `contributes.configuration` block above.
- Update the `description` field to mention the two detection paths and the `claudegate.fileWatcher.enabled` accuracy tip for terminal users.

### Modified: `readme.md`

Add an **Extension Settings** section documenting both settings with examples, and a note that terminal-CLI users can disable the watcher for best accuracy.

## Error Handling

- Invalid/garbage glob strings: `globToRegExp` wraps compilation in try/catch; a pattern that fails to compile is skipped and logged at WARN, never throwing (fail-open — the file is simply not excluded).
- Missing/absent config: treated as defaults (`enabled: true`, `exclude: {}`).
- Toggling the watcher off mid-session: `stop()` disposes watchers and clears snapshots; already-captured entries remain reviewable. Toggling on re-`start()`s and re-snapshots open documents.

## Testing

**Automated:** `npm run typecheck` and `npm run compile` must pass.

**`excludeMatcher` (pure functions — validated via a small standalone check or manual):**
1. `globToRegExp("**/*.pb.go")` matches `api/user.pb.go`, not `api/user.go`.
2. `**/dist/**` matches `pkg/dist/index.js`, not `pkg/distinct/index.js`.
3. `?` matches exactly one non-separator char.
4. Empty map / all-`false` → `isExcluded` always `false`.
5. Invalid glob → skipped, no throw.

**Manual (Extension Development Host):**
6. `claudegate.fileWatcher.enabled: false` → a GUI-extension edit is NOT captured; a terminal CLI edit (hook) still is.
7. Toggle back to `true` (no reload) → watcher captures again.
8. Set `claudegate.exclude: { "**/*.pb.go": true }` → a `*.pb.go` change (even hook-captured) is absent from the panel and excluded from counts/badges; a normal file still appears.
9. Clear the pattern (no reload) → previously hidden hook-captured entry reappears on refresh.
10. `Accept All` / `Reject All` do not touch excluded files.

## Release

- **No version bump.** 1.2.0 has not shipped yet, so this work folds into the existing unreleased `1.2.0` (package.json stays `1.2.0`).
- Extend the existing `## [1.2.0]` CHANGELOG entry with an **Added** section: `claudegate.fileWatcher.enabled` and `claudegate.exclude` settings; README/description docs. Do not create a new version heading.
- No hook changes → no Setup Hook re-run required.
