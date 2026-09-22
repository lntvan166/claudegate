import { SessionManager } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { isInWorkspace, isExcluded } from "./workspaceScope";

// Which sessions the review panels draw from.
//
// Those panels render the primary session's records AND every attached
// worktree's (FilteredTreeProvider.getRecordChildren appends worktreeGroups()),
// and their view-gating counts are already worktree-inclusive via
// WorktreeSessionRegistry.totalAccepted/totalRejected. The title-bar bulk
// actions, however, used the primary SessionManager alone — so a record that
// lived in a worktree was displayed, counted, and then left untouched by the
// very button above it. With an empty primary those commands' `count === 0`
// early return fired first, making the button a silent no-op.
//
// The Pending panel has the same split: its badge already sums
// worktreeRegistry.totalPending(), while Accept All / Reject All read the primary
// session alone, so worktree files were counted and then not accepted.
//
// Everything that acts on the panels in bulk goes through here, so the set it
// acts on cannot drift from the set the panel draws.

/** The primary session followed by every attached worktree session. */
export function reviewScopes(
  primary: SessionManager,
  registry?: WorktreeSessionRegistry
): SessionManager[] {
  return [primary, ...(registry?.getManagers().values() ?? [])];
}

/** In-scope accepted records across every scope — the number the Accepted panel
 *  shows, and the number a bulk action there should be reporting. */
export function countAcceptedAcross(scopes: SessionManager[]): number {
  return scopes.reduce((n, m) => n + m.getAcceptedCount(), 0);
}

/** Same, for the Rejected panel. */
export function countRejectedAcross(scopes: SessionManager[]): number {
  return scopes.reduce((n, m) => n + m.getRejectedCount(), 0);
}

/** In-scope pending files across every scope, paired with the session that owns
 *  each — callers need the owner to accept/reject it and to close its diff. */
export function pendingAcross(
  scopes: SessionManager[]
): Array<{ filePath: string; manager: SessionManager }> {
  const out: Array<{ filePath: string; manager: SessionManager }> = [];
  for (const manager of scopes) {
    const session = manager.getSession();
    if (!session) continue;
    for (const filePath of Object.keys(session.files)) {
      if (isInWorkspace(filePath) && !isExcluded(filePath)) {
        out.push({ filePath, manager });
      }
    }
  }
  return out;
}
