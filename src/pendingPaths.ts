import { isInWorkspace, isExcluded } from "./workspaceScope";
import { SessionManager } from "./sessionManager";
import { orderPending } from "./reviewNav";

// Canonical ordered list of pending files for the stepper and the diff-title
// progress count. Same filter + ordering openNextPending used inline, extracted
// so navigation, auto-advance, and the "N of M" progress can never disagree.
//
// Takes ONE session. Almost every caller wants orderedPendingAcross() instead —
// see the note there. This stays exported because the per-session list is still
// the right unit for anything scoped to a single worktree.
export function orderedPendingPaths(mgr: SessionManager): string[] {
  const session = mgr.getSession();
  if (!session) return [];
  const paths = Object.keys(session.files).filter(
    (fp) =>
      session.files[fp].reviewStatus === "pending" &&
      isInWorkspace(fp) &&
      !isExcluded(fp) &&
      mgr.hasRealPendingChange(fp)
  );
  return orderPending(paths);
}

/** The ordered pending list across every session the panel draws from.
 *
 *  Navigation reads this, not a single session's list. `Next Pending File`,
 *  `Previous Pending File` and the auto-advance after a decision all walked the
 *  PRIMARY session only, so on a workspace with nested worktrees they reached a
 *  small fraction of what was pending — measured on a real one, 27 of 224 files,
 *  with the other 197 unreachable by keyboard at all. Worse, accepting the last
 *  primary file reported "all caught up" with 197 files still listed in the
 *  panel in front of the user.
 *
 *  Ordering is a single sort over the union rather than per-session runs, so
 *  stepping crosses worktree boundaries the same way the panel presents them:
 *  one list. A worktree is a place a file lives, not a separate queue.
 *
 *  Each path is paired with the session that owns it, because accepting or
 *  opening it has to target that session — the same reason pendingAcross() in
 *  reviewScopes.ts pairs them. */
export function orderedPendingAcross(
  scopes: SessionManager[]
): Array<{ filePath: string; manager: SessionManager }> {
  const owners = new Map<string, SessionManager>();
  for (const mgr of scopes) {
    for (const fp of orderedPendingPaths(mgr)) {
      // First scope wins. The same path cannot legitimately be pending in two
      // sessions, but a stale session file could claim one, and a stable choice
      // beats whichever happened to be iterated last.
      if (!owners.has(fp)) owners.set(fp, mgr);
    }
  }
  return orderPending([...owners.keys()]).map((filePath) => ({
    filePath,
    manager: owners.get(filePath)!,
  }));
}
