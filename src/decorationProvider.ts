import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { isExcluded, isProtected } from "./workspaceScope";

// Colours are git's OWN semantic theme colours, deliberately — not an invented
// palette. A file Claude created is untracked-green, a file Claude edited is
// modified-orange, which is what git would say about them anyway. Agreeing with
// git means the decoration reinforces it instead of fighting it in the Explorer,
// where a FileDecorationProvider's colour necessarily also lands (decorations are
// keyed by URI; there is no API to scope one to a single view).
//
// These resolve from the active THEME, not from git state, so a workspace with
// no git repo — or a machine with no git at all — renders exactly the same.
const COLOR_MODIFIED = new vscode.ThemeColor("gitDecoration.modifiedResourceForeground");
const COLOR_NEW      = new vscode.ThemeColor("gitDecoration.untrackedResourceForeground");

/** Claude created this file (no baseline) vs. edited an existing one. */
export function isNewFile(entry: { originalContent: string | null }): boolean {
  return entry.originalContent === null;
}

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

    // Until now every pending file got the "modified" colour, including the ones
    // Claude had CREATED — overpainting the green git gives an untracked file and
    // hiding the new/modified distinction in both the panel and the Explorer.
    const s = entry.reviewStatus;
    const isNew = isNewFile(entry);
    return {
      badge: BADGES[s],
      color: isNew ? COLOR_NEW : COLOR_MODIFIED,
      tooltip: isNew
        ? "Claude Gate: pending review — new file"
        : TOOLTIPS[s] ?? `Claude Gate: ${s}`,
      propagate: false,
    };
  }
}
