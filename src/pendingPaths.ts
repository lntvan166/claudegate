import { isInWorkspace, isExcluded } from "./workspaceScope";
import { SessionManager } from "./sessionManager";
import { orderPending } from "./reviewNav";

// Canonical ordered list of pending files for the stepper and the diff-title
// progress count. Same filter + ordering openNextPending used inline, extracted
// so navigation, auto-advance, and the "N of M" progress can never disagree.
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
