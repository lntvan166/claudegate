import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
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

  // The registry is how a file inside a nested worktree finds its OWN session.
  // Without it this provider read the primary session alone, and a worktree's
  // pending files are never in there — they live in the worktree's own session
  // file (verified: zero path overlap between a worktree session and its
  // parent's). So every one of them fell through the `!entry` guard below and
  // got no badge and no colour at all, anywhere in the Explorer.
  //
  // That was silent for most people — the file simply looked undecorated. It
  // only became visible to a user whose worktree parent directory is gitignored,
  // where git's ignored-grey filled the vacuum. Same root cause as the bulk
  // actions in reviewScopes.ts: "the primary session" is never the answer.
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly worktreeRegistry?: WorktreeSessionRegistry
  ) {
    sessionManager.onSessionChange(() => this._onDidChange.fire(undefined));
    // A decision taken inside a worktree must repaint the Explorer too, or the
    // badge lingers on a file that is no longer pending.
    worktreeRegistry?.onChange(() => this._onDidChange.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const owner = this.worktreeRegistry?.managerFor(uri.fsPath) ?? this.sessionManager;
    const session = owner.getSession();
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
