import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SessionManager, ReviewStatus, Session, FileEntry, ReviewRecord } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
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

// An item belongs to a session bucket: null = the "unknown" bucket (no session id).
// Shared by pending files (FileEntry.sessionId) and accepted/rejected records
// (ReviewRecord.sessionId).
function matchesSession(itemSessionId: string | undefined, sessionId: string | null): boolean {
  return sessionId === null ? !itemSessionId : itemSessionId === sessionId;
}

/** Open `dir` as a new VS Code window. Shared by the folder-node and
 *  worktree-group "Open in New Window" actions so their behaviour can't drift. */
export function openFolderInNewWindow(dir: string): void {
  void vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(dir),
    { forceNewWindow: true }
  );
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
    // Stable id → VS Code diffs children by identity across onDidChangeTreeData
    // refreshes instead of tearing the whole subtree down and rebuilding it (see
    // FileReviewItem). Include groupStatus + sessionId because in group-by-session
    // mode the same folder path can appear under more than one session node.
    this.id = `folder::${groupStatus}::${sessionId ?? "*"}::${folderPath}`;
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
    // Stable across refreshes (see FileReviewItem). Session ids are unique within
    // a tree; the file-count lives in `description`, which the full-tree refresh
    // still re-renders, so a stable id doesn't freeze the count.
    this.id = `session::${sessionId ?? "__unknown__"}`;
  }
}

// ─── Worktree group item (parent window shows a nested worktree's pending) ─────

export class WorktreeGroupItem extends vscode.TreeItem {
  constructor(
    public readonly worktreeRoot: string,
    public readonly sessionManager: SessionManager,
    pendingCount: number
  ) {
    super(`${path.basename(worktreeRoot)} (worktree)`, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri  = vscode.Uri.file(worktreeRoot);
    this.description  = `${pendingCount} pending`;
    this.tooltip      = new vscode.MarkdownString(
      `**Git worktree** — a nested worktree with its own review scope.\n\n` +
      `\`${worktreeRoot}\`\n\n` +
      `${pendingCount} pending file(s). These also appear in **Review All Pending** and in the worktree's own ` +
      `window — accept/reject in either place and the decision syncs to both.\n\n` +
      `Use the **Open Worktree in New Window** action (hover this row) to open it directly.`
    );
    this.contextValue = "claudegate.worktreeGroup";
    this.iconPath     = new vscode.ThemeIcon("git-branch");
    // Stable across refreshes (see FileReviewItem); the pending count lives in
    // `description`, which the full-tree refresh re-renders.
    this.id = `worktree::${worktreeRoot}`;
  }
}

// ─── File item ────────────────────────────────────────────────────────────────

export class FileReviewItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly reviewStatus: ReviewStatus,
    public readonly sessionManager: SessionManager,
    showPath = true
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri  = vscode.Uri.file(filePath);
    this.description  = showPath ? relativeDir(filePath) : undefined;
    this.tooltip      = new vscode.MarkdownString(
      `**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
    );
    // FileReviewItem is only used for pending rows now (accepted/rejected use
    // RecordReviewItem), so the context value is always the pending one.
    this.contextValue = "claudegate.file.pending";
    // Stable id keyed on the file path — preserves selection/expansion state
    // across refreshes (a pending path is unique in the tree: each file belongs
    // to exactly one session/worktree scope).
    this.id = `pending::${filePath}`;
    // NB: intentionally NO `this.command`. Opening the diff is wired to the tree
    // view's onDidChangeSelection in extension.ts instead. Binding the open to a
    // TreeItem.command means VS Code dispatches it through the tree's own
    // click→command path, which — when the row's node is stale mid-refresh (e.g.
    // right after accepting another file) — executes a MALFORMED command id
    // ("claudegate.openDiff/<treeHandle>", e.g. ".../59") and shows "Actual
    // command not found" (microsoft/vscode#173233). Handling selection ourselves
    // and calling openDiff(filePath, sessionManager) directly removes that
    // fragile dispatch entirely.
    if (isProtected(filePath)) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      this.tooltip = new vscode.MarkdownString(
        `⚠ **Protected — sensitive file; review carefully**\n\n**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
      );
    }
  }
}

// ─── Record item (accepted/rejected log rows) ─────────────────────────────────

export class RecordReviewItem extends vscode.TreeItem {
  constructor(
    public readonly record: ReviewRecord,
    public readonly decision: "accepted" | "rejected",
    showPath = true
  ) {
    super(path.basename(record.path), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(record.path);
    this.description = showPath ? relativeDir(record.path) : undefined;
    this.filePath = record.path;
    this.recordId = record.id;
    this.contextValue = decision === "accepted" ? "claudegate.file.accepted" : "claudegate.file.rejected";
    // Stable across refreshes (see FileReviewItem). record.id is already unique
    // (`<decidedAt>::<path>`); prefix with the decision to stay unique if the
    // same record id ever surfaced in both logs.
    this.id = `${decision}::${record.id}`;
    this.tooltip = new vscode.MarkdownString(
      `**${path.basename(record.path)}**\n\n${record.path}\n\n*${decision}* · ${new Date(record.decidedAt).toLocaleString()}`
    );
    // No TreeItem.command — opened via the Accepted/Rejected views'
    // onDidChangeSelection in extension.ts, for the same reason as FileReviewItem
    // (avoids VS Code's stale-handle "Actual command not found" dispatch,
    // microsoft/vscode#173233).
    if (isProtected(record.path)) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
    }
  }
  filePath: string;
  recordId: string;
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
    initialViewMode: ViewMode = "tree",
    private readonly worktreeRegistry?: WorktreeSessionRegistry
  ) {
    this.viewMode = initialViewMode;
    sessionManager.onSessionChange(() => this._onDidChangeTreeData.fire());
    worktreeRegistry?.onChange(() => this._onDidChangeTreeData.fire());
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

    const grouped = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("groupBySession", false);

    // Accepted/Rejected panels are primary-only — nothing to show without a session.
    if (this.status !== "pending") {
      return session ? this.getRecordChildren(session, element, grouped) : [];
    }

    // Worktree group expansion must work even when the primary session is null
    // (all edits may live in a nested worktree), so handle it before that guard.
    if (element instanceof WorktreeGroupItem) return this.worktreeFiles(element);

    // Root
    if (!element) {
      let primary: vscode.TreeItem[] = [];
      if (session) {
        if (grouped) {
          primary = this.sessionGroups(session);
        } else {
          const files = this.filteredFiles(session);
          primary =
            this.viewMode === "list"
              ? [...files]
                  .sort(
                    (a, b) =>
                      (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
                  )
                  .map((fp) => new FileReviewItem(fp, this.status, this.sessionManager))
              : this.directChildren(files, getWorkspaceRoot(files), this.status, false);
        }
      }
      return [...primary, ...this.worktreeGroups()];
    }

    // Remaining element branches need the primary session (SessionItem/FolderItem
    // are only produced when a session exists).
    if (!session) return [];

    // Session group children
    if (element instanceof SessionItem) {
      const files = this.filteredFiles(session).filter((fp) =>
        matchesSession(session.files[fp].sessionId, element.sessionId)
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
          (element.sessionId === undefined || matchesSession(session.files[fp].sessionId, element.sessionId))
      );
      return this.directChildren(filesUnder, element.folderPath, this.status, false, element.sessionId);
    }

    return [];
  }

  // ── Accepted / Rejected: record-backed panels ─────────────────────────────
  //
  // Same tree/list/session-grouping shape as the pending panel above, but the
  // leaves are ReviewRecord-backed RecordReviewItem rows sourced from
  // session.accepted (append-only log, newest first) or session.rejected
  // (latest-per-file map) instead of session.files.

  private getRecordChildren(
    session: Session,
    element: vscode.TreeItem | undefined,
    grouped: boolean
  ): vscode.TreeItem[] {
    const decision = this.status as "accepted" | "rejected";

    // Root
    if (!element) {
      if (grouped) return this.recordSessionGroups(this.filteredRecords(session));
      const records = this.filteredRecords(session);
      if (this.viewMode === "list") {
        return records.map((r) => new RecordReviewItem(r, decision));
      }
      return this.recordDirectChildren(records, getWorkspaceRoot(records.map((r) => r.path)), decision, false);
    }

    // Session group children
    if (element instanceof SessionItem) {
      const records = this.filteredRecords(session).filter((r) =>
        matchesSession(r.sessionId, element.sessionId)
      );
      if (this.viewMode === "list") {
        return records.map((r) => new RecordReviewItem(r, decision));
      }
      return this.recordDirectChildren(records, getWorkspaceRoot(records.map((r) => r.path)), decision, false, element.sessionId);
    }

    // Folder children (tree mode)
    if (element instanceof FolderItem) {
      const recordsUnder = this.filteredRecords(session).filter(
        (r) =>
          r.path.startsWith(element.folderPath + path.sep) &&
          (element.sessionId === undefined || matchesSession(r.sessionId, element.sessionId))
      );
      return this.recordDirectChildren(recordsUnder, element.folderPath, decision, false, element.sessionId);
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
    // Show every pending entry by its session state. Do NOT gate on live disk
    // content here: the hook records an entry *before* Claude writes (so its
    // baseline momentarily equals disk), and the panel only re-renders on
    // session-file changes — a live-disk gate would hide the row and never
    // re-show it after the write lands. Settled no-op entries are pruned by the
    // grace-delayed reconcile instead.
    return Object.keys(session.files).filter(
      (fp) => isInWorkspace(fp) && !isExcluded(fp)
    );
  }

  // In-scope pending files of an arbitrary (worktree) session manager.
  private pendingOf(mgr: SessionManager): string[] {
    const s = mgr.getSession();
    if (!s) return [];
    return Object.keys(s.files).filter((fp) => isInWorkspace(fp) && !isExcluded(fp));
  }

  // One group node per attached worktree that currently has pending files.
  private worktreeGroups(): WorktreeGroupItem[] {
    if (this.status !== "pending" || !this.worktreeRegistry) return [];
    const items: WorktreeGroupItem[] = [];
    for (const [root, mgr] of this.worktreeRegistry.getManagers()) {
      const count = this.pendingOf(mgr).length;
      if (count > 0) items.push(new WorktreeGroupItem(root, mgr, count));
    }
    return items.sort((a, b) => a.worktreeRoot.localeCompare(b.worktreeRoot));
  }

  // Flat pending-file rows for one worktree group, bound to its session manager
  // so openDiff/accept/reject resolve against the correct (worktree) session.
  private worktreeFiles(group: WorktreeGroupItem): vscode.TreeItem[] {
    const files = this.pendingOf(group.sessionManager).sort(
      (a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
    );
    return files.map((fp) => new FileReviewItem(fp, "pending", group.sessionManager, true));
  }

  // Accepted (newest first) / rejected (latest-per-file) records, scoped to
  // the workspace and excludes — mirrors filteredFiles() above for records.
  private filteredRecords(session: Session): ReviewRecord[] {
    const records = this.status === "accepted" ? session.accepted : Object.values(session.rejected);
    const inScope = records.filter((r) => isInWorkspace(r.path) && !isExcluded(r.path));
    return this.status === "accepted" ? [...inScope].reverse() : inScope;
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

  // Same grouping as sessionGroups() above, keyed off ReviewRecord.sessionId /
  // decidedAt instead of FileEntry.sessionId / capturedAt.
  private recordSessionGroups(records: ReviewRecord[]): vscode.TreeItem[] {
    const UNKNOWN = "__unknown__";
    const buckets = new Map<
      string,
      { key: string | null; records: ReviewRecord[]; earliest: string; label: string }
    >();
    for (const r of records) {
      const key = r.sessionId ?? null;
      const mapKey = key ?? UNKNOWN;
      const cap = r.decidedAt ?? "";
      const b = buckets.get(mapKey);
      if (b) {
        b.records.push(r);
        if (cap && (b.earliest === "" || cap < b.earliest)) b.earliest = cap;
      } else {
        buckets.set(mapKey, { key, records: [r], earliest: cap, label: "" });
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
      items.push(new SessionItem(b.key, b.label, b.records.length));
    }
    const unknown = buckets.get(UNKNOWN);
    if (unknown) items.push(new SessionItem(null, "Unknown session", unknown.records.length));
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

  // Same directory-grouping shape as directChildren() above, but for
  // ReviewRecord leaves (RecordReviewItem) instead of pending FileReviewItem
  // rows. Leaves keep the caller's order (newest-first for accepted;
  // insertion order for rejected) instead of the alphabetical + protected-
  // first sort used for pending files, so the log ordering survives folder
  // grouping.
  private recordDirectChildren(
    records: ReviewRecord[],
    parentPath: string,
    decision: "accepted" | "rejected",
    showFilePath: boolean,
    sessionId?: string | null
  ): vscode.TreeItem[] {
    const seenFolders = new Set<string>();
    const folders: FolderItem[]       = [];
    const leaves:  RecordReviewItem[] = [];

    for (const r of records) {
      const rel   = path.relative(parentPath, r.path);
      const parts = rel.split(path.sep);
      if (parts.length === 1) {
        leaves.push(new RecordReviewItem(r, decision, showFilePath));
      } else {
        const folderPath = path.join(parentPath, parts[0]);
        if (!seenFolders.has(folderPath)) {
          seenFolders.add(folderPath);
          folders.push(new FolderItem(folderPath, decision, sessionId));
        }
      }
    }

    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    return [...folders, ...leaves];
  }
}

// ─── Register commands ────────────────────────────────────────────────────────

export function registerOpenDiff(
  context: vscode.ExtensionContext,
  resolve: (filePath: string) => SessionManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudegate.openDiff",
      (filePath: string) => openDiff(filePath, resolve(filePath))
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
