# ClaudeGate v1 Improvements — Design Spec

**Date:** 2026-05-30  
**Status:** Approved  
**Scope:** Four UX improvements based on first-day usage feedback. No version bump (pre-release).

---

## 1. Command Palette Hygiene

### Problem
Too many internal commands appear in Cmd+Shift+P, creating noise.

### Design
Only 4 commands remain visible in the Command Palette (those with `category: "ClaudeGate"`):
- `ClaudeGate: Setup Hook`
- `ClaudeGate: Clear Session`
- `ClaudeGate: Accept All`
- `ClaudeGate: Reject All`

All other commands are hidden via `"commandPalette"` entries in `package.json` with `"when": "false"`:
- `claudegate.acceptFile`
- `claudegate.rejectFile`
- `claudegate.reapplyFile`
- `claudegate.acceptFolder` (new)
- `claudegate.rejectFolder` (new)
- `claudegate.openDiff`
- `claudegate.viewAsTree`
- `claudegate.viewAsList`
- `claudegate.expandAll` (new)

These commands remain fully functional via toolbar buttons and right-click context menus.

### Files changed
- `package.json` — add `menus.commandPalette` block

---

## 2. Folder-level Accept/Reject

### Problem
In tree mode, files are grouped under folders, but accept/reject only works per-file. Users want to review a package/folder as a unit and accept or reject it in one action.

### Design
Two new commands: `claudegate.acceptFolder` and `claudegate.rejectFolder`.

- Shown as inline icon buttons (`$(check)` / `$(x)`) on `FolderItem` nodes in tree mode.
- `contextValue` on `FolderItem` stays `"claudegate.folder"` — menu entries target this value.
- Both commands act recursively: all pending files whose absolute path starts with `folderPath + path.sep`.
- `rejectFolder` shows a confirmation dialog: *"Revert N file(s) in `<folderName>` to their original content?"*
- Implementation delegates to existing `SessionManager.rejectFile` / `acceptFile` per-file logic — no new file I/O code.

### New SessionManager methods
```ts
acceptFolder(folderPath: string): void
rejectFolder(folderPath: string): Promise<void>  // async for confirmation dialog
```

Actually, folder confirmation lives in the command handler in `extension.ts`, same pattern as `rejectAll`. `SessionManager` gets two synchronous methods:
```ts
acceptFolder(folderPath: string): void   // iterates pending files under path, marks accepted
rejectFolder(folderPath: string): void   // iterates pending files under path, restores/deletes
```

### Files changed
- `src/sessionManager.ts` — add `acceptFolder`, `rejectFolder`
- `src/extension.ts` — register `claudegate.acceptFolder`, `claudegate.rejectFolder` commands
- `package.json` — declare commands, wire to `view/item/context` for `claudegate.folder`, hide from palette

---

## 3. Workspace File Filtering

### Problem
When Claude modifies files outside the current workspace (e.g., `~/.claude/settings.json`), they appear in the session and can crash or clutter the tree view.

### Design
Filter applied in `ReviewTreeProvider.getChildren` when building the file list for a `GroupItem`. A file is included only if at least one `vscode.workspace.workspaceFolders` entry is an ancestor of the file path.

```ts
function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return true; // no workspace open — show everything
  return folders.some(f => filePath.startsWith(f.uri.fsPath + path.sep));
}
```

- Out-of-workspace files are silently skipped in the tree. They remain in `session.json` — the hook continues to write them, and the session status logic is unaffected.
- The status bar pending count may over-count by the number of hidden out-of-workspace pending files. This is acceptable (edge case; the crash fix is the priority).
- If no workspace is open, filtering is skipped and all files are shown (safe fallback).

### Files changed
- `src/reviewPanel.ts` — add `isInWorkspace` helper, apply filter in `getChildren`

---

## 4. Rejected New File Diff View

### Problem
When Claude creates a new file and the user rejects it, the file is deleted from disk. Clicking the file item in the tree view tries to open the deleted file as the right side of the diff → blank or error. The user cannot see what Claude wrote.

### Design
`openDiff` detects the case: `entry.originalContent === null && entry.reviewStatus === "rejected"`.

In this case:
- Left side: existing `claudegate:` virtual URI (serves the empty placeholder `"// New file — no original content"`).
- Right side: new `claudegate:` virtual URI with query param `?side=claude`, serving `entry.claudeContent`.
- Diff title: `ClaudeGate: <filename>  (rejected — Claude's version)`

`ClaudeGateContentProvider.provideTextDocumentContent` checks `uri.query`:
- `"side=claude"` → return `entry.claudeContent ?? "// Claude's version not available"`
- default → return `entry.originalContent ?? "// New file — no original content"` (existing behavior)

#### Helper
```ts
export function claudeUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: SCHEME, query: "side=claude" });
}
```

### Behavior for the "accepted then deleted" question
If a user accepts a file in session N, and Claude's next prompt removes lines from it, the hook fires `PreToolUse` before that edit and saves the current (accepted) state as `originalContent` in a new session entry. The user sees the removal in the diff for session N+1. No new code needed — this already works by design.

### Files changed
- `src/diffProvider.ts` — add `claudeUri`, update `provideTextDocumentContent`, update `openDiff`

---

## 5. Collapse / Expand All Buttons

### Problem
No way to quickly collapse or expand all groups in the tree view (Git panel has this).

### Design

**Collapse All:** Set `showCollapseAll: true` in `createTreeView` in `extension.ts`. VS Code renders a native Collapse All button in the panel title bar for free — no command needed.

**Expand All:** New command `claudegate.expandAll`. Calls `treeProvider.expandAll()` which fires `_onDidChangeTreeData(undefined)`. Since `GroupItem` constructor sets `collapsibleState` to `Expanded` when count > 0, a full re-render restores the expanded state.

- Expand All shown as `$(expand-all)` icon in `view/title` toolbar (`navigation@0` so it sits before the view-toggle button).
- Hidden from Command Palette.

### Files changed
- `src/extension.ts` — set `showCollapseAll: true`, register `claudegate.expandAll`
- `src/reviewPanel.ts` — add `expandAll()` method to `ReviewTreeProvider`
- `package.json` — declare `claudegate.expandAll`, add to `view/title` menu, hide from palette

---

## Summary of changes

| File | Changes |
|---|---|
| `src/sessionManager.ts` | Add `acceptFolder`, `rejectFolder` |
| `src/reviewPanel.ts` | Add `isInWorkspace` filter, `expandAll()` method |
| `src/diffProvider.ts` | Add `claudeUri`, update `provideTextDocumentContent` + `openDiff` |
| `src/extension.ts` | Register new commands, set `showCollapseAll: true` |
| `package.json` | Declare new commands, update menus, hide commands from palette |
