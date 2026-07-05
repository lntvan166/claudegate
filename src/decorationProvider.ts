import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { isExcluded, isProtected } from "./workspaceScope";

const COLORS: Record<string, vscode.ThemeColor> = {
  pending: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
};

const BADGES: Record<string, string> = {
  pending: "!",
};

const TOOLTIPS: Record<string, string> = {
  pending:  "Claude Gate: pending review",
  accepted: "Claude Gate: accepted",
  rejected: "Claude Gate: rejected",
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
    if (isExcluded(uri.fsPath)) return undefined;

    // files{} is pending-only now, so entry.reviewStatus is always "pending".
    // (No live-disk gate here: it would drop the badge for an entry the hook
    // recorded pre-write; settled no-op entries are pruned by the reconcile.)
    if (isProtected(uri.fsPath)) {
      return {
        badge: "⚠",
        color: new vscode.ThemeColor("list.warningForeground"),
        tooltip: "Claude Gate: protected — sensitive file, review carefully",
        propagate: false,
      };
    }

    const s = entry.reviewStatus;
    return {
      badge: BADGES[s],
      color: COLORS[s],
      tooltip: TOOLTIPS[s] ?? `Claude Gate: ${s}`,
      propagate: false,
    };
  }
}
