// Pure, vscode-free state transitions for the review log. sessionManager adds
// the disk I/O and calls these to mutate its in-memory Session.

export interface FileEntry {
  originalContent: string | null; // frozen "before" baseline (null = Claude created the file)
  reviewStatus: "pending";        // files{} holds only pending changes now
  newFile?: boolean;   // true ⇒ confident the file did not exist ⇒ reject may delete it
  sessionId?: string;
  capturedAt?: string;
}

export interface ReviewRecord {
  id: string;
  path: string;
  before: string | null; // baseline reviewed
  after: string | null;  // accepted content, or the discarded Claude version
  decidedAt: string;     // ISO timestamp
  sessionId?: string;
  newFile?: boolean;     // preserved so a reopened (revert/reapply) new-file entry
                         // still deletes-on-reject instead of being left on disk
}

export interface Session {
  sessionId: string;
  status: "active" | "reviewed";
  files: Record<string, FileEntry>;
  accepted: ReviewRecord[];
  rejected: Record<string, ReviewRecord>;
}

export function makeRecordId(decidedAt: string, path: string): string {
  return `${decidedAt}::${path}`;
}

// Upper bound on the append-only accepted[] log. Past this, the OLDEST records
// are dropped first (they lose their "Revert Accepted" undo, but the recent
// history a user actually acts on is always kept). The cap keeps the per-workspace
// session file — re-read on every fs.watch event — from growing without limit.
// Generous on purpose: normal review sessions never approach it.
export const MAX_ACCEPTED_RECORDS = 500;

// Trim accepted[] in place to the most recent MAX_ACCEPTED_RECORDS. Returns true
// if anything was dropped (so callers can flag the session as needing a rewrite).
export function capAcceptedLog(session: Session): boolean {
  const excess = session.accepted.length - MAX_ACCEPTED_RECORDS;
  if (excess <= 0) return false;
  session.accepted.splice(0, excess); // drop oldest-first
  return true;
}

// A pending entry is a real change unless its baseline already equals the
// current disk content (no-op / failed edit). diskContent === null means the
// file is absent on disk.
export function hasRealChange(originalContent: string | null, diskContent: string | null): boolean {
  if (originalContent === null) return diskContent !== null; // new file: real iff it exists
  return originalContent !== diskContent;
}

// Decide whether the reconcile should prune a pending entry as a settled no-op.
//
// The hook records an entry BEFORE Claude writes, so a brand-new entry is
// momentarily a no-op (baseline === disk). Pruning must be PER-ENTRY age-based,
// not on a shared timer: only drop a no-op once it has outlived its own grace
// window, so a real edit whose write lands slightly late (e.g. in a multi-file
// burst) is never pruned before it appears. A real change is always kept; an
// entry with no `capturedAt` (e.g. the file-watcher path, created post-write) is
// treated as already settled.
export function shouldPruneNoOp(
  entry: FileEntry,
  diskContent: string | null,
  nowMs: number,
  graceMs: number
): boolean {
  if (hasRealChange(entry.originalContent, diskContent)) return false; // real → keep
  const captured = entry.capturedAt ? Date.parse(entry.capturedAt) : NaN;
  const age = Number.isNaN(captured) ? Infinity : nowMs - captured;
  return age > graceMs; // settled no-op → prune; still-young no-op → keep (write may land)
}

// Merge hook-captured pending entries that landed on disk since we loaded, so a
// concurrent hook write is not lost when the extension persists. Only files{}
// is reconciled (the hook's sole territory); mine's accepted[]/rejected{} are
// authoritative.
//
// A disk pending entry absent from mine.files is either (a) a hook capture we
// never consumed, or (b) an entry the user already accepted/rejected (so we
// dropped it from files, but the hook's pre-write copy still lingers on disk
// until our persist overwrites it). We used to tell these apart with a
// wall-clock guard (capturedAt > lastLoaded), but that silently dropped genuine
// unseen captures whenever an unrelated load raced ahead of the capture's
// timestamp — the "vanished pending file" race. The authoritative signal for
// "already handled" is a DECISION RECORD, not a clock: skip a disk entry only
// when we hold an accept/reject for that path at least as new as the capture.
// Otherwise merge it (a later reconcile re-prunes a no-op, and the next
// loadSession drops an out-of-workspace re-add, so erring toward keeping never
// loses data).
// `prunedThisCycle` (path → capturedAt) lists entries the caller deliberately
// removed from `mine` in this same persist cycle (e.g. a settled no-op reconcile
// prune). The on-disk copy we re-read below still contains them, so without this
// guard the merge would resurrect the just-removed entry, undo the prune, and —
// because the prune caller then persists again — spin an endless rewrite loop
// (persist ≈ every RECONCILE_GRACE_MS, reloading the UI nonstop). We suppress
// only the EXACT stale entry (matched by capturedAt); a genuinely fresh
// re-capture carries a newer capturedAt and still merges, so no hook write is lost.
export function mergeFreshCaptures(
  mine: Session,
  disk: Session,
  prunedThisCycle?: Map<string, string | undefined>,
): Session {
  for (const [path, entry] of Object.entries(disk.files)) {
    if (mine.files[path]) continue;          // we already know this path
    if (!entry.capturedAt) continue;         // no timestamp → cannot prove it's a real capture
    if (prunedThisCycle && prunedThisCycle.get(path) === entry.capturedAt) continue; // just pruned this exact entry
    const captured = Date.parse(entry.capturedAt);
    if (Number.isNaN(captured)) continue;    // unparseable → cannot reason; leave it

    // Latest decision (accept or reject) we hold for this path, if any.
    let decidedAtMs = -Infinity;
    for (const rec of mine.accepted) {
      if (rec.path !== path) continue;
      const d = Date.parse(rec.decidedAt);
      if (!Number.isNaN(d) && d > decidedAtMs) decidedAtMs = d;
    }
    const rejected = mine.rejected[path];
    if (rejected) {
      const d = Date.parse(rejected.decidedAt);
      if (!Number.isNaN(d) && d > decidedAtMs) decidedAtMs = d;
    }

    // Merge unless a decision STRICTLY newer than this capture supersedes it.
    // On an exact tie (captured === decidedAt) we keep: a genuinely-decided
    // file's stale on-disk copy always predates its decision (capture happens
    // before the decision, and the decision's persist removes it from files{}),
    // so an equal timestamp can only be a fresh concurrent re-capture — dropping
    // it would be data loss.
    if (captured >= decidedAtMs) mine.files[path] = entry;
  }
  return mine;
}

export function acceptEntry(session: Session, path: string, after: string | null, decidedAt: string): void {
  const entry = session.files[path];
  if (!entry) return;
  session.accepted.push({
    id: makeRecordId(decidedAt, path),
    path,
    before: entry.originalContent,
    after,
    decidedAt,
    sessionId: entry.sessionId,
    newFile: entry.newFile,
  });
  capAcceptedLog(session); // bound the log; drops oldest if over the cap
  delete session.files[path];
}

export function rejectEntry(session: Session, path: string, after: string | null, decidedAt: string): void {
  const entry = session.files[path];
  if (!entry) return;
  session.rejected[path] = {
    id: makeRecordId(decidedAt, path),
    path,
    before: entry.originalContent,
    after,
    decidedAt,
    sessionId: entry.sessionId,
    newFile: entry.newFile,
  };
  delete session.files[path];
}

// Convert a raw on-disk session (possibly legacy: accepted/rejected in files{})
// into the current shape. Best-effort — sessions are transient.
//
// Returns { session, changed }. `changed` is true when the migration actually
// transformed something (defaulted a missing/invalid top-level field, moved a
// legacy accepted/rejected entry out of files{}, or trimmed an over-cap log),
// i.e. when the on-disk form is stale and worth rewriting. Callers use it to
// re-persist ONLY when needed — replacing the old approach of stringifying the
// whole session twice and diffing, which ran on every fs.watch reload and, for
// large sessions, dominated reload cost (and re-persisted on cosmetic key-order
// differences, spuriously churning the file and reloading the UI).
export function migrateSession(raw: any): { session: Session; changed: boolean } {
  let changed = false;
  const hasSessionId  = typeof raw?.sessionId === "string";
  const validStatus   = raw?.status === "reviewed" || raw?.status === "active";
  const validAccepted = Array.isArray(raw?.accepted);
  const validRejected = raw?.rejected != null && typeof raw.rejected === "object";
  // Any missing/invalid top-level field means the raw form differs from what we
  // will write back → flag it so the normalized shape gets persisted.
  if (!hasSessionId || !validStatus || !validAccepted || !validRejected) changed = true;

  const session: Session = {
    sessionId: hasSessionId ? raw.sessionId : new Date().toISOString(),
    status: raw?.status === "reviewed" ? "reviewed" : "active",
    files: {},
    accepted: validAccepted ? raw.accepted : [],
    rejected: validRejected ? raw.rejected : {},
  };
  const files = raw?.files ?? {};
  for (const [path, e] of Object.entries<any>(files)) {
    const status = e?.reviewStatus;
    if (status === "accepted") {
      changed = true; // legacy shape → moved out of files{}
      const decidedAt = e.capturedAt ?? session.sessionId;
      session.accepted.push({
        id: makeRecordId(decidedAt, path), path,
        before: e.originalContent ?? null,
        after: e.claudeContent ?? e.originalContent ?? null,
        decidedAt, sessionId: e.sessionId,
      });
    } else if (status === "rejected") {
      changed = true; // legacy shape → moved out of files{}
      const decidedAt = e.capturedAt ?? session.sessionId;
      session.rejected[path] = {
        id: makeRecordId(decidedAt, path), path,
        before: e.originalContent ?? null,
        after: e.claudeContent ?? e.originalContent ?? null,
        decidedAt, sessionId: e.sessionId,
      };
    } else {
      // pending (or unknown → treat as pending)
      session.files[path] = {
        originalContent: e?.originalContent ?? null,
        reviewStatus: "pending",
        newFile: e?.newFile,
        sessionId: e?.sessionId,
        capturedAt: e?.capturedAt,
      };
    }
  }
  // Heal a pre-cap session that already grew past the bound (drops oldest-first).
  if (capAcceptedLog(session)) changed = true;
  return { session, changed };
}
