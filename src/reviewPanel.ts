import * as vscode from "vscode";
import * as path from "path";
import { SessionManager, ReviewStatus } from "./sessionManager";
import { openDiff } from "./diffProvider";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(filePaths: string[]): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.[0]) return folders[0].uri.fsPath;

  // Fall back to common ancestor of all files
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

// ─── Group header ─────────────────────────────────────────────────────────────

const GROUP_ICONS: Record<ReviewStatus, vscode.ThemeIcon> = {
  pending:  new vscode.ThemeIcon("circle-outline",
              new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")),
  accepted: new vscode.ThemeIcon("pass-filled",
              new vscode.ThemeColor("gitDecoration.addedResourceForeground")),
  rejected: new vscode.ThemeIcon("error",
              new vscode.ThemeColor("gitDecoration.deletedResourceForeground")),
};

const GROUP_LABELS: Record<ReviewStatus, string> = {
  pending:  "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
};

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupStatus: ReviewStatus,
    count: number
  ) {
    super(
      GROUP_LABELS[groupStatus],
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.iconPath    = GROUP_ICONS[groupStatus];
    this.description = String(count);
    this.contextValue = `claudegate.group.${groupStatus}`;
  }
}

// ─── Folder item (tree mode) ──────────────────────────────────────────────────

export class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderPath: string,
    public readonly groupStatus: ReviewStatus
  ) {
    super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
    // resourceUri → VS Code uses the active theme's folder icon
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

    // resourceUri → correct file-type icon + FileDecoration badge/color overlay
    this.resourceUri  = vscode.Uri.file(filePath);
    this.description  = showPath ? relativeDir(filePath) : undefined;
    this.tooltip      = new vscode.MarkdownString(
      `**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
    );
    this.contextValue =
      reviewStatus === "pending"   ? "claudegate.file.pending"  :
      reviewStatus === "rejected"  ? "claudegate.file.rejected" :
                                     "claudegate.file.accepted";
    this.command = {
      command: "claudegate.openDiff",
      title:   "Open Diff",
      arguments: [filePath, sessionManager],
    };
  }
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

// ─── Tree data provider ───────────────────────────────────────────────────────

export type ViewMode = "list" | "tree";

export class ReviewTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private viewMode: ViewMode = "list";

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() => this._onDidChangeTreeData.fire());
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    vscode.commands.executeCommand("setContext", "claudegate.viewMode", mode);
    this._onDidChangeTreeData.fire();
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  expandAll(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const session = this.sessionManager.getSession();
    console.log("[ClaudeGate] getChildren", element?.constructor?.name, !!session);
    if (!session) return [];

    // ── Root: group headers ──────────────────────────────────────────────────
    if (!element) {
      const counts = this.countByStatus(session.files);
      return (["pending", "accepted", "rejected"] as ReviewStatus[])
        .filter((s) => s === "pending" || counts[s] > 0)
        .map((s) => new GroupItem(s, counts[s]));
    }

    // ── Group children ───────────────────────────────────────────────────────
    if (element instanceof GroupItem) {
      const files = Object.entries(session.files)
        .filter(([fp, e]) => e.reviewStatus === element.groupStatus && isInWorkspace(fp))
        .map(([fp]) => fp);

      if (this.viewMode === "list") {
        return files.map(
          (fp) => new FileReviewItem(fp, element.groupStatus, this.sessionManager)
        );
      }

      const root = getWorkspaceRoot(files);
      return this.directChildren(files, root, element.groupStatus, false);
    }

    // ── Folder children (tree mode) ──────────────────────────────────────────
    if (element instanceof FolderItem) {
      const filesUnder = Object.entries(session.files)
        .filter(
          ([fp, e]) =>
            e.reviewStatus === element.groupStatus &&
            fp.startsWith(element.folderPath + path.sep)
        )
        .map(([fp]) => fp);
      return this.directChildren(
        filesUnder,
        element.folderPath,
        element.groupStatus,
        false
      );
    }

    return [];
  }

  /** Returns immediate folder+file children of `parentPath` for the given files. */
  private directChildren(
    filePaths: string[],
    parentPath: string,
    groupStatus: ReviewStatus,
    showFilePath: boolean
  ): vscode.TreeItem[] {
    const seenFolders = new Set<string>();
    const folders: FolderItem[]    = [];
    const files:   FileReviewItem[] = [];

    for (const fp of filePaths) {
      const rel   = path.relative(parentPath, fp);
      const parts = rel.split(path.sep);

      if (parts.length === 1) {
        files.push(new FileReviewItem(fp, groupStatus, this.sessionManager, showFilePath));
      } else {
        const folderPath = path.join(parentPath, parts[0]);
        if (!seenFolders.has(folderPath)) {
          seenFolders.add(folderPath);
          folders.push(new FolderItem(folderPath, groupStatus));
        }
      }
    }

    // Folders first (alphabetical), then files (alphabetical) — same as Explorer
    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return [...folders, ...files];
  }

  private countByStatus(
    files: Record<string, { reviewStatus: ReviewStatus }>
  ): Record<ReviewStatus, number> {
    const c: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
    for (const { reviewStatus } of Object.values(files)) c[reviewStatus]++;
    return c;
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
