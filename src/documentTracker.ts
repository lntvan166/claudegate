import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "./sessionManager";

// Directory segments that are never Claude-authored — skip any path containing these.
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "target", "vendor", "Pods", ".dart_tool", ".gradle", ".cache",
  "coverage", ".nyc_output", ".turbo", ".svelte-kit",
]);

// File suffixes that indicate editor/VCS temporary files, never source files.
const IGNORED_SUFFIXES = [".git", ".orig", ".tmp", "~"];

// git/codegen typically touch many files at once; Claude GUI edits are usually few.
const BULK_FILE_THRESHOLD = 8;
const FS_BATCH_DEBOUNCE_MS = 300;

// A git pull/merge/checkout/rebase touches .git telltales; suppress capture
// for a short window after any of them change, regardless of file count.
const GIT_OP_WINDOW_MS = 3000;
const GIT_TELLTALES = ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "FETCH_HEAD", "index"];

interface FsEvent {
  uri: vscode.Uri;
  isCreate: boolean;
}

interface FsCandidate {
  filePath: string;
  isCreate: boolean;
  hasSnapshot: boolean;
  snapshot: string | null;
  currentContent: string;
}

export class DocumentTracker {
  private readonly snapshots = new Map<string, string | null>();
  private readonly disposables: vscode.Disposable[] = [];
  private fsEventQueue: FsEvent[] = [];
  private fsBatchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly workspacePath: string | undefined,
    private readonly log: vscode.OutputChannel
  ) {}

  start(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.snapshotDocument(doc);
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.snapshotDocument(doc))
    );

    if (!this.workspacePath) return;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspacePath, "**/*")
    );

    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => this.enqueueFileChange(uri, false)),
      watcher.onDidCreate((uri) => this.enqueueFileChange(uri, true)),
      watcher.onDidDelete((uri) => this.handleFileDelete(uri))
    );
  }

  stop(): void {
    if (this.fsBatchTimer !== undefined) {
      clearTimeout(this.fsBatchTimer);
      this.fsBatchTimer = undefined;
    }
    this.fsEventQueue = [];
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.snapshots.clear();
  }

  private snapshotDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file") return;
    const filePath = doc.uri.fsPath;
    if (!this.isInWorkspace(filePath)) return;
    if (!this.snapshots.has(filePath)) {
      this.snapshots.set(filePath, doc.getText());
    }
  }

  private enqueueFileChange(uri: vscode.Uri, isCreate: boolean): void {
    this.fsEventQueue.push({ uri, isCreate });
    if (this.fsBatchTimer !== undefined) clearTimeout(this.fsBatchTimer);
    this.fsBatchTimer = setTimeout(() => this.processFsEventBatch(), FS_BATCH_DEBOUNCE_MS);
  }

  private processFsEventBatch(): void {
    this.fsBatchTimer = undefined;
    const batch = this.fsEventQueue.splice(0);
    if (batch.length === 0) return;

    const session = this.sessionManager.getSession();
    const candidates: FsCandidate[] = [];

    for (const { uri, isCreate } of batch) {
      const filePath = uri.fsPath;
      if (!this.isInWorkspace(filePath)) continue;
      if (this.isIgnoredPath(filePath)) continue;
      try { if (fs.statSync(filePath).isDirectory()) continue; } catch { continue; }
      if (session?.files[filePath]) continue;

      // Design: modifications require a cached snapshot from a prior document open.
      const hasSnapshot = this.snapshots.has(filePath);
      if (!isCreate && !hasSnapshot) continue;

      let currentContent: string;
      try {
        currentContent = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const snapshot = hasSnapshot ? (this.snapshots.get(filePath) ?? null) : null;
      candidates.push({
        filePath,
        isCreate,
        hasSnapshot,
        snapshot,
        currentContent,
      });
    }

    if (candidates.length === 0) return;

    if (this.isGitOperationActive()) {
      for (const c of candidates) {
        this.refreshSnapshot(c.filePath, c.currentContent);
      }
      this.log.appendLine(
        `[INFO] DocumentTracker: ignored git operation (${candidates.length} file(s))`
      );
      return;
    }

    const allNewCreatesWithoutSnapshot = candidates.every(
      (c) => c.isCreate && !c.hasSnapshot
    );
    const looksLikeExternalBulk =
      candidates.length >= BULK_FILE_THRESHOLD ||
      (candidates.length >= 2 && allNewCreatesWithoutSnapshot);

    if (looksLikeExternalBulk) {
      for (const c of candidates) {
        this.refreshSnapshot(c.filePath, c.currentContent);
      }
      this.log.appendLine(
        `[INFO] DocumentTracker: ignored bulk external change (${candidates.length} file(s))`
      );
      return;
    }

    for (const c of candidates) {
      if (c.isCreate && !c.hasSnapshot) {
        this.captureFile(c.filePath, null);
        continue;
      }

      if (!c.hasSnapshot) continue;
      if (c.currentContent === c.snapshot) continue;

      this.captureFile(c.filePath, c.snapshot);
    }
  }

  private captureFile(filePath: string, originalContent: string | null): void {
    this.sessionManager.trackFileChange(filePath, originalContent);
    this.log.appendLine(`[INFO] DocumentTracker: captured ${path.basename(filePath)}`);
  }

  private refreshSnapshot(filePath: string, content: string): void {
    this.snapshots.set(filePath, content);
  }

  private handleFileDelete(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    const session = this.sessionManager.getSession();
    const entry = session?.files[filePath];
    if (entry?.reviewStatus === "pending") {
      this.sessionManager.removePendingFile(filePath);
      this.snapshots.delete(filePath);
      this.log.appendLine(`[INFO] DocumentTracker: removed deleted file ${path.basename(filePath)}`);
    }
  }

  // True if a git operation appears to be in progress or just completed.
  // Fails open (returns false) on any error so normal capture is unaffected.
  private isGitOperationActive(): boolean {
    if (!this.workspacePath) return false;
    const gitDir = path.join(this.workspacePath, ".git");
    try {
      // Worktrees/submodules use a .git *file*; skip detection for those.
      if (!fs.statSync(gitDir).isDirectory()) return false;
    } catch {
      return false; // no repo
    }

    // index.lock existence is treated as an active op with no time bound: a
    // held lock means git is mid-operation. Tradeoff: a stale lock left by a
    // crashed git process keeps capture suppressed until it is removed — but a
    // stale lock also breaks git itself, so the user will notice and clear it.
    try {
      if (fs.existsSync(path.join(gitDir, "index.lock"))) return true;
    } catch { /* ignore */ }

    const now = Date.now();
    for (const name of GIT_TELLTALES) {
      try {
        const { mtimeMs } = fs.statSync(path.join(gitDir, name));
        if (now - mtimeMs < GIT_OP_WINDOW_MS) return true;
      } catch { /* missing telltale is fine */ }
    }
    return false;
  }

  private isInWorkspace(filePath: string): boolean {
    if (!this.workspacePath) return false;
    return filePath.startsWith(this.workspacePath + path.sep);
  }

  private isIgnoredPath(filePath: string): boolean {
    const segments = filePath.split(path.sep);
    if (segments.some((s) => IGNORED_DIRS.has(s))) return true;
    const filename = segments[segments.length - 1];
    return IGNORED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
  }
}
