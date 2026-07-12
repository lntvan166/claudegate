import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionManager } from "./sessionManager";
import {
  FilteredTreeProvider,
  FileReviewItem,
  FolderItem,
  WorktreeGroupItem,
  registerOpenDiff,
  closeDiffEditor,
} from "./reviewPanel";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { HookInstaller } from "./hookInstaller";
import { SettingsTreeProvider, SettingsItem } from "./settingsPanel";
import { ClaudeGateContentProvider, SCHEME, openReviewRecord, openHistoryRecord, originalUri } from "./diffProvider";
import { HistoryTreeProvider, HistorySessionItem } from "./historyPanel";
import { formatBytes } from "./historyModel";
import { ClaudeGateDecorationProvider } from "./decorationProvider";
import { DocumentTracker } from "./documentTracker";
import { sessionFeedbackItems, buildFeedbackText } from "./reviewFeedback";
import { fileEntryFor } from "./reviewModel";
import { persistWorkspaceRoots } from "./workspaceRoots";
import { isInWorkspace, isExcluded, isProtected, setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { ExcludeMatcher, DEFAULT_EXCLUDES } from "./excludeMatcher";
import { saveDirtyPending } from "./saveEdits";


function getActivePendingFilePath(managerFor: (p?: string) => SessionManager): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const uri = editor.document.uri;
  const filePath =
    uri.scheme === "file"       ? uri.fsPath :
    uri.scheme === "claudegate" ? uri.path   :
    undefined;
  if (!filePath) return undefined;
  if (!isInWorkspace(filePath) || isExcluded(filePath)) return undefined;
  // Resolve the owning session (primary or the worktree the file belongs to).
  // Case-tolerant lookup: the editor URI's drive-letter case can differ from
  // the hook-stored session key on Windows (fileEntryFor handles it).
  const mgr = managerFor(filePath);
  const session = mgr.getSession();
  const entry = session ? fileEntryFor(session.files, filePath) : undefined;
  return entry?.reviewStatus === "pending" && mgr.hasRealPendingChange(filePath)
    ? filePath
    : undefined;
}

// Replaces the old yes/no reject confirm with an optional reason capture: the
// input box IS the confirmation (submit = reject, Esc = cancel). Empty reason
// is allowed. The reason feeds the "Feedback to AI" log via ReviewRecord.reason.
// ("Reject" = discard Claude's change and restore the original; distinct from the
// Accepted panel's "Revert to Pending", which un-accepts a kept file.)
async function promptRejectReason(basename: string): Promise<{ ok: boolean; reason?: string }> {
  const input = await vscode.window.showInputBox({
    title: `Reject "${basename}" — restore its original content`,
    prompt: "Reason to feed back to AI (optional) — leave blank to just reject. Press Esc to cancel.",
    placeHolder: "e.g. don't drop legacyDropoff — still called by the batch job",
  });
  if (input === undefined) return { ok: false };          // Esc / dismissed → cancel
  return { ok: true, reason: input.trim() || undefined }; // submitted (empty allowed) → reject
}

// Modal confirmation for a bulk action that clears history or rewrites many files
// on disk. Returns true only if the user picked the confirming action.
async function confirmBulk(message: string, action: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return answer === action;
}

function refreshActiveFilePendingContext(managerFor: (p?: string) => SessionManager): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const scheme = editor.document.uri.scheme;
    if (scheme !== "file" && scheme !== "claudegate") return;
  }
  const pending = getActivePendingFilePath(managerFor);
  vscode.commands.executeCommand("setContext", "claudegate.activeFileIsPending", pending !== undefined);
}


export function activate(context: vscode.ExtensionContext): void {
  try {
    const log = vscode.window.createOutputChannel("Claude Gate");
    context.subscriptions.push(log);
    log.appendLine("[INFO] Claude Gate activating…");

    vscode.commands.executeCommand(
      "setContext",
      "claudegate.claudeContextAvailable",
      !!vscode.extensions.getExtension("lntvan166.claude-context")
    );

    const updateClaudegateConfig = async (key: string, value: unknown): Promise<void> => {
      const target =
        (vscode.workspace.workspaceFolders?.length ?? 0) > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await vscode.workspace.getConfiguration("claudegate").update(key, value, target);
      } catch (err) {
        log.appendLine(`[ERROR] Failed to update claudegate.${key}: ${(err as Error).message}`);
        vscode.window.showErrorMessage(
          `Claude Gate: could not update ${key} — ${(err as Error).message}`
        );
      }
    };

    const userExcludeMap = (): Record<string, boolean> => {
      const info = vscode.workspace.getConfiguration("claudegate").inspect<Record<string, boolean>>("exclude");
      const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      const own = hasFolder ? info?.workspaceValue : info?.globalValue;
      return { ...(own ?? {}) };
    };

    vscode.commands.executeCommand("setContext", "claudegate.viewMode", "tree");

    persistWorkspaceRoots();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => persistWorkspaceRoots())
    );

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const excludeMatcher = new ExcludeMatcher();
    const loadExclude = () =>
      excludeMatcher.reload(
        vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("exclude"),
        workspacePath
      );
    loadExclude();
    setExcludeMatcher(excludeMatcher);
    const protectedMatcher = new ExcludeMatcher();
    const loadProtected = () =>
      protectedMatcher.reload(
        vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("protected"),
        workspacePath
      );
    loadProtected();
    setProtectedMatcher(protectedMatcher);
    const sessionManager = new SessionManager(log, workspacePath);
    const worktreeRegistry = new WorktreeSessionRegistry(log, workspacePath);
    // Route a file/folder path to its owning session: the worktree it falls under,
    // else the primary window session.
    const managerFor = (p?: string): SessionManager =>
      (p ? worktreeRegistry.managerFor(p) : null) ?? sessionManager;

    // ── "Review All Pending" — native multi-file diff editor ────────────────
    // Opens every pending change in VS Code's built-in multi-diff editor for a
    // one-pass review. Worktree-aware: aggregates pending files across the
    // primary session AND every attached nested worktree. Each resource is the
    // triple [file, original(read-only claudegate: doc), file] — the left side
    // resolves through managerFor(), so a worktree file shows ITS own baseline.
    const allManagers = (): SessionManager[] =>
      [sessionManager, ...worktreeRegistry.getManagers().values()];
    const pendingReviewPaths = (): string[] => {
      const paths: string[] = [];
      for (const mgr of allManagers()) {
        const s = mgr.getSession();
        if (!s) continue;
        for (const [fp, e] of Object.entries(s.files)) {
          if (e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp) && mgr.hasRealPendingChange(fp)) {
            paths.push(fp);
          }
        }
      }
      // Protected files first, then alphabetical — a stable, predictable order.
      return paths.sort((a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b));
    };
    const isPendingMultiDiffOpen = (): boolean =>
      vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.startsWith("Claude Gate: Pending")));
    const closePendingMultiDiff = async (): Promise<void> => {
      const stale = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label.startsWith("Claude Gate: Pending"));
      if (stale.length > 0) await vscode.window.tabGroups.close(stale);
    };
    const openPendingMultiDiff = async (paths: string[]): Promise<void> => {
      const resourceList = paths.map((fp) => [vscode.Uri.file(fp), originalUri(fp), vscode.Uri.file(fp)]);
      try {
        await vscode.commands.executeCommand("vscode.changes", `Claude Gate: Pending (${paths.length})`, resourceList);
      } catch (err) {
        log.appendLine(`[WARN] reviewAllPending: vscode.changes failed: ${(err as Error).message}`);
        vscode.window.showWarningMessage(
          "Claude Gate: the multi-file diff view isn't available in this VS Code version."
        );
      }
    };

    const hookInstaller  = new HookInstaller(context, log);
    void hookInstaller.syncHookIfNeeded().then(() => {
      hookInstaller.warnIfHookNotRegisteredInSettings();
    });
    // Health signal: warn if settings.json changes out from under a running
    // session (which silently invalidates the hook until the session restarts).
    context.subscriptions.push(hookInstaller.watchSettingsForTrustInvalidation());
    const documentTracker = new DocumentTracker(sessionManager, workspacePath, log);

    // Keep the hook.py sentinel file in sync with the hookLog.enabled setting
    // (the hook only checks a file on disk, not VS Code config, on each fire).
    const syncHookLogSentinel = () =>
      hookInstaller.setHookLogEnabled(
        vscode.workspace.getConfiguration("claudegate").get<boolean>("hookLog.enabled", false)
      );
    syncHookLogSentinel();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudegate.hookLog.enabled")) syncHookLogSentinel();
      })
    );

    const badgeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    badgeBar.text    = "$(shield) 0";
    badgeBar.tooltip = "Claude Gate: 0 pending file(s) — click to open review panel";
    badgeBar.command = "claudegate.pendingPanel.focus";
    badgeBar.show();
    context.subscriptions.push(badgeBar);

    // Hook-health status chip: hidden when healthy, surfaces a warning with a
    // one-click fix (Setup Hook / Verify Setup) when the hook needs attention.
    const hookHealthBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    context.subscriptions.push(hookHealthBar);
    const HEALTH_TEXT: Record<string, string> = {
      "not-installed": "hook not installed",
      "not-registered": "hook not registered",
      "stale": "hook update available",
      "trust-invalidated": "restart Claude sessions",
    };
    const renderHookHealth = (health: string) => {
      if (health === "ok") { hookHealthBar.hide(); return; }
      hookHealthBar.text = `$(warning) Claude Gate`;
      hookHealthBar.tooltip = `Claude Gate: ${HEALTH_TEXT[health] ?? health} — click for details`;
      hookHealthBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      hookHealthBar.command = health === "not-installed" || health === "not-registered"
        ? "claudegate.setupHook" : "claudegate.verifyHook";
      hookHealthBar.show();
    };
    context.subscriptions.push(hookInstaller.onHealthChange(renderHookHealth));
    renderHookHealth(hookInstaller.getHealth());

    const pendingProvider  = new FilteredTreeProvider(sessionManager, "pending",  "tree", worktreeRegistry);
    const acceptedProvider = new FilteredTreeProvider(sessionManager, "accepted", "tree");
    const rejectedProvider = new FilteredTreeProvider(sessionManager, "rejected", "tree");

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        SCHEME,
        new ClaudeGateContentProvider(sessionManager, managerFor)
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

    const settingsProvider = new SettingsTreeProvider(hookInstaller, context.subscriptions);
    const settingsView = vscode.window.createTreeView("claudegate.settingsPanel", {
      treeDataProvider: settingsProvider,
    });
    context.subscriptions.push(settingsView);
    // The Settings Hook row reads ~/.claude/settings.json directly, so an
    // external edit that breaks/repairs registration fires no config event.
    // onHealthChange DOES fire on the settings.json watchFile change, so refresh
    // the tree from it too — otherwise the status-bar chip updates but the row
    // shows stale status until the next config event. (Spec A.)
    context.subscriptions.push(hookInstaller.onHealthChange(() => settingsProvider.refresh()));

    // ── History panel (view-only archives from Clear Session) ───────────────
    const historyProvider = new HistoryTreeProvider(workspacePath ?? null);
    historyProvider.start();
    const historyView = vscode.window.createTreeView("claudegate.historyPanel", {
      treeDataProvider: historyProvider,
    });
    const updateHistoryContext = () =>
      vscode.commands.executeCommand("setContext", "claudegate.historyCount", historyProvider.getCount());
    context.subscriptions.push(
      historyView,
      { dispose: () => historyProvider.stop() },
      historyProvider.onDidChangeTreeData(updateHistoryContext)
    );
    updateHistoryContext();

    const openNextPending = async (): Promise<void> => {
      const session = sessionManager.getSession();
      const next = session
        ? Object.entries(session.files)
            .filter(
              ([fp, e]) =>
                e.reviewStatus === "pending" &&
                isInWorkspace(fp) &&
                !isExcluded(fp) &&
                sessionManager.hasRealPendingChange(fp)
            )
            .map(([fp]) => fp)
            .sort((a, b) => a.localeCompare(b))[0]
        : undefined;
      if (next) {
        await vscode.commands.executeCommand("claudegate.openDiff", next);
      } else {
        vscode.window.showInformationMessage("Claude Gate: all caught up ✓");
      }
    };

    // ── Commands ──────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand("claudegate.setupHook", async () => {
        await hookInstaller.setup();
        settingsProvider.refresh();
      }),

      vscode.commands.registerCommand("claudegate.clearSession", async () => {
        const s = sessionManager.getSession();
        if (!s) return;
        const historyOn = vscode.workspace.getConfiguration("claudegate").get<boolean>("history.enabled", true);
        const pending = Object.keys(s.files).length;
        const base = pending > 0
          ? `Clear this review session? ${pending} pending change(s) will stop being tracked (files on disk are left as-is).`
          : "Clear this review session, including its accepted/rejected history?";
        const message = historyOn ? base : `${base}\n\nHistory saving is off — this permanently deletes the review log.`;
        if (!(await confirmBulk(message, "Clear Session"))) return;
        sessionManager.clearSession({ archive: historyOn });
        historyProvider.refresh();
      }),

      // ── Pending file actions ──
      vscode.commands.registerCommand(
        "claudegate.acceptFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(managerFor);
          if (!filePath) return;
          await saveDirtyPending([filePath]);
          managerFor(filePath).acceptFile(filePath);
          await closeDiffEditor(filePath);
        }
      ),

      vscode.commands.registerCommand(
        "claudegate.rejectFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(managerFor);
          if (!filePath) return;
          const { ok, reason } = await promptRejectReason(path.basename(filePath));
          if (ok) {
            managerFor(filePath).rejectFile(filePath, reason);
            await closeDiffEditor(filePath);
          }
        }
      ),

      vscode.commands.registerCommand("claudegate.acceptCurrent", async () => {
        const fp = getActivePendingFilePath(managerFor);
        if (!fp) return;
        await saveDirtyPending([fp]);
        managerFor(fp).acceptFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
      vscode.commands.registerCommand("claudegate.rejectCurrent", async () => {
        const fp = getActivePendingFilePath(managerFor);
        if (!fp) return;
        const { ok, reason } = await promptRejectReason(path.basename(fp));
        if (!ok) return;
        managerFor(fp).rejectFile(fp, reason);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),

      // ── Pending folder actions ──
      vscode.commands.registerCommand(
        "claudegate.acceptFolder",
        async (item: FolderItem) => {
          const mgr = managerFor(item.folderPath);
          const session = mgr.getSession();
          const pendingFiles = Object.entries(session?.files ?? {})
            .filter(
              ([fp, e]) =>
                fp.startsWith(item.folderPath + path.sep) &&
                e.reviewStatus === "pending"
            )
            .map(([fp]) => fp);
          await saveDirtyPending(pendingFiles);
          mgr.acceptFolder(item.folderPath);
        }
      ),

      vscode.commands.registerCommand(
        "claudegate.rejectFolder",
        async (item: FolderItem) => {
          const mgr = managerFor(item.folderPath);
          const session = mgr.getSession();
          const pendingFiles = Object.entries(session?.files ?? {})
            .filter(
              ([fp, e]) =>
                fp.startsWith(item.folderPath + path.sep) &&
                e.reviewStatus === "pending"
            )
            .map(([fp]) => fp);
          if (pendingFiles.length === 0) return;
          const answer = await vscode.window.showWarningMessage(
            `Reject ${pendingFiles.length} file(s) in "${path.basename(item.folderPath)}"? This restores their original content.`,
            { modal: false },
            "Reject"
          );
          if (answer === "Reject") {
            mgr.rejectFolder(item.folderPath);
            await Promise.all(pendingFiles.map((fp) => closeDiffEditor(fp)));
          }
        }
      ),

      // ── Accepted file/folder actions ──
      vscode.commands.registerCommand("claudegate.revertAccepted", (item: any) => {
        const id = typeof item === "string" ? item : item?.recordId;
        if (id) sessionManager.revertAccepted(id);
      }),

      vscode.commands.registerCommand(
        "claudegate.revertAcceptedFolder",
        (item: FolderItem) => sessionManager.revertAcceptedFolder(item.folderPath)
      ),

      vscode.commands.registerCommand("claudegate.revertAcceptedAll", async () => {
        const count = sessionManager.getSession()?.accepted.length ?? 0;
        if (count === 0) return;
        if (!(await confirmBulk(`Revert all ${count} accepted file(s) back to pending review?`, "Revert All"))) return;
        sessionManager.revertAcceptedAll();
        vscode.window.showInformationMessage(`Claude Gate: reverted ${count} file(s) to pending.`);
      }),

      vscode.commands.registerCommand("claudegate.clearAccepted", async () => {
        const count = sessionManager.getSession()?.accepted.length ?? 0;
        if (count === 0) return;
        if (!(await confirmBulk(
          `Permanently clear ${count} record(s) from the Accepted history? This cannot be undone.`,
          "Clear History"
        ))) return;
        sessionManager.clearAccepted();
        vscode.window.showInformationMessage(`Claude Gate: cleared ${count} accepted record(s).`);
      }),

      // ── Rejected file/folder actions ──
      vscode.commands.registerCommand("claudegate.reapplyFile", (item: any) => {
        const fp = typeof item === "string" ? item : item?.filePath;
        if (fp) sessionManager.reapplyRejected(fp);
      }),

      vscode.commands.registerCommand(
        "claudegate.reapplyFolder",
        (item: FolderItem) => sessionManager.reapplyFolder(item.folderPath)
      ),

      vscode.commands.registerCommand("claudegate.reapplyAll", async () => {
        const count = Object.keys(sessionManager.getSession()?.rejected ?? {}).length;
        if (count === 0) return;
        if (!(await confirmBulk(
          `Re-apply Claude's version to all ${count} rejected file(s) on disk?`,
          "Re-apply All"
        ))) return;
        sessionManager.reapplyAll();
      }),

      // ── Bulk pending actions ──
      vscode.commands.registerCommand("claudegate.acceptAll", async () => {
        const session = sessionManager.getSession();
        const pending = session
          ? Object.entries(session.files).filter(
              ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
            )
          : [];
        if (pending.length === 0) return;
        await saveDirtyPending(pending.map(([fp]) => fp));
        sessionManager.acceptAll();
        await Promise.all(pending.map(([fp]) => closeDiffEditor(fp)));
        // Accept keeps files as-is (non-destructive), so no modal — just confirm
        // what happened, mirroring the feedback Reject All already gives.
        vscode.window.showInformationMessage(`Claude Gate: accepted ${pending.length} file(s).`);
      }),

      vscode.commands.registerCommand("claudegate.rejectAll", async () => {
        const pending = sessionManager.getPendingCount();
        if (pending === 0) return;
        const answer = await vscode.window.showWarningMessage(
          `Reject all ${pending} pending file(s)? This restores their original content.`,
          { modal: true },
          "Reject All"
        );
        if (answer === "Reject All") {
          const session = sessionManager.getSession();
          const files = session
            ? Object.entries(session.files).filter(
                ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
              )
            : [];
          sessionManager.rejectAll();
          await Promise.all(files.map(([fp]) => closeDiffEditor(fp)));
        }
      }),

      vscode.commands.registerCommand("claudegate.clearRejected", async () => {
        const count = Object.keys(sessionManager.getSession()?.rejected ?? {}).length;
        if (count === 0) return;
        if (!(await confirmBulk(
          `Permanently clear ${count} record(s) from the Rejected history? This cannot be undone.`,
          "Clear History"
        ))) return;
        sessionManager.clearRejected();
        vscode.window.showInformationMessage(`Claude Gate: cleared ${count} rejected record(s).`);
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
      }),

      // ── Settings panel actions ──
      vscode.commands.registerCommand("claudegate.toggleFileWatcher", async () => {
        const cur = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("fileWatcher.enabled", false);
        await updateClaudegateConfig("fileWatcher.enabled", !cur);
        // Provider auto-refreshes via its onDidChangeConfiguration listener.
      }),

      vscode.commands.registerCommand("claudegate.enableFileWatcher", async () => {
        await updateClaudegateConfig("fileWatcher.enabled", true);
      }),

      vscode.commands.registerCommand("claudegate.toggleGroupBySession", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("groupBySession", false);
        await updateClaudegateConfig("groupBySession", !cur);
      }),

      vscode.commands.registerCommand("claudegate.toggleAutoAdvance", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true);
        await updateClaudegateConfig("autoAdvance", !cur);
      }),

      vscode.commands.registerCommand("claudegate.verifyHook", () => hookInstaller.verify()),

      vscode.commands.registerCommand("claudegate.openHookLog", async () => {
        const p = hookInstaller.hookLogPath();
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
          vscode.window.showInformationMessage(
            "Claude Gate: no hook log yet — enable Hook Log in Settings, then make a Claude edit."
          );
          return;
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(p)));
      }),

      vscode.commands.registerCommand("claudegate.toggleHookLog", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("hookLog.enabled", false);
        await updateClaudegateConfig("hookLog.enabled", !cur);
      }),

      vscode.commands.registerCommand("claudegate.openProtectedSettings", () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "claudegate.protected")
      ),

      vscode.commands.registerCommand("claudegate.addExcludePattern", async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Glob or folder to exclude — e.g. **/dist/**, **/*.min.js, **/*.log, or a folder like .superpowers",
          placeHolder: "**/dist/**",
          validateInput: (v) => (v.trim().length === 0 ? "Enter a non-empty glob" : undefined),
        });
        if (!input) return;
        const glob = input.trim();
        const map = userExcludeMap();
        if (map[glob] === true) {
          vscode.window.showInformationMessage(`Claude Gate: "${glob}" is already excluded.`);
          return;
        }
        map[glob] = true;
        await updateClaudegateConfig("exclude", map);
      }),

      vscode.commands.registerCommand(
        "claudegate.removeExcludePattern",
        async (item: SettingsItem) => {
          const glob = item?.pattern;
          if (!glob) return;
          const map = userExcludeMap();
          if (DEFAULT_EXCLUDES.includes(glob)) {
            map[glob] = false; // can't delete a shipped default — deactivate it
          } else {
            delete map[glob];
          }
          await updateClaudegateConfig("exclude", map);
        }
      ),

      vscode.commands.registerCommand("claudegate.openFile", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.openToSide", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.filePath), {
          viewColumn: vscode.ViewColumn.Beside,
        });
      }),
      vscode.commands.registerCommand("claudegate.revealInExplorer", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.copyPath", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.env.clipboard.writeText(item.filePath);
      }),
      vscode.commands.registerCommand("claudegate.copyRelativePath", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.addToClaudeChat", async (item: FileReviewItem) => {
        if (!item?.filePath) return;
        const uri = vscode.Uri.file(item.filePath);
        try {
          await vscode.commands.executeCommand("claude-context.addFile", uri, [uri]);
        } catch {
          vscode.window.showWarningMessage("Claude Gate: 'Claude Context' extension not available.");
        }
      }),

      vscode.commands.registerCommand("claudegate.reviewAllPending", async () => {
        const paths = pendingReviewPaths();
        // Reuse the existing multi-diff tab instead of stacking a new one.
        await closePendingMultiDiff();
        if (paths.length === 0) {
          vscode.window.showInformationMessage("Claude Gate: no pending changes to review.");
          return;
        }
        await openPendingMultiDiff(paths);
        // One-time discoverability hint: the per-file actions in this view are
        // focus-based (click into a file's pane), which nothing on screen says.
        const HINT_KEY = "claudegate.multiDiffHintShown";
        if (!context.globalState.get<boolean>(HINT_KEY)) {
          void context.globalState.update(HINT_KEY, true);
          vscode.window.showInformationMessage(
            "Claude Gate: click into a file's diff, then use the ✓/✗ title buttons — or " +
            "⌘Enter to keep and ⌘⌫ to reject (asks for an optional note). " +
            "Run “Copy Feedback to AI” anytime to export your decisions."
          );
        }
      }),

      vscode.commands.registerCommand("claudegate.copyReviewFeedback", async () => {
        // Aggregate the review log across the primary session and every attached
        // worktree, in workspace scope, and copy the AI-ready summary.
        const items = allManagers().flatMap((mgr) => {
          const s = mgr.getSession();
          if (!s) return [];
          return sessionFeedbackItems(
            s,
            (abs) => vscode.workspace.asRelativePath(abs, false).split(/[\\/]/).join("/"),
            (abs) => isInWorkspace(abs) && !isExcluded(abs)
          );
        });
        if (items.length === 0) {
          vscode.window.showInformationMessage("Claude Gate: nothing reviewed yet — no feedback to copy.");
          return;
        }
        await vscode.env.clipboard.writeText(buildFeedbackText(items));
        vscode.window.showInformationMessage("Claude Gate: review feedback copied to clipboard.");
      }),

      vscode.commands.registerCommand(
        "claudegate.openWorktreeWindow",
        (item: WorktreeGroupItem) => {
          if (!item?.worktreeRoot) return;
          void vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(item.worktreeRoot),
            { forceNewWindow: true }
          );
        }
      ),

      // ── History panel actions ──
      vscode.commands.registerCommand("claudegate.clearHistory", async () => {
        const files = historyProvider.matchingFiles();
        if (files.length === 0) {
          vscode.window.showInformationMessage("Claude Gate: no archived sessions for this workspace.");
          return;
        }
        if (!(await confirmBulk(
          `Permanently delete ${files.length} archived session(s) (${formatBytes(historyProvider.totalBytes())})? This cannot be undone.`,
          "Delete History"
        ))) return;
        for (const f of files) {
          try { fs.unlinkSync(f); } catch (err) { log.appendLine(`[WARN] clearHistory: ${(err as Error).message}`); }
        }
        historyProvider.refresh();
        vscode.window.showInformationMessage(`Claude Gate: deleted ${files.length} archived session(s).`);
      }),

      vscode.commands.registerCommand("claudegate.deleteHistorySession", async (item: HistorySessionItem) => {
        if (!item?.summary) return;
        if (!(await confirmBulk(`Delete archived session "${item.summary.label}"? This cannot be undone.`, "Delete"))) return;
        try { fs.unlinkSync(item.summary.file); } catch (err) {
          vscode.window.showErrorMessage(`Claude Gate: could not delete the archive — ${(err as Error).message}`);
        }
        historyProvider.refresh();
      }),

      vscode.commands.registerCommand("claudegate.openHistoryRecord", (archiveFile: string, rec: any) =>
        openHistoryRecord(archiveFile, rec)
      ),

      vscode.commands.registerCommand("claudegate.toggleHistoryEnabled", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("history.enabled", true);
        await updateClaudegateConfig("history.enabled", !cur);
      }),
    );

    registerOpenDiff(context, managerFor);
    context.subscriptions.push(
      vscode.commands.registerCommand("claudegate.openReviewRecord", (id: string) =>
        openReviewRecord(id, sessionManager)
      )
    );

    // ── Reactive updates ──────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        refreshActiveFilePendingContext(managerFor)
      )
    );

    // Keep an open "Review All Pending" multi-diff in sync: when the session
    // changes (a file accepted/rejected — worktree changes fan in here via
    // notifyChanged), rebuild it with the current pending set, or close it once
    // everything is reviewed. The multi-diff's resource list is static, so it
    // must be reopened to reflect changes.
    let multiDiffRefreshing = false;
    sessionManager.onSessionChange(async () => {
      if (multiDiffRefreshing || !isPendingMultiDiffOpen()) return;
      multiDiffRefreshing = true;
      try {
        const paths = pendingReviewPaths();
        await closePendingMultiDiff();
        if (paths.length > 0) await openPendingMultiDiff(paths);
      } finally {
        multiDiffRefreshing = false;
      }
    });

    sessionManager.onSessionChange((session) => {
      refreshActiveFilePendingContext(managerFor);
      let pending = 0;
      let accepted = 0;
      let rejected = 0;
      if (session) {
        for (const fp of Object.keys(session.files)) {
          // Count every pending entry (matches the Pending panel); settled
          // no-op entries are pruned by the reconcile, not filtered here.
          if (isInWorkspace(fp) && !isExcluded(fp)) pending++;
        }
        accepted = session.accepted.filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
        rejected = Object.values(session.rejected).filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
      }
      pending += worktreeRegistry.totalPending();

      vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", accepted);
      vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", rejected);

      pendingView.badge = pending > 0 ? { value: pending, tooltip: `${pending} pending file(s)` } : undefined;

      badgeBar.text            = `$(shield) ${pending}`;
      badgeBar.tooltip         = `Claude Gate: ${pending} pending file(s) — click to open review panel`;
      badgeBar.backgroundColor = pending > 0
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    });

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        const exclChanged = e.affectsConfiguration("claudegate.exclude");
        const protChanged = e.affectsConfiguration("claudegate.protected");
        if (!exclChanged && !protChanged) return;
        if (exclChanged) loadExclude();
        if (protChanged) loadProtected();
        // Re-render trees and recompute counts/badges without a session change.
        pendingProvider.refresh();
        acceptedProvider.refresh();
        rejectedProvider.refresh();
        sessionManager.notifyChanged();
      })
    );

    sessionManager.startWatching();
    context.subscriptions.push({ dispose: () => sessionManager.stopWatching() });

    // Subscribe BEFORE the first refresh so the initial attach's synchronous
    // onChange updates the badge counter (via notifyChanged) at cold start.
    context.subscriptions.push(worktreeRegistry.onChange(() => sessionManager.notifyChanged()));
    worktreeRegistry.refresh();
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((e) => { if (e.focused) worktreeRegistry.refresh(); })
    );
    context.subscriptions.push({ dispose: () => worktreeRegistry.dispose() });

    const isWatcherEnabled = () =>
      vscode.workspace.getConfiguration("claudegate").get<boolean>("fileWatcher.enabled", false);

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

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("claudegate.groupBySession")) return;
        pendingProvider.refresh();
        acceptedProvider.refresh();
        rejectedProvider.refresh();
        settingsProvider.refresh();
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

    // One-time notice: the file watcher is now off by default because the hook
    // covers all Claude Code (terminal + in-editor). Only surface it once the
    // hook is registered — otherwise the "not registered" warning takes priority.
    const watcherNoticeKey = "claudegate.watcherDefaultNoticeShown";
    if (!context.globalState.get(watcherNoticeKey)) {
      let hookRegistered = false;
      try {
        hookRegistered = hookInstaller.getStatus().registered;
      } catch {
        hookRegistered = false;
      }
      if (hookRegistered) {
        void context.globalState.update(watcherNoticeKey, true);
        void vscode.window
          .showInformationMessage(
            "Claude Gate captures Claude Code edits (terminal & in-editor) via the hook — the file watcher is off by default. Enable it only for non-Claude agents (Cursor Composer, Codex).",
            "Enable file watcher"
          )
          .then((choice) => {
            if (choice === "Enable file watcher") {
              void vscode.commands.executeCommand("claudegate.enableFileWatcher");
            }
          });
      }
    }

    refreshActiveFilePendingContext(managerFor);
    log.appendLine("[INFO] Claude Gate ready.");
  } catch (err) {
    console.error("[Claude Gate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`Claude Gate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {}
