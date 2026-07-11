# Session History panel (view-only)

**Date:** 2026-07-11
**Status:** approved

## Problem

`clearSession` archives the full session JSON to `~/.claudegate/history/` (a
safety net added in 1.6.1 — clearing aborts if the backup fails), but the
archives are write-only: no way to view, manage, or opt out of them.

## Scope (maintainer-set)

- **View only** — browse past sessions and open each decided record as a native
  before→after diff. No restore/re-apply of archived records, enforced by
  simply not building any such command.
- **Clear controls** — delete one archived session, or clear all of the current
  workspace's history.
- **Opt-out setting** — `claudegate.history.enabled` (default `true`); when off,
  Clear Session stops writing archives.

## Design

### Data & workspace scoping
- Archives are raw `Session` JSON files named after the sanitized sessionId.
  The directory is shared by all workspaces and old files carry no workspace
  marker.
- `archiveSession` now writes the session JSON **augmented with a top-level
  `workspacePath`** (the manager's resolved workspace root) instead of a byte
  copy. Old archives stay as-is.
- Display filter: an archive belongs to the current workspace when its
  `workspacePath` matches (normalized; case-folded on win32), or — fallback for
  old archives — any decided record's path lies under the workspace root.
  Non-matching archives are ignored (not shown, not deleted by Clear History).
- Only **decided** records (accepted[] entries, rejected{} values) are shown;
  an archive with zero decided records is skipped entirely. Pending-at-clear
  entries have no stored "after" content, so they can't render a meaningful
  view-only diff.

### Pure model — `src/historyModel.ts` (vscode-free, node-tested)
```ts
export interface HistoryRecordRef { id: string; path: string; kind: "kept" | "rejected";
  before: string | null; after: string | null; reason?: string; decidedAt?: string; }
export interface HistoryArchiveSummary { file: string; sessionId: string; label: string;
  kept: number; rejected: number; bytes: number; records: HistoryRecordRef[]; }
// null when unparseable or no decided records
export function summarizeArchive(file: string, raw: unknown, bytes: number): HistoryArchiveSummary | null;
// workspacePath equality, else record-path-under-root inference
export function archiveMatchesWorkspace(raw: unknown, workspaceRoot: string,
  caseInsensitive?: boolean): boolean;
```
`label` renders the sessionId ISO timestamp as local `YYYY-MM-DD HH:mm`
(falls back to the raw id). The model has a local 4-line path-under helper so
it stays free of `vscode` imports.

### Panel — `src/historyPanel.ts`
- `HistoryTreeProvider` (TreeDataProvider), view id `claudegate.historyPanel`,
  registered between Rejected and Settings, `when: claudegate.historyCount > 0`
  (context key updated on every refresh).
- Session rows: `<label>` + description `N✓ M✗ · X MB`, collapsed,
  contextValue `claudegate.historySession`, inline `$(trash)` delete.
- Record rows: ✓/✗ theme icon + workspace-relative path (reason in tooltip);
  click runs internal `claudegate.openHistoryRecord`.
- `fs.watch` on the history dir (created lazily) refreshes the tree, so
  archives written/deleted by any window appear live.

### Diff rendering — extend `src/diffProvider.ts`
- `historyRecordUri(archiveFile, recordId, side)` → `claudegate:` URI carrying
  `hist=<archive path>&rec=<id>&side=…` (path kept as the fsPath so syntax
  highlighting works, mirroring `recordUri`).
- `provideTextDocumentContent`: when `hist` is present, load that archive JSON
  (per-path cache; archives are immutable), find the record, return the side.
- `openHistoryRecord` opens `vscode.diff(before, after,
  "Claude Gate (history): <basename> (kept|rejected)")`.

### Commands & setting (package.json + extension.ts)
- `claudegate.clearHistory` — History panel title bar `$(clear-all)`; modal
  confirm with count + total size; deletes only the current workspace's
  matching archives.
- `claudegate.deleteHistorySession` — inline on session rows; warning confirm;
  unlinks that file.
- `claudegate.openHistoryRecord` — internal (registered, not contributed),
  same precedent as `claudegate.openReviewRecord`.
- `claudegate.toggleHistoryEnabled` — palette command flipping the setting.
- Setting `claudegate.history.enabled` (boolean, default `true`): "Archive the
  session to `~/.claudegate/history/` when you run Clear Session, so past
  reviews stay browsable in the History panel."
- Settings panel gets a **Session History** On/Off row (same pattern as
  Auto-advance).

### clearSession interaction
- `SessionManager.clearSession(opts?: { archive?: boolean })` — default `true`.
  With `archive: false` the backup is skipped **and the abort-if-backup-fails
  guard does not apply** (explicit opt-out). The caller (extension.ts) reads
  the setting and passes it; SessionManager stays config-free.
- The Clear Session confirm dialog appends "History saving is off — this
  permanently deletes the review log." when the setting is disabled.

## Testing
- `historyModel.test.ts` (node): summarize (counts/label/bytes; null on garbage
  or no decided records), workspace matching (workspacePath match, inference
  fallback, win32 case-fold), record extraction incl. reject reason.
- `sessionManager.test.ts` additions: archive file now contains
  `workspacePath`; `clearSession({archive:false})` deletes without writing an
  archive even when the history dir is unwritable (guard bypassed).
- Panel render test following the `worktreePanel.test.ts` vscode-stub pattern:
  session + record rows from a seeded history dir; historyCount context.
- Manual: seed via `manual-test-seed.py`, decide files, Clear Session, browse
  History, open record diffs, per-session delete, Clear History, toggle the
  setting off and confirm no new archive + adapted dialog wording.

## Non-goals
- Restore/re-apply from history; retention caps/auto-pruning; cross-workspace
  history browsing; showing pending-at-clear entries.
