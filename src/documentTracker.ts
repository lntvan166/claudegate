import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";

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
      watcher.onDidCreate((uri) => this.handleFileChange(uri))
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
    if (filePath.includes(path.sep + ".git" + path.sep)) return;

    const session = this.sessionManager.getSession();
    if (session?.files[filePath]?.reviewStatus === "pending") return;

    const originalContent = this.snapshots.has(filePath)
      ? (this.snapshots.get(filePath) ?? null)
      : null;

    this.sessionManager.trackFileChange(filePath, originalContent);
    this.log.appendLine(`[INFO] DocumentTracker: captured ${path.basename(filePath)}`);
  }

  private isInWorkspace(filePath: string): boolean {
    if (!this.workspacePath) return false;
    return filePath.startsWith(this.workspacePath + path.sep);
  }
}
