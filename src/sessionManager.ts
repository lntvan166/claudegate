import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isInWorkspace, isExcluded } from "./workspaceScope";
import {
  Session, FileEntry, ReviewRecord, hasRealChange, shouldPruneNoOp, acceptEntry,
  rejectEntry, migrateSession, mergeFreshCaptures,
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

export class SessionManager {
  private readonly sessionPath: string;
  private readonly sessionFilename: string;
  private readonly watchDir: string;
  private readonly claudegateDir: string;
  private session: Session | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

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
    } else {
      this.sessionFilename = "session.json";
      this.watchDir   = this.claudegateDir;
      this.sessionPath = path.join(this.claudegateDir, "session.json");
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
  hasRealPendingChange(filePath: string): boolean {
    const entry = this.session?.files[filePath];
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
    this.persist();
  }

  acceptFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const decidedAt = new Date().toISOString();
    let count = 0;
    for (const fp of Object.keys(s.files)) {
      if (!fp.startsWith(prefix) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const after = this.readFileOrNull(fp);
      if (after === null) this.log.appendLine(`[WARN] Accept folder: could not read ${fp}; accepted diff unavailable`);
      acceptEntry(s, fp, after, decidedAt);
      count++;
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Accepted folder: ${folderPath} (${count} file(s))`);
    this.persist();
  }

  acceptAll(): void {
    const s = this.session;
    if (!s) return;
    const decidedAt = new Date().toISOString();
    let count = 0;
    for (const fp of Object.keys(s.files)) {
      if (!isInWorkspace(fp) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const after = this.readFileOrNull(fp);
      if (after === null) this.log.appendLine(`[WARN] Accept all: could not read ${fp}; accepted diff unavailable`);
      acceptEntry(s, fp, after, decidedAt);
      count++;
    }
    this.log.appendLine(`[INFO] Accepted all: ${count} file(s)`);
    this.persist();
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

  rejectFile(filePath: string): void {
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
    rejectEntry(this.session!, filePath, after, new Date().toISOString());
    if (outcome === "left") {
      vscode.window.showInformationMessage(
        `Claude Gate: left "${path.basename(filePath)}" on disk (created outside Claude Code — not auto-deleted).`
      );
    }
    this.log.appendLine(`[INFO] Rejected: ${filePath}`);
    this.persist();
  }

  rejectFolder(folderPath: string): void {
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
      rejectEntry(s, fp, after, decidedAt);
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

  rejectAll(): void {
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
      rejectEntry(s, fp, after, decidedAt);
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
    if (!this.session?.files[filePath]) return;
    delete this.session.files[filePath];
    this.persist();
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
    this.persist();
  }

  revertAcceptedAll(): void {
    const s = this.session;
    if (!s) return;
    const recs = [...s.accepted];
    if (recs.length === 0) return;
    for (const rec of recs) this.revertAcceptedRecord(rec);
    this.log.appendLine(`[INFO] Reverted all accepted: ${recs.length} file(s)`);
    this.persist();
  }

  revertAcceptedFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const recs = s.accepted.filter((r) => r.path.startsWith(prefix));
    if (recs.length === 0) return;
    for (const rec of recs) this.revertAcceptedRecord(rec);
    this.log.appendLine(`[INFO] Reverted accepted folder: ${folderPath} (${recs.length} file(s))`);
    this.persist();
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
    this.persist();
  }

  private reapplyMany(paths: string[], label: string): void {
    if (paths.length === 0) return;
    const errors: string[] = [];
    for (const fp of paths) {
      const err = this.reapplyRejectedRecord(fp);
      if (err) {
        errors.push(`${path.basename(fp)}: ${err}`);
        this.log.appendLine(`[ERROR] reapply ${fp}: ${err}`);
      }
    }
    this.persist();
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
    const count = this.session.accepted.length;
    if (count === 0) return;
    this.session.accepted = [];
    this.log.appendLine(`[INFO] Cleared accepted: ${count} record(s)`);
    this.persist();
  }

  clearRejected(): void {
    if (!this.session) return;
    const count = Object.keys(this.session.rejected).length;
    if (count === 0) return;
    this.session.rejected = {};
    this.log.appendLine(`[INFO] Cleared rejected: ${count} record(s)`);
    this.persist();
  }

  clearSession(): void {
    if (!this.session) return;
    this.archiveSession();
    try {
      fs.unlinkSync(this.sessionPath);
    } catch { /* already gone */ }
    this.session = null;
    this._onSessionChange.fire(null);
    this.log.appendLine(`[INFO] ` + "Session cleared.");
  }

  private loadSession(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionPath, "utf-8"));
      const migrated = migrateSession(raw);
      const changed = JSON.stringify(migrated) !== JSON.stringify(raw);
      this.session = migrated;
      this.log.appendLine(
        `[INFO] Session loaded: ${Object.keys(this.session.files).length} pending, ` +
        `${this.session.accepted.length} accepted, ${Object.keys(this.session.rejected).length} rejected`
      );
      this.pruneOutOfWorkspaceEntries();
      if (changed) this.persist();
    } catch {
      this.session = null;
    }
    this._onSessionChange.fire(this.session);
    this.scheduleReconcile();
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
    if (pruned.size > 0) this.persist(pruned);
  }

  // Prune temp files Claude created then deleted, after a grace delay so a
  // just-created file (recorded by the hook before the write lands) survives.
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
      if (shouldPruneNoOp(entry, disk, now, RECONCILE_GRACE_MS)) {
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
    if (pruned.size > 0) this.persist(pruned);
    // Give still-young no-op entries their full per-entry grace instead of the
    // shared timer's remaining time (closes the burst-coalescing hole).
    if (youngNoOp) this.scheduleReconcile();
  }

  // Read a file's current content, or null if it cannot be read. Used to
  // checkpoint the review baseline at approve/reject time.
  private readFileOrNull(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
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

  // `prunedThisCycle` (path → capturedAt) lets a caller that just deliberately
  // removed no-op entries tell the dual-writer merge below not to resurrect them
  // from the still-stale on-disk copy (see mergeFreshCaptures).
  private persist(prunedThisCycle?: Map<string, string | undefined>): void {
    if (!this.session) return;

    const lock = this.acquireLock();
    try {
      this.persistLocked(prunedThisCycle);
    } finally {
      this.releaseLock(lock);
    }
    this._onSessionChange.fire(this.session);
  }

  // The read-modify-write body of persist(), run while holding the advisory lock.
  private persistLocked(prunedThisCycle?: Map<string, string | undefined>): void {
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
      const disk = migrateSession(JSON.parse(fs.readFileSync(this.sessionPath, "utf-8")));
      this.session = mergeFreshCaptures(this.session, disk, prunedThisCycle);
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

  private archiveSession(): void {
    if (!this.session) return;
    try {
      const historyDir = path.join(this.claudegateDir, "history");
      fs.mkdirSync(historyDir, { recursive: true });
      const safeName = this.session.sessionId.replace(/[:.]/g, "-");
      fs.copyFileSync(this.sessionPath, path.join(historyDir, `${safeName}.json`));
    } catch (err) {
      this.log.appendLine(`[WARN] ` + `Could not archive session: ${(err as Error).message}`);
    }
  }
}
