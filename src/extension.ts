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

let _badgeBar: vscode.StatusBarItem | undefined;

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
    const log = vscode.window.createOutputChannel("ClaudeGate");
    context.subscriptions.push(log);
    log.appendLine("[INFO] ClaudeGate activating…");

    vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");

    const sessionManager = new SessionManager(log);
    const hookInstaller  = new HookInstaller(context, log);

    const badgeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    badgeBar.text    = "$(shield) 0";
    badgeBar.tooltip = "ClaudeGate: 0 pending file(s) — click to open review panel";
    badgeBar.command = "claudegate.pendingPanel.focus";
    badgeBar.show();
    _badgeBar = badgeBar;
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
        for (const { reviewStatus } of Object.values(session.files)) {
          counts[reviewStatus]++;
        }
      }

      vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", counts.accepted);
      vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", counts.rejected);

      pendingView.badge = counts.pending > 0 ? { value: counts.pending, tooltip: `${counts.pending} pending file(s)` } : undefined;

      if (_badgeBar) {
        _badgeBar.text            = `$(shield) ${counts.pending}`;
        _badgeBar.tooltip         = `ClaudeGate: ${counts.pending} pending file(s) — click to open review panel`;
        _badgeBar.backgroundColor = counts.pending > 0
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
      }
    });

    sessionManager.startWatching();
    context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

    refreshActiveFilePendingContext(sessionManager);
    log.appendLine("[INFO] ClaudeGate ready.");
  } catch (err) {
    console.error("[ClaudeGate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`ClaudeGate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {}
