import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { SessionManager, ReviewStatus, Session, FileEntry, ReviewRecord } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { openDiff } from "./diffProvider";
import { isInWorkspace, isExcluded, isProtected, pathIsUnder } from "./workspaceScope";
import { countChanges, formatChangeCount } from "./changeCount";
import { createCoalescer } from "./scheduling";
import { matchesFilter, normalizeFilter } from "./panelFilter";
import { ageLabel, rowDescription, ageTooltipLine } from "./pendingAge";

// How long a burst of session changes is collected before the tree repaints
// once. Short enough to feel instant, long enough to swallow the persist() +
// fs.watch-reload pair (and a multi-file accept's follow-on reconcile).
const TREE_REFRESH_COALESCE_MS = 60;

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

// Path comparison for the reveal walk. Exact first (fast, and always right);
// case-folded only on win32, where the editor URI's drive-letter case can differ
// from the hook-stored session key — the same tolerance fileEntryFor() applies.
export function samePath(
  a: string,
  b: string,
  caseInsensitive: boolean = process.platform === "win32"
): boolean {
  return a === b || (caseInsensitive && a.toLowerCase() === b.toLowerCase());
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
    count: number,
    // Which panel this group belongs to. Only the pending group carries the
    // bulk Accept/Reject Worktree actions — those make no sense on a decision
    // log, so the record panels get their own contextValue and no menu binding.
    public readonly status: ReviewStatus = "pending"
  ) {
    super(`${path.basename(worktreeRoot)} (worktree)`, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri  = vscode.Uri.file(worktreeRoot);
    this.description  = `${count} ${status}`;
    this.tooltip      = new vscode.MarkdownString(
      status === "pending"
        ? `**Git worktree** — a nested worktree with its own review scope.\n\n` +
          `\`${worktreeRoot}\`\n\n` +
          `${count} pending file(s). These also appear in **Review All Pending** and in the worktree's own ` +
          `window — accept/reject in either place and the decision syncs to both.\n\n` +
          `Use the **Open Worktree in New Window** action (hover this row) to open it directly.`
        : `**Git worktree** — a nested worktree with its own review scope.\n\n` +
          `\`${worktreeRoot}\`\n\n` +
          `${count} ${status} record(s), stored in this worktree's own session. ` +
          `They also appear in the worktree's own window.`
    );
    this.contextValue = status === "pending"
      ? "claudegate.worktreeGroup"
      : `claudegate.worktreeGroup.${status}`;
    this.iconPath     = new vscode.ThemeIcon("git-branch");
    // Stable across refreshes (see FileReviewItem); the count lives in
    // `description`, which the full-tree refresh re-renders. Scoped by status so
    // the same worktree can appear in more than one panel without an id clash.
    this.id = `worktree::${status}::${worktreeRoot}`;
  }
}

// ─── File item ────────────────────────────────────────────────────────────────

export class FileReviewItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly reviewStatus: ReviewStatus,
    public readonly sessionManager: SessionManager,
    showPath = true,
    // Pre-computed by the provider: the short row label (undefined when the entry
    // is younger than the configured threshold) and the raw timestamp, which the
    // tooltip reports regardless of that threshold.
    private readonly age?: string,
    public readonly capturedAt?: string
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri  = vscode.Uri.file(filePath);
    // In tree mode showPath is false, so the description slot is empty and the
    // age has it to itself; in list mode it shares with the relative directory.
    this.description  = rowDescription(showPath ? relativeDir(filePath) : undefined, age);
    const capturedLine = capturedAt ? ageTooltipLine(capturedAt, new Date()) : undefined;
    this.tooltip      = new vscode.MarkdownString(
      `**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*` +
      (capturedLine ? `\n\n${capturedLine}` : "")
    );
    // FileReviewItem is only used for pending rows now (accepted/rejected use
    // RecordReviewItem), so the context value is always the pending one.
    this.contextValue = "claudegate.file.pending";
    // Stable id keyed on the file path — preserves selection/expansion state
    // across refreshes (a pending path is unique in the tree: each file belongs
    // to exactly one session/worktree scope).
    this.id = `pending::${filePath}`;
    // Opening runs through TWO paths, deliberately.
    //
    // `onDidChangeSelection` alone cannot see a click on a row that is ALREADY
    // selected — measured in a real host: selecting the same row twice fires the
    // event once. That used to be a rare edge case, but revealing the active
    // file's row made it the normal one: open a file and its row is already
    // selected, so clicking it could never re-open the diff.
    //
    // `TreeItem.command` fires on every click regardless, and is the only API
    // that does — TreeView exposes no open/click event. It was dropped once
    // before, because a stale node mid-refresh made VS Code dispatch a malformed
    // id ("claudegate.openDiff/<treeHandle>", microsoft/vscode#173233). The
    // stable `id` below postdates that decision and is exactly what stops a node
    // going stale across a refresh, so the condition it depended on should no
    // longer hold — but since that cannot be proven without a real click during a
    // refresh, the selection path stays as a fallback rather than being replaced.
    // openDiff() collapses the pair when a click triggers both.
    this.command = {
      command: "claudegate.openDiff",
      title: "Open Diff",
      // The command resolves the owning (possibly worktree) session itself, so a
      // row only has to name its file.
      arguments: [filePath],
    };
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
    showPath = true,
    // The session that OWNS this record. Undefined for primary-session rows (the
    // command handlers fall back to the primary manager); set for rows inside a
    // worktree group so revert / re-apply target that worktree's session.
    public readonly sessionManager?: SessionManager
  ) {
    super(path.basename(record.path), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(record.path);
    this.description = showPath ? relativeDir(record.path) : undefined;
    this.filePath = record.path;
    this.recordId = record.id;
    this.contextValue = decision === "accepted" ? "claudegate.file.accepted" : "claudegate.file.rejected";
    // Same two-path reasoning as FileReviewItem above: the Accepted/Rejected
    // panels open on selection too, so re-clicking an already-selected record row
    // was equally dead.
    this.command = {
      command: "claudegate.openReviewRecord",
      title: "Open Record Diff",
      arguments: [record.id],
    };
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

  // Session changes arrive in bursts — persist() fires one and the fs.watch
  // reload it triggers fires another, so a single accept produced several
  // full-tree refreshes back-to-back. Firing each one raced inside VS Code's
  // async tree, which threw "TreeError [claudegate.acceptedPanel] Data tree node
  // not found" / "Tree element not found" as a refresh resolved children that a
  // later refresh had already discarded. Collapsing the burst into one refresh
  // removes the race and the redundant re-render of a 100+ row tree.
  private readonly coalescedRefresh = createCoalescer(
    TREE_REFRESH_COALESCE_MS,
    () => this.fireChanged()
  );

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly status: ReviewStatus,
    initialViewMode: ViewMode = "tree",
    private readonly worktreeRegistry?: WorktreeSessionRegistry
  ) {
    this.viewMode = initialViewMode;
    sessionManager.onSessionChange(() => this.coalescedRefresh.schedule());
    worktreeRegistry?.onChange(() => this.coalescedRefresh.schedule());
  }

  // Free-text filter, Pending panel only (only that provider ever has one set).
  // Provider state rather than a native tree find, so it survives the refreshes
  // this panel fires on every decision — see panelFilter.ts.
  private filter: string | null = null;

  getFilter(): string | null {
    return this.filter;
  }

  // claudegate.pendingAge.minDays, cached for a second. A full render of a large
  // backlog builds hundreds of rows; reading the configuration once per row would
  // be hundreds of lookups per repaint for a value that changes by hand. The TTL
  // keeps a settings change taking effect promptly without that cost, and the
  // config listener in activate() forces the repaint that shows it.
  private minDaysCache: { at: number; value: number } | null = null;

  private ageMinDays(): number {
    const now = Date.now();
    if (!this.minDaysCache || now - this.minDaysCache.at > 1000) {
      const raw = vscode.workspace
        .getConfiguration("claudegate")
        .get<number>("pendingAge.minDays", 0);
      // A hand-edited settings.json can hold anything; a negative or non-numeric
      // threshold must not produce "NaNd" on every row.
      // 0 or less is "off"; anything unparseable falls back to off rather than
      // decorating every row on a hand-edited settings.json.
      const value = Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : 0;
      this.minDaysCache = { at: now, value };
    }
    return this.minDaysCache.value;
  }

  /** Row label + raw timestamp for a pending file, resolved against the session
   *  that owns it (primary or a worktree). */
  private ageOf(filePath: string, mgr: SessionManager): { age?: string; capturedAt?: string } {
    const capturedAt = mgr.getSession()?.files[filePath]?.capturedAt;
    return { age: ageLabel(capturedAt, new Date(), this.ageMinDays()), capturedAt };
  }

  /** Returns true if the filter actually changed (so the caller can skip a
   *  redundant repaint of a large tree). */
  setFilter(raw: string | undefined | null): boolean {
    const next = normalizeFilter(raw);
    if (next === this.filter) return false;
    this.filter = next;
    // Direct, not coalesced: a user action on the view must repaint at once, and
    // it cannot storm — it needs a prompt to be answered. Same reasoning as
    // setViewMode below.
    this.fireChanged();
    return true;
  }

  /** In-scope pending files across the primary session AND every attached
   *  worktree, ignoring the filter. This is what the view description counts
   *  against, so "4 of 16" compares like with like. */
  totalPendingInScope(): number {
    const own = this.sessionManager.getSession();
    let n = own ? Object.keys(own.files).filter((fp) => isInWorkspace(fp) && !isExcluded(fp)).length : 0;
    for (const [, mgr] of this.worktreeRegistry?.getManagers() ?? []) {
      const s = mgr.getSession();
      if (s) n += Object.keys(s.files).filter((fp) => isInWorkspace(fp) && !isExcluded(fp)).length;
    }
    return n;
  }

  /** Same, but after the filter — the number of rows the panel will draw. */
  shownPendingInScope(): number {
    const own = this.sessionManager.getSession();
    let n = own ? this.filteredFiles(own).length : 0;
    for (const [, mgr] of this.worktreeRegistry?.getManagers() ?? []) {
      n += this.pendingOf(mgr).length;
    }
    return n;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    // Direct, not coalesced: this is a user action on the view itself and must
    // repaint immediately. It also can't storm — it needs a button press.
    this.fireChanged();
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  refresh(): void {
    this.fireChanged();
  }

  dispose(): void {
    this.coalescedRefresh.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const session = this.sessionManager.getSession();

    const grouped = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("groupBySession", false);

    // Accepted/Rejected panels. A worktree's decision records live in that
    // worktree's own session, so they must be surfaced here too — otherwise
    // accepting a file inside a worktree makes it vanish from this window
    // entirely. Group expansion is handled before the primary-session guard
    // because the primary session may legitimately be null (or empty) while a
    // worktree holds every record.
    if (this.status !== "pending") {
      if (element instanceof WorktreeGroupItem) return this.worktreeRecords(element);
      if (!element) {
        const primary = session ? this.getRecordChildren(session, element, grouped) : [];
        return [...primary, ...this.worktreeGroups()];
      }
      return session ? this.getRecordChildren(session, element, grouped) : [];
    }

    // Worktree group expansion must work even when the primary session is null
    // (all edits may live in a nested worktree), so handle it before that guard.
    if (element instanceof WorktreeGroupItem) return this.worktreeFiles(element);

    // Non-grouped tree-mode folder expansion (sessionId undefined). Handled before
    // the session guard because a folder node can exist purely to hold a nested
    // worktree (no primary-session file under it, e.g. a `ws-*` dir whose only
    // change is a checked-out worktree). A folder that falls INSIDE a worktree
    // resolves to that worktree's manager (so its rows target the worktree
    // session); otherwise it belongs to the primary session. Only the primary
    // subtree nests further worktree groups.
    if (element instanceof FolderItem && element.sessionId === undefined) {
      const wtMgr = this.worktreeRegistry?.managerFor(element.folderPath) ?? null;
      const mgr = wtMgr ?? this.sessionManager;
      const filesUnder = mgr.getSession()
        ? this.pendingOf(mgr).filter((fp) => fp.startsWith(element.folderPath + path.sep))
        : [];
      return this.treeChildrenAt(element.folderPath, filesUnder, mgr, wtMgr === null);
    }

    // Root
    if (!element) {
      // Group-by-session keeps worktrees as flat top-level groups (they are their
      // own sessions, not part of the primary session's session buckets).
      if (session && grouped) return [...this.sessionGroups(session), ...this.worktreeGroups()];

      const files = session ? this.filteredFiles(session) : [];
      if (this.viewMode === "list") {
        const rows = [...files]
          .sort((a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b))
          .map((fp) => {
            const a = this.ageOf(fp, this.sessionManager);
            return new FileReviewItem(fp, this.status, this.sessionManager, true, a.age, a.capturedAt);
          });
        return [...rows, ...this.worktreeGroups()];
      }
      // Tree mode: worktree groups nest under the folder they live in.
      return this.treeChildrenAt(getWorkspaceRoot(files), files, this.sessionManager, true);
    }

    // Remaining element branches need the primary session (SessionItem/grouped
    // FolderItem are only produced when a session exists).
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
        return ordered.map((fp) => {
          const a = this.ageOf(fp, this.sessionManager);
          return new FileReviewItem(fp, this.status, this.sessionManager, true, a.age, a.capturedAt);
        });
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

  // ── reveal() support ──────────────────────────────────────────────────────
  //
  // TreeView.reveal() is unusable without getParent(). Rather than reimplement
  // the tree's shape here — list vs tree mode, group-by-session, nested folders,
  // worktree groups, five interacting branches — the chain is DERIVED by walking
  // getChildren() down from the root and recording each child→parent link on the
  // way. getChildren() is synchronous and reads only in-memory session state, so
  // this is a pure in-process walk. Deriving it means the layout rules live in
  // exactly one place and getParent() cannot drift out of step with them.

  private readonly parentOf = new Map<string, vscode.TreeItem>();

  /** Clear the derived parent links, then repaint. Every fire goes through here:
   *  a link that outlived its tree would hand reveal() a node VS Code has already
   *  discarded. */
  private fireChanged(): void {
    this.parentOf.clear();
    this._onDidChangeTreeData.fire();
  }

  getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
    const id = element.id;
    if (!id) return undefined;
    // A leaf VS Code asks about before anything has been expanded has no link
    // yet; rebuilding the chain populates it (and costs one walk, once).
    if (!this.parentOf.has(id) && element instanceof FileReviewItem) {
      this.chainTo(element.filePath);
    }
    return this.parentOf.get(id);
  }

  /** The root→leaf chain of items leading to `filePath`, or [] if no pending row
   *  for it is currently rendered. Populates `parentOf` for every node visited. */
  chainTo(filePath: string): vscode.TreeItem[] {
    const seen = new Set<string>();

    const walk = (parent: vscode.TreeItem | undefined): vscode.TreeItem[] | null => {
      for (const child of this.getChildren(parent)) {
        if (child.id) {
          if (seen.has(child.id)) continue;   // defensive: never loop on a malformed tree
          seen.add(child.id);
          if (parent) this.parentOf.set(child.id, parent);
          else this.parentOf.delete(child.id);
        }

        if (child instanceof FileReviewItem) {
          if (samePath(child.filePath, filePath)) return [child];
          continue;
        }

        // Only descend where the target could actually live. Folder and worktree
        // nodes carry a path, so a prefix test prunes most of the tree; a session
        // bucket carries none, so it always has to be entered.
        const branch =
          child instanceof FolderItem        ? child.folderPath :
          child instanceof WorktreeGroupItem ? child.worktreeRoot :
          null;
        if (branch !== null && !pathIsUnder(filePath, branch)) continue;

        const rest = walk(child);
        if (rest) return [child, ...rest];
      }
      return null;
    };

    return walk(undefined) ?? [];
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
          const captured = ageTooltipLine(entry.capturedAt, new Date());
          item.tooltip = new vscode.MarkdownString(
            `**${path.basename(element.filePath)}**\n\n${element.filePath}\n\nStatus: *pending* · ${formatChangeCount(counts)}` +
            (captured ? `\n\n${captured}` : "")
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
      (fp) => isInWorkspace(fp) && !isExcluded(fp) && matchesFilter(fp, this.filter)
    );
  }

  // In-scope pending files of an arbitrary (worktree) session manager.
  private pendingOf(mgr: SessionManager): string[] {
    const s = mgr.getSession();
    if (!s) return [];
    return Object.keys(s.files).filter(
      (fp) => isInWorkspace(fp) && !isExcluded(fp) && matchesFilter(fp, this.filter)
    );
  }

  // Tree-mode children at `parentPath`, binding file rows to `mgr` (the primary
  // session, or a nested worktree's session when we're inside one). When
  // `includeWorktrees` is set, attached worktree groups that live under
  // `parentPath` are nested here too, so a worktree checked out under a `ws-*`
  // directory renders INSIDE that folder instead of floating at the root (the
  // go.work / multi-module layout) — intermediate folder nodes are created for
  // them even when no file lives under them. Folder rows carry no sessionId, so
  // getChildren() re-resolves their owning manager (primary vs worktree) via the
  // registry on expansion. Order within a folder: subfolders, then worktree
  // groups, then files.
  private treeChildrenAt(
    parentPath: string,
    files: string[],
    mgr: SessionManager,
    includeWorktrees: boolean
  ): vscode.TreeItem[] {
    const seenFolders = new Set<string>();
    const folders: FolderItem[] = [];
    const worktrees: WorktreeGroupItem[] = [];
    const fileItems: FileReviewItem[] = [];

    // Returns true if `targetPath` is an immediate child of parentPath (a leaf at
    // this level); otherwise creates/reuses the intermediate FolderItem for it.
    const isImmediateChild = (targetPath: string): boolean => {
      const parts = path.relative(parentPath, targetPath).split(path.sep);
      if (parts.length === 1) return true;
      const folderPath = path.join(parentPath, parts[0]);
      if (!seenFolders.has(folderPath)) {
        seenFolders.add(folderPath);
        folders.push(new FolderItem(folderPath, this.status));
      }
      return false;
    };

    for (const fp of files) {
      if (isImmediateChild(fp)) {
        const a = this.ageOf(fp, mgr);
        fileItems.push(new FileReviewItem(fp, this.status, mgr, false, a.age, a.capturedAt));
      }
    }
    if (includeWorktrees) {
      for (const g of this.worktreeGroupsUnder(parentPath)) {
        if (isImmediateChild(g.worktreeRoot)) worktrees.push(g);
      }
    }

    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    worktrees.sort((a, b) => a.worktreeRoot.localeCompare(b.worktreeRoot));
    fileItems.sort(
      (a, b) =>
        (Number(isProtected(b.filePath)) - Number(isProtected(a.filePath))) ||
        a.filePath.localeCompare(b.filePath)
    );
    return [...folders, ...worktrees, ...fileItems];
  }

  // Attached worktree groups (pending, count > 0) whose root lives under `parentPath`.
  private worktreeGroupsUnder(parentPath: string): WorktreeGroupItem[] {
    const prefix = parentPath.endsWith(path.sep) ? parentPath : parentPath + path.sep;
    return this.worktreeGroups().filter((g) => g.worktreeRoot.startsWith(prefix));
  }

  // One group node per attached worktree that currently has rows for THIS panel —
  // pending files for the Pending panel, decision records for Accepted/Rejected.
  private worktreeGroups(): WorktreeGroupItem[] {
    if (!this.worktreeRegistry) return [];
    const items: WorktreeGroupItem[] = [];
    for (const [root, mgr] of this.worktreeRegistry.getManagers()) {
      const count = this.status === "pending"
        ? this.pendingOf(mgr).length
        : this.recordsOf(mgr).length;
      if (count > 0) items.push(new WorktreeGroupItem(root, mgr, count, this.status));
    }
    return items.sort((a, b) => a.worktreeRoot.localeCompare(b.worktreeRoot));
  }

  // In-scope decision records of an arbitrary (worktree) session manager —
  // the record-panel counterpart of pendingOf().
  private recordsOf(mgr: SessionManager): ReviewRecord[] {
    const s = mgr.getSession();
    return s ? this.filteredRecords(s) : [];
  }

  // Record rows for one worktree group, bound to its own session so revert /
  // re-apply resolve against the worktree's session rather than the primary one.
  // Deliberately FLAT in both view modes: a folder row inside a record group would
  // be re-expanded through the primary session (getRecordChildren's FolderItem
  // branch), which would silently show the wrong worktree's records.
  private worktreeRecords(group: WorktreeGroupItem): vscode.TreeItem[] {
    const decision = this.status as "accepted" | "rejected";
    return this.recordsOf(group.sessionManager)
      .map((r) => new RecordReviewItem(r, decision, true, group.sessionManager));
  }

  // Pending-file rows for one worktree group, bound to its session manager so
  // openDiff/accept/reject resolve against the correct (worktree) session. Honors
  // the panel's view mode: a folder tree rooted at the worktree in tree mode, a
  // flat path-labelled list in list mode.
  private worktreeFiles(group: WorktreeGroupItem): vscode.TreeItem[] {
    const files = this.pendingOf(group.sessionManager);
    if (this.viewMode === "list") {
      return [...files]
        .sort((a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b))
        .map((fp) => {
          const a = this.ageOf(fp, group.sessionManager);
          return new FileReviewItem(fp, "pending", group.sessionManager, true, a.age, a.capturedAt);
        });
    }
    // Tree mode: nest into folders; a worktree never re-nests worktree groups.
    return this.treeChildrenAt(group.worktreeRoot, files, group.sessionManager, false);
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
        const a = this.ageOf(fp, this.sessionManager);
        files.push(new FileReviewItem(fp, status, this.sessionManager, showFilePath, a.age, a.capturedAt));
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
