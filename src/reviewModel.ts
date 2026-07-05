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
// is reconciled (the hook's sole territory); mine's accepted[]/rejected{} and
// file removals are authoritative. "Fresh" = absent from mine.files AND
// capturedAt newer than our last load. O(disk.files) — never walks accepted[].
export function mergeFreshCaptures(mine: Session, disk: Session, lastLoadedAtMs: number): Session {
  for (const [path, entry] of Object.entries(disk.files)) {
    if (mine.files[path]) continue;          // we already know this path
    if (!entry.capturedAt) continue;         // no timestamp → cannot prove fresh
    if (Date.parse(entry.capturedAt) > lastLoadedAtMs) {
      mine.files[path] = entry;              // a hook capture we missed → merge in
    }
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
  });
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
  };
  delete session.files[path];
}

// Convert a raw on-disk session (possibly legacy: accepted/rejected in files{})
// into the current shape. Best-effort — sessions are transient.
export function migrateSession(raw: any): Session {
  const session: Session = {
    sessionId: raw?.sessionId ?? new Date().toISOString(),
    status: raw?.status === "reviewed" ? "reviewed" : "active",
    files: {},
    accepted: Array.isArray(raw?.accepted) ? raw.accepted : [],
    rejected: raw?.rejected && typeof raw.rejected === "object" ? raw.rejected : {},
  };
  const files = raw?.files ?? {};
  for (const [path, e] of Object.entries<any>(files)) {
    const status = e?.reviewStatus;
    if (status === "accepted") {
      const decidedAt = e.capturedAt ?? session.sessionId;
      session.accepted.push({
        id: makeRecordId(decidedAt, path), path,
        before: e.originalContent ?? null,
        after: e.claudeContent ?? e.originalContent ?? null,
        decidedAt, sessionId: e.sessionId,
      });
    } else if (status === "rejected") {
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
  return session;
}
