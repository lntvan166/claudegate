import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { computeHunks } from "./hunks";
import { isInWorkspace, isExcluded } from "./workspaceScope";

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly sessionManager: SessionManager,
    disposables: vscode.Disposable[]
  ) {
    disposables.push(
      sessionManager.onSessionChange(() => this._onDidChangeCodeLenses.fire()),
      vscode.workspace.onDidChangeTextDocument(() => this._onDidChangeCodeLenses.fire())
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") return [];
    const enabled = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("hunkCodeLens.enabled", true);
    if (!enabled) return [];
    const fp = document.uri.fsPath;
    const entry = this.sessionManager.getSession()?.files[fp];
    if (entry?.reviewStatus !== "pending" || !isInWorkspace(fp) || isExcluded(fp)) return [];
    return computeHunks(entry.originalContent ?? "", document.getText()).map(
      (h, i) =>
        new vscode.CodeLens(new vscode.Range(h.startLine, 0, h.startLine, 0), {
          title: `↩ Revert this change · ${h.label}`,
          command: "claudegate.revertHunk",
          arguments: [document.uri, i],
        })
    );
  }
}
