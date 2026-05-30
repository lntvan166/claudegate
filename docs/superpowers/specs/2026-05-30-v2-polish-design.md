# ClaudeGate v2 Polish — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Scope:** Three polish items: PENDING-only badge count, CodeLens-based Accept/Reject (removing editor/title buttons), and demo image in README.

---

## 1. PENDING-Only Badge + Remove Status Bar

### Problem
- All three panels show badge counts — ACCEPTED and REJECTED counts add noise since those files are already reviewed.
- The bottom status bar item duplicates information already visible in the PENDING badge.

### Design

**Badge changes in `onSessionChange`:**
- Remove `acceptedView.badge` and `rejectedView.badge` assignments.
- Keep only `pendingView.badge = counts.pending > 0 ? { value: counts.pending, tooltip: \`${counts.pending} pending file(s)\` } : undefined`.

**Status bar removal:**
- Delete `let statusBarItem: vscode.StatusBarItem` module-level variable.
- Delete the `statusBarItem = vscode.window.createStatusBarItem(...)` block.
- Delete the `updateStatusBar()` function.
- Delete `statusBarItem?.dispose()` from `deactivate()`.
- Remove `statusBarItem` from `context.subscriptions`.

### Files changed
- `src/extension.ts`

---

## 2. CodeLens Accept/Reject — Remove All editor/title Buttons

### Problem
Accept/Reject buttons in the `editor/title` bar overflow into the `...` menu in diff view (competing with VS Code's built-in diff buttons), and are invisible until the user discovers them. The editor/title location is also removed from the regular editor per user preference.

### Design

#### New: `src/codeLensProvider.ts`

A `vscode.CodeLensProvider` that injects `✓ Accept` and `✕ Reject` text links at line 0 of any document whose path is in the session as `"pending"`. This mirrors VS Code's own merge-conflict resolution pattern.

```typescript
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export class ClaudeGateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri;
    const filePath =
      uri.scheme === "file"       ? uri.fsPath :
      uri.scheme === "claudegate" ? uri.path   :
      undefined;

    if (!filePath) return [];

    const session = this.sessionManager.getSession();
    if (session?.files[filePath]?.reviewStatus !== "pending") return [];

    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: "✓ Accept",
        command: "claudegate.acceptFile",
        arguments: [{ filePath }],
      }),
      new vscode.CodeLens(range, {
        title: "✕ Reject",
        command: "claudegate.rejectFile",
        arguments: [{ filePath }],
      }),
    ];
  }
}
```

- The `claudegate:` URI scheme check ensures the CodeLens also appears on the left pane of a ClaudeGate diff (the virtual original-content doc). Both panes of the diff show the links, making them highly visible.
- Clicking Accept/Reject reuses the existing `claudegate.acceptFile` and `claudegate.rejectFile` commands — no new commands needed.
- `rejectFile` shows its existing confirmation dialog (this is consistent behavior regardless of surface).
- `onDidChangeCodeLenses` fires on every session change so the lens appears/disappears automatically as review status changes.

Registration in `extension.ts`:
```typescript
context.subscriptions.push(
  vscode.languages.registerCodeLensProvider("*", new ClaudeGateCodeLensProvider(sessionManager))
);
```

#### Remove from `extension.ts`

- `let activePendingFilePath: string | undefined` module-level variable
- `updateActivePending()` function and its `onDidChangeActiveTextEditor` listener
- The `setContext("claudegate.isActivePending", ...)` call in the `openDiff` handler — simplify to just `await openDiff(filePath, sessionManager)`; the `else` branch is also removed
- Command registrations: `claudegate.acceptActivePending`, `claudegate.rejectActivePendingFromDiff`, `claudegate.rejectActivePending`
- Import: remove `openDiff` from `diffProvider` import (no longer needed in extension.ts)
- Restore `registerOpenDiff` to the `reviewPanel` import and replace the inline `openDiff` registration with `registerOpenDiff(context, sessionManager)`

#### Remove from `package.json`

- Three `editor/title` menu entries (acceptActivePending, rejectActivePendingFromDiff, rejectActivePending)
- `claudegate.showEditorButtons` configuration property
- Three command declarations: `acceptActivePending`, `rejectActivePendingFromDiff`, `rejectActivePending`
- Those three entries from the `commandPalette` suppression list

#### Remove from `README.md`

- The "Hiding the Accept/Reject buttons in the editor" section added in v2

### Files changed
- `src/codeLensProvider.ts` — new file
- `src/extension.ts` — register CodeLens provider, remove active-pending tracking, restore `registerOpenDiff`
- `package.json` — remove editor/title entries, commands, config
- `README.md` — remove editor buttons section

---

## 3. Demo Image in README

### Design

Copy `/Users/tuvan/Document/ClaudeGateDemo.png` to `media/ClaudeGateDemo.png` in the repo.

Add a `## Screenshot` section to `README.md` after the intro paragraph (before `## Quick Start`):

```markdown
## Screenshot

![ClaudeGate in action](media/ClaudeGateDemo.png)
```

### Files changed
- `media/ClaudeGateDemo.png` — new (binary copy)
- `README.md` — new Screenshot section

---

## Summary

| Item | New files | Modified files | Deleted logic |
|---|---|---|---|
| 1. PENDING-only badge + no status bar | — | `extension.ts` | statusBar*, acceptedView.badge, rejectedView.badge |
| 2. CodeLens + remove editor buttons | `codeLensProvider.ts` | `extension.ts`, `package.json`, `README.md` | activePendingFilePath, updateActivePending, 3 commands, editor/title menus, showEditorButtons config |
| 3. Demo image | `media/ClaudeGateDemo.png` | `README.md` | — |
