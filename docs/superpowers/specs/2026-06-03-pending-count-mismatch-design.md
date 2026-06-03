# Pending Count Mismatch Fix — ClaudeGate

**Date:** 2026-06-03  
**Status:** Approved for implementation  
**Related:** `docs/2026-06-03-pending-count-mismatch-bug.md`

## Problem

The pending **badge / status-bar count** can disagree with the **Pending review tree** (e.g. shows `2` but only `1` file is listed). The extra count is a "ghost" entry: a file path stored in the workspace session JSON that lives **outside** any open VS Code workspace folder, so the tree hides it but counters still include it. The user cannot clear the ghost from the panel.

## Root Cause

Two layers:

1. **Display vs count:** `reviewPanel.ts` filters with `isInWorkspace`; `extension.ts` session-change counts and `SessionManager.getPendingCount()` do not.
2. **Hook routing:** `hook.py` `workspace_root_for_file` falls back to Claude's `cwd` when no registered root matches, so paths like `~/.claude/projects/.../memory/*.md` are written into the wrong session file while `cwd` is a real project.

Bulk actions (`acceptAll`, `rejectAll`) iterate all pending entries without the workspace filter, so ghosts can still be reverted on disk even when invisible in the tree.

## Goal

One rule everywhere ClaudeGate surfaces or mutates session files for the **current** VS Code window: **only paths under an open `workspaceFolders` root count and are actionable.** Stop creating new out-of-workspace entries at the hook. Remove existing ghosts on session load.

## Product Decision

When the hook cannot match any entry in `~/.claudegate/workspace-roots.json`, **skip capture** (exit 0, no session write). Do **not** fall back to `cwd`.

Rationale: `cwd` reflects the active terminal session, not file ownership. With merged roots from every open VS Code window, in-project files still route correctly; global paths (`~/.claude`, etc.) are intentionally out of scope.

**Trade-off:** Terminal-only Claude with no VS Code window open has no registered roots → hook captures nothing until a window registers roots. Acceptable; aligns with sidebar-only review UX.

## Architecture

```
Edited file path
        │
        ▼
hook.py: match longest workspace-roots.json prefix
        │
        ├─ no match ──► exit 0 (no write)          ← NEW
        └─ match ──► correct session JSON
                │
                ▼
        SessionManager.loadSession()
                │
                ├─ prune entries where !isInWorkspace()   ← NEW
                └─ existing reconcile (vanished new files)
                │
                ▼
        UI + bulk actions: count/filter via isInWorkspace()  ← NEW (shared helper)
```

## Components

### New: `src/workspaceScope.ts`

Single exported function used across the extension:

```typescript
export function isInWorkspace(filePath: string): boolean
```

Logic (same as today in `reviewPanel.ts`):

- If `vscode.workspace.workspaceFolders` is empty/undefined → `true` (preserve legacy behavior when no folder is open).
- Else → `true` if `filePath` starts with `folder.uri.fsPath + path.sep` for any folder.

### Modified: `src/reviewPanel.ts`

Remove local `isInWorkspace`; import from `workspaceScope.ts`. Behavior unchanged.

### Modified: `src/extension.ts`

In `sessionManager.onSessionChange`, count only entries where `isInWorkspace(filePath)` when incrementing `pending` / `accepted` / `rejected` for badges, context keys, and status bar.

In `claudegate.acceptAll` / `claudegate.rejectAll` command handlers, filter pending file lists with `isInWorkspace` before closing diff editors (counts already come from updated `getPendingCount()`).

### Modified: `src/sessionManager.ts`

- `getPendingCount()` — count pending entries with `isInWorkspace(fp)`.
- `acceptAll()` / `rejectAll()` — only transition pending entries that pass `isInWorkspace`.
- `loadSession()` — after parse, call `pruneOutOfWorkspaceEntries()` before `scheduleReconcile()`; log and `persist()` if any removed.

### Modified: `hooks/hook.py`

- `workspace_root_for_file` returns `str | None`; return `None` instead of `cwd` when no root matches.
- `main()` — if `workspace_root is None`, `sys.exit(0)` before reading/writing session.

Users must re-run **Setup Hook** after upgrade to deploy the updated script.

### Unchanged

- `DocumentTracker` — already ignores out-of-workspace via `this.workspacePath`; no change required.
- `decorationProvider` — out-of-workspace paths are not shown in the explorer; no change required.
- Session JSON schema.

## Error Handling

- Hook skip is silent (exit 0) — same as other no-op hook paths; no user notification.
- Prune on load is logged to the ClaudeGate output channel at INFO; no modal.
- `rejectAll` on in-workspace pending only; ghost paths never touched.

## Testing

**Automated:** `npm run compile` and `npm run typecheck` must pass.

**Manual:**

1. Reproduce bug (edit `~/.claude/.../memory/*.md` with project `cwd`) → no new session entry after fix + hook reinstall.
2. Session JSON with a pre-existing out-of-workspace pending entry → reload extension → entry pruned; count matches tree.
3. Normal in-workspace Claude edit → still appears in tree; count increments.
4. `Reject All` modal count matches visible pending files only.
5. Setup Hook verification still smoke-tests `hook.py`.

## Release

- Patch version bump (e.g. `1.1.10` → `1.1.11`).
- CHANGELOG **Fixed** entry referencing ghost pending count and hook skip for unmatched roots.
- Remind users to re-run **Setup Hook** in release notes.
