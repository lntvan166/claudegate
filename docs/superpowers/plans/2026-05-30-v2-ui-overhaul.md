# ClaudeGate v2 UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single sidebar panel with three independent collapsible panels (PENDING / ACCEPTED / REJECTED), add Accept/Reject buttons to the editor title bar, and wire new bulk session actions for accepted and rejected files.

**Architecture:** `FilteredTreeProvider` replaces `ReviewTreeProvider` — one class, three instances, each scoped to a single `ReviewStatus`. `GroupItem` is removed (each panel IS its own group). `SessionManager` gains five new methods for reversing accepted/rejected decisions. `extension.ts` creates three `TreeView`s and tracks the active pending file for editor-title buttons. `package.json` is restructured with three view declarations and `editor/title` menu entries.

**Tech Stack:** TypeScript, VS Code Extension API, esbuild (bundler). No test runner — verification via `npm run typecheck` and manual Extension Development Host (F5).

---

## File Map

| File | What changes |
|---|---|
| `src/sessionManager.ts` | Add `revertAccepted`, `revertAcceptedAll`, `revertAcceptedFolder`, `reapplyAll`, `reapplyFolder` |
| `src/reviewPanel.ts` | Replace `ReviewTreeProvider` + `GroupItem` with `FilteredTreeProvider`; keep all item classes and helpers |
| `src/extension.ts` | Three `createTreeView` calls; `updateActivePending` listener; new command registrations; remove `expandAll` |
| `package.json` | Three view declarations; restructured `view/title` + `view/item/context` menus; `editor/title` entries; `showEditorButtons` config; updated `commandPalette` block |
| `README.md` | Add "Hiding Accept/Reject buttons in the editor" section |

---

## Task 1: SessionManager — five new methods

**Files:**
- Modify: `src/sessionManager.ts`

- [ ] **Step 1: Add `revertAccepted` after `acceptFolder`**

  In `src/sessionManager.ts`, after the closing `}` of `acceptFolder`, insert:

  ```typescript
  revertAccepted(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "accepted") return;
    entry.reviewStatus = "pending";
    this.log.appendLine(`[INFO] Reverted accepted: ${filePath}`);
    this.persist();
  }

  revertAcceptedAll(): void {
    if (!this.session) return;
    let count = 0;
    for (const entry of Object.values(this.session.files)) {
      if (entry.reviewStatus === "accepted") {
        entry.reviewStatus = "pending";
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Reverted all accepted: ${count} file(s)`);
    this.persist();
  }

  revertAcceptedFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    let count = 0;
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "accepted") {
        entry.reviewStatus = "pending";
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Reverted accepted folder: ${folderPath} (${count} file(s))`);
    this.persist();
  }
  ```

- [ ] **Step 2: Add `reapplyAll` and `reapplyFolder` after `reapplyFile`**

  After the closing `}` of `reapplyFile` (around line 189), insert:

  ```typescript
  reapplyAll(): void {
    if (!this.session) return;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus !== "rejected") continue;
      if (!entry.claudeContent) {
        errors.push(`${path.basename(fp)}: Cannot re-apply — content not available.`);
        this.log.appendLine(`[WARN] reapplyAll skipped ${fp}: no claudeContent`);
        continue;
      }
      try {
        fs.writeFileSync(fp, entry.claudeContent, "utf-8");
        entry.reviewStatus = "pending";
        entry.claudeContent = undefined;
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] reapplyAll failed for ${fp}: ${(err as Error).message}`);
      }
    }

    this.persist();
    this.log.appendLine(`[INFO] Reapplied all: ${count} file(s)`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `ClaudeGate: Could not re-apply ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }

  reapplyFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (!fp.startsWith(prefix) || entry.reviewStatus !== "rejected") continue;
      if (!entry.claudeContent) {
        errors.push(`${path.basename(fp)}: Cannot re-apply — content not available.`);
        this.log.appendLine(`[WARN] reapplyFolder skipped ${fp}: no claudeContent`);
        continue;
      }
      try {
        fs.writeFileSync(fp, entry.claudeContent, "utf-8");
        entry.reviewStatus = "pending";
        entry.claudeContent = undefined;
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] reapplyFolder failed for ${fp}: ${(err as Error).message}`);
      }
    }

    this.persist();
    this.log.appendLine(`[INFO] Reapplied folder: ${folderPath} (${count} file(s))`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `ClaudeGate: Could not re-apply ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }
  ```

- [ ] **Step 3: Typecheck**

  ```bash
  cd /Users/tuvan/Document/Src/claude-session-reviewer && npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/sessionManager.ts
  git commit -m "feat: add revertAccepted*, reapplyAll, reapplyFolder to SessionManager"
  ```

---

## Task 2: ReviewPanel — FilteredTreeProvider

**Files:**
- Modify: `src/reviewPanel.ts`

Replace the entire file content. The new file keeps `FolderItem`, `FileReviewItem`, `relativeDir`, `isInWorkspace`, `getWorkspaceRoot`, `closeDiffEditor`, `registerOpenDiff` — and replaces `ReviewTreeProvider` + `GroupItem` with `FilteredTreeProvider`.

- [ ] **Step 1: Replace `src/reviewPanel.ts` with the new implementation**

  Write the complete file:

  ```typescript
  import * as vscode from "vscode";
  import * as path from "path";
  import { SessionManager, ReviewStatus } from "./sessionManager";
  import { openDiff } from "./diffProvider";

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function getWorkspaceRoot(filePaths: string[]): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.[0]) return folders[0].uri.fsPath;

    if (!filePaths.length) return path.sep;
    const split = filePaths.map((fp) => fp.split(path.sep));
    let common = split[0].slice(0, -1);
    for (const parts of split.slice(1)) {
      let i = 0;
      while (i < common.length && common[i] === parts[i]) i++;
      common = common.slice(0, i);
    }
    return common.join(path.sep) || path.sep;
  }

  function relativeDir(filePath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        const rel = path.relative(folder.uri.fsPath, path.dirname(filePath));
        if (!rel.startsWith("..")) return rel || ".";
      }
    }
    const parts = path.dirname(filePath).split(path.sep);
    return parts.slice(-2).join("/");
  }

  function isInWorkspace(filePath: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return true;
    return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
  }

  // ─── Folder item (tree mode) ──────────────────────────────────────────────────

  export class FolderItem extends vscode.TreeItem {
    constructor(
      public readonly folderPath: string,
      public readonly groupStatus: ReviewStatus
    ) {
      super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
      this.resourceUri  = vscode.Uri.file(folderPath);
      this.tooltip      = folderPath;
      this.contextValue = `claudegate.folder.${groupStatus}`;
    }
  }

  // ─── File item ────────────────────────────────────────────────────────────────

  export class FileReviewItem extends vscode.TreeItem {
    constructor(
      public readonly filePath: string,
      public readonly reviewStatus: ReviewStatus,
      sessionManager: SessionManager,
      showPath = true
    ) {
      super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
      this.resourceUri  = vscode.Uri.file(filePath);
      this.description  = showPath ? relativeDir(filePath) : undefined;
      this.tooltip      = new vscode.MarkdownString(
        `**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
      );
      this.contextValue =
        reviewStatus === "pending"  ? "claudegate.file.pending"  :
        reviewStatus === "rejected" ? "claudegate.file.rejected" :
                                      "claudegate.file.accepted";
      this.command = {
        command:   "claudegate.openDiff",
        title:     "Open Diff",
        arguments: [filePath, sessionManager],
      };
    }
  }

  // ─── Filtered tree provider ───────────────────────────────────────────────────

  export type ViewMode = "list" | "tree";

  export class FilteredTreeProvider
    implements vscode.TreeDataProvider<vscode.TreeItem>
  {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<
      vscode.TreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private viewMode: ViewMode = "list";

    constructor(
      private readonly sessionManager: SessionManager,
      private readonly status: ReviewStatus
    ) {
      sessionManager.onSessionChange(() => this._onDidChangeTreeData.fire());
    }

    setViewMode(mode: ViewMode): void {
      this.viewMode = mode;
      this._onDidChangeTreeData.fire();
    }

    getViewMode(): ViewMode {
      return this.viewMode;
    }

    refresh(): void {
      this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
      return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
      const session = this.sessionManager.getSession();
      if (!session) return [];

      // Root: files/folders directly (no group header)
      if (!element) {
        const files = Object.entries(session.files)
          .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp))
          .map(([fp]) => fp);

        if (this.viewMode === "list") {
          return files.map(
            (fp) => new FileReviewItem(fp, this.status, this.sessionManager)
          );
        }
        const root = getWorkspaceRoot(files);
        return this.directChildren(files, root, this.status, false);
      }

      // Folder children (tree mode)
      if (element instanceof FolderItem) {
        const filesUnder = Object.entries(session.files)
          .filter(
            ([fp, e]) =>
              e.reviewStatus === this.status &&
              fp.startsWith(element.folderPath + path.sep) &&
              isInWorkspace(fp)
          )
          .map(([fp]) => fp);
        return this.directChildren(filesUnder, element.folderPath, this.status, false);
      }

      return [];
    }

    private directChildren(
      filePaths: string[],
      parentPath: string,
      status: ReviewStatus,
      showFilePath: boolean
    ): vscode.TreeItem[] {
      const seenFolders = new Set<string>();
      const folders: FolderItem[]     = [];
      const files:   FileReviewItem[] = [];

      for (const fp of filePaths) {
        const rel   = path.relative(parentPath, fp);
        const parts = rel.split(path.sep);
        if (parts.length === 1) {
          files.push(new FileReviewItem(fp, status, this.sessionManager, showFilePath));
        } else {
          const folderPath = path.join(parentPath, parts[0]);
          if (!seenFolders.has(folderPath)) {
            seenFolders.add(folderPath);
            folders.push(new FolderItem(folderPath, status));
          }
        }
      }

      folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
      files.sort((a, b) => a.filePath.localeCompare(b.filePath));
      return [...folders, ...files];
    }
  }

  // ─── Register commands ────────────────────────────────────────────────────────

  export function registerOpenDiff(
    context: vscode.ExtensionContext,
    sessionManager: SessionManager
  ): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "claudegate.openDiff",
        (filePath: string) => openDiff(filePath, sessionManager)
      )
    );
  }

  export async function closeDiffEditor(filePath: string): Promise<void> {
    const prefix = `ClaudeGate: ${path.basename(filePath)}`;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.label.startsWith(prefix)) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }
  ```

- [ ] **Step 2: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: errors will fire in `extension.ts` because it still imports `ReviewTreeProvider` and `GroupItem`. That is expected at this point — `extension.ts` is updated in Task 3.

  Verify that `reviewPanel.ts` itself has **no** type errors (errors should only be in extension.ts).

- [ ] **Step 3: Commit**

  ```bash
  git add src/reviewPanel.ts
  git commit -m "feat: replace ReviewTreeProvider with FilteredTreeProvider, remove GroupItem"
  ```

---

## Task 3: extension.ts — three panels, new commands, active-pending tracking

**Files:**
- Modify: `src/extension.ts`

Replace the entire file:

- [ ] **Step 1: Write the new `src/extension.ts`**

  ```typescript
  import * as vscode from "vscode";
  import * as path from "path";
  import { SessionManager } from "./sessionManager";
  import {
    FilteredTreeProvider,
    FileReviewItem,
    FolderItem,
    registerOpenDiff,
    closeDiffEditor,
  } from "./reviewPanel";
  import { HookInstaller } from "./hookInstaller";
  import { ClaudeGateContentProvider, SCHEME } from "./diffProvider";
  import { ClaudeGateDecorationProvider } from "./decorationProvider";

  let statusBarItem: vscode.StatusBarItem;

  // Path of the active pending file — read by editor-title button commands
  let activePendingFilePath: string | undefined;

  export function activate(context: vscode.ExtensionContext): void {
    try {
      const log = vscode.window.createOutputChannel("ClaudeGate");
      context.subscriptions.push(log);
      log.appendLine("[INFO] ClaudeGate activating…");

      vscode.commands.executeCommand("setContext", "claudegate.viewMode", "list");

      const sessionManager = new SessionManager(log);
      const hookInstaller  = new HookInstaller(context, log);

      const pendingProvider  = new FilteredTreeProvider(sessionManager, "pending");
      const acceptedProvider = new FilteredTreeProvider(sessionManager, "accepted");
      const rejectedProvider = new FilteredTreeProvider(sessionManager, "rejected");

      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
          SCHEME,
          new ClaudeGateContentProvider(sessionManager)
        )
      );

      context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(
          new ClaudeGateDecorationProvider(sessionManager)
        )
      );

      // ── Three sidebar panels ───────────────────────────────────────────────
      const pendingView = vscode.window.createTreeView("claudegate.pendingPanel", {
        treeDataProvider: pendingProvider,
        showCollapseAll:  true,
      });
      const acceptedView = vscode.window.createTreeView("claudegate.acceptedPanel", {
        treeDataProvider: acceptedProvider,
        showCollapseAll:  true,
      });
      const rejectedView = vscode.window.createTreeView("claudegate.rejectedPanel", {
        treeDataProvider: rejectedProvider,
        showCollapseAll:  true,
      });
      context.subscriptions.push(pendingView, acceptedView, rejectedView);

      // Status bar
      statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      statusBarItem.command = "workbench.view.extension.claudegate";
      context.subscriptions.push(statusBarItem);

      // ── Commands ──────────────────────────────────────────────────────────
      context.subscriptions.push(
        vscode.commands.registerCommand("claudegate.setupHook", () =>
          hookInstaller.setup()
        ),

        vscode.commands.registerCommand("claudegate.clearSession", () =>
          sessionManager.clearSession()
        ),

        // ── Pending file actions ──
        vscode.commands.registerCommand(
          "claudegate.acceptFile",
          async (item: FileReviewItem | { filePath: string }) => {
            sessionManager.acceptFile(item.filePath);
            await closeDiffEditor(item.filePath);
          }
        ),

        vscode.commands.registerCommand(
          "claudegate.rejectFile",
          async (item: FileReviewItem | { filePath: string }) => {
            const answer = await vscode.window.showWarningMessage(
              `Revert "${path.basename(item.filePath)}" to its original content?`,
              { modal: false },
              "Revert"
            );
            if (answer === "Revert") {
              sessionManager.rejectFile(item.filePath);
              await closeDiffEditor(item.filePath);
            }
          }
        ),

        // ── Pending folder actions ──
        vscode.commands.registerCommand(
          "claudegate.acceptFolder",
          (item: FolderItem) => sessionManager.acceptFolder(item.folderPath)
        ),

        vscode.commands.registerCommand(
          "claudegate.rejectFolder",
          async (item: FolderItem) => {
            const session = sessionManager.getSession();
            const pendingFiles = Object.entries(session?.files ?? {})
              .filter(
                ([fp, e]) =>
                  fp.startsWith(item.folderPath + path.sep) &&
                  e.reviewStatus === "pending"
              )
              .map(([fp]) => fp);
            if (pendingFiles.length === 0) return;
            const answer = await vscode.window.showWarningMessage(
              `Revert ${pendingFiles.length} file(s) in "${path.basename(item.folderPath)}" to their original content?`,
              { modal: false },
              "Revert"
            );
            if (answer === "Revert") {
              sessionManager.rejectFolder(item.folderPath);
              await Promise.all(pendingFiles.map((fp) => closeDiffEditor(fp)));
            }
          }
        ),

        // ── Accepted file/folder actions ──
        vscode.commands.registerCommand(
          "claudegate.revertAccepted",
          (item: FileReviewItem | { filePath: string }) =>
            sessionManager.revertAccepted(item.filePath)
        ),

        vscode.commands.registerCommand(
          "claudegate.revertAcceptedFolder",
          (item: FolderItem) => sessionManager.revertAcceptedFolder(item.folderPath)
        ),

        vscode.commands.registerCommand("claudegate.revertAcceptedAll", () =>
          sessionManager.revertAcceptedAll()
        ),

        // ── Rejected file/folder actions ──
        vscode.commands.registerCommand(
          "claudegate.reapplyFile",
          (item: FileReviewItem | { filePath: string }) =>
            sessionManager.reapplyFile(item.filePath)
        ),

        vscode.commands.registerCommand(
          "claudegate.reapplyFolder",
          (item: FolderItem) => sessionManager.reapplyFolder(item.folderPath)
        ),

        vscode.commands.registerCommand("claudegate.reapplyAll", () =>
          sessionManager.reapplyAll()
        ),

        // ── Bulk pending actions ──
        vscode.commands.registerCommand("claudegate.acceptAll", async () => {
          const session = sessionManager.getSession();
          const pending = session
            ? Object.entries(session.files).filter(([, e]) => e.reviewStatus === "pending")
            : [];
          sessionManager.acceptAll();
          await Promise.all(pending.map(([fp]) => closeDiffEditor(fp)));
        }),

        vscode.commands.registerCommand("claudegate.rejectAll", async () => {
          const pending = sessionManager.getPendingCount();
          if (pending === 0) return;
          const answer = await vscode.window.showWarningMessage(
            `Revert all ${pending} pending file(s) to their original content?`,
            { modal: true },
            "Revert All"
          );
          if (answer === "Revert All") {
            const session = sessionManager.getSession();
            const files = session
              ? Object.entries(session.files).filter(([, e]) => e.reviewStatus === "pending")
              : [];
            sessionManager.rejectAll();
            await Promise.all(files.map(([fp]) => closeDiffEditor(fp)));
          }
        }),

        // ── View mode toggle (pending panel only) ──
        vscode.commands.registerCommand("claudegate.viewAsTree", () => {
          pendingProvider.setViewMode("tree");
          vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");
        }),
        vscode.commands.registerCommand("claudegate.viewAsList", () => {
          pendingProvider.setViewMode("list");
          vscode.commands.executeCommand("setContext", "claudegate.viewMode", "list");
        }),

        // ── Editor-title buttons (active pending file) ──
        vscode.commands.registerCommand("claudegate.acceptActivePending", async () => {
          if (!activePendingFilePath) return;
          sessionManager.acceptFile(activePendingFilePath);
          await closeDiffEditor(activePendingFilePath);
        }),

        // Used from diff view — no confirmation dialog
        vscode.commands.registerCommand("claudegate.rejectActivePendingFromDiff", async () => {
          if (!activePendingFilePath) return;
          sessionManager.rejectFile(activePendingFilePath);
          await closeDiffEditor(activePendingFilePath);
        }),

        // Used from regular editor — shows confirmation
        vscode.commands.registerCommand("claudegate.rejectActivePending", async () => {
          if (!activePendingFilePath) return;
          const answer = await vscode.window.showWarningMessage(
            `Revert "${path.basename(activePendingFilePath)}" to its original content?`,
            { modal: false },
            "Revert"
          );
          if (answer === "Revert") {
            sessionManager.rejectFile(activePendingFilePath);
            await closeDiffEditor(activePendingFilePath);
          }
        })
      );

      registerOpenDiff(context, sessionManager);

      // ── Active pending file tracking ──────────────────────────────────────
      function updateActivePending(): void {
        const editor = vscode.window.activeTextEditor;
        const uri = editor?.document.uri;
        const filePath =
          uri?.scheme === "file"        ? uri.fsPath :
          uri?.scheme === "claudegate"  ? uri.path   :
          undefined;
        const session = sessionManager.getSession();
        const isPending = !!(
          filePath && session?.files[filePath]?.reviewStatus === "pending"
        );
        activePendingFilePath = isPending ? filePath : undefined;
        vscode.commands.executeCommand("setContext", "claudegate.isActivePending", isPending);
      }

      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => updateActivePending())
      );

      // ── Reactive updates ──────────────────────────────────────────────────
      sessionManager.onSessionChange((session) => {
        const counts = {
          pending:  0,
          accepted: 0,
          rejected: 0,
        };
        if (session) {
          for (const { reviewStatus } of Object.values(session.files)) {
            counts[reviewStatus]++;
          }
        }

        vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", counts.accepted);
        vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", counts.rejected);

        updateActivePending();
        updateStatusBar(session ? counts.pending : -1);

        pendingView.description  = counts.pending  > 0 ? String(counts.pending)  : undefined;
        acceptedView.description = counts.accepted > 0 ? String(counts.accepted) : undefined;
        rejectedView.description = counts.rejected > 0 ? String(counts.rejected) : undefined;
      });

      sessionManager.startWatching();
      context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

      log.appendLine("[INFO] ClaudeGate ready.");
    } catch (err) {
      console.error("[ClaudeGate] ACTIVATION ERROR:", err);
      vscode.window.showErrorMessage(`ClaudeGate failed to activate: ${(err as Error).message}`);
    }
  }

  export function deactivate(): void {
    statusBarItem?.dispose();
  }

  function updateStatusBar(pendingCount: number): void {
    if (pendingCount < 0) {
      statusBarItem.text = "$(circle-slash) ClaudeGate: No active review";
      statusBarItem.tooltip = "No active Claude session";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.show();
      return;
    }
    if (pendingCount === 0) {
      statusBarItem.text = "$(check) ClaudeGate: All reviewed";
      statusBarItem.tooltip = "All changes reviewed — clear session when done";
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(diff) ClaudeGate: ${pendingCount} pending`;
      statusBarItem.tooltip = `${pendingCount} file${pendingCount !== 1 ? "s" : ""} waiting for review`;
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    statusBarItem.show();
  }
  ```

- [ ] **Step 2: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/extension.ts
  git commit -m "feat: three panel tree views, editor-title active-pending tracking, new commands"
  ```

---

## Task 4: package.json — three views, menus, editor/title, config

**Files:**
- Modify: `package.json`

This task restructures `contributes.views`, `contributes.viewsWelcome`, `contributes.commands`, `contributes.menus`, and adds `contributes.configuration`. Make changes in order.

- [ ] **Step 1: Replace `contributes.views` with three panel declarations**

  Find:
  ```json
  "views": {
    "claudegate": [
      {
        "id": "claudegate.reviewPanel",
        "name": "Review Session"
      }
    ]
  }
  ```

  Replace with:
  ```json
  "views": {
    "claudegate": [
      {
        "id": "claudegate.pendingPanel",
        "name": "Pending"
      },
      {
        "id": "claudegate.acceptedPanel",
        "name": "Accepted",
        "when": "claudegate.acceptedCount > 0"
      },
      {
        "id": "claudegate.rejectedPanel",
        "name": "Rejected",
        "when": "claudegate.rejectedCount > 0"
      }
    ]
  }
  ```

- [ ] **Step 2: Update `contributes.viewsWelcome`**

  Find:
  ```json
  "viewsWelcome": [
    {
      "view": "claudegate.reviewPanel",
      "contents": "No active Claude session.\n\nRun Claude Code in your terminal to start tracking changes.\n\n[Setup Hook](command:claudegate.setupHook)\n\n[View Documentation](https://github.com/claudegate/claudegate#readme)"
    }
  ]
  ```

  Replace with:
  ```json
  "viewsWelcome": [
    {
      "view": "claudegate.pendingPanel",
      "contents": "No pending files.\n\nRun Claude Code in your terminal to start tracking changes.\n\n[Setup Hook](command:claudegate.setupHook)"
    }
  ]
  ```

- [ ] **Step 3: Add new command declarations to `contributes.commands`**

  After the existing `claudegate.viewAsList` entry, add:
  ```json
  {
    "command": "claudegate.revertAccepted",
    "title": "Revert to Pending",
    "icon": "$(debug-step-back)"
  },
  {
    "command": "claudegate.revertAcceptedFolder",
    "title": "Revert Folder to Pending",
    "icon": "$(debug-step-back)"
  },
  {
    "command": "claudegate.revertAcceptedAll",
    "title": "Revert All Accepted",
    "icon": "$(discard)"
  },
  {
    "command": "claudegate.reapplyFolder",
    "title": "Re-apply Folder",
    "icon": "$(debug-restart)"
  },
  {
    "command": "claudegate.reapplyAll",
    "title": "Re-apply All",
    "icon": "$(debug-restart)"
  },
  {
    "command": "claudegate.acceptActivePending",
    "title": "Accept",
    "icon": "$(check)"
  },
  {
    "command": "claudegate.rejectActivePendingFromDiff",
    "title": "Reject",
    "icon": "$(x)"
  },
  {
    "command": "claudegate.rejectActivePending",
    "title": "Reject",
    "icon": "$(x)"
  }
  ```

  Also **delete** the existing `claudegate.expandAll` entry from `contributes.commands` (the 4-line block with `"command": "claudegate.expandAll"`). It is no longer needed — each panel has native collapse via `showCollapseAll: true`.

- [ ] **Step 4: Replace entire `contributes.menus` block**

  Replace the existing `"menus": { ... }` with:

  ```json
  "menus": {
    "view/title": [
      {
        "command": "claudegate.viewAsTree",
        "when": "view == claudegate.pendingPanel && claudegate.viewMode == 'list'",
        "group": "navigation@1"
      },
      {
        "command": "claudegate.viewAsList",
        "when": "view == claudegate.pendingPanel && claudegate.viewMode == 'tree'",
        "group": "navigation@1"
      },
      {
        "command": "claudegate.acceptAll",
        "when": "view == claudegate.pendingPanel",
        "group": "navigation@2"
      },
      {
        "command": "claudegate.rejectAll",
        "when": "view == claudegate.pendingPanel",
        "group": "navigation@3"
      },
      {
        "command": "claudegate.clearSession",
        "when": "view == claudegate.pendingPanel",
        "group": "navigation@4"
      },
      {
        "command": "claudegate.revertAcceptedAll",
        "when": "view == claudegate.acceptedPanel",
        "group": "navigation@1"
      },
      {
        "command": "claudegate.reapplyAll",
        "when": "view == claudegate.rejectedPanel",
        "group": "navigation@1"
      }
    ],
    "view/item/context": [
      {
        "command": "claudegate.acceptFile",
        "when": "view == claudegate.pendingPanel && viewItem == claudegate.file.pending",
        "group": "inline@1"
      },
      {
        "command": "claudegate.rejectFile",
        "when": "view == claudegate.pendingPanel && viewItem == claudegate.file.pending",
        "group": "inline@2"
      },
      {
        "command": "claudegate.acceptFolder",
        "when": "view == claudegate.pendingPanel && viewItem == claudegate.folder.pending",
        "group": "inline@1"
      },
      {
        "command": "claudegate.rejectFolder",
        "when": "view == claudegate.pendingPanel && viewItem == claudegate.folder.pending",
        "group": "inline@2"
      },
      {
        "command": "claudegate.revertAccepted",
        "when": "view == claudegate.acceptedPanel && viewItem == claudegate.file.accepted",
        "group": "inline@1"
      },
      {
        "command": "claudegate.revertAcceptedFolder",
        "when": "view == claudegate.acceptedPanel && viewItem == claudegate.folder.accepted",
        "group": "inline@1"
      },
      {
        "command": "claudegate.reapplyFile",
        "when": "view == claudegate.rejectedPanel && viewItem == claudegate.file.rejected",
        "group": "inline@1"
      },
      {
        "command": "claudegate.reapplyFolder",
        "when": "view == claudegate.rejectedPanel && viewItem == claudegate.folder.rejected",
        "group": "inline@1"
      }
    ],
    "editor/title": [
      {
        "command": "claudegate.acceptActivePending",
        "when": "claudegate.isActivePending",
        "group": "navigation@1"
      },
      {
        "command": "claudegate.rejectActivePendingFromDiff",
        "when": "activeEditorIsDiffEditor && claudegate.isActivePending",
        "group": "navigation@2"
      },
      {
        "command": "claudegate.rejectActivePending",
        "when": "!activeEditorIsDiffEditor && claudegate.isActivePending && config.claudegate.showEditorButtons",
        "group": "navigation@2"
      }
    ],
    "commandPalette": [
      { "command": "claudegate.acceptFile",                "when": "false" },
      { "command": "claudegate.rejectFile",                "when": "false" },
      { "command": "claudegate.reapplyFile",               "when": "false" },
      { "command": "claudegate.acceptFolder",              "when": "false" },
      { "command": "claudegate.rejectFolder",              "when": "false" },
      { "command": "claudegate.revertAccepted",            "when": "false" },
      { "command": "claudegate.revertAcceptedFolder",      "when": "false" },
      { "command": "claudegate.reapplyFolder",             "when": "false" },
      { "command": "claudegate.viewAsTree",                "when": "false" },
      { "command": "claudegate.viewAsList",                "when": "false" },
      { "command": "claudegate.acceptActivePending",       "when": "false" },
      { "command": "claudegate.rejectActivePendingFromDiff","when": "false" },
      { "command": "claudegate.rejectActivePending",        "when": "false" },
      { "command": "claudegate.revertAcceptedAll",          "when": "false" },
      { "command": "claudegate.reapplyAll",                 "when": "false" }
    ]
  }
  ```

- [ ] **Step 5: Add `contributes.configuration`**

  After the `"menus"` closing `}`, before the closing `}` of `"contributes"`, add:

  ```json
  "configuration": {
    "title": "ClaudeGate",
    "properties": {
      "claudegate.showEditorButtons": {
        "type": "boolean",
        "default": true,
        "description": "Show Accept/Reject buttons in the editor title bar for pending files. Buttons in the diff view are always shown."
      }
    }
  }
  ```

- [ ] **Step 6: Compile to verify JSON is valid**

  ```bash
  npm run compile
  ```

  Expected: `out/extension.js` written, no errors.

- [ ] **Step 7: Commit**

  ```bash
  git add package.json
  git commit -m "feat: three panel views, editor/title buttons, showEditorButtons config, restructured menus"
  ```

---

## Task 5: README — editor buttons documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the editor buttons section**

  Read `README.md` to find the end of the document, then append a new section. Add the following after the last existing section:

  ```markdown
  ---

  ## Hiding the Accept/Reject buttons in the editor

  By default, ClaudeGate shows **Accept** (✓) and **Reject** (✕) icon buttons in the editor title bar whenever you open a file that is pending review. They also appear in the ClaudeGate diff view with no extra configuration.

  To hide the buttons in the regular editor (not the diff view):

  1. Open Settings (`Cmd+,` / `Ctrl+,`)
  2. Search for **`ClaudeGate: Show Editor Buttons`**
  3. Uncheck the setting

  Or add this to your `settings.json`:

  ```json
  "claudegate.showEditorButtons": false
  ```

  > **Note:** The buttons in the diff view (opened by clicking a file in the ClaudeGate sidebar) are always shown and cannot be disabled separately.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add README.md
  git commit -m "docs: add editor buttons section to README"
  ```

---

## Task 6: Final typecheck + compile

- [ ] **Step 1: Full typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: zero errors.

- [ ] **Step 2: Full compile**

  ```bash
  npm run compile
  ```

  Expected: `out/extension.js` written cleanly.

- [ ] **Step 3: Manual spot-check in Extension Development Host**

  Press **F5** in VS Code/Cursor. In the Extension Development Host:

  - ClaudeGate sidebar shows **PENDING** panel only (no ACCEPTED or REJECTED yet)
  - Add entries to `~/.claudegate/session.json` with `accepted` and `rejected` statuses — ACCEPTED and REJECTED panels appear
  - Remove those entries — panels disappear
  - Pending file: hover shows ✓ and ✕ inline buttons
  - Accepted file: hover shows ↩ inline button
  - Rejected file: hover shows ↻ inline button
  - Open a pending file in the editor — ✓ and ✕ appear in the editor title bar
  - Open the diff (click file in sidebar) — ✓ and ✕ appear in title bar, Reject has no confirmation dialog
  - Cmd+Shift+P: only `Setup Hook`, `Clear Session`, `Accept All`, `Reject All`, `Revert All Accepted`, `Re-apply All` visible

- [ ] **Step 4: Commit any fixups**

  ```bash
  git add -p
  git commit -m "fix: verification fixups for v2 UI overhaul"
  ```
