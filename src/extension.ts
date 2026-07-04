import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
import { DocumentTracker } from "./documentTracker";
import { persistWorkspaceRoots } from "./workspaceRoots";
import { isInWorkspace } from "./workspaceScope";


function getActivePendingFilePath(sessionManager: SessionManager): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const uri = editor.document.uri;
  const filePath =
    uri.scheme === "file"       ? uri.fsPath :
    uri.scheme === "claudegate" ? uri.path   :
    undefined;
  if (!filePath) return undefined;
  return sessionManager.getSession()?.files[filePath]?.reviewStatus === "pending"
    ? filePath
    : undefined;
}

function refreshActiveFilePendingContext(sessionManager: SessionManager): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const scheme = editor.document.uri.scheme;
    if (scheme !== "file" && scheme !== "claudegate") return;
  }
  const pending = getActivePendingFilePath(sessionManager);
  vscode.commands.executeCommand("setContext", "claudegate.activeFileIsPending", pending !== undefined);
}


export function activate(context: vscode.ExtensionContext): void {
  try {
    const log = vscode.window.createOutputChannel("Claude Gate");
    context.subscriptions.push(log);
    log.appendLine("[INFO] Claude Gate activating…");

    vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");

    persistWorkspaceRoots();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => persistWorkspaceRoots())
    );

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessionManager = new SessionManager(log, workspacePath);
    const hookInstaller  = new HookInstaller(context, log);
    void hookInstaller.syncHookIfNeeded().then(() => {
      hookInstaller.warnIfHookNotRegisteredInSettings();
    });
    const documentTracker = new DocumentTracker(sessionManager, workspacePath, log);

    const badgeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    badgeBar.text    = "$(shield) 0";
    badgeBar.tooltip = "Claude Gate: 0 pending file(s) — click to open review panel";
    badgeBar.command = "claudegate.pendingPanel.focus";
    badgeBar.show();
    context.subscriptions.push(badgeBar);

    const pendingProvider  = new FilteredTreeProvider(sessionManager, "pending",  "tree");
    const acceptedProvider = new FilteredTreeProvider(sessionManager, "accepted", "tree");
    const rejectedProvider = new FilteredTreeProvider(sessionManager, "rejected", "tree");

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
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(sessionManager);
          if (!filePath) return;
          sessionManager.acceptFile(filePath);
          await closeDiffEditor(filePath);
        }
      ),

      vscode.commands.registerCommand(
        "claudegate.rejectFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(sessionManager);
          if (!filePath) return;
          const answer = await vscode.window.showWarningMessage(
            `Revert "${path.basename(filePath)}" to its original content?`,
            { modal: false },
            "Revert"
          );
          if (answer === "Revert") {
            sessionManager.rejectFile(filePath);
            await closeDiffEditor(filePath);
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

      vscode.commands.registerCommand("claudegate.clearAccepted", () =>
        sessionManager.clearAccepted()
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
          ? Object.entries(session.files).filter(
              ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp)
            )
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
            ? Object.entries(session.files).filter(
                ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp)
              )
            : [];
          sessionManager.rejectAll();
          await Promise.all(files.map(([fp]) => closeDiffEditor(fp)));
        }
      }),

      vscode.commands.registerCommand("claudegate.clearRejected", () =>
        sessionManager.clearRejected()
      ),

      // ── View mode toggle (all panels) ──
      vscode.commands.registerCommand("claudegate.viewAsTree", () => {
        pendingProvider.setViewMode("tree");
        acceptedProvider.setViewMode("tree");
        rejectedProvider.setViewMode("tree");
        vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");
      }),
      vscode.commands.registerCommand("claudegate.viewAsList", () => {
        pendingProvider.setViewMode("list");
        acceptedProvider.setViewMode("list");
        rejectedProvider.setViewMode("list");
        vscode.commands.executeCommand("setContext", "claudegate.viewMode", "list");
      })
    );

    registerOpenDiff(context, sessionManager);

    // ── Reactive updates ──────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        refreshActiveFilePendingContext(sessionManager)
      )
    );

    sessionManager.onSessionChange((session) => {
      refreshActiveFilePendingContext(sessionManager);
      const counts = {
        pending:  0,
        accepted: 0,
        rejected: 0,
      };
      if (session) {
        for (const [filePath, { reviewStatus }] of Object.entries(session.files)) {
          if (!isInWorkspace(filePath)) continue;
          counts[reviewStatus]++;
        }
      }

      vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", counts.accepted);
      vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", counts.rejected);

      pendingView.badge = counts.pending > 0 ? { value: counts.pending, tooltip: `${counts.pending} pending file(s)` } : undefined;

      badgeBar.text            = `$(shield) ${counts.pending}`;
      badgeBar.tooltip         = `Claude Gate: ${counts.pending} pending file(s) — click to open review panel`;
      badgeBar.backgroundColor = counts.pending > 0
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    });

    sessionManager.startWatching();
    context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

    const isWatcherEnabled = () =>
      vscode.workspace.getConfiguration("claudegate").get<boolean>("fileWatcher.enabled", true);

    if (isWatcherEnabled()) {
      documentTracker.start();
    } else {
      log.appendLine("[INFO] File watcher disabled (claudegate.fileWatcher.enabled=false); using CLI hook only.");
    }
    context.subscriptions.push({ dispose: () => documentTracker.stop() });

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("claudegate.fileWatcher.enabled")) return;
        if (isWatcherEnabled()) {
          documentTracker.start();
          log.appendLine("[INFO] File watcher enabled.");
        } else {
          documentTracker.stop();
          log.appendLine("[INFO] File watcher disabled.");
        }
      })
    );

    // One-time migration notice: v1.0 used a single ~/.claudegate/session.json;
    // v1.1+ uses per-workspace files. Warn users with an existing old file so
    // they know to re-run Setup Hook and that previous session data is not migrated.
    const legacyPath = path.join(os.homedir(), ".claudegate", "session.json");
    const migrationKey = "claudegate.shownMigrationNotice";
    if (fs.existsSync(legacyPath) && !context.globalState.get(migrationKey)) {
      context.globalState.update(migrationKey, true);
      vscode.window.showInformationMessage(
        "Claude Gate has been updated to use per-workspace session files. " +
        "Please re-run 'Claude Gate: Setup Hook' to install the updated hook script."
      );
    }

    refreshActiveFilePendingContext(sessionManager);
    log.appendLine("[INFO] Claude Gate ready.");
  } catch (err) {
    console.error("[Claude Gate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`Claude Gate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {}
