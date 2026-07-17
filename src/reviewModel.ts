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
  reason?: string;       // optional revert reason, fed into the "Feedback to AI" log (reject only)
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

// Look up a pending entry by path, tolerating drive-letter/case differences on
// case-insensitive filesystems (Windows). `vscode.Uri.file(p).fsPath` lowercases
// the drive letter, so a URI-derived path (e.g. `c:\Foo`) can miss an exact
// object-key match against the hook-stored key (`C:\Foo`) even though they name
// the same file — leaving the diff's original pane blank. Exact match first
// (fast, always correct), then a case-folded scan on win32 only.
export function fileEntryFor(
  files: Record<string, FileEntry>,
  filePath: string,
  caseInsensitive: boolean = process.platform === "win32"
): FileEntry | undefined {
  const exact = files[filePath];
  if (exact) return exact;
  if (!caseInsensitive) return undefined;
  const target = filePath.toLowerCase();
  for (const key in files) if (key.toLowerCase() === target) return files[key];
  return undefined;
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

// The count cap alone doesn't bound the file SIZE: a few accepts of large files
// can push the session file past the size warning long before 500 records. When
// that happens, drop the OLDEST accepted records until the serialized log fits
// `maxBytes`, keeping the recent history a user actually acts on. Returns the
// number dropped. O(n) — only run when the file is actually oversized (rare), not
// on every load.
export function capAcceptedBytes(session: Session, maxBytes: number): number {
  const recs = session.accepted;
  if (recs.length <= 1) return 0; // never trim below the newest single record
  let total = 0;
  let keepFrom = 0; // keep recs[keepFrom..]
  for (let i = recs.length - 1; i >= 0; i--) {
    total += Buffer.byteLength(JSON.stringify(recs[i]));
    if (total > maxBytes) { keepFrom = i + 1; break; }
  }
  // Always keep at least the newest record: a single record larger than the
  // whole budget must not empty the log (that would wipe all history over one
  // big-file accept).
  if (keepFrom > recs.length - 1) keepFrom = recs.length - 1;
  if (keepFrom === 0) return 0;
  session.accepted = recs.slice(keepFrom);
  return keepFrom;
}

// A pending entry is a real change unless its baseline already equals the
// current disk content (no-op / failed edit). diskContent === null means the
// file is absent on disk.
export function hasRealChange(originalContent: string | null, diskContent: string | null): boolean {
  if (originalContent === null) return diskContent !== null; // new file: real iff it exists
  return originalContent !== diskContent;
}

// The PreToolUse hook records an entry BEFORE Claude's write lands, and that
// write can land SECONDS after the hook fires — measured up to ~6s in the field
// under a busy PreToolUse hook chain or a slow editor save. So a freshly captured
// entry is momentarily a no-op (existing file: baseline === disk; new file: still
// absent on disk) until the write catches up. Pruning it at the old ~1.5s grace
// destroyed legitimate pending entries before their content ever landed — the
// reported ".claude/*.commits.yaml / SKILL.md flash-then-vanish" bug. The settle
// windows below must comfortably exceed real write lag. They gate only session
// housekeeping (the panel already hides no-ops via hasRealPendingChange), so being
// generous costs nothing but a slightly later cleanup of genuine no-ops/temp files.
export const NOOP_SETTLE_MS = 15_000;      // existing-file no-op: prune only after this long
export const NEW_FILE_ABSENT_MS = 45_000;  // new file is a PROMISED write — allow this long to land

// Decide whether the reconcile should prune a pending entry as a settled no-op.
// PER-ENTRY age-based (not a shared timer) so a real edit whose write lands late
// is never pruned before it appears. A real change is always kept; an entry with
// no `capturedAt` (e.g. the file-watcher path, created post-write) is treated as
// already settled.
export function shouldPruneNoOp(
  entry: FileEntry,
  diskContent: string | null,
  nowMs: number
): boolean {
  if (hasRealChange(entry.originalContent, diskContent)) return false; // real → keep
  // No-op: existing file unchanged, or new file not yet on disk. Either way the
  // tool's write may still be in flight — only prune once the entry out-ages the
  // window for its kind. A new file (originalContent === null) is a promised
  // creation, so it gets the longer window.
  const settleMs = entry.originalContent === null ? NEW_FILE_ABSENT_MS : NOOP_SETTLE_MS;
  const captured = entry.capturedAt ? Date.parse(entry.capturedAt) : NaN;
  const age = Number.isNaN(captured) ? Infinity : nowMs - captured;
  return age > settleMs; // out-aged its window → prune; still within → keep (write may land)
}

// Merge hook-captured pending entries that landed on disk since we loaded, so a
// concurrent hook write is not lost when the extension persists.
//
// This also unions accepted[]/rejected{} from disk. There is NOT a single
// extension writer of the decision log: the v1.6.0 nested-worktree feature runs
// a SessionManager for each attached worktree root, and the worktree's own VS
// Code window runs its own SessionManager for the same root — both hash to the
// same session file and both persist user decisions. Treating mine's
// accepted[]/rejected{} as authoritative (write-back verbatim) therefore lets
// the last writer silently clobber the other window's accept/reject records
// (irreversible loss of the review log). We reconcile them: accepted[] is unioned
// by record id (append-only, so union-by-id + re-cap is safe), and rejected{} is
// merged latest-decision-per-path. A files{} entry we still show as pending but
// which the other window has since decided (a disk decision strictly newer than
// our capture) is dropped, so a file can't appear in both Pending and the log.
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
// Records/paths the caller deliberately removed from `mine` in this same persist
// cycle. The on-disk copy the merge re-reads still contains them, so without these
// tombstones the union below would resurrect the just-removed entry, undo the
// clear/revert/reapply, and (because the caller then persists) can spin an endless
// rewrite loop. Each set suppresses only the exact removed record; a genuinely
// fresh record from another window is never in these sets and still merges.
export interface MergeGuards {
  prunedFiles?: Map<string, string | undefined>; // path → capturedAt of a just-pruned pending entry
  droppedAcceptedIds?: Set<string>;              // accepted record ids removed this cycle
  droppedRejectedPaths?: Set<string>;            // rejected paths removed this cycle
}

export function mergeFreshCaptures(
  mine: Session,
  disk: Session,
  guards?: MergeGuards,
): Session {
  const prunedThisCycle = guards?.prunedFiles;
  // Union the decision log first, so the files{} reconcile below sees the other
  // window's decisions too. accepted[] is append-only → union by id, then re-cap.
  const seenAccepted = new Set(mine.accepted.map((r) => r.id));
  let unionedAccept = false;
  for (const rec of disk.accepted) {
    if (seenAccepted.has(rec.id)) continue;
    if (guards?.droppedAcceptedIds?.has(rec.id)) continue; // we just removed it this cycle
    mine.accepted.push(rec);
    seenAccepted.add(rec.id);
    unionedAccept = true;
  }
  if (unionedAccept) {
    // Keep a deterministic oldest-first order so capAcceptedLog drops the oldest.
    mine.accepted.sort((a, b) => {
      const da = Date.parse(a.decidedAt), db = Date.parse(b.decidedAt);
      if (Number.isNaN(da) || Number.isNaN(db) || da === db) return 0;
      return da - db;
    });
    capAcceptedLog(mine);
  }
  // rejected{} is latest-per-path → take disk's record when it is newer (or when
  // we hold none for that path).
  for (const [path, rec] of Object.entries(disk.rejected)) {
    if (guards?.droppedRejectedPaths?.has(path)) continue; // we just cleared/reapplied it this cycle
    const ours = mine.rejected[path];
    if (!ours) { mine.rejected[path] = rec; continue; }
    const dOurs = Date.parse(ours.decidedAt), dDisk = Date.parse(rec.decidedAt);
    if (!Number.isNaN(dDisk) && (Number.isNaN(dOurs) || dDisk > dOurs)) mine.rejected[path] = rec;
  }

  for (const [path, entry] of Object.entries(disk.files)) {
    if (mine.files[path]) continue;          // we already know this path
    if (!entry.capturedAt) continue;         // no timestamp → cannot prove it's a real capture
    if (prunedThisCycle && prunedThisCycle.get(path) === entry.capturedAt) continue; // just pruned this exact entry
    const captured = Date.parse(entry.capturedAt);
    if (Number.isNaN(captured)) continue;    // unparseable → cannot reason; leave it

    // Latest decision (accept or reject) we hold for this path, if any.
    const decidedAtMs = latestDecisionMs(mine, path);

    // Merge unless a decision STRICTLY newer than this capture supersedes it.
    // On an exact tie (captured === decidedAt) we keep: a genuinely-decided
    // file's stale on-disk copy always predates its decision (capture happens
    // before the decision, and the decision's persist removes it from files{}),
    // so an equal timestamp can only be a fresh concurrent re-capture — dropping
    // it would be data loss.
    if (captured >= decidedAtMs) mine.files[path] = entry;
  }

  // Drop any pending entry the other window has since decided: a decision record
  // strictly newer than our capture supersedes it (symmetric to the add rule
  // above, which keeps the capture on a tie). Prevents a file appearing in both
  // Pending and the accepted/rejected log after a concurrent decision.
  for (const [path, entry] of Object.entries(mine.files)) {
    const captured = entry.capturedAt ? Date.parse(entry.capturedAt) : NaN;
    if (Number.isNaN(captured)) continue; // no capture time → can't compare; leave it
    if (latestDecisionMs(mine, path) > captured) delete mine.files[path];
  }
  return mine;
}

// The most-recent decision (accept or reject) timestamp we hold for a path, in ms,
// or -Infinity when there is none.
function latestDecisionMs(session: Session, path: string): number {
  let ms = -Infinity;
  for (const rec of session.accepted) {
    if (rec.path !== path) continue;
    const d = Date.parse(rec.decidedAt);
    if (!Number.isNaN(d) && d > ms) ms = d;
  }
  const rejected = session.rejected[path];
  if (rejected) {
    const d = Date.parse(rejected.decidedAt);
    if (!Number.isNaN(d) && d > ms) ms = d;
  }
  return ms;
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
  // The latest decision for this path is now "accepted"; drop any prior reject so
  // the file can't sit in both the Accepted log and the Rejected panel at once.
  delete session.rejected[path];
}

export function rejectEntry(session: Session, path: string, after: string | null, decidedAt: string, reason?: string): void {
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
    ...(reason ? { reason } : {}),
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
