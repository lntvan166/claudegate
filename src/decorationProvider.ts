import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { isExcluded, isProtected } from "./workspaceScope";
import { createCoalescer } from "./scheduling";

// Same window the tree providers use: short enough to feel instant, long enough
// to swallow the persist() + fs.watch-reload pair a single decision produces.
const DECORATION_COALESCE_MS = 60;

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

// Two badges, because colour alone must not be the only difference. A file
// Claude CREATED and a file Claude EDITED were previously distinguished purely
// by untracked-green versus modified-orange — which is the single most
// confusable pair for deuteranopia and protanopia, and invisible to anyone
// reading a screenshot in greyscale. The information existed only in the tooltip.
//
// `+` reads as "added" everywhere, costs nothing (the badge slot is already
// ours), and does not collide with git's own A/M/U/D/R — the constraint that
// keeps this extension's badge from being mistaken for a git status.
const BADGE_PENDING = "!";
const BADGE_NEW = "+";

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

  // The set of pending paths at the last repaint. Diffing against it is what
  // lets us invalidate only what changed — see invalidateChanged().
  private lastPaths = new Set<string>();

  private readonly coalescedInvalidate = createCoalescer(
    DECORATION_COALESCE_MS,
    () => this.invalidateChanged()
  );

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
    // Coalesced, like every other consumer of this burst. Firing undefined
    // invalidates EVERY decoration in the Explorer, and a session change arrives
    // at least twice per decision — once from persist() and once from the
    // fs.watch reload that write triggers — so a multi-file accept repainted the
    // whole Explorer several times over. CLAUDE.md's Extension-Host
    // Responsiveness section already describes the two consumers that coalesce;
    // this was a third that never did.
    sessionManager.onSessionChange(() => this.coalescedInvalidate.schedule());
    // A decision taken inside a worktree must repaint the Explorer too, or the
    // badge lingers on a file that is no longer pending.
    worktreeRegistry?.onChange(() => this.coalescedInvalidate.schedule());
  }

  /** Every path that currently has a pending entry, across the primary session
   *  and every attached worktree — the only paths this provider decorates. */
  private currentPaths(): Set<string> {
    const out = new Set<string>();
    const add = (m: SessionManager): void => {
      const session = m.getSession();
      if (!session) return;
      for (const fp of Object.keys(session.files)) out.add(fp);
    };
    add(this.sessionManager);
    for (const [, m] of this.worktreeRegistry?.getManagers() ?? []) add(m);
    return out;
  }

  /** Invalidate the rows that changed, never the whole Explorer.
   *
   *  Firing `undefined` tells VS Code every decoration is stale, so it drops all
   *  of them and re-queries — and in the gap each row falls back to the default
   *  theme foreground. That reads as the panel blinking white and reloading on
   *  every accept. Firing a path list repaints only those rows, so everything
   *  else keeps its colour untouched.
   *
   *  A path's decoration can only change when it enters or leaves the pending
   *  set: the hook never rewrites an entry that is already pending, and the
   *  colour depends on `originalContent === null`, which is fixed for the life
   *  of an entry. So the symmetric difference is the complete change set. */
  private invalidateChanged(): void {
    const now = this.currentPaths();
    const changed: vscode.Uri[] = [];
    for (const fp of now) if (!this.lastPaths.has(fp)) changed.push(vscode.Uri.file(fp));
    for (const fp of this.lastPaths) if (!now.has(fp)) changed.push(vscode.Uri.file(fp));
    this.lastPaths = now;
    // A session change that touched no pending path — a decision recorded in the
    // accepted log, say — needs no repaint at all.
    if (changed.length === 0) return;
    this._onDidChange.fire(changed);
  }

  dispose(): void {
    this.coalescedInvalidate.dispose();
    this._onDidChange.dispose();
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
      badge: isNew ? BADGE_NEW : BADGE_PENDING,
      color: isNew ? COLOR_NEW : COLOR_MODIFIED,
      tooltip: isNew
        ? "Claude Gate: pending review — new file"
        : TOOLTIPS[s] ?? `Claude Gate: ${s}`,
      propagate: false,
    };
  }
}
