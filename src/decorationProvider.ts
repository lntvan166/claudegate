import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

const COLORS: Record<string, vscode.ThemeColor> = {
  pending:  new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
  accepted: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
  rejected: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
};

const BADGES: Record<string, string> = {
  pending:  "M",
  accepted: "A",
  rejected: "R",
};

const TOOLTIPS: Record<string, string> = {
  pending:  "ClaudeGate: pending review",
  accepted: "ClaudeGate: accepted",
  rejected: "ClaudeGate: rejected",
};

export class ClaudeGateDecorationProvider
  implements vscode.FileDecorationProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() => this._onDidChange.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const session = this.sessionManager.getSession();
    const entry = session?.files[uri.fsPath];
    if (!entry) return undefined;

    const s = entry.reviewStatus;
    return {
      badge: BADGES[s],
      color: COLORS[s],
      tooltip: TOOLTIPS[s],
      propagate: false,
    };
  }
}
