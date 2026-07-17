import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isInWorkspace, isExcluded } from "./workspaceScope";
import {
  Session, FileEntry, ReviewRecord, hasRealChange, shouldPruneNoOp, acceptEntry,
  rejectEntry, migrateSession, mergeFreshCaptures, MergeGuards, capAcceptedBytes,
  fileEntryFor,
} from "./reviewModel";
export type { Session, FileEntry, ReviewRecord } from "./reviewModel";
export type ReviewStatus = "pending" | "accepted" | "rejected"; // panel tab id

// A pending "new file" (originalContent === null) whose path has vanished was a
// temp file Claude created and then removed — there is nothing left to review,
// so it is pruned. The PreToolUse hook records the entry *before* Claude writes
// the file, so a genuinely new file briefly does not exist on disk; the grace
// delay avoids pruning it in that window.
const RECONCILE_GRACE_MS = 1500;

// Advisory lock shared with hook.py to serialize read-modify-write of the
// session file, so the hook cannot overwrite the extension's accepted/rejected
// log (or vice-versa) from a snapshot taken microseconds earlier. Both sides
// FAIL OPEN: if the lock can't be acquired in time we proceed anyway, because a
// rare unlocked write (still backstopped by mergeFreshCaptures) is far better
// than blocking — the hook must never stall a Claude write. A lock older than
// LOCK_STALE_MS is presumed abandoned by a crashed writer and stolen.
const LOCK_STALE_MS = 3000;
const LOCK_TIMEOUT_MS = 200;   // extension gives up fast (keeps the UI responsive)
const LOCK_SLEEP_MS = 5;

// A per-workspace session file this large is almost certainly bloated (a huge
// accepted/rejected history, or stray oversized captures). We still load it, but
// surface it: parsing megabytes on every fs.watch reload hurts responsiveness,
// and clearing the review history shrinks it. Well past a healthy session.
const SESSION_SIZE_WARN_BYTES = 2_000_000;
// When a session file crosses the warning size, auto-trim the accepted log down
// to this byte budget (oldest-first) so the panel self-heals instead of relying
// on the user to clear history manually. Kept under the warn threshold to leave
// room for pending/rejected entries. Only the accepted log is ever trimmed —
// pending entries are unreviewed baselines and are never dropped automatically.
const MAX_ACCEPTED_BYTES = 1_500_000;

export class SessionManager {
  private readonly sessionPath: string;
  private readonly sessionFilename: string;
  private readonly watchDir: string;
  private readonly claudegateDir: string;
  private readonly workspaceRoot: string | null;
  private session: Session | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private oversizeWarned = false; // popup fires at most once per activation
  private corruptWarned = false;  // corruption popup fires at most once per activation

  private readonly _onSessionChange = new vscode.EventEmitter<Session | null>();
  readonly onSessionChange = this._onSessionChange.event;

  constructor(
    private readonly log: vscode.OutputChannel,
    workspacePath?: string
  ) {
    this.claudegateDir = path.join(os.homedir(), ".claudegate");

    if (workspacePath) {
      // Mirror hook.py: normcase (lower-case on Windows) + abspath, then MD5.
      const resolved  = path.resolve(workspacePath);
      const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const hash = crypto.createHash("md5").update(normalized).digest("hex");
      this.sessionFilename = `${hash}.json`;
      this.watchDir   = path.join(this.claudegateDir, "sessions");
      this.sessionPath = path.join(this.watchDir, this.sessionFilename);
      this.workspaceRoot = resolved;
    } else {
      this.sessionFilename = "session.json";
      this.watchDir   = this.claudegateDir;
      this.sessionPath = path.join(this.claudegateDir, "session.json");
      this.workspaceRoot = null;
    }
  }

  startWatching(): void {
    fs.mkdirSync(this.watchDir, { recursive: true });
    this.loadSession();

    this.watcher = fs.watch(this.watchDir, (_event, filename) => {
      if (filename === this.sessionFilename) {
        this.loadSession();
      }
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  getSession(): Session | null {
    return this.session;
  }

  // Re-fire the current session to consumers (used when a display filter,
  // e.g. claudegate.exclude, changes without the session itself changing).
  notifyChanged(): void {
    this._onSessionChange.fire(this.session);
  }

  // A pending entry is a "real" change unless its baseline already equals the
  // current disk content (a no-op edit, or an edit that was undone by hand).
  // Case-tolerant lookup (fileEntryFor): callers may pass URI-derived paths
  // whose drive-letter case differs from the hook-stored key on Windows.
  hasRealPendingChange(filePath: string): boolean {
    const entry = this.session ? fileEntryFor(this.session.files, filePath) : undefined;
    if (!entry) return false;
    return hasRealChange(entry.originalContent, this.readFileOrNull(filePath));
  }

  getPendingCount(): number {
    if (!this.session) return 0;
    // Count every pending entry (matches what the panel shows); settled no-op
    // entries are pruned by the grace-delayed reconcile, not filtered here.
    return Object.keys(this.session.files).filter(
      (fp) => isInWorkspace(fp) && !isExcluded(fp)
    ).length;
  }

  trackFileChange(filePath: string, originalContent: string | null, newFile = false): void {
    // Create session if it doesn't exist (in memory; persist() will write it)
    if (!this.session) {
      this.session = {
        sessionId: new Date().toISOString(),
        status: "active",
        files: {},
        accepted: [],
        rejected: {},
      };
    }

    // files{} is pending-only now: if the path is already tracked, its
    // originalContent is the frozen review baseline — never overwrite it here.
    if (this.session.files[filePath]) return;

    this.session.files[filePath] = {
      originalContent,
      reviewStatus: "pending",
      newFile,
    };
    // Reset session status from "reviewed" to "active" if needed
    if (this.session.status === "reviewed") {
      this.session.status = "active";
    }
    this.log.appendLine(`[INFO] Tracking: ${filePath}`);
    this.persist();
  }

  acceptFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry) return;
    // Snapshot the accepted content as the record's "after" side so the
    // Accepted panel can show before → after.
    const after = this.readFileOrNull(filePath);
    if (after === null) {
      this.log.appendLine(`[WARN] Accept: could not read ${filePath}; accepted diff unavailable`);
    }
    acceptEntry(this.session!, filePath, after, new Date().toISOString());
    this.log.appendLine(`[INFO] Accepted: ${filePath}`);
    // acceptEntry drops any prior reject for this path; tombstone it so the merge
    // doesn't resurrect the reject from the still-stale on-disk copy.
    this.persist({ droppedRejectedPaths: new Set([filePath]) });
  }

  acceptFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const decidedAt = new Date().toISOString();
    const accepted = new Set<string>();
    for (const fp of Object.keys(s.files)) {
      if (!fp.startsWith(prefix) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const after = this.readFileOrNull(fp);
      if (after === null) this.log.appendLine(`[WARN] Accept folder: could not read ${fp}; accepted diff unavailable`);
      acceptEntry(s, fp, after, decidedAt);
      accepted.add(fp);
    }
    if (accepted.size === 0) return;
    this.log.appendLine(`[INFO] Accepted folder: ${folderPath} (${accepted.size} file(s))`);
    this.persist({ droppedRejectedPaths: accepted });
  }

  acceptAll(): void {
    const s = this.session;
    if (!s) return;
    const decidedAt = new Date().toISOString();
    const accepted = new Set<string>();
    for (const fp of Object.keys(s.files)) {
      if (!isInWorkspace(fp) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const after = this.readFileOrNull(fp);
      if (after === null) this.log.appendLine(`[WARN] Accept all: could not read ${fp}; accepted diff unavailable`);
      acceptEntry(s, fp, after, decidedAt);
      accepted.add(fp);
    }
    this.log.appendLine(`[INFO] Accepted all: ${accepted.size} file(s)`);
    this.persist({ droppedRejectedPaths: accepted });
  }

  // The on-disk effect of rejecting one entry. Deletes only a confident-new
  // file; an uncertain null-baseline file (watcher create-without-snapshot) is
  // left on disk rather than risking deletion of a real file.
  private applyReject(filePath: string, entry: FileEntry): "restored" | "deleted" | "left" {
    if (entry.originalContent !== null) {
      this.atomicWrite(filePath, entry.originalContent, true);
      return "restored";
    }
    if (entry.newFile) {
      fs.unlinkSync(filePath);
      return "deleted";
    }
    return "left";
  }

  rejectFile(filePath: string, reason?: string): void {
    const entry = this.session?.files[filePath];
    if (!entry) return;
    const after = this.readFileOrNull(filePath); // Claude's discarded version
    let outcome: "restored" | "deleted" | "left";
    try {
      outcome = this.applyReject(filePath, entry);
    } catch (err) {
      this.log.appendLine(`[ERROR] reject ${filePath}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }
    rejectEntry(this.session!, filePath, after, new Date().toISOString(), reason);
    if (outcome === "left") {
      vscode.window.showInformationMessage(
        `Claude Gate: left "${path.basename(filePath)}" on disk (created outside Claude Code — not auto-deleted).`
      );
    }
    this.log.appendLine(`[INFO] Rejected: ${filePath}`);
    this.persist();
  }

  rejectFolder(folderPath: string, reason?: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const decidedAt = new Date().toISOString();
    const errors: string[] = [];
    let count = 0;
    let left = 0;

    for (const fp of Object.keys(s.files)) {
      if (!fp.startsWith(prefix) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const entry = s.files[fp];
      const after = this.readFileOrNull(fp);
      try {
        if (this.applyReject(fp, entry) === "left") left++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] rejectFolder failed for ${fp}: ${(err as Error).message}`);
        continue;
      }
      rejectEntry(s, fp, after, decidedAt, reason);
      count++;
    }

    if (count === 0 && errors.length === 0) return;
    this.persist();
    this.log.appendLine(`[INFO] Rejected folder: ${folderPath} (${count} file(s))`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${errors.length} file(s). Check Output panel for details.`
      );
    }
    if (left > 0) {
      vscode.window.showInformationMessage(
        `Claude Gate: left ${left} file(s) created outside Claude Code on disk (not auto-deleted).`
      );
    }
  }

  // Concurrency: hook.py and the extension both read-modify-write the same JSON
  // file. persist() serializes against the hook via the fail-open advisory lock
  // (see acquireLock) and always merges the on-disk files{} before writing, so a
  // hook capture is never lost. The residual window is the hook's fail-open case
  // (it must never block a Claude write); atomic rename still prevents torn reads.

  rejectAll(reason?: string): void {
    const s = this.session;
    if (!s) return;
    const decidedAt = new Date().toISOString();
    const errors: string[] = [];
    let count = 0;
    let left = 0;

    for (const fp of Object.keys(s.files)) {
      if (!isInWorkspace(fp) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const entry = s.files[fp];
      const after = this.readFileOrNull(fp);
      try {
        if (this.applyReject(fp, entry) === "left") left++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] rejectAll failed for ${fp}: ${(err as Error).message}`);
        continue;
      }
      rejectEntry(s, fp, after, decidedAt, reason);
      count++;
    }

    if (count === 0 && errors.length === 0) return;
    this.persist();
    this.log.appendLine(`[INFO] Rejected all: ${count} file(s)`);

    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${errors.length} file(s). Check Output panel for details.`
      );
    }
    if (left > 0) {
      vscode.window.showInformationMessage(
        `Claude Gate: left ${left} file(s) created outside Claude Code on disk (not auto-deleted).`
      );
    }
  }

  removePendingFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry) return;
    delete this.session!.files[filePath];
    // Tombstone so the merge does not resurrect the just-removed pending entry
    // from the still-stale on-disk copy.
    this.persist({ prunedFiles: new Map([[filePath, entry.capturedAt]]) });
  }

  // Self-heal a stale "phantom" pending row. When a captured file is reverted to
  // its baseline (git reset, editor undo, or any change the hook doesn't re-write
  // the session for), the entry becomes a no-op — but because the extension only
  // reconciles on a session-file change and has no workspace file-watcher, that
  // no-op can linger in the panel and open a blank diff. Call this when opening
  // such an entry: if it currently has no real change, remove it so the row
  // clears at once. Returns true iff an entry was dropped; a genuine pending
  // change is always kept.
  dropIfNoRealChange(filePath: string): boolean {
    if (!this.session?.files[filePath]) return false;
    if (this.hasRealPendingChange(filePath)) return false; // real → keep
    this.removePendingFile(filePath);
    return true;
  }

  // ── Accepted log: undo ──────────────────────────────────────────────────

  // Shared mutation for reverting one accepted record; callers persist().
  private revertAcceptedRecord(rec: ReviewRecord): void {
    const s = this.session!;
    const idx = s.accepted.findIndex((r) => r.id === rec.id);
    if (idx !== -1) s.accepted.splice(idx, 1);
    // Only reopen as pending if there is no pending entry already and this
    // record is still the file's on-disk state (it wasn't re-edited since).
    if (!s.files[rec.path] && this.readFileOrNull(rec.path) === rec.after) {
      s.files[rec.path] = { originalContent: rec.before, reviewStatus: "pending", newFile: rec.newFile, sessionId: rec.sessionId, capturedAt: new Date().toISOString() };
    }
  }

  revertAccepted(id: string): void {
    const s = this.session;
    if (!s) return;
    const rec = s.accepted.find((r) => r.id === id);
    if (!rec) return;
    this.revertAcceptedRecord(rec);
    this.log.appendLine(`[INFO] Reverted accepted: ${rec.path}`);
    this.persist({ droppedAcceptedIds: new Set([rec.id]) });
  }

  revertAcceptedAll(): void {
    const s = this.session;
    if (!s) return;
    const recs = [...s.accepted];
    if (recs.length === 0) return;
    for (const rec of recs) this.revertAcceptedRecord(rec);
    this.log.appendLine(`[INFO] Reverted all accepted: ${recs.length} file(s)`);
    this.persist({ droppedAcceptedIds: new Set(recs.map((r) => r.id)) });
  }

  revertAcceptedFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const recs = s.accepted.filter((r) => r.path.startsWith(prefix));
    if (recs.length === 0) return;
    for (const rec of recs) this.revertAcceptedRecord(rec);
    this.log.appendLine(`[INFO] Reverted accepted folder: ${folderPath} (${recs.length} file(s))`);
    this.persist({ droppedAcceptedIds: new Set(recs.map((r) => r.id)) });
  }

  // ── Rejected store (latest-per-file): re-apply ──────────────────────────

  // Shared mutation for re-applying one rejected record; callers persist().
  // Returns an error message on failure (no UI), or null on success.
  private reapplyRejectedRecord(filePath: string): string | null {
    const s = this.session!;
    const rec = s.rejected[filePath];
    if (!rec) return null;
    if (rec.after == null) return `Claude's version of "${path.basename(filePath)}" was not saved`;
    try {
      this.atomicWrite(filePath, rec.after, true);
    } catch (err) {
      return (err as Error).message;
    }
    delete s.rejected[filePath];
    s.files[filePath] = { originalContent: rec.before, reviewStatus: "pending", newFile: rec.newFile, sessionId: rec.sessionId, capturedAt: new Date().toISOString() };
    this.log.appendLine(`[INFO] Re-applied: ${filePath}`);
    return null;
  }

  reapplyRejected(filePath: string): void {
    if (!this.session?.rejected[filePath]) return;
    const err = this.reapplyRejectedRecord(filePath);
    if (err) {
      vscode.window.showWarningMessage(`Claude Gate: Cannot re-apply ${path.basename(filePath)} — ${err}`);
      return;
    }
    this.persist({ droppedRejectedPaths: new Set([filePath]) });
  }

  private reapplyMany(paths: string[], label: string): void {
    if (paths.length === 0) return;
    const errors: string[] = [];
    const dropped = new Set<string>();
    for (const fp of paths) {
      const err = this.reapplyRejectedRecord(fp);
      if (err) {
        errors.push(`${path.basename(fp)}: ${err}`);
        this.log.appendLine(`[ERROR] reapply ${fp}: ${err}`);
      } else {
        dropped.add(fp); // reapplyRejectedRecord removed it from rejected{}
      }
    }
    this.persist({ droppedRejectedPaths: dropped });
    this.log.appendLine(`[INFO] ${label}: ${paths.length - errors.length}/${paths.length} file(s)`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not re-apply ${errors.length} file(s). Check the Output panel for details.`
      );
    }
  }

  reapplyAll(): void {
    const s = this.session;
    if (!s) return;
    this.reapplyMany(Object.keys(s.rejected).filter((fp) => !isExcluded(fp)), "Re-applied all");
  }

  reapplyFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    this.reapplyMany(
      Object.keys(s.rejected).filter((fp) => fp.startsWith(prefix) && !isExcluded(fp)),
      `Re-applied folder ${folderPath}`
    );
  }

  // ── Clear ────────────────────────────────────────────────────────────────

  clearAccepted(): void {
    if (!this.session) return;
    const ids = this.session.accepted.map((r) => r.id);
    if (ids.length === 0) return;
    this.session.accepted = [];
    this.log.appendLine(`[INFO] Cleared accepted: ${ids.length} record(s)`);
    // Tombstone every cleared id so the merge can't resurrect them from disk (a
    // concurrent accept in another window, absent from this set, still survives).
    this.persist({ droppedAcceptedIds: new Set(ids) });
  }

  clearRejected(): void {
    if (!this.session) return;
    const paths = Object.keys(this.session.rejected);
    if (paths.length === 0) return;
    this.session.rejected = {};
    this.log.appendLine(`[INFO] Cleared rejected: ${paths.length} record(s)`);
    this.persist({ droppedRejectedPaths: new Set(paths) });
  }

  clearSession(opts: { archive?: boolean } = {}): void {
    if (!this.session) return;
    const archive = opts.archive !== false;
    // Never destroy the session without a backup — unless the user explicitly
    // disabled history (claudegate.history.enabled=false → archive:false).
    if (archive && !this.archiveSession()) {
      vscode.window.showErrorMessage(
        "Claude Gate: couldn't back up the review session, so it was NOT cleared — your history is intact. " +
        "See the Claude Gate Output channel for details."
      );
      return;
    }
    try {
      fs.unlinkSync(this.sessionPath);
    } catch { /* already gone */ }
    this.session = null;
    this._onSessionChange.fire(null);
    this.log.appendLine(`[INFO] ` + "Session cleared.");
  }

  private loadSession(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionPath, "utf-8");
    } catch (err) {
      // Absent file is normal: the session was never created, or was cleared
      // (clearSession unlinks it). Anything else (e.g. EACCES) is worth a log.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.appendLine(`[WARN] Could not read session file: ${(err as Error).message}`);
      }
      this.session = null;
      this._onSessionChange.fire(this.session);
      this.scheduleReconcile();
      return;
    }
    try {
      const oversized = this.checkSessionSize();
      // migrateSession reports whether it normalized anything, so we re-persist
      // only when the on-disk form is actually stale — no full-session stringify
      // on every fs.watch reload (was two serializations per event).
      const { session, changed } = migrateSession(JSON.parse(raw));
      this.session = session;
      this.log.appendLine(
        `[INFO] Session loaded: ${Object.keys(this.session.files).length} pending, ` +
        `${this.session.accepted.length} accepted, ${Object.keys(this.session.rejected).length} rejected`
      );
      this.pruneOutOfWorkspaceEntries();
      if (changed) this.persist();
      if (oversized) this.healOversized();
    } catch (err) {
      // The file exists but does not parse → corruption (external, since our own
      // writes are atomic). Do NOT discard a good in-memory session; surface it
      // once so it's diagnosable. The next user decision re-persists our state
      // atomically over the bad file (persistLocked's re-read catch), self-healing.
      this.log.appendLine(
        `[ERROR] Session file is corrupt and was not loaded (${(err as Error).message}); ` +
        `keeping last-known state: ${this.sessionPath}`
      );
      this.warnCorruptOnce();
    }
    this._onSessionChange.fire(this.session);
    this.scheduleReconcile();
  }

  private warnCorruptOnce(): void {
    if (this.corruptWarned) return;
    this.corruptWarned = true;
    vscode.window.showWarningMessage(
      "Claude Gate: the review session file could not be read (it may be corrupt). " +
      "Your last-known changes are still shown; the next accept/reject will rewrite the file."
    );
  }

  // Log a warning (every load, for diagnostics) if the session file is bloated,
  // and return whether it is so loadSession can surface a one-time popup. Stat is
  // cheap; we never block loading — the user still needs their pending changes.
  private checkSessionSize(): boolean {
    try {
      const { size } = fs.statSync(this.sessionPath);
      if (size <= SESSION_SIZE_WARN_BYTES) return false;
      this.log.appendLine(
        `[WARN] Session file is large (${(size / 1e6).toFixed(1)} MB): ${this.sessionPath}. ` +
        `Clearing Accepted/Rejected history will shrink it.`
      );
      return true;
    } catch {
      return false; // stat failed → let the read below decide
    }
  }

  // Self-heal a bloated session: auto-trim the oldest accepted records down to
  // the byte budget (the accepted log is almost always what grows), then persist.
  // If trimming didn't help (bloat lives in pending/rejected), fall back to the
  // one-shot "clear it manually" warning. Runs only when checkSessionSize() flags
  // the file as oversized, so the O(n) byte scan is rare, not per-load.
  private healOversized(): void {
    if (!this.session) return;
    const before = new Set(this.session.accepted.map((r) => r.id));
    const dropped = capAcceptedBytes(this.session, MAX_ACCEPTED_BYTES);
    if (dropped > 0) {
      const kept = new Set(this.session.accepted.map((r) => r.id));
      const droppedIds = new Set([...before].filter((id) => !kept.has(id)));
      this.log.appendLine(`[INFO] Trimmed ${dropped} oldest accepted record(s) to bound session file size.`);
      // Tombstone the trimmed ids so the dual-writer merge in persist() does not
      // resurrect them from the still-large on-disk copy (byte-cap is below the
      // count cap, so mergeFreshCaptures wouldn't otherwise re-drop them).
      this.persist({ droppedAcceptedIds: droppedIds }); // atomic rewrite → healthy size
      this.warnOversizedOnce(dropped);
    } else {
      this.warnOversizedOnce(0);
    }
  }

  // Surface the bloat to the user, but only once per activation — loadSession
  // runs on every fs.watch event, so a popup here would otherwise spam.
  private warnOversizedOnce(dropped: number): void {
    if (this.oversizeWarned) return;
    this.oversizeWarned = true;
    vscode.window.showWarningMessage(
      dropped > 0
        ? `Claude Gate: the review history was very large, so the ${dropped} oldest accepted ` +
          `record(s) were trimmed to keep the panel responsive.`
        : "Claude Gate: this workspace's session is unusually large and may slow the panel. " +
          "The bloat is in your pending or rejected entries (not accepted history), so review the " +
          "pending changes — accept or reject them — to shrink it. Nothing was deleted automatically."
    );
  }

  private pruneOutOfWorkspaceEntries(): void {
    if (!this.session) return;
    const pruned = new Map<string, string | undefined>();
    for (const filePath of Object.keys(this.session.files)) {
      if (!isInWorkspace(filePath)) {
        pruned.set(filePath, this.session.files[filePath].capturedAt);
        delete this.session.files[filePath];
        this.log.appendLine(`[INFO] Pruned out-of-workspace entry: ${filePath}`);
      }
    }
    // Same anti-resurrection guard as reconcilePending: the merge must not re-add
    // an entry we just pruned from the stale on-disk copy (would loop persist).
    if (pruned.size > 0) this.persist({ prunedFiles: pruned });
  }

  // Force an immediate no-op / temp-file reconcile pass. Used when disk may have
  // changed WITHOUT a session-file write to trigger the usual grace reconcile —
  // e.g. a git reset / editor undo reverted a captured file while the window was
  // unfocused, leaving a settled no-op "phantom" row that the panel keeps showing
  // (the panel deliberately does not disk-gate rows) with nothing to prune it.
  reconcileNow(): void {
    if (!this.session) return;
    this.reconcilePending();
  }

  // Re-check cadence for the no-op/temp-file reconcile. This interval only paces
  // how often entries are re-evaluated; the actual prune thresholds live per-entry
  // in shouldPruneNoOp (NOOP_SETTLE_MS / NEW_FILE_ABSENT_MS), which are far longer
  // so a write that lands seconds after the hook is never mistaken for a no-op.
  private scheduleReconcile(): void {
    if (!this.session || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcilePending();
    }, RECONCILE_GRACE_MS);
  }

  // Prune settled no-op / failed-edit pending entries. The decision is PER-ENTRY
  // (see shouldPruneNoOp): a no-op still within its own grace window is kept and
  // re-checked later, so a real edit whose write lands slightly late — e.g. a
  // later file in a multi-file burst — is never pruned before it appears.
  private reconcilePending(): void {
    if (!this.session) return;
    const now = Date.now();
    const pruned = new Map<string, string | undefined>();
    let youngNoOp = false;
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      const disk = this.readFileOrNull(filePath);
      if (shouldPruneNoOp(entry, disk, now)) {
        pruned.set(filePath, entry.capturedAt);
        delete this.session.files[filePath];
        this.log.appendLine(`[INFO] Pruned no-op pending entry: ${filePath}`);
      } else if (!hasRealChange(entry.originalContent, disk)) {
        youngNoOp = true; // no-op but still within grace — re-evaluate once it settles
      }
    }
    // Pass the pruned set so the dual-writer merge in persist() does not resurrect
    // these entries from the stale on-disk copy — otherwise the prune never sticks
    // and persist spins forever (nonstop UI reload).
    if (pruned.size > 0) this.persist({ prunedFiles: pruned });
    // Give still-young no-op entries their full per-entry grace instead of the
    // shared timer's remaining time (closes the burst-coalescing hole).
    if (youngNoOp) this.scheduleReconcile();
  }

  // Read a file's current content, or null if it cannot be read. Used to
  // checkpoint the review baseline at approve/reject time.
  //
  // Decodes STRICTLY as UTF-8: Node's readFileSync(path, "utf-8") silently
  // replaces invalid bytes with U+FFFD, so a binary / non-UTF-8 file would be
  // captured (and later written back on restore) as irreversibly corrupted
  // mojibake. Reading as a Buffer and decoding with { fatal: true } instead
  // returns null for anything that isn't valid UTF-8 text — matching hook.py's
  // strict-decode skip, so such files are treated as unreadable, never mangled.
  private readFileOrNull(filePath: string): string | null {
    try {
      const buf = fs.readFileSync(filePath);
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return null; // unreadable (permissions) or not valid UTF-8 (binary)
    }
  }

  private get lockPath(): string {
    return this.sessionPath + ".lock";
  }

  // Sync millisecond sleep that doesn't spin the CPU (persist() is synchronous).
  private sleep(ms: number): void {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      /* SharedArrayBuffer unavailable → skip the wait; the retry loop still bounds attempts */
    }
  }

  // Acquire the advisory lock, returning an fd, or null if we should proceed
  // without it (fail-open). Steals a stale lock left by a crashed writer.
  private acquireLock(): number | null {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, "wx"); // O_CREAT|O_EXCL
        try { fs.writeSync(fd, String(process.pid)); } catch { /* pid is advisory only */ }
        return fd;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null; // unexpected → skip lock
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) { try { fs.unlinkSync(this.lockPath); } catch { /* raced */ } continue; }
        } catch {
          continue; // lock vanished between open and stat → try to grab it
        }
        if (Date.now() >= deadline) return null; // timed out → proceed unlocked
        this.sleep(LOCK_SLEEP_MS);
      }
    }
  }

  private releaseLock(fd: number | null): void {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
  }

  // `guards` lets a caller that just deliberately removed entries (a pruned no-op
  // pending file, or a cleared/reverted/reapplied decision record) tell the
  // dual-writer merge below not to resurrect them from the still-stale on-disk
  // copy (see mergeFreshCaptures / MergeGuards).
  private persist(guards?: MergeGuards): void {
    if (!this.session) return;

    const lock = this.acquireLock();
    try {
      this.persistLocked(guards);
    } finally {
      this.releaseLock(lock);
    }
    this._onSessionChange.fire(this.session);
  }

  // The read-modify-write body of persist(), run while holding the advisory lock.
  private persistLocked(guards?: MergeGuards): void {
    if (!this.session) return;

    // Dual-writer guard: always re-read the on-disk copy and merge in any hook
    // captures that landed since we loaded, so a concurrent hook write is never
    // clobbered. We deliberately do NOT gate this on an mtime check — coarse
    // filesystem mtime granularity (FAT, many network/virtual mounts) can bucket
    // a concurrent hook write into the same timestamp as our last write, and
    // skipping the merge on that false "unchanged" reading silently drops the
    // capture. The read+parse+merge is cheap (small JSON, and persist only runs
    // on a user decision or a reconcile), and mergeFreshCaptures is a no-op when
    // nothing changed, so always reconciling is both correct and inexpensive.
    try {
      const disk = migrateSession(JSON.parse(fs.readFileSync(this.sessionPath, "utf-8"))).session;
      this.session = mergeFreshCaptures(this.session, disk, guards);
    } catch {
      // no readable/parseable disk copy → write our own state (never lose it)
    }

    // No pending entries left → the session is fully reviewed; any pending
    // entry (added by the hook, or reopened by revert/re-apply) reactivates it.
    this.session.status = Object.keys(this.session.files).length === 0 ? "reviewed" : "active";

    try {
      this.atomicWrite(this.sessionPath, JSON.stringify(this.session, null, 2));
    } catch (err) {
      this.log.appendLine(`[ERROR] ` + `Failed to persist session: ${(err as Error).message}`);
    }
  }

  // Write via a temp file + rename so an interrupted write can't corrupt the
  // target. When restoring a user's working file (preserveExisting=true), follow
  // symlinks (write through to the target, as writeFileSync did) and preserve the
  // existing file's mode (e.g. the executable bit) — the session file, which we
  // own, passes preserveExisting=false to avoid the extra stats.
  private atomicWrite(filePath: string, content: string, preserveExisting = false): void {
    let target = filePath;
    let mode: number | undefined;
    if (preserveExisting) {
      try {
        if (fs.lstatSync(filePath).isSymbolicLink()) target = fs.realpathSync(filePath);
      } catch { /* target doesn't exist yet — treat as a new file */ }
      try { mode = fs.statSync(target).mode; } catch { /* new file — default mode */ }
    }
    const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, content, "utf-8");
      if (mode !== undefined) fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore cleanup error */ }
      throw err;
    }
  }

  // Write the session into history/ as a browsable archive (History panel).
  // Embeds workspacePath so the panel can scope archives per workspace.
  // Returns true when safely archived OR there is nothing on disk to lose;
  // false only when a real file exists but the write failed.
  private archiveSession(): boolean {
    if (!this.session) return true;
    if (!fs.existsSync(this.sessionPath)) return true; // in-memory only → nothing to lose
    try {
      const historyDir = path.join(this.claudegateDir, "history");
      fs.mkdirSync(historyDir, { recursive: true });
      const safeName = this.session.sessionId.replace(/[:.]/g, "-");
      const payload = JSON.stringify(
        { ...this.session, ...(this.workspaceRoot ? { workspacePath: this.workspaceRoot } : {}) },
        null, 2
      );
      this.atomicWrite(path.join(historyDir, `${safeName}.json`), payload);
      return true;
    } catch (err) {
      this.log.appendLine(`[WARN] ` + `Could not archive session: ${(err as Error).message}`);
      return false;
    }
  }
}
