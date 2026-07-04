import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isInWorkspace, isExcluded } from "./workspaceScope";

export type ReviewStatus = "pending" | "accepted" | "rejected";
export type SessionStatus = "active" | "reviewed";

export interface FileEntry {
  originalContent: string | null;
  claudeContent?: string | null; // saved at reject time so the action can be undone
  reviewStatus: ReviewStatus;
  sessionId?: string;  // Claude session_id that produced this change (hook path only)
  capturedAt?: string; // ISO timestamp of first capture
}

export interface Session {
  sessionId: string;
  status: SessionStatus;
  files: Record<string, FileEntry>;
}

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

  getPendingCount(): number {
    if (!this.session) return 0;
    return Object.entries(this.session.files).filter(
      ([fp, f]) => f.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
    ).length;
  }

  trackFileChange(filePath: string, originalContent: string | null): void {
    // Create session if it doesn't exist (in memory; persist() will write it)
    if (!this.session) {
      this.session = {
        sessionId: new Date().toISOString(),
        status: "active",
        files: {},
      };
    }

    const entry = this.session.files[filePath];

    // If file not yet in session, add it
    if (!entry) {
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
      return;
    }

    // INVARIANT: a pending entry's originalContent is the frozen review
    // baseline — never overwrite it here. It advances only on accept
    // (checkpoint) or when a previously accepted/rejected file is re-edited.

    // If already pending, no-op
    if (entry.reviewStatus === "pending") {
      return;
    }

    // If accepted or rejected, reset to pending
    if (entry.reviewStatus === "accepted" || entry.reviewStatus === "rejected") {
      entry.originalContent = originalContent;
      entry.reviewStatus = "pending";
      entry.claudeContent = undefined;
      this.session.status = "active";
      this.log.appendLine(`[INFO] Re-tracking: ${filePath}`);
      this.persist();
    }
  }

  acceptFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;
    // Checkpoint: the approved content becomes the new baseline so the next
    // Claude edit diffs from here, not the original.
    const current = this.readFileOrNull(filePath);
    if (current !== null) {
      entry.originalContent = current;
    } else {
      this.log.appendLine(`[WARN] Accept: could not read ${filePath}; baseline unchanged`);
    }
    entry.reviewStatus = "accepted";
    this.log.appendLine(`[INFO] ` + `Accepted: ${filePath}`);
    this.persist();
  }

  acceptFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    let count = 0;
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "pending" && !isExcluded(fp)) {
        const current = this.readFileOrNull(fp);
        if (current !== null) entry.originalContent = current;
        else this.log.appendLine(`[WARN] Accept folder: could not read ${fp}; baseline unchanged`);
        entry.reviewStatus = "accepted";
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Accepted folder: ${folderPath} (${count} file(s))`);
    this.persist();
  }

  revertAccepted(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "accepted") return;
    entry.reviewStatus = "pending";
    this.log.appendLine(`[INFO] Reverted accepted: ${filePath}`);
    this.persist();
  }

  revertAcceptedAll(): void {
    if (!this.session) return;
    let count = 0;
    for (const entry of Object.values(this.session.files)) {
      if (entry.reviewStatus === "accepted") {
        entry.reviewStatus = "pending";
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Reverted all accepted: ${count} file(s)`);
    this.persist();
  }

  revertAcceptedFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    let count = 0;
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "accepted") {
        entry.reviewStatus = "pending";
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Reverted accepted folder: ${folderPath} (${count} file(s))`);
    this.persist();
  }

  rejectFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (!fp.startsWith(prefix) || entry.reviewStatus !== "pending" || isExcluded(fp)) continue;
      let savedClaudeContent: string | null;
      try {
        savedClaudeContent = fs.readFileSync(fp, "utf-8");
      } catch {
        savedClaudeContent = null;
      }
      try {
        if (entry.originalContent === null) {
          fs.unlinkSync(fp);
        } else {
          fs.writeFileSync(fp, entry.originalContent, "utf-8");
        }
        entry.claudeContent = savedClaudeContent;
        entry.reviewStatus = "rejected";
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(
          `[ERROR] rejectFolder failed for ${fp}: ${(err as Error).message}`
        );
      }
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

  rejectFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;

    // Save Claude's version before overwriting so the reject can be undone
    try {
      entry.claudeContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      entry.claudeContent = null;
    }

    try {
      if (entry.originalContent === null) {
        fs.unlinkSync(filePath);
        this.log.appendLine(`[INFO] ` + `Deleted new file: ${filePath}`);
      } else {
        fs.writeFileSync(filePath, entry.originalContent, "utf-8");
        this.log.appendLine(`[INFO] ` + `Restored: ${filePath}`);
      }
    } catch (err) {
      this.log.appendLine(`[ERROR] ` + `Failed to reject ${filePath}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }

    entry.reviewStatus = "rejected";
    this.persist();
  }

  reapplyFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "rejected") return;
    if (entry.claudeContent === undefined) {
      vscode.window.showWarningMessage(
        `Claude Gate: Cannot re-apply — reject this file first with the updated extension.`
      );
      return;
    }

    try {
      if (entry.claudeContent === null) {
        // Claude had created a new file that we deleted — nothing to restore
        vscode.window.showWarningMessage(
          `Claude Gate: Cannot re-apply — Claude's version of "${path.basename(filePath)}" was not saved.`
        );
        return;
      }
      fs.writeFileSync(filePath, entry.claudeContent, "utf-8");
      this.log.appendLine(`[INFO] ` + `Re-applied Claude's version: ${filePath}`);
    } catch (err) {
      this.log.appendLine(`[ERROR] ` + `Failed to re-apply ${filePath}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate: Could not re-apply ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }

    entry.reviewStatus = "pending"; // back to pending so user can review again
    entry.claudeContent = undefined;
    this.persist();
  }

  reapplyAll(): void {
    if (!this.session) return;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus !== "rejected" || isExcluded(fp)) continue;
      if (entry.claudeContent === undefined) {
        this.log.appendLine(`[WARN] reapplyAll skipped ${fp}: no claudeContent`);
        continue;
      }
      if (entry.claudeContent === null) {
        this.log.appendLine(`[WARN] reapplyAll skipped ${fp}: Claude created new file, nothing to restore`);
        continue;
      }
      try {
        fs.writeFileSync(fp, entry.claudeContent, "utf-8");
        entry.reviewStatus = "pending";
        entry.claudeContent = undefined;
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] reapplyAll failed for ${fp}: ${(err as Error).message}`);
      }
    }

    if (count === 0 && errors.length === 0) return;
    this.persist();
    this.log.appendLine(`[INFO] Reapplied all: ${count} file(s)`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not re-apply ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }

  reapplyFolder(folderPath: string): void {
    if (!this.session) return;
    const prefix = folderPath + path.sep;
    const errors: string[] = [];
    let count = 0;

    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (!fp.startsWith(prefix) || entry.reviewStatus !== "rejected" || isExcluded(fp)) continue;
      if (entry.claudeContent === undefined) {
        this.log.appendLine(`[WARN] reapplyFolder skipped ${fp}: no claudeContent`);
        continue;
      }
      if (entry.claudeContent === null) {
        this.log.appendLine(`[WARN] reapplyFolder skipped ${fp}: Claude created new file, nothing to restore`);
        continue;
      }
      try {
        fs.writeFileSync(fp, entry.claudeContent, "utf-8");
        entry.reviewStatus = "pending";
        entry.claudeContent = undefined;
        count++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] reapplyFolder failed for ${fp}: ${(err as Error).message}`);
      }
    }

    if (count === 0 && errors.length === 0) return;
    this.persist();
    this.log.appendLine(`[INFO] Reapplied folder: ${folderPath} (${count} file(s))`);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not re-apply ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }

  // Mark rejected without writing to disk (used after inline diff already wrote the file)
  markRejected(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;
    let savedClaudeContent: string | null;
    try {
      savedClaudeContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      savedClaudeContent = null;
    }
    if (entry.originalContent === null) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
    entry.claudeContent = savedClaudeContent;
    entry.reviewStatus = "rejected";
    this.persist();
  }

  acceptAll(): void {
    if (!this.session) return;
    let count = 0;
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus === "pending" && isInWorkspace(filePath) && !isExcluded(filePath)) {
        const current = this.readFileOrNull(filePath);
        if (current !== null) entry.originalContent = current;
        else this.log.appendLine(`[WARN] Accept all: could not read ${filePath}; baseline unchanged`);
        entry.reviewStatus = "accepted";
        count++;
      }
    }
    this.log.appendLine(`[INFO] ` + `Accepted all: ${count} file(s)`);
    this.persist();
  }

  // Known limitation: hook.py and the extension both read-modify-write the
  // same JSON file without a cross-process lock. Atomic rename prevents torn
  // reads, but a concurrent hook.py write can still overwrite accept/reject
  // state written by the extension (and vice-versa). This is low-probability
  // in normal single-user use; the long-term fix is a version/timestamp check.

  rejectAll(): void {
    if (!this.session) return;
    let count = 0;
    const errors: string[] = [];

    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus !== "pending" || !isInWorkspace(filePath) || isExcluded(filePath)) continue;
      let savedClaudeContent: string | null;
      try {
        savedClaudeContent = fs.readFileSync(filePath, "utf-8");
      } catch {
        savedClaudeContent = null;
      }
      try {
        if (entry.originalContent === null) {
          fs.unlinkSync(filePath);
        } else {
          fs.writeFileSync(filePath, entry.originalContent, "utf-8");
        }
        entry.claudeContent = savedClaudeContent;
        entry.reviewStatus = "rejected";
        count++;
      } catch (err) {
        errors.push(`${path.basename(filePath)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] ` + `rejectAll failed for ${filePath}: ${(err as Error).message}`);
      }
    }

    if (count === 0 && errors.length === 0) return;
    this.persist();
    this.log.appendLine(`[INFO] ` + `Rejected all: ${count} file(s)`);

    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${errors.length} file(s). Check Output panel for details.`
      );
    }
  }

  removePendingFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;
    delete this.session!.files[filePath];
    this.persist();
  }

  clearAccepted(): void {
    if (!this.session) return;
    let count = 0;
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus === "accepted") {
        delete this.session.files[filePath];
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Cleared accepted: ${count} file(s)`);
    this.persist();
  }

  clearRejected(): void {
    if (!this.session) return;
    let count = 0;
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus === "rejected") {
        delete this.session.files[filePath];
        count++;
      }
    }
    if (count === 0) return;
    this.log.appendLine(`[INFO] Cleared rejected: ${count} file(s)`);
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
      const raw = fs.readFileSync(this.sessionPath, "utf-8");
      this.session = JSON.parse(raw) as Session;
      this.log.appendLine(`[INFO] Session loaded: ${Object.keys(this.session.files).length} file(s), status=${this.session.status}`);
      this.pruneOutOfWorkspaceEntries();
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
      if (
        entry.reviewStatus === "pending" &&
        entry.originalContent === null &&
        !fs.existsSync(filePath)
      ) {
        delete this.session.files[filePath];
        removed++;
        this.log.appendLine(`[INFO] Pruned vanished new file: ${filePath}`);
      }
    }
    if (removed > 0) this.persist();
  }

  // Read a file's current content, or null if it cannot be read. Used to
  // checkpoint the review baseline at approve time.
  private readFileOrNull(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.session) return;

    const allDone = Object.values(this.session.files).every(
      (f) => f.reviewStatus !== "pending"
    );
    if (allDone) {
      this.session.status = "reviewed";
    }

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
