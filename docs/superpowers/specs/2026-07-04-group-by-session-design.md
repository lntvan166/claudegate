# Group Pending Review by Claude Session

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Related:** `hooks/hook.py`, `src/sessionManager.ts`, `src/reviewPanel.ts`, `src/settingsPanel.ts`, `src/extension.ts`, `package.json`

## Problem

Multiple Claude Code sessions can run at once in the **same workspace**. They all write into one per-workspace session file with a flat `files` map, so the review panels mix every session's changes together with no way to tell which file came from which session. `hook.py` already receives the Claude `session_id` on stdin but discards it.

## Goal

An **optional** "group by session" mode for the review panels: when enabled, files are grouped under per-session nodes labeled by first-seen order and time. Off by default (git worktrees remain the primary isolation for overlapping-file work).

## Non-Goals

- Not changing the per-workspace session-file model or isolation.
- Not attributing GUI file-watcher captures to a session (they have no `session_id`) — they collect under an "Unknown session" node.
- No renaming/custom session labels (YAGNI); ordinal + time is enough.

## Product Decisions

- **Default off** (`claudegate.groupBySession: false`).
- **Most-recent session on top**; the ordinal `N` reflects first-seen birth order (stable across refreshes), so top-to-bottom reads newest→oldest by number.
- **Applies to all three panels** (Pending / Accepted / Rejected — they share `FilteredTreeProvider`).
- Composes with the existing View-as-Tree / View-as-List toggle: session grouping is the outer layer; within a session, the current folder/flat arrangement applies.
- Also toggleable from the **Settings pane** (mirrors the File Watcher row).

## Capture (enabling change)

`hooks/hook.py` — when creating a new file entry (and on the accepted/rejected → re-pending re-baseline branch), record:

```python
"sessionId": hook_input.get("session_id"),
"capturedAt": datetime.now(timezone.utc).isoformat(),
```

Backward compatible: both are optional; existing entries and GUI-watcher captures simply lack them. No change to the workspace-routing or baseline logic.

## Schema

`src/sessionManager.ts` `FileEntry` gains two optional fields (read-only on the TS side — the Python hook writes them):

```typescript
export interface FileEntry {
  originalContent: string | null;
  claudeContent?: string | null;
  reviewStatus: ReviewStatus;
  sessionId?: string;    // Claude session_id that produced this change (hook path only)
  capturedAt?: string;   // ISO timestamp of first capture
}
```

## Components

### Modified: `src/reviewPanel.ts` (the main work)

- **New `SessionItem extends vscode.TreeItem`** carrying `sessionId: string | null` (`null` = the Unknown bucket). Label `Session N · <time>` (or `Unknown session`), `description` = file count, `collapsibleState: Expanded`, `contextValue: "claudegate.session"`.
- **`FolderItem`** gains an optional `sessionId?: string | null` so folder filtering stays scoped when nested inside a session group.
- **Grouping predicate** `matchesSession(entry, sessionId)`: `sessionId === null ? !entry.sessionId : entry.sessionId === sessionId`.
- **`getChildren` changes** (read `const grouped = getConfiguration("claudegate").get("groupBySession", false)`):
  - **Root + grouped:** collect the filtered files (status ∧ `isInWorkspace` ∧ `!isExcluded`), bucket by `sessionId` (undefined → the `null` bucket). Order buckets by each bucket's earliest `capturedAt` ascending to assign ordinals `1..k`; return `SessionItem`s sorted **most-recent-first** (largest ordinal on top; Unknown bucket last). Return `[]`-collapse to today's behavior when `grouped` is false (existing code path unchanged).
  - **`SessionItem` element:** the session's files, arranged by the existing `viewMode` — list → flat `FileReviewItem`s; tree → `directChildren(files, root, status, false, item.sessionId)`.
  - **`FolderItem` element:** existing filter plus `&& matchesSession(e, element.sessionId)` when `element.sessionId !== undefined`.
- **`directChildren`** gains a trailing optional `sessionId` param, passed into any `FolderItem` it creates (files need no session).
- Label/time helpers: ordinal from the birth-order map; time via `new Date(capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })` (falls back to `Session N` with no time if `capturedAt` absent).

### Modified: `src/settingsPanel.ts`

Add a **Group by Session** row (kind `"groupBySession"`) mirroring the File Watcher row: description `On`/`Off` from the setting, `ThemeIcon("list-tree")`/`("list-flat")`, `command: claudegate.toggleGroupBySession`.

### Modified: `src/extension.ts`

- New command `claudegate.toggleGroupBySession` → `updateClaudegateConfig("groupBySession", !current)` (reuses the existing Workspace-scope helper).
- Extend the existing `onDidChangeConfiguration` handling: on `claudegate.groupBySession` change, refresh the three review providers and the settings provider.

### Modified: `package.json`

- `contributes.configuration`: add `claudegate.groupBySession` (boolean, default `false`, description).
- `contributes.commands`: add `claudegate.toggleGroupBySession`.

## Error Handling

- Missing `capturedAt`/`sessionId` (legacy or GUI entries): sort such buckets last; label without a time; group under Unknown. No throw.
- Concurrent hook writes remain the known read-modify-write limitation (unchanged); adding two fields does not worsen it.
- Setting absent → treated as `false`.

## Testing

**Automated:**
- `hooks/tests/test_hook.py`: new case — a `PreToolUse` payload with `"session_id": "s-123"` produces a file entry with `sessionId == "s-123"` and a non-empty `capturedAt`.
- `npm run typecheck` / `compile` pass; `npm run test:unit` still green.

**Manual (Extension Development Host):**
1. `claudegate.groupBySession: false` (default) → panels look exactly as today.
2. Enable via the setting or the Settings-pane row → pending files group under `Session N · time` nodes, newest on top, with file counts.
3. Two terminal sessions editing different files in one workspace → two session nodes, each holding its own files.
4. Toggle View-as-List / Tree while grouped → arrangement changes *within* each session node.
5. A GUI-watcher capture (or pre-upgrade entry) → appears under "Unknown session".
6. Toggle off → flat/folder view returns, no reload needed.

## Release

- No version bump — folds into the unreleased `1.2.0`; extend the `## [1.2.0] — 2026-07-04` CHANGELOG **Added** section (group-by-session mode + hook now records `session_id`).
- `hook.py` changed → users re-run **Setup Hook** (or rely on activate auto-sync) to record session ids going forward.
