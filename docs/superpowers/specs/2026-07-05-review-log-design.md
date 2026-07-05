# Persistent Review Log (Accepted history + real-diff Pending)

**Date:** 2026-07-05
**Status:** Draft for approval
**Related:** `src/sessionManager.ts`, `src/diffProvider.ts`, `src/diffPlan.ts`, `src/reviewPanel.ts`, `src/decorationProvider.ts`, `hooks/hook.py`, `CLAUDE.md`; supersedes the interim `claudeContent`-on-`files` diff approach (commit `7454436`).

## Problem

When Claude re-edits a file you already accepted, the PreToolUse hook flips that file's single review entry back to *pending* and re-snapshots its baseline **before the edit runs**. Consequences:

1. **Accepted record vanishes** — the accepted change leaves the Accepted panel; if the follow-up edit is a no-op or a failed `Edit`, the file is stranded as an **empty Pending row** and the accepted decision is destroyed.
2. **No history** — even on a successful re-edit, the work you accepted (A→B) is no longer visible anywhere; Pending only shows the new delta.

Root cause (confirmed by reproduction): the model stores **one review status per file**, and the eager PreToolUse mutation overwrites it.

## Goal

Each panel means exactly what it says, and decisions persist:

- **Pending** — files with a *real* unreviewed change (`baseline → current disk`). Behaves exactly as today.
- **Accepted** — an append-only **log** of every change you approved; each row diffs its own `before → after`. Persists through subsequent edits.
- **Rejected** — the **latest** discarded change *per file* (a new reject replaces the file's prior rejected row); each row diffs `before → discarded version`.

A file can simultaneously have accepted history **and** a live pending change.

## Product Decisions

- **Accepted = full log** (row per accept); **Rejected = latest per file** (accept advances the baseline so its log tells a story; reject reverts, so repeated rejects would pile up redundant rows).
- **Pending shows only real diffs** — an entry whose baseline equals the current disk content (no-op / failed edit) is never shown or counted. This is the root-cause fix for empty Pending rows.
- **The log resets when the session is cleared** (Clear Session), or per-panel via Clear All Accepted / Clear All Rejected.
- **Folds into unreleased `1.3.0`.**

## Data Model

```ts
interface Session {
  sessionId: string;
  status: "active" | "reviewed";
  files: { [absPath: string]: FileEntry };   // PENDING changes only
  accepted: ReviewRecord[];                   // NEW: append-only accept log
  rejected: { [absPath: string]: ReviewRecord }; // NEW: latest reject per file
}

interface FileEntry {                 // a live pending change
  originalContent: string | null;     // frozen "before" baseline (null = Claude created the file)
  reviewStatus: "pending";            // always "pending" now (kept for hook/back-compat)
  sessionId?: string;
  capturedAt?: string;
}

interface ReviewRecord {              // a decision (accepted or rejected)
  id: string;                         // `${decidedAt}::${path}` — stable, used in diff URIs
  path: string;
  before: string | null;             // baseline you reviewed
  after: string | null;              // accepted content, or the discarded Claude version
  decidedAt: string;                 // ISO timestamp
  sessionId?: string;
}
```

`claudeContent` is removed from `FileEntry` — the "after" side now lives in `ReviewRecord.after`. `diffPlan.chooseRightSide` (from the interim fix) is replaced by explicit pending-vs-record rendering in `openDiff`.

## Components

### `hooks/hook.py` (simplified)

Replace the three-way entry handling with: **ensure a pending entry exists, otherwise leave a pending baseline frozen.**

```python
existing = session["files"].get(file_path)
if existing is None or existing.get("reviewStatus") != "pending":
    session["files"][file_path] = {
        "originalContent": original_content,   # pre-edit disk content
        "reviewStatus": "pending",
        "sessionId": session_id,
        "capturedAt": captured_at,
    }
    if session.get("status") == "reviewed":
        session["status"] = "active"
    save_session(session, session_file)
# else: an existing pending entry keeps its frozen baseline (no-op)
```

The old accepted/rejected → pending flip is gone (those no longer live in `files`). Treating a non-pending existing entry as absent makes the hook forward-safe against any pre-migration entry. The hook never touches `accepted`/`rejected` — only the extension writes the log. **Requires re-running Setup Hook (auto-synced on activate).**

### `src/sessionManager.ts`

- **Load + migrate** (`loadSession`): if a `files` entry has `reviewStatus` `"accepted"`/`"rejected"`, convert it to a record (`before = originalContent`, `after = claudeContent ?? originalContent`) appended to `accepted[]` / set in `rejected{}`, and delete it from `files`. Initialize missing `accepted`/`rejected` to `[]`/`{}`. Best-effort (sessions are transient).
- **`hasRealChange(entry, diskContent)`** helper: `false` when `originalContent !== null && originalContent === diskContent`; `false` when `originalContent === null && file absent`; else `true`. Used to hide no-op pending entries.
- **`acceptFile(path)`**: `after = readFileOrNull(path)`; push `{id, path, before: entry.originalContent, after, decidedAt, sessionId}` to `accepted[]`; `delete files[path]`; persist.
- **`rejectFile(path)`**: `after = readFileOrNull(path)` (Claude's version); restore disk (`unlink` if `before === null`, else write `before`); set `rejected[path] = {id, path, before: entry.originalContent, after, decidedAt, sessionId}` (replaces any prior); `delete files[path]`; persist.
- **`acceptFolder`/`acceptAll`/`rejectFolder`/`rejectAll`**: loop the single-file logic over matching pending files.
- **Undo:**
  - `revertAccepted(id)`: find the accepted record; remove it. If it is the file's current on-disk state (`readFileOrNull(path) === record.after`) and no pending entry exists, recreate `files[path] = {originalContent: record.before, reviewStatus:"pending"}` (so it returns to Pending as `before → disk`). Otherwise remove-only (superseded row). persist.
  - `reapplyRejected(path)`: record = `rejected[path]`; if `after == null` warn and stop (nothing saved); else write `after` to disk, recreate `files[path] = {originalContent: record.before, reviewStatus:"pending"}`, `delete rejected[path]`; persist.
  - `revertAcceptedAll` / bulk variants: remove all accepted records (optionally recreate pending for current-state rows).
- **Clear:** `clearSession` → `files={}, accepted=[], rejected={}`. `clearAccepted` → `accepted=[]`. `clearRejected` → `rejected={}`.
- **Counts:** `getPendingCount` counts `files` entries that pass `hasRealChange` and workspace/exclude filters. Accepted count = `accepted.length`; rejected count = `Object.keys(rejected).length` (post workspace/exclude filter).
- **`status`**: `"reviewed"` when no real-diff pending entries remain, else `"active"`.

### `src/diffProvider.ts`

- **Pending** (`files` entry): unchanged — `originalUri(path)` (before) ↔ file-on-disk (right), with change-count suffix and scroll-to-first-change.
- **Records**: new virtual URIs carry a record id — `recordUri(id, "before")` and `recordUri(id, "after")` under the `claudegate:` scheme (`?rec=<id>&side=before|after`). The content provider resolves the id across `accepted[]` and `rejected{}` and returns `before`/`after`. `openDiffRecord(id)` opens `before ↔ after` titled `Claude Gate: <name> (accepted|rejected · <count>)`.
- The content provider fires `onDidChange` for affected URIs on session change.

### `src/reviewPanel.ts`

- **Pending tree**: `files` entries passing `hasRealChange` (+ workspace/exclude), rows call `claudegate.openDiff(path)`. (As today.)
- **Accepted tree**: rows from `accepted[]` (newest first), each labeled by file with a `+A -R` suffix; row command `claudegate.openReviewRecord(id)`. Multiple rows per file are allowed; in tree mode they group under the file directory as today.
- **Rejected tree**: rows from `Object.values(rejected)`, one per file; same record-open command.
- Context values drive the right-click menus: accepted rows → Revert to Pending (`claudegate.revertAccepted` now takes an id); rejected rows → Re-apply (`claudegate.reapplyFile` takes a path).

### `src/decorationProvider.ts`

Explorer `!` badge stays **pending-only** (files passing `hasRealChange`). Accepted/rejected are not badged. Unchanged in spirit; just reads the pending set.

### `CLAUDE.md`

Update the "Session State Schema" and "Hook Input" sections to the model above (files = pending; `accepted[]` log; `rejected{}` latest-per-file; hook simplified).

## Data Flow (the target scenario)

1. Claude edits `auth.ts` → hook adds `files["auth.ts"] = {original: A, pending}`; disk = B. **Pending: A→B.**
2. Accept → push `accepted[{before:A, after:B}]`; delete `files["auth.ts"]`. **Accepted: A→B. Pending: empty.**
3. Claude edits again → hook adds `files["auth.ts"] = {original: B, pending}`; disk = C. **Pending: B→C. Accepted still shows A→B.** ✅
4. Accept → push `accepted[{before:B, after:C}]`. **Accepted: A→B and B→C.**
5. No-op / failed edit anywhere → a pending entry with `original === disk` is created but **filtered out** by `hasRealChange`; no phantom row, no lost history.

## Error Handling

- `readFileOrNull` failure on accept/reject → record `after = null`; reject still restores baseline; re-apply of a `null`-after record warns and no-ops.
- Migration of a pre-`7454436` accepted entry (baseline was overwritten, no `claudeContent`) yields `before === after` → a zero-diff accepted row; acceptable for transient legacy data.
- Dual-writer (hook vs extension): unchanged risk profile; both use atomic-rename writes. The hook only writes `files`; the extension owns `accepted`/`rejected`.
- Missing `accepted`/`rejected` keys in an older on-disk session → initialized on load.

## Testing

**Automated (`test:unit`, pure/vscode-free):**
1. `hasRealChange`: equal baseline/disk → false; differing → true; new file present → true; new file absent → false.
2. Accept appends a record with correct `before`/`after` and removes the pending entry (pure session-reducer test on a plain object).
3. Two accepts on one file → two accepted records in order (log).
4. Reject sets `rejected[path]`; a second reject on the same path **replaces** it (latest-per-file).
5. Migration: a `files` entry with `reviewStatus:"accepted"` + `claudeContent` → moved to `accepted[]` as `before→after`, removed from `files`.

To keep these vscode-free, factor the reducers (accept/reject/migrate/hasRealChange) into a pure module (e.g. `src/reviewModel.ts`) that `sessionManager` calls; unit-test that module.

**Manual (Extension Development Host, via `manual-test-seed.py`):**
6. Accept `auth.ts` → Accepted shows A→B; re-edit via Claude → Pending shows B→C while Accepted still shows A→B.
7. Failed/no-op edit → no empty Pending row appears; accepted history intact.
8. Reject `.env`, reject again after a new edit → Rejected shows only the latest.
9. Revert to Pending / Re-apply move a row back into Pending correctly.
10. Clear All Accepted / Rejected / Clear Session reset the respective stores.

## Release

- **No version bump** — folds into unreleased `1.3.0`; add a CHANGELOG **Fixed/Changed** entry describing persistent Accepted history, latest-per-file Rejected, and real-diff-only Pending. Update README panel descriptions.
