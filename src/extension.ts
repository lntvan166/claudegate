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
import { ClaudeGateContentProvider, SCHEME, originalUri, openReviewRecord } from "./diffProvider";
import { ClaudeGateDecorationProvider } from "./decorationProvider";
import { DocumentTracker } from "./documentTracker";
import { persistWorkspaceRoots } from "./workspaceRoots";
import { isInWorkspace, isExcluded, setExcludeMatcher, isProtected, setProtectedMatcher } from "./workspaceScope";
import { ExcludeMatcher, DEFAULT_EXCLUDES } from "./excludeMatcher";


function getActivePendingFilePath(sessionManager: SessionManager): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const uri = editor.document.uri;
  const filePath =
    uri.scheme === "file"       ? uri.fsPath :
    uri.scheme === "claudegate" ? uri.path   :
    undefined;
  if (!filePath) return undefined;
  if (!isInWorkspace(filePath) || isExcluded(filePath)) return undefined;
  return sessionManager.getSession()?.files[filePath]?.reviewStatus === "pending" &&
    sessionManager.hasRealPendingChange(filePath)
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
    const hookInstaller  = new HookInstaller(context, log);
    void hookInstaller.syncHookIfNeeded().then(() => {
      hookInstaller.warnIfHookNotRegisteredInSettings();
    });
    // Health signal: warn if settings.json changes out from under a running
    // session (which silently invalidates the hook until the session restarts).
    context.subscriptions.push(hookInstaller.watchSettingsForTrustInvalidation());
    const documentTracker = new DocumentTracker(sessionManager, workspacePath, log);

    const badgeBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    badgeBar.text    = "$(shield) 0";
    badgeBar.tooltip = "Claude Gate: 0 pending file(s) — click to open review panel";
    badgeBar.command = "claudegate.pendingPanel.focus";
    badgeBar.show();
    context.subscriptions.push(badgeBar);

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

    // ── Review All Pending (multi-diff) helpers ───────────────────────────
    const pendingReviewPaths = (): string[] => {
      const session = sessionManager.getSession();
      return session
        ? Object.entries(session.files)
            .filter(
              ([fp, e]) =>
                e.reviewStatus === "pending" &&
                isInWorkspace(fp) &&
                !isExcluded(fp) &&
                sessionManager.hasRealPendingChange(fp)
            )
            .map(([fp]) => fp)
            .sort(
              (a, b) =>
                (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
            )
        : [];
    };
    const closePendingMultiDiff = async (): Promise<void> => {
      const stale = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label.startsWith("Claude Gate: Pending"));
      if (stale.length > 0) await vscode.window.tabGroups.close(stale);
    };
    const openPendingMultiDiff = async (paths: string[]): Promise<void> => {
      const resourceList = paths.map((fp) => [
        vscode.Uri.file(fp),
        originalUri(fp),
        vscode.Uri.file(fp),
      ]);
      try {
        await vscode.commands.executeCommand(
          "vscode.changes",
          `Claude Gate: Pending (${paths.length})`,
          resourceList
        );
      } catch (err) {
        log.appendLine(`[WARN] reviewAllPending: vscode.changes failed: ${(err as Error).message}`);
        vscode.window.showWarningMessage(
          "Claude Gate: the multi-file diff view isn't available in this VS Code version."
        );
      }
    };
    const isPendingMultiDiffOpen = (): boolean =>
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => t.label.startsWith("Claude Gate: Pending"))
      );

    // ── Commands ──────────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand("claudegate.setupHook", async () => {
        await hookInstaller.setup();
        settingsProvider.refresh();
      }),

      vscode.commands.registerCommand("claudegate.clearSession", () =>
        sessionManager.clearSession()
      ),

      // ── Pending file actions ──
      vscode.commands.registerCommand(
        "claudegate.acceptFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(sessionManager);
          if (!filePath) return;
          managerFor(filePath).acceptFile(filePath);
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
            managerFor(filePath).rejectFile(filePath);
            await closeDiffEditor(filePath);
          }
        }
      ),

      vscode.commands.registerCommand("claudegate.acceptCurrent", async () => {
        const fp = getActivePendingFilePath(sessionManager);
        if (!fp) return;
        sessionManager.acceptFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
      vscode.commands.registerCommand("claudegate.rejectCurrent", async () => {
        const fp = getActivePendingFilePath(sessionManager);
        if (!fp) return;
        sessionManager.rejectFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),

      // ── Pending folder actions ──
      vscode.commands.registerCommand(
        "claudegate.acceptFolder",
        (item: FolderItem) => managerFor(item.folderPath).acceptFolder(item.folderPath)
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
            `Revert ${pendingFiles.length} file(s) in "${path.basename(item.folderPath)}" to their original content?`,
            { modal: false },
            "Revert"
          );
          if (answer === "Revert") {
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

      vscode.commands.registerCommand("claudegate.revertAcceptedAll", () =>
        sessionManager.revertAcceptedAll()
      ),

      vscode.commands.registerCommand("claudegate.clearAccepted", () =>
        sessionManager.clearAccepted()
      ),

      // ── Rejected file/folder actions ──
      vscode.commands.registerCommand("claudegate.reapplyFile", (item: any) => {
        const fp = typeof item === "string" ? item : item?.filePath;
        if (fp) sessionManager.reapplyRejected(fp);
      }),

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
              ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
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
                ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
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
        refreshActiveFilePendingContext(sessionManager)
      )
    );

    // Keep an open "Review All Pending" multi-diff in sync: when the session
    // changes (a file accepted/rejected), rebuild it with the current pending
    // set, or close it once everything is reviewed. The multi-diff's resource
    // list is static, so it must be reopened to reflect changes.
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
      refreshActiveFilePendingContext(sessionManager);
      let pending = 0;
      let accepted = 0;
      let rejected = 0;
      if (session) {
        for (const fp of Object.keys(session.files)) {
          // Count every pending entry (matches the Pending panel); settled
          // no-op entries are pruned by the reconcile, not filtered here.
          if (isInWorkspace(fp) && !isExcluded(fp)) pending++;
        }
        pending += worktreeRegistry.totalPending();
        accepted = session.accepted.filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
        rejected = Object.values(session.rejected).filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
      }

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

    refreshActiveFilePendingContext(sessionManager);
    log.appendLine("[INFO] Claude Gate ready.");
  } catch (err) {
    console.error("[Claude Gate] ACTIVATION ERROR:", err);
    vscode.window.showErrorMessage(`Claude Gate failed to activate: ${(err as Error).message}`);
  }
}

export function deactivate(): void {}
