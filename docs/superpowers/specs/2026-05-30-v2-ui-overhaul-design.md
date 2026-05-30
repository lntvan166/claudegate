# ClaudeGate v2 UI Overhaul — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Scope:** Three separate sidebar panels (PENDING / ACCEPTED / REJECTED), Accept/Reject buttons in diff and regular editors, new SessionManager bulk methods. No version bump (pre-release).

---

## 1. Three Separate Sidebar Panels

### Problem

The single "Review Session" panel with Pending / Accepted / Rejected as collapsible headers inside is visually compact but limits per-group actions: the toolbar is shared, collapse-all collapses everything at once, and there is no way to hide empty groups. Users want each group to behave like an independent panel — like OUTLINE / TIMELINE / PORTS in the Explorer sidebar.

### Design

Replace the single `claudegate.reviewPanel` view with three independent views registered under the same `claudegate` viewsContainer:

| View ID | Panel title | Shows when |
|---|---|---|
| `claudegate.pendingPanel` | PENDING | Always |
| `claudegate.acceptedPanel` | ACCEPTED | `claudegate.acceptedCount > 0` |
| `claudegate.rejectedPanel` | REJECTED | `claudegate.rejectedCount > 0` |

Each panel is a separate `createTreeView` call with `showCollapseAll: true`. Two context variables — `claudegate.acceptedCount` and `claudegate.rejectedCount` — are updated on every session change and control panel visibility via `when` in the view declaration.

#### PENDING panel

**Toolbar (`view/title`):**
- View toggle (list ↔ tree) — existing
- Accept All (`$(check-all)`) — existing
- Reject All (`$(discard)`) — existing
- Clear Session (`$(trash)`) — moved from the old shared toolbar
- *(native Collapse All from `showCollapseAll: true`)*

**Per-file inline (`view/item/context`, `claudegate.file.pending`):**
- ✓ Accept (`$(check)`)
- ✕ Reject (`$(x)`)

**Per-folder inline (`claudegate.folder.pending`, tree mode only):**
- ✓ Accept folder (`$(check)`)
- ✕ Reject folder (`$(x)`)

**Empty state:** *"No pending files — run Claude Code to start tracking changes."*

#### ACCEPTED panel

**Toolbar (`view/title`):**
- Revert All (`$(discard)`) — moves all accepted files back to pending (no disk op)
- *(native Collapse All)*

**Per-file inline (`claudegate.file.accepted`):**
- ↩ Revert (`$(debug-step-back)`) — moves file back to pending, no disk change

**Per-folder inline (`claudegate.folder.accepted`, tree mode only):**
- ↩ Revert folder — moves all accepted files in folder back to pending

**Empty state:** *(panel hidden via `when` condition — not shown when count is 0)*

#### REJECTED panel

**Toolbar (`view/title`):**
- Reapply All (`$(debug-restart)`) — restores Claude's content for all rejected files, moves back to pending
- *(native Collapse All)*

**Per-file inline (`claudegate.file.rejected`):**
- ↻ Re-apply (`$(debug-restart)`) — existing `reapplyFile` behavior

**Per-folder inline (`claudegate.folder.rejected`, tree mode only):**
- ↻ Re-apply folder — new, applies `reapplyFile` logic to all rejected files in folder

**Empty state:** *(panel hidden via `when` condition — not shown when count is 0)*

### Architecture

Three `TreeDataProvider` instances, each a thin wrapper around a shared `FilteredTreeProvider` class that accepts a `ReviewStatus` filter. This avoids duplicating the list/tree rendering logic. The existing `ReviewTreeProvider` is refactored into:

- `FilteredTreeProvider(sessionManager, status: ReviewStatus)` — renders only files with the given status; exposes `setViewMode`, `expandAll` (kept for keyboard shortcut compatibility even though the toolbar button is removed)
- Three instances: `pendingProvider`, `acceptedProvider`, `rejectedProvider`

The `GroupItem` header layer is removed — each panel IS the group. `getChildren(undefined)` returns files/folders directly (no group header nodes).

### Remove expand-all

`claudegate.expandAll` command and its toolbar entry are removed. Each panel has native collapse via `showCollapseAll: true`. The command registration is also removed from `extension.ts`.

### Context variables

Updated on every `sessionManager.onSessionChange`:

```typescript
vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", acceptedCount);
vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", rejectedCount);
```

Used in `package.json` view `when` conditions:
```json
{ "id": "claudegate.acceptedPanel", "when": "claudegate.acceptedCount > 0" }
{ "id": "claudegate.rejectedPanel", "when": "claudegate.rejectedCount > 0" }
```

### Files changed

- `src/reviewPanel.ts` — refactor `ReviewTreeProvider` into `FilteredTreeProvider`; remove `GroupItem`; three exported provider instances
- `src/extension.ts` — three `createTreeView` calls; update context variables; register new commands; remove `expandAll`
- `package.json` — replace single view with three views; restructure all `view/title` and `view/item/context` menu entries

---

## 2. Accept / Reject Buttons in Editor

### Problem

The only way to accept or reject a file is from the sidebar. When reviewing in the diff editor, the user must switch back to the sidebar to act — adding friction to the review flow.

### Design

**Option C:** Labeled buttons in the ClaudeGate diff view; icon-only in the regular editor. Configurable.

#### In the ClaudeGate diff view

When the active diff editor has a `claudegate:` URI on the left side, labeled buttons appear in the editor title bar:

- **`✓ Accept`** (green background) — `claudegate.acceptFile` with `{ filePath }` arg
- **`✕ Reject`** (red background) — `claudegate.rejectFile` **without confirmation dialog** (user is already reviewing the diff)

Condition: `activeEditorIsDiffEditor && claudegate.isActivePending`

In VS Code, `resourceScheme` reflects the *right* (current) pane of a diff editor, which is `file:` — not `claudegate:`. Instead, `activeEditorIsDiffEditor` is a built-in VS Code context key that is true whenever a diff editor is active. Combined with `claudegate.isActivePending`, this reliably identifies the ClaudeGate diff view.

#### In the regular editor

When the active editor is a regular file that is pending in the session, icon-only buttons appear:

- **`$(check)`** — accept
- **`$(x)`** — reject (with confirmation dialog — user may not have reviewed the diff)

Condition: `!activeEditorIsDiffEditor && resourceScheme == file && claudegate.isActivePending && config.claudegate.showEditorButtons`

#### Context variable: `claudegate.isActivePending`

An `onDidChangeActiveTextEditor` listener (registered in `extension.ts`) checks whether the active editor's file path is in the session with `reviewStatus === "pending"` and updates:

```typescript
vscode.commands.executeCommand("setContext", "claudegate.isActivePending", isPending);
```

This is also updated on `sessionManager.onSessionChange` so that if the session changes while the same file is open, the buttons appear/disappear correctly.

#### Configuration

New setting in `package.json` `contributes.configuration`:

```json
{
  "claudegate.showEditorButtons": {
    "type": "boolean",
    "default": true,
    "description": "Show Accept/Reject buttons in the editor title bar for pending files."
  }
}
```

The `when` condition for regular-editor buttons reads this config via `config.claudegate.showEditorButtons`. If the user sets it to `false`, buttons still appear in the diff view (those are always on — the user opened the diff intentionally).

#### README documentation

New section: **"Hiding the Accept/Reject buttons in the editor"**

> By default, ClaudeGate shows Accept (✓) and Reject (✕) buttons in the editor title bar whenever you have a pending file open. To disable this:
>
> 1. Open Settings (`Cmd+,` / `Ctrl+,`)
> 2. Search for `claudegate.showEditorButtons`
> 3. Uncheck the setting
>
> The buttons in the diff view (opened by clicking a file in the ClaudeGate sidebar) are always shown and cannot be disabled separately.

### Files changed

- `src/extension.ts` — add `onDidChangeActiveTextEditor` listener; update `claudegate.isActivePending` context; register `claudegate.acceptActivePending` / `claudegate.rejectActivePending` commands (or reuse existing with different arg pattern)
- `package.json` — add `editor/title` menu entries; add `claudegate.showEditorButtons` config; hide new commands from palette

---

## 3. New SessionManager Methods

| Method | Disk op | Notes |
|---|---|---|
| `revertAccepted(filePath)` | None | Sets `reviewStatus = "pending"` for an accepted file; file content unchanged |
| `revertAcceptedAll()` | None | All accepted files → pending |
| `revertAcceptedFolder(folderPath)` | None | All accepted files under path → pending |
| `reapplyFolder(folderPath)` | Write | Applies `reapplyFile` logic to all rejected files in folder |

`revertAccepted*` methods have no disk side-effects — accepting a file never modifies it, so un-accepting is a metadata-only change.

`reapplyFolder` must handle the same partial-failure pattern as `rejectFolder`: accumulate errors, persist once at the end, show a summary error message if any files fail.

---

## 4. UX Improvements (no extra implementation cost)

These fall out naturally from the redesign:

1. **Empty panel hiding** — Accepted and Rejected panels disappear when count is 0; the sidebar stays focused on what matters (pending files)
2. **Per-panel file count in title** — Each panel header shows the count (e.g., "PENDING 3") via `treeView.description`
3. **Reject in diff = no confirmation** — Removes friction when reviewing; the user has already seen the diff
4. **Remove expand-all button** — Redundant with per-panel native collapse

---

## Summary of changes

| File | Changes |
|---|---|
| `src/sessionManager.ts` | Add `revertAccepted`, `revertAcceptedAll`, `revertAcceptedFolder`, `reapplyFolder` |
| `src/reviewPanel.ts` | Refactor to `FilteredTreeProvider`; remove `GroupItem`; export three provider instances |
| `src/extension.ts` | Three `createTreeView` calls; `isActivePending` context; new commands; remove `expandAll` |
| `package.json` | Three views; restructured menus; `editor/title` entries; `showEditorButtons` config |
| `README.md` | "Hiding the Accept/Reject buttons in the editor" section |
