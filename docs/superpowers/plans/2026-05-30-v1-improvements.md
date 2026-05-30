# ClaudeGate v1 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five UX improvements to ClaudeGate — folder-level accept/reject, workspace file filtering, rejected-new-file diff view, collapse/expand all, and command palette cleanup.

**Architecture:** All changes are confined to five existing files. No new files are created. `SessionManager` gains two new bulk methods; `ReviewTreeProvider` gains a workspace filter and an expandAll method; `ClaudeGateContentProvider` / `openDiff` gain a virtual-URI path for rejected-new-file content; `extension.ts` registers new commands and enables the native collapse button; `package.json` wires menus and hides internal commands from the palette.

**Tech Stack:** TypeScript, VS Code Extension API, esbuild (bundler). No test runner is configured — verification is done in the Extension Development Host (F5).

---

## File Map

| File | What changes |
|---|---|
| `src/sessionManager.ts` | Add `acceptFolder(folderPath)` and `rejectFolder(folderPath)` |
| `src/reviewPanel.ts` | Update `FolderItem.contextValue` to embed status; add `isInWorkspace` filter in `getChildren`; add `expandAll()` to `ReviewTreeProvider` |
| `src/diffProvider.ts` | Add `claudeUri` helper; update `provideTextDocumentContent` to serve `claudeContent` on `?side=claude`; update `openDiff` to handle rejected new files |
| `src/extension.ts` | Register `claudegate.acceptFolder`, `claudegate.rejectFolder`, `claudegate.expandAll`; set `showCollapseAll: true`; import `FolderItem` |
| `package.json` | Declare three new commands; add folder inline buttons; add expand-all toolbar button; add `commandPalette` block hiding all internal commands |

---

## Task 1: SessionManager — acceptFolder and rejectFolder

**Files:**
- Modify: `src/sessionManager.ts`

- [ ] **Step 1: Add `acceptFolder` after the existing `acceptFile` method**

  Open `src/sessionManager.ts`. After the closing brace of `acceptFile` (line 69), insert:

  ```typescript
  acceptFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    let count = 0;
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "pending") {
        entry.reviewStatus = "accepted";
        count++;
      }
    }
    this.log.appendLine(`[INFO] Accepted folder: ${folderPath} (${count} file(s))`);
    this.persist();
  }
  ```

- [ ] **Step 2: Add `rejectFolder` after `acceptFolder`**

  Insert immediately after `acceptFolder`:

  ```typescript
  rejectFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (!fp.startsWith(prefix) || entry.reviewStatus !== "pending") continue;
      try {
        entry.claudeContent = fs.readFileSync(fp, "utf-8");
      } catch {
        entry.claudeContent = null;
      }
      try {
        if (entry.originalContent === null) {
          fs.unlinkSync(fp);
        } else {
          fs.writeFileSync(fp, entry.originalContent, "utf-8");
        }
        entry.reviewStatus = "rejected";
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(
          `[ERROR] rejectFolder failed for ${fp}: ${(err as Error).message}`
        );
      }
    }

    this.persist();
    this.log.appendLine(`[INFO] Rejected folder: ${folderPath} (${count} file(s))`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `ClaudeGate: Could not restore ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }
  ```

- [ ] **Step 3: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/sessionManager.ts
  git commit -m "feat: add acceptFolder and rejectFolder to SessionManager"
  ```

---

## Task 2: ReviewPanel — FolderItem contextValue, workspace filter, expandAll

**Files:**
- Modify: `src/reviewPanel.ts`

- [ ] **Step 1: Update `FolderItem.contextValue` to embed review status**

  In `src/reviewPanel.ts`, find the `FolderItem` constructor. Replace:

  ```typescript
  this.contextValue = "claudegate.folder";
  ```

  With:

  ```typescript
  this.contextValue = `claudegate.folder.${groupStatus}`;
  ```

  This allows the `view/item/context` menus to show accept/reject buttons only on pending folders (not on already-accepted or already-rejected ones).

- [ ] **Step 2: Add `isInWorkspace` helper function**

  After the `relativeDir` function (around line 112), add:

  ```typescript
  function isInWorkspace(filePath: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return true;
    return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
  }
  ```

- [ ] **Step 3: Apply workspace filter in `getChildren` for GroupItem**

  In `getChildren`, find the block under `if (element instanceof GroupItem)`. The current file-list build is:

  ```typescript
  const files = Object.entries(session.files)
    .filter(([, e]) => e.reviewStatus === element.groupStatus)
    .map(([fp]) => fp);
  ```

  Replace with:

  ```typescript
  const files = Object.entries(session.files)
    .filter(([fp, e]) => e.reviewStatus === element.groupStatus && isInWorkspace(fp))
    .map(([fp]) => fp);
  ```

- [ ] **Step 4: Add `expandAll` method to `ReviewTreeProvider`**

  Inside the `ReviewTreeProvider` class, after `getViewMode()`, add:

  ```typescript
  expandAll(): void {
    this._onDidChangeTreeData.fire();
  }
  ```

  Because `GroupItem` always defaults to `TreeItemCollapsibleState.Expanded` when `count > 0`, firing a full re-render restores all groups to expanded.

- [ ] **Step 5: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/reviewPanel.ts
  git commit -m "feat: workspace filter, folder contextValue, expandAll in ReviewTreeProvider"
  ```

---

## Task 3: DiffProvider — rejected new-file diff view

**Files:**
- Modify: `src/diffProvider.ts`

- [ ] **Step 1: Add `claudeUri` export helper**

  In `src/diffProvider.ts`, after the `originalUri` function, add:

  ```typescript
  export function claudeUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(filePath).with({ scheme: SCHEME, query: "side=claude" });
  }
  ```

- [ ] **Step 2: Update `provideTextDocumentContent` to serve `claudeContent`**

  Replace the current `provideTextDocumentContent` body:

  ```typescript
  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.sessionManager.getSession();
    if (!session) return "";
    const entry = session.files[uri.path];
    if (!entry) return "";
    return entry.originalContent ?? "// New file — no original content";
  }
  ```

  With:

  ```typescript
  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.sessionManager.getSession();
    if (!session) return "";
    const entry = session.files[uri.path];
    if (!entry) return "";
    if (uri.query === "side=claude") {
      return entry.claudeContent ?? "// Claude's version not available";
    }
    return entry.originalContent ?? "// New file — no original content";
  }
  ```

- [ ] **Step 3: Update `openDiff` to handle rejected new files**

  Replace the entire `openDiff` function with:

  ```typescript
  export async function openDiff(
    filePath: string,
    sessionManager: SessionManager
  ): Promise<void> {
    const session = sessionManager.getSession();
    if (!session?.files[filePath]) return;

    const entry = session.files[filePath];
    const label = path.basename(filePath);
    const beforeUri = originalUri(filePath);

    // Rejected new file: the file was deleted; show Claude's saved content instead
    if (entry.originalContent === null && entry.reviewStatus === "rejected") {
      const rightUri = claudeUri(filePath);
      await vscode.commands.executeCommand(
        "vscode.diff",
        beforeUri,
        rightUri,
        `ClaudeGate: ${label}  (rejected — Claude's version)`
      );
      return;
    }

    const currentUri = vscode.Uri.file(filePath);
    const title =
      entry.originalContent === null
        ? `ClaudeGate: ${label}  (new file)`
        : `ClaudeGate: ${label}  (original ↔ current)`;

    await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);

    // Scroll the right pane to the first changed line
    if (entry.originalContent !== null) {
      const currentDoc = await vscode.workspace.openTextDocument(filePath);
      const changes = diffLines(entry.originalContent, currentDoc.getText());
      let firstChangedLine = 0;
      let cursor = 0;
      for (const change of changes) {
        if (change.added || change.removed) { firstChangedLine = cursor; break; }
        if (!change.removed) cursor += change.count ?? 0;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.revealRange(
          new vscode.Range(firstChangedLine, 0, firstChangedLine, 0),
          vscode.TextEditorRevealType.InCenter
        );
      }
    }
  }
  ```

- [ ] **Step 4: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/diffProvider.ts
  git commit -m "feat: show Claude's content when viewing a rejected new file in diff"
  ```

---

## Task 4: Extension — register new commands and enable collapse-all

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Import `FolderItem` from reviewPanel**

  At the top of `src/extension.ts`, find:

  ```typescript
  import { ReviewTreeProvider, registerOpenDiff, FileReviewItem, closeDiffEditor, GroupItem } from "./reviewPanel";
  ```

  Replace with:

  ```typescript
  import { ReviewTreeProvider, registerOpenDiff, FileReviewItem, FolderItem, closeDiffEditor, GroupItem } from "./reviewPanel";
  ```

- [ ] **Step 2: Enable the native Collapse All button**

  Find:

  ```typescript
  const treeView = vscode.window.createTreeView("claudegate.reviewPanel", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  ```

  Replace with:

  ```typescript
  const treeView = vscode.window.createTreeView("claudegate.reviewPanel", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  ```

- [ ] **Step 3: Register `claudegate.expandAll`**

  Inside the `context.subscriptions.push(...)` block that registers commands, add after the `claudegate.viewAsList` registration:

  ```typescript
  vscode.commands.registerCommand("claudegate.expandAll", () =>
    treeProvider.expandAll()
  ),
  ```

- [ ] **Step 4: Register `claudegate.acceptFolder`**

  In the same `context.subscriptions.push(...)` block, add after `claudegate.expandAll`:

  ```typescript
  vscode.commands.registerCommand(
    "claudegate.acceptFolder",
    (item: FolderItem) => {
      sessionManager.acceptFolder(item.folderPath);
    }
  ),
  ```

- [ ] **Step 5: Register `claudegate.rejectFolder`**

  Add after `claudegate.acceptFolder`:

  ```typescript
  vscode.commands.registerCommand(
    "claudegate.rejectFolder",
    async (item: FolderItem) => {
      const session = sessionManager.getSession();
      const pendingCount = Object.entries(session?.files ?? {}).filter(
        ([fp, e]) =>
          fp.startsWith(item.folderPath + path.sep) &&
          e.reviewStatus === "pending"
      ).length;
      if (pendingCount === 0) return;
      const folderName = path.basename(item.folderPath);
      const answer = await vscode.window.showWarningMessage(
        `Revert ${pendingCount} file(s) in "${folderName}" to their original content?`,
        { modal: false },
        "Revert"
      );
      if (answer === "Revert") {
        sessionManager.rejectFolder(item.folderPath);
      }
    }
  ),
  ```

- [ ] **Step 6: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 7: Commit**

  ```bash
  git add src/extension.ts
  git commit -m "feat: register folder accept/reject and expand-all commands, enable collapse-all"
  ```

---

## Task 5: package.json — commands, menus, palette hygiene

**Files:**
- Modify: `package.json`

This task has three parts: (A) declare new commands, (B) update menus, (C) hide internal commands from the palette.

- [ ] **Step 1: Declare the three new commands in `contributes.commands`**

  In `package.json`, inside `"contributes": { "commands": [ ... ] }`, add after the `claudegate.viewAsList` entry:

  ```json
  {
    "command": "claudegate.expandAll",
    "title": "Expand All",
    "icon": "$(expand-all)"
  },
  {
    "command": "claudegate.acceptFolder",
    "title": "Accept Folder",
    "icon": "$(check)"
  },
  {
    "command": "claudegate.rejectFolder",
    "title": "Reject Folder",
    "icon": "$(x)"
  }
  ```

- [ ] **Step 2: Add Expand All to the `view/title` toolbar**

  In `"menus": { "view/title": [ ... ] }`, add as the **first** entry (so it sits left of the view-toggle button):

  ```json
  {
    "command": "claudegate.expandAll",
    "when": "view == claudegate.reviewPanel",
    "group": "navigation@0"
  }
  ```

- [ ] **Step 3: Add folder inline buttons to `view/item/context`**

  In `"menus": { "view/item/context": [ ... ] }`, add after the existing entries:

  ```json
  {
    "command": "claudegate.acceptFolder",
    "when": "view == claudegate.reviewPanel && viewItem == claudegate.folder.pending",
    "group": "inline@1"
  },
  {
    "command": "claudegate.rejectFolder",
    "when": "view == claudegate.reviewPanel && viewItem == claudegate.folder.pending",
    "group": "inline@2"
  }
  ```

  Note: `viewItem == claudegate.folder.pending` matches the updated `contextValue` set in Task 2 Step 1 — so these buttons only appear on pending folders, not accepted/rejected ones.

- [ ] **Step 4: Add `commandPalette` block to hide internal commands**

  In `"menus": { ... }`, add a new `"commandPalette"` key:

  ```json
  "commandPalette": [
    { "command": "claudegate.acceptFile",   "when": "false" },
    { "command": "claudegate.rejectFile",   "when": "false" },
    { "command": "claudegate.reapplyFile",  "when": "false" },
    { "command": "claudegate.acceptFolder", "when": "false" },
    { "command": "claudegate.rejectFolder", "when": "false" },
    { "command": "claudegate.viewAsTree",   "when": "false" },
    { "command": "claudegate.viewAsList",   "when": "false" },
    { "command": "claudegate.expandAll",    "when": "false" }
  ]
  ```

  After this, Cmd+Shift+P will only show: `ClaudeGate: Setup Hook`, `Clear Session`, `Accept All`, `Reject All`.

- [ ] **Step 5: Compile**

  ```bash
  npm run compile
  ```

  Expected: `out/extension.js` written, no errors.

- [ ] **Step 6: Commit**

  ```bash
  git add package.json
  git commit -m "feat: wire folder buttons, expand-all toolbar, hide internal commands from palette"
  ```

---

## Task 6: End-to-End Verification in Extension Development Host

No automated test runner exists — verification is manual via the Extension Development Host.

- [ ] **Step 1: Launch Extension Development Host**

  Press **F5** in VS Code/Cursor. A new window opens with the extension loaded.

- [ ] **Verify: Collapse/Expand All**

  Open the ClaudeGate sidebar. Confirm a Collapse All button (chevron icon) appears in the panel title bar. Collapse all groups, then run `ClaudeGate: Expand All` via the toolbar button (`$(expand-all)`) — all groups should re-expand.

- [ ] **Verify: Command Palette hygiene**

  Open Cmd+Shift+P and type "ClaudeGate". Confirm only these 4 commands appear:
  - `ClaudeGate: Setup Hook`
  - `ClaudeGate: Clear Session`
  - `ClaudeGate: Accept All`
  - `ClaudeGate: Reject All`

- [ ] **Verify: Workspace file filtering**

  Manually add a file path outside the workspace to `~/.claudegate/session.json` (e.g., `/tmp/external.txt` or `~/.claude/settings.json` with `"reviewStatus": "pending"` and `"originalContent": null`). Reload the session. Confirm the external file does **not** appear in the tree. Confirm the extension does not crash.

- [ ] **Verify: Folder-level accept/reject**

  Switch to tree view mode. In a session with multiple pending files under the same folder, hover over a folder node. Confirm `$(check)` and `$(x)` inline buttons appear. Click `$(check)` — all files in that folder should move to Accepted. Add new pending files, hover the folder, click `$(x)` — confirm the revert confirmation dialog appears with the correct count, and on "Revert" all files are restored.

- [ ] **Verify: Rejected new-file diff**

  Set up a session where a file has `"originalContent": null` (Claude created it) and `"reviewStatus": "rejected"` (user already rejected it) — `claudeContent` must be populated. Click the file in the tree. Confirm the diff opens with the left side showing `// New file — no original content` and the right side showing Claude's content (not an error or blank). Title should read `(rejected — Claude's version)`.

- [ ] **Final commit if any fixups were needed**

  ```bash
  git add -p
  git commit -m "fix: verification fixups for v1 improvements"
  ```
