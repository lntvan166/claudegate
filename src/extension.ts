import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";
import { ReviewTreeProvider, registerOpenDiff, FileReviewItem, closeDiffEditor, GroupItem } from "./reviewPanel";
import { HookInstaller } from "./hookInstaller";
import { ClaudeGateContentProvider, SCHEME } from "./diffProvider";
import { ClaudeGateDecorationProvider } from "./decorationProvider";

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  try {
  // Structured output channel — visible in Output panel → "ClaudeGate"
  const log = vscode.window.createOutputChannel("ClaudeGate");
  context.subscriptions.push(log);
  log.appendLine("[INFO] ClaudeGate activating…");
  console.log("[ClaudeGate] activate() called");
  // Set initial view mode context so the toggle button renders correctly
  vscode.commands.executeCommand("setContext", "claudegate.viewMode", "list");

  const sessionManager = new SessionManager(log);
  const treeProvider = new ReviewTreeProvider(sessionManager);
  const hookInstaller = new HookInstaller(context, log);
  const contentProvider = new ClaudeGateContentProvider(sessionManager);

  // Virtual document provider for original file content (left side of diff)
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider)
  );

  // File decoration provider — adds M/A/R badge and color in Explorer + editor tabs
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(
      new ClaudeGateDecorationProvider(sessionManager)
    )
  );

  // Sidebar tree view
  const treeView = vscode.window.createTreeView("claudegate.reviewPanel", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Status bar — always visible, reflects current state
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "workbench.view.extension.claudegate";
  context.subscriptions.push(statusBarItem);

  // ─── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("claudegate.setupHook", () =>
      hookInstaller.setup()
    ),

    vscode.commands.registerCommand("claudegate.clearSession", () => {
      sessionManager.clearSession();
    }),

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

    vscode.commands.registerCommand(
      "claudegate.reapplyFile",
      (item: FileReviewItem | { filePath: string }) =>
        sessionManager.reapplyFile(item.filePath)
    ),

    // View mode toggle (same pattern as VS Code Git extension)
    vscode.commands.registerCommand("claudegate.viewAsTree", () =>
      treeProvider.setViewMode("tree")
    ),
    vscode.commands.registerCommand("claudegate.viewAsList", () =>
      treeProvider.setViewMode("list")
    ),

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
    })
  );

  registerOpenDiff(context, sessionManager);

  // ─── Reactive updates ───────────────────────────────────────────────────────

  sessionManager.onSessionChange((session) => {
    const pending = session ? sessionManager.getPendingCount() : -1;
    updateStatusBar(pending);
    treeView.description =
      session && pending > 0 ? `${pending} pending` : undefined;
  });

  sessionManager.startWatching();
  context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

  log.appendLine("[INFO] ClaudeGate ready.");
  console.log("[ClaudeGate] ready, session =", sessionManager.getSession());
  } catch (err) {
    console.error("[ClaudeGate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`ClaudeGate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {
  statusBarItem?.dispose();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
