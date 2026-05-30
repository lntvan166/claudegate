# ClaudeGate v2 Fixes — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Scope:** Three targeted fixes following v2 UI review: shared view-mode toggle for all panels, count display via TreeView.badge, and reliable Accept/Reject buttons in the diff view.

---

## 1. Shared View Mode for Accepted and Rejected Panels

### Problem
The "View as Tree / View as List" toggle exists only on the PENDING panel toolbar. Accepted and Rejected panels always render in list mode with no way to switch.

### Design
Treat view mode as a **session-level preference** shared across all three panels. The single toggle button on the PENDING panel already drives the `claudegate.viewMode` context key and `pendingProvider.setViewMode()`. Extend both commands to also call `setViewMode` on `acceptedProvider` and `rejectedProvider`.

Add the toggle button to the `view/title` menus for `claudegate.acceptedPanel` and `claudegate.rejectedPanel` using the same `claudegate.viewMode` conditions — no new context keys.

**`claudegate.viewAsTree` command (updated):**
```typescript
pendingProvider.setViewMode("tree");
acceptedProvider.setViewMode("tree");
rejectedProvider.setViewMode("tree");
vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");
```

**`claudegate.viewAsList` command (updated):**
```typescript
pendingProvider.setViewMode("list");
acceptedProvider.setViewMode("list");
rejectedProvider.setViewMode("list");
vscode.commands.executeCommand("setContext", "claudegate.viewMode", "list");
```

**New `view/title` menu entries (package.json):**
```json
{ "command": "claudegate.viewAsTree", "when": "view == claudegate.acceptedPanel && claudegate.viewMode == 'list'", "group": "navigation@1" },
{ "command": "claudegate.viewAsList", "when": "view == claudegate.acceptedPanel && claudegate.viewMode == 'tree'", "group": "navigation@1" },
{ "command": "claudegate.viewAsTree", "when": "view == claudegate.rejectedPanel && claudegate.viewMode == 'list'", "group": "navigation@1" },
{ "command": "claudegate.viewAsList", "when": "view == claudegate.rejectedPanel && claudegate.viewMode == 'tree'", "group": "navigation@1" }
```

### Files changed
- `src/extension.ts` — update `viewAsTree` and `viewAsList` command handlers
- `package.json` — add 4 `view/title` menu entries

---

## 2. Count Display via TreeView.badge

### Problem
`treeView.description` (the count number) sits in the same panel title bar strip as the toolbar buttons. With 4 buttons on the PENDING panel, the description gets squeezed or hidden — bad UI.

### Design
Replace `treeView.description` with `treeView.badge` (`ViewBadge`) for all three views. The badge renders as a small number pill overlaid on the panel's section header — the same visual pattern as VS Code's notification counts. It does not compete with toolbar buttons.

VS Code `ViewBadge` API: `{ value: number, tooltip: string }`. Supported since VS Code 1.73; package.json requires ^1.85.0 so this is safe.

**In `onSessionChange` handler (updated):**
```typescript
// Remove these lines:
pendingView.description  = counts.pending  > 0 ? String(counts.pending)  : undefined;
acceptedView.description = counts.accepted > 0 ? String(counts.accepted) : undefined;
rejectedView.description = counts.rejected > 0 ? String(counts.rejected) : undefined;

// Add these lines:
pendingView.badge  = counts.pending  > 0 ? { value: counts.pending,  tooltip: `${counts.pending} pending file(s)`  } : undefined;
acceptedView.badge = counts.accepted > 0 ? { value: counts.accepted, tooltip: `${counts.accepted} accepted file(s)` } : undefined;
rejectedView.badge = counts.rejected > 0 ? { value: counts.rejected, tooltip: `${counts.rejected} rejected file(s)` } : undefined;
```

### Files changed
- `src/extension.ts` — swap `description` for `badge` in `onSessionChange`

---

## 3. Accept/Reject Buttons in the Diff View

### Problem
The Accept and Reject buttons declared in `editor/title` (gated on `claudegate.isActivePending`) do not appear when a ClaudeGate diff editor is open. Root cause: VS Code's `onDidChangeActiveTextEditor` fires with `undefined` when a diff editor opens — the `updateActivePending()` function then clears `isActivePending`, so the buttons never show.

### Design
Replace the `registerOpenDiff(context, sessionManager)` call with an **inline command registration** in `extension.ts` that calls `openDiff` and then explicitly sets `activePendingFilePath` and `claudegate.isActivePending` immediately after — no reliance on `activeTextEditor`.

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    "claudegate.openDiff",
    async (filePath: string) => {
      await openDiff(filePath, sessionManager);
      // Set active pending state explicitly — diff editors don't reliably
      // fire onDidChangeActiveTextEditor, so we set it here on open.
      const session = sessionManager.getSession();
      if (session?.files[filePath]?.reviewStatus === "pending") {
        activePendingFilePath = filePath;
        vscode.commands.executeCommand("setContext", "claudegate.isActivePending", true);
      }
    }
  )
);
```

The existing `onDidChangeActiveTextEditor` listener still handles **cleanup**: when the user navigates to any other file, `updateActivePending()` runs and clears `isActivePending` if the new file is not pending.

`registerOpenDiff` is removed from the `registerOpenDiff` import in `extension.ts` (it is no longer needed). The export can remain in `reviewPanel.ts` for API cleanliness but is unused.

### Files changed
- `src/extension.ts` — replace `registerOpenDiff(context, sessionManager)` with inline command registration; remove `registerOpenDiff` from the import

---

## Summary

| Fix | Files | Change size |
|---|---|---|
| 1. Shared view mode | `extension.ts`, `package.json` | 2 command handlers + 4 menu entries |
| 2. TreeView.badge | `extension.ts` | 3 lines swapped |
| 3. Diff view buttons | `extension.ts` | 1 call replaced, 1 import removed |
