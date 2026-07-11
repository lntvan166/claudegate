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

export class HistoryRecordItem extends vscode.TreeItem {
  constructor(
    public readonly archiveFile: string,
    public readonly record: HistoryRecordRef,
    workspaceRoot: string | null
  ) {
    super(workspaceRoot ? path.relative(workspaceRoot, record.path) : record.path);
    this.iconPath = new vscode.ThemeIcon(record.kind === "kept" ? "check" : "close");
    this.description = record.kind;
    this.tooltip = record.reason ? `${record.kind} — ${record.reason}` : record.kind;
    this.command = {
      command: "claudegate.openHistoryRecord",
      title: "Open History Diff",
      arguments: [archiveFile, record],
    };
  }
}

type Item = HistorySessionItem | HistoryRecordItem;

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
      return element.summary.records.map((r) => new HistoryRecordItem(element.summary.file, r, this.workspaceRoot));
    }
    return [];
  }
}
