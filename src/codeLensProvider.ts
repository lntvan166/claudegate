import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export class ClaudeGateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri;
    const filePath =
      uri.scheme === "file"       ? uri.fsPath :
      uri.scheme === "claudegate" ? uri.path   :
      undefined;

    if (!filePath) return [];

    const session = this.sessionManager.getSession();
    if (session?.files[filePath]?.reviewStatus !== "pending") return [];

    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: "✓ Accept",
        command: "claudegate.acceptFile",
        arguments: [{ filePath }],
      }),
      new vscode.CodeLens(range, {
        title: "✕ Reject",
        command: "claudegate.rejectFile",
        arguments: [{ filePath }],
      }),
    ];
  }
}
