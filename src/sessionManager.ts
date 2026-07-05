import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isInWorkspace, isExcluded } from "./workspaceScope";
import {
  Session, FileEntry, ReviewRecord, hasRealChange, acceptEntry, rejectEntry,
  migrateSession,
} from "./reviewModel";
export type { Session, FileEntry, ReviewRecord } from "./reviewModel";
export type ReviewStatus = "pending" | "accepted" | "rejected"; // panel tab id

// A pending "new file" (originalContent === null) whose path has vanished was a
// temp file Claude created and then removed — there is nothing left to review,
// so it is pruned. The PreToolUse hook records the entry *before* Claude writes
// the file, so a genuinely new file briefly does not exist on disk; the grace
// delay avoids pruning it in that window.
const RECONCILE_GRACE_MS = 1500;

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
    return Object.keys(this.session.files).filter(
      (fp) => isInWorkspace(fp) && !isExcluded(fp) && this.hasRealPendingChange(fp)
    ).length;
  }

  trackFileChange(filePath: string, originalContent: string | null): void {
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

  rejectFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry) return;
    const after = this.readFileOrNull(filePath); // Claude's discarded version
    try {
      if (entry.originalContent === null) fs.unlinkSync(filePath);
      else fs.writeFileSync(filePath, entry.originalContent, "utf-8");
    } catch (err) {
      this.log.appendLine(`[ERROR] reject ${filePath}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }
    rejectEntry(this.session!, filePath, after, new Date().toISOString());
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

    for (const fp of Object.keys(s.files)) {
      if (!fp.startsWith(prefix) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const entry = s.files[fp];
      const after = this.readFileOrNull(fp);
      try {
        if (entry.originalContent === null) fs.unlinkSync(fp);
        else fs.writeFileSync(fp, entry.originalContent, "utf-8");
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
  }

  // Known limitation: hook.py and the extension both read-modify-write the
  // same JSON file without a cross-process lock. Atomic rename prevents torn
  // reads, but a concurrent hook.py write can still overwrite accept/reject
  // state written by the extension (and vice-versa). This is low-probability
  // in normal single-user use; the long-term fix is a version/timestamp check.

  rejectAll(): void {
    const s = this.session;
    if (!s) return;
    const decidedAt = new Date().toISOString();
    const errors: string[] = [];
    let count = 0;

    for (const fp of Object.keys(s.files)) {
      if (!isInWorkspace(fp) || isExcluded(fp) || !this.hasRealPendingChange(fp)) continue;
      const entry = s.files[fp];
      const after = this.readFileOrNull(fp);
      try {
        if (entry.originalContent === null) fs.unlinkSync(fp);
        else fs.writeFileSync(fp, entry.originalContent, "utf-8");
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
      s.files[rec.path] = { originalContent: rec.before, reviewStatus: "pending", sessionId: rec.sessionId };
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

  reapplyRejected(filePath: string): void {
    const s = this.session;
    const rec = s?.rejected[filePath];
    if (!s || !rec) return;
    if (rec.after == null) {
      vscode.window.showWarningMessage(
        `Claude Gate: Cannot re-apply — Claude's version of "${path.basename(filePath)}" was not saved.`
      );
      return;
    }
    try {
      fs.writeFileSync(filePath, rec.after, "utf-8");
    } catch (err) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not re-apply ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }
    delete s.rejected[filePath];
    s.files[filePath] = { originalContent: rec.before, reviewStatus: "pending", sessionId: rec.sessionId };
    this.log.appendLine(`[INFO] Re-applied: ${filePath}`);
    this.persist();
  }

  reapplyAll(): void {
    const s = this.session;
    if (!s) return;
    const paths = Object.keys(s.rejected).filter((fp) => !isExcluded(fp));
    for (const fp of paths) this.reapplyRejected(fp);
  }

  reapplyFolder(folderPath: string): void {
    const s = this.session;
    if (!s) return;
    const prefix = folderPath + path.sep;
    const paths = Object.keys(s.rejected).filter((fp) => fp.startsWith(prefix) && !isExcluded(fp));
    for (const fp of paths) this.reapplyRejected(fp);
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
    let removed = 0;
    for (const filePath of Object.keys(this.session.files)) {
      if (!isInWorkspace(filePath)) {
        delete this.session.files[filePath];
        removed++;
        this.log.appendLine(`[INFO] Pruned out-of-workspace entry: ${filePath}`);
      }
    }
    if (removed > 0) this.persist();
  }

  // Prune temp files Claude created then deleted, after a grace delay so a
  // just-created file (recorded by the hook before the write lands) survives.
  private scheduleReconcile(): void {
    if (!this.session || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcileVanishedNewFiles();
    }, RECONCILE_GRACE_MS);
  }

  private reconcileVanishedNewFiles(): void {
    if (!this.session) return;
    let removed = 0;
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.originalContent === null && !fs.existsSync(filePath)) {
        delete this.session.files[filePath];
        removed++;
        this.log.appendLine(`[INFO] Pruned vanished new file: ${filePath}`);
      }
    }
    if (removed > 0) this.persist();
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

  private persist(): void {
    if (!this.session) return;

    // No pending entries left → the session is fully reviewed; any pending
    // entry (added by the hook, or reopened by revert/re-apply) reactivates it.
    this.session.status = Object.keys(this.session.files).length === 0 ? "reviewed" : "active";

    try {
      this.atomicWrite(this.sessionPath, JSON.stringify(this.session, null, 2));
    } catch (err) {
      this.log.appendLine(`[ERROR] ` + `Failed to persist session: ${(err as Error).message}`);
    }

    this._onSessionChange.fire(this.session);
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, filePath);
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
