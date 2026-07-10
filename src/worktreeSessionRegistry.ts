import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { nestedWorktreesUnder, worktreeRootForPath } from "./worktrees";

// Guardrail: never attach an unbounded number of worktree sessions. Well past any
// realistic count; excess are logged (never silently dropped) per spec §8.
const MAX_ATTACHED_WORKTREES = 10;

/**
 * Owns one reused SessionManager per git worktree nested under the window's
 * primary root. Each attached manager watches the worktree's own canonical
 * session file, so pending changes are visible here AND in the worktree's own
 * window, and a decision in either targets the same record.
 */
export class WorktreeSessionRegistry {
  private readonly managers = new Map<string, SessionManager>();
  private readonly subs = new Map<string, vscode.Disposable>();
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly primaryRoot: string | undefined
  ) {}

  // Recompute the nested-worktree set and attach/detach managers to match.
  // Cheap (filesystem enumeration only) — call at activation and on a coarse
  // trigger (window focus / manual refresh), never in a hot loop.
  refresh(): void {
    if (!this.primaryRoot) return;
    let roots = nestedWorktreesUnder(this.primaryRoot);
    if (roots.length > MAX_ATTACHED_WORKTREES) {
      this.log.appendLine(
        `[WARN] ${roots.length} nested worktrees found; attaching only ${MAX_ATTACHED_WORKTREES}. ` +
        `Open the others directly to review them.`
      );
      roots = roots.slice(0, MAX_ATTACHED_WORKTREES);
    }
    const wanted = new Set(roots);
    for (const root of [...this.managers.keys()]) {
      if (!wanted.has(root)) this.detach(root);
    }
    for (const root of roots) {
      if (this.managers.has(root)) continue;
      const mgr = new SessionManager(this.log, root);
      this.subs.set(root, mgr.onSessionChange(() => this._onChange.fire()));
      mgr.startWatching(); // loads the session synchronously
      this.managers.set(root, mgr);
      this.log.appendLine(`[INFO] Attached worktree session: ${root}`);
    }
    this._onChange.fire();
  }

  private detach(root: string): void {
    this.subs.get(root)?.dispose();
    this.subs.delete(root);
    this.managers.get(root)?.stopWatching();
    this.managers.delete(root);
    this.log.appendLine(`[INFO] Detached worktree session: ${root}`);
  }

  getManagers(): Map<string, SessionManager> {
    return this.managers;
  }

  // The SessionManager that OWNS filePath (the worktree it falls under), or null.
  managerFor(filePath: string): SessionManager | null {
    const root = worktreeRootForPath(filePath, [...this.managers.keys()]);
    return root ? this.managers.get(root) ?? null : null;
  }

  // Total in-scope pending files across all attached worktrees (for the badge).
  totalPending(): number {
    let n = 0;
    for (const mgr of this.managers.values()) n += mgr.getPendingCount();
    return n;
  }

  dispose(): void {
    for (const root of [...this.managers.keys()]) this.detach(root);
    this._onChange.dispose();
  }
}
