import * as vscode from "vscode";
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

export class DocumentTracker {
  private readonly snapshots = new Map<string, string | null>();
  private readonly disposables: vscode.Disposable[] = [];

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
      watcher.onDidChange((uri) => this.handleFileChange(uri)),
      watcher.onDidCreate((uri) => this.handleFileChange(uri)),
      watcher.onDidDelete((uri) => this.handleFileDelete(uri))
    );
  }

  stop(): void {
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

  private handleFileChange(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    if (!this.isInWorkspace(filePath)) return;
    if (this.isIgnoredPath(filePath)) return;

    const session = this.sessionManager.getSession();
    // Skip any file already in the session regardless of status.
    // Limiting to === "pending" causes accepted files to be re-queued
    // when git or VS Code touches them without changing content.
    if (session?.files[filePath]) return;

    const originalContent = this.snapshots.has(filePath)
      ? (this.snapshots.get(filePath) ?? null)
      : null;

    this.sessionManager.trackFileChange(filePath, originalContent);
    this.log.appendLine(`[INFO] DocumentTracker: captured ${path.basename(filePath)}`);
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
