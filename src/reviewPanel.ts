import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SessionManager, ReviewStatus, Session, FileEntry } from "./sessionManager";
import { openDiff } from "./diffProvider";
import { isInWorkspace, isExcluded, isProtected } from "./workspaceScope";
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

// A file belongs to a session bucket: null = the "unknown" bucket (no session id).
function matchesSession(entry: FileEntry, sessionId: string | null): boolean {
  return sessionId === null ? !entry.sessionId : entry.sessionId === sessionId;
}

// ─── Folder item (tree mode) ──────────────────────────────────────────────────

export class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderPath: string,
    public readonly groupStatus: ReviewStatus,
    public readonly sessionId?: string | null
  ) {
    super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri  = vscode.Uri.file(folderPath);
    this.tooltip      = folderPath;
    this.contextValue = `claudegate.folder.${groupStatus}`;
  }
}

// ─── Session group item (group-by-session mode) ───────────────────────────────

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string | null,
    label: string,
    fileCount: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description  = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
    this.contextValue = "claudegate.session";
    this.iconPath     = new vscode.ThemeIcon(sessionId ? "history" : "question");
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
    if (isProtected(filePath)) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      this.tooltip = new vscode.MarkdownString(
        `⚠ **Protected — sensitive file; review carefully**\n\n**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
      );
    }
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

    const grouped = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("groupBySession", false);

    // Root
    if (!element) {
      if (grouped) return this.sessionGroups(session);
      const files = this.filteredFiles(session);
      if (this.viewMode === "list") {
        const ordered = [...files].sort(
          (a, b) =>
            (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
        );
        return ordered.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager));
      }
      return this.directChildren(files, getWorkspaceRoot(files), this.status, false);
    }

    // Session group children
    if (element instanceof SessionItem) {
      const files = this.filteredFiles(session).filter((fp) =>
        matchesSession(session.files[fp], element.sessionId)
      );
      if (this.viewMode === "list") {
        const ordered = [...files].sort(
          (a, b) =>
            (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
        );
        return ordered.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager));
      }
      return this.directChildren(files, getWorkspaceRoot(files), this.status, false, element.sessionId);
    }

    // Folder children (tree mode)
    if (element instanceof FolderItem) {
      const filesUnder = this.filteredFiles(session).filter(
        (fp) =>
          fp.startsWith(element.folderPath + path.sep) &&
          (element.sessionId === undefined || matchesSession(session.files[fp], element.sessionId))
      );
      return this.directChildren(filesUnder, element.folderPath, this.status, false, element.sessionId);
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

  private filteredFiles(session: Session): string[] {
    return Object.entries(session.files)
      .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp) && !isExcluded(fp))
      .map(([fp]) => fp);
  }

  // Build one SessionItem per distinct session (known sessions ordered by
  // earliest capturedAt → ordinal N; displayed most-recent-first; unknown last).
  private sessionGroups(session: Session): vscode.TreeItem[] {
    const UNKNOWN = "__unknown__";
    const buckets = new Map<
      string,
      { key: string | null; files: string[]; earliest: string; label: string }
    >();
    for (const fp of this.filteredFiles(session)) {
      const e = session.files[fp];
      const key = e.sessionId ?? null;
      const mapKey = key ?? UNKNOWN;
      const cap = e.capturedAt ?? "";
      const b = buckets.get(mapKey);
      if (b) {
        b.files.push(fp);
        if (cap && (b.earliest === "" || cap < b.earliest)) b.earliest = cap;
      } else {
        buckets.set(mapKey, { key, files: [fp], earliest: cap, label: "" });
      }
    }

    const known = [...buckets.values()]
      .filter((b) => b.key !== null)
      .sort((a, b) => (a.earliest || "~").localeCompare(b.earliest || "~"));

    const items: SessionItem[] = [];
    known.forEach((b, i) => {
      const n = i + 1;
      const time = b.earliest
        ? new Date(b.earliest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      b.label = time ? `Session ${n} · ${time}` : `Session ${n}`;
    });
    // most-recent (largest ordinal) on top
    for (const b of [...known].reverse()) {
      items.push(new SessionItem(b.key, b.label, b.files.length));
    }
    const unknown = buckets.get(UNKNOWN);
    if (unknown) items.push(new SessionItem(null, "Unknown session", unknown.files.length));
    return items;
  }

  private directChildren(
    filePaths: string[],
    parentPath: string,
    status: ReviewStatus,
    showFilePath: boolean,
    sessionId?: string | null
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
          folders.push(new FolderItem(folderPath, status, sessionId));
        }
      }
    }

    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    files.sort(
      (a, b) =>
        (Number(isProtected(b.filePath)) - Number(isProtected(a.filePath))) ||
        a.filePath.localeCompare(b.filePath)
    );
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
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        (input.modified.fsPath === filePath || input.original.fsPath === filePath)
      ) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}
