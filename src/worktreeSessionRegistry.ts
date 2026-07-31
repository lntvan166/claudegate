import * as fs from "fs";
import * as vscode from "vscode";
import { SessionManager, sessionFilePathFor } from "./sessionManager";
import { nestedWorktreesUnder, worktreeRootForPath } from "./worktrees";

// Runaway-scan backstop, NOT a resource budget. Attaching a worktree costs one
// fs.watch on the sessions directory that every manager already shares, plus a
// JSON parse of that worktree's OWN file when it changes (the watch callback
// filters on filename). There is no polling loop, no per-worktree crawl, and no
// git subprocess — so the ceiling can sit far above any real layout.
//
// It has to. A `go.work` monorepo checks out one worktree PER MODULE, so a single
// feature workspace is 5-10 on its own and two of them plus agent worktrees clears
// 18. The previous value of 10 was below that baseline, and because roots were
// sliced in alphabetical order it silently hid every worktree late in the alphabet.
const DEFAULT_MAX_ATTACHED_WORKTREES = 256;

/**
 * Order worktree roots for attachment: those that already have a session file on
 * disk (i.e. the hook has captured work there) first, alphabetical within each
 * tier. Only matters if the cap is ever hit — it guarantees the slots that get
 * dropped are idle worktrees rather than ones holding unreviewed changes.
 *
 * The probe is deliberately existence-only: parsing every session file on each
 * refresh would cost far more than the attach it is protecting.
 */
export function orderRootsForAttach(
  roots: string[],
  hasSession: (root: string) => boolean
): string[] {
  const active: string[] = [];
  const idle: string[] = [];
  // Sort first so BOTH tiers are stable: slicing an unsorted list could drop a
  // still-present worktree (and attach a different one) between refreshes.
  for (const root of [...roots].sort()) {
    (hasSession(root) ? active : idle).push(root);
  }
  return [...active, ...idle];
}

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
    const max = this.maxAttached();
    // Worktrees with captured work first, so a cap hit can only ever drop idle ones.
    let roots = orderRootsForAttach(
      nestedWorktreesUnder(this.primaryRoot),
      (root) => {
        try { return fs.existsSync(sessionFilePathFor(root)); } catch { return false; }
      }
    );
    if (roots.length > max) {
      const dropped = roots.slice(max);
      this.log.appendLine(
        `[WARN] ${roots.length} nested worktrees found; attaching only ${max}. ` +
        `Raise claudegate.worktrees.maxAttached, or open the others directly to review them.`
      );
      for (const root of dropped) this.log.appendLine(`[WARN]   not attached: ${root}`);
      roots = roots.slice(0, max);
    }
    const wanted = new Set(roots);
    let changed = false;
    for (const root of [...this.managers.keys()]) {
      if (!wanted.has(root)) { this.detach(root); changed = true; }
    }
    for (const root of roots) {
      if (this.managers.has(root)) continue;
      const mgr = new SessionManager(this.log, root);
      this.subs.set(root, mgr.onSessionChange(() => this._onChange.fire()));
      mgr.startWatching(); // loads the session synchronously
      this.managers.set(root, mgr);
      this.log.appendLine(`[INFO] Attached worktree session: ${root}`);
      changed = true;
    }
    if (changed) this._onChange.fire();
  }

  // Read the ceiling fresh each refresh so changing the setting takes effect on the
  // next focus/refresh without a reload. Non-positive or non-numeric → the default.
  private maxAttached(): number {
    const configured = vscode.workspace
      .getConfiguration("claudegate")
      .get<number>("worktrees.maxAttached", DEFAULT_MAX_ATTACHED_WORKTREES);
    return Number.isFinite(configured) && (configured as number) > 0
      ? Math.floor(configured as number)
      : DEFAULT_MAX_ATTACHED_WORKTREES;
  }

  private detach(root: string): void {
    this.subs.get(root)?.dispose();
    this.subs.delete(root);
    this.managers.get(root)?.stopWatching();
    this.managers.delete(root);
    this.log.appendLine(`[INFO] Detached worktree session: ${root}`);
  }

  // Copy so a caller can't mutate our internal map (which would desync the
  // subscription set and leak a watcher/timer that detach() never stops).
  getManagers(): Map<string, SessionManager> {
    return new Map(this.managers);
  }

  // The SessionManager that OWNS filePath (the worktree it falls under), or null.
  managerFor(filePath: string): SessionManager | null {
    const root = worktreeRootForPath(filePath, [...this.managers.keys()]);
    return root ? this.managers.get(root) ?? null : null;
  }

  // Force a no-op/temp-file reconcile on every attached worktree session — used on
  // window focus so a settled "phantom" no-op in any worktree session is pruned
  // even when nothing wrote its session file to trigger the usual grace reconcile.
  reconcileAll(): void {
    for (const mgr of this.managers.values()) mgr.reconcileNow();
  }

  // Total in-scope pending files across all attached worktrees (for the badge).
  totalPending(): number {
    let n = 0;
    for (const mgr of this.managers.values()) n += mgr.getPendingCount();
    return n;
  }

  // Same, for the decision logs. The Accepted/Rejected views are gated on
  // `claudegate.acceptedCount`/`rejectedCount`; without these, accepting a file
  // that lives in a worktree left both counts at 0, so the view stayed hidden and
  // the record appeared to vanish.
  totalAccepted(): number {
    let n = 0;
    for (const mgr of this.managers.values()) n += mgr.getAcceptedCount();
    return n;
  }

  totalRejected(): number {
    let n = 0;
    for (const mgr of this.managers.values()) n += mgr.getRejectedCount();
    return n;
  }

  dispose(): void {
    for (const root of [...this.managers.keys()]) this.detach(root);
    this._onChange.dispose();
  }
}
