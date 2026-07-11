// View-only History panel: browses the session archives clearSession writes to
// ~/.claudegate/history/, scoped to the current workspace. Records open native
// before→after diffs (claudegate.openHistoryRecord). No restore/re-apply.
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HistoryArchiveSummary, HistoryRecordRef, archiveMatchesWorkspace, formatBytes, summarizeArchive,
} from "./historyModel";

export class HistorySessionItem extends vscode.TreeItem {
  constructor(public readonly summary: HistoryArchiveSummary) {
    super(summary.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${summary.kept}✓ ${summary.rejected}✗ · ${formatBytes(summary.bytes)}`;
    this.contextValue = "claudegate.historySession";
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = summary.file;
  }
}

// A directory node grouping records under `folderPath` within one archive
// (tree view). Its children are re-derived in getChildren from the archive's
// record set, so the item stays cheap.
export class HistoryFolderItem extends vscode.TreeItem {
  constructor(
    public readonly archiveFile: string,
    public readonly folderPath: string
  ) {
    super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = vscode.Uri.file(folderPath);
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "claudegate.historyFolder";
  }
}

export class HistoryRecordItem extends vscode.TreeItem {
  constructor(
    public readonly archiveFile: string,
    public readonly record: HistoryRecordRef,
    workspaceRoot: string | null
  ) {
    // Leaf label is the basename — the folder ancestry gives the path context;
    // the full workspace-relative path lives in the tooltip.
    super(path.basename(record.path));
    const rel = workspaceRoot ? path.relative(workspaceRoot, record.path) : record.path;
    this.iconPath = new vscode.ThemeIcon(record.kind === "kept" ? "check" : "close");
    this.description = record.kind;
    this.tooltip = `${rel} — ${record.kind}${record.reason ? ` — ${record.reason}` : ""}`;
    this.command = {
      command: "claudegate.openHistoryRecord",
      title: "Open History Diff",
      arguments: [archiveFile, record],
    };
  }
}

type Item = HistorySessionItem | HistoryFolderItem | HistoryRecordItem;

export class HistoryTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private summaries: HistoryArchiveSummary[] = [];
  private watcher: fs.FSWatcher | null = null;

  constructor(
    private readonly workspaceRoot: string | null,
    private readonly historyDir: string = path.join(os.homedir(), ".claudegate", "history")
  ) {}

  // mkdir first so the watch target always exists (an empty dir is harmless);
  // the watcher keeps the panel live across windows (any writer/deleter).
  start(): void {
    try {
      fs.mkdirSync(this.historyDir, { recursive: true });
      this.watcher = fs.watch(this.historyDir, () => this.refresh());
    } catch { /* history unavailable → panel stays empty */ }
    this.refresh();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  refresh(): void {
    this.summaries = this.load();
    this._onDidChangeTreeData.fire();
  }

  getCount(): number { return this.summaries.length; }
  matchingFiles(): string[] { return this.summaries.map((s) => s.file); }
  totalBytes(): number { return this.summaries.reduce((n, s) => n + s.bytes, 0); }

  private load(): HistoryArchiveSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.historyDir).filter((f) => f.endsWith(".json")); }
    catch { return []; }
    const out: HistoryArchiveSummary[] = [];
    for (const name of names) {
      const file = path.join(this.historyDir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        // no workspace open → show everything (legacy single-session windows)
        if (this.workspaceRoot && !archiveMatchesWorkspace(raw, this.workspaceRoot)) continue;
        const s = summarizeArchive(file, raw, fs.statSync(file).size);
        if (s) out.push(s);
      } catch { /* unreadable/garbage archive → skip */ }
    }
    return out.sort((a, b) => b.sessionId.localeCompare(a.sessionId)); // newest first
  }

  getTreeItem(item: Item): vscode.TreeItem { return item; }

  getChildren(element?: Item): Item[] {
    if (!element) return this.summaries.map((s) => new HistorySessionItem(s));
    if (element instanceof HistorySessionItem) {
      // Top of a session's tree: group its records under the workspace root.
      return this.directChildren(element.summary.records, this.workspaceRoot ?? "", element.summary.file);
    }
    if (element instanceof HistoryFolderItem) {
      const summary = this.summaries.find((s) => s.file === element.archiveFile);
      if (!summary) return [];
      const under = summary.records.filter((r) => r.path.startsWith(element.folderPath + path.sep));
      return this.directChildren(under, element.folderPath, element.archiveFile);
    }
    return [];
  }

  // One level of the folder tree: records directly in `parentPath` become leaves;
  // deeper records collapse into a folder node for their next path segment
  // (folders first, then files — the same shape as the Pending/Accepted panels).
  // With no workspace root, or a record that isn't under parentPath, we can't
  // form a sensible relative path, so the record renders as a flat leaf.
  private directChildren(records: HistoryRecordRef[], parentPath: string, archiveFile: string): Item[] {
    const folders: HistoryFolderItem[] = [];
    const leaves: HistoryRecordItem[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      const rel = parentPath ? path.relative(parentPath, r.path) : r.path;
      const parts = rel.split(path.sep);
      if (!parentPath || parts.length === 1 || rel.startsWith("..")) {
        leaves.push(new HistoryRecordItem(archiveFile, r, this.workspaceRoot));
      } else {
        const folderPath = path.join(parentPath, parts[0]);
        if (!seen.has(folderPath)) {
          seen.add(folderPath);
          folders.push(new HistoryFolderItem(archiveFile, folderPath));
        }
      }
    }
    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    // records keep the summary's order (newest accept first, then rejected)
    return [...folders, ...leaves];
  }
}
