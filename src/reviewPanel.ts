import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SessionManager, ReviewStatus } from "./sessionManager";
import { openDiff } from "./diffProvider";
import { isInWorkspace, isExcluded } from "./workspaceScope";
import { countChanges, formatChangeCount } from "./changeCount";

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

  private viewMode: ViewMode;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly status: ReviewStatus,
    initialViewMode: ViewMode = "tree"
  ) {
    this.viewMode = initialViewMode;
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
        .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp) && !isExcluded(fp))
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
            isInWorkspace(fp) && !isExcluded(fp)
        )
        .map(([fp]) => fp);
      return this.directChildren(filesUnder, element.folderPath, this.status, false);
    }

    return [];
  }

  // Lazily enrich a pending file row's tooltip with its change count (only on
  // hover — no per-refresh cost). Non-pending rows keep their default tooltip.
  resolveTreeItem(
    item: vscode.TreeItem,
    element: vscode.TreeItem
  ): vscode.TreeItem {
    if (element instanceof FileReviewItem && element.reviewStatus === "pending") {
      const entry = this.sessionManager.getSession()?.files[element.filePath];
      if (entry) {
        try {
          const current = fs.readFileSync(element.filePath, "utf-8");
          const counts = countChanges(entry.originalContent ?? "", current);
          item.tooltip = new vscode.MarkdownString(
            `**${path.basename(element.filePath)}**\n\n${element.filePath}\n\nStatus: *pending* · ${formatChangeCount(counts)}`
          );
        } catch {
          // Keep the existing tooltip on read failure.
        }
      }
    }
    return item;
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
  const prefix = `Claude Gate: ${path.basename(filePath)}`;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label.startsWith(prefix)) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}
