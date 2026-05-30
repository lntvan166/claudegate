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
import { ClaudeGateCodeLensProvider } from "./codeLensProvider";


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

    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        "*",
        new ClaudeGateCodeLensProvider(sessionManager)
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

      pendingView.badge = counts.pending > 0 ? { value: counts.pending, tooltip: `${counts.pending} pending file(s)` } : undefined;
    });

    sessionManager.startWatching();
    context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

    log.appendLine("[INFO] ClaudeGate ready.");
  } catch (err) {
    console.error("[ClaudeGate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`ClaudeGate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {}
