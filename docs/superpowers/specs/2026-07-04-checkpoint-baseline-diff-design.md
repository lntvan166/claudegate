# Checkpoint Baseline & Diff Robustness — ClaudeGate

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Related:** `src/sessionManager.ts`, `hooks/hook.py`, `src/documentTracker.ts`, `src/diffProvider.ts`

## Problem

Two review-diff annoyances, reported together:

1. **Diff sometimes loses the original.** After Claude edits a file twice (step0 → step1 → step2), the review diff sometimes shows only step1 ↔ step2 instead of step0 ↔ step2 — even for a file the user never accepted or rejected. The user wants the diff to always start from the original, and wants **approving** a file to make its current content the new baseline ("mark current as step0").
2. **`git pull` creates phantom reviews.** Pulling teammate changes surfaces files in the Pending panel as if Claude wrote them. A prior mitigation ignores bulk changes of ≥8 files, but small pulls (under the threshold) still leak through.

## Root Cause

**Baseline (#1).** `FileEntry.originalContent` is the left side of every diff. It is meant to be frozen while a file is `pending`, and both `hook.py` and `SessionManager.trackFileChange` do preserve it in the common path. The baseline drifts to a later step in these cases:

- The `hook.py` "null-fill" branch overwrites a *pending* entry's `originalContent` when it was `null` — intended to backfill a `DocumentTracker`-first capture, but it can advance the baseline of a file whose true origin is legitimately "new/empty."
- On the terminal path the true leak is **untracked edits**: a change reaching disk through a tool the hook does not intercept (`bash` redirects, `sed`, `apply_patch`, `NotebookEdit`) is invisible to the hook. The next intercepted edit reads the already-modified file and records it as the "original." This is an attribution gap, explicitly **out of scope** here (see Non-Goals).

**Phantom reviews (#2).** `DocumentTracker` watches the filesystem and cannot distinguish a `git pull`/`merge`/`checkout` from a Claude edit. The 8-file bulk heuristic is a guess by count; a small pull evades it.

## Goal

- **Freeze the baseline.** While a file is `pending`, `originalContent` is immutable — no code path overwrites it.
- **Checkpoint on approve.** Accepting a file sets its baseline to the current on-disk content, so the next Claude edit diffs from the approved point, not the ancient origin.
- **Per-file, never workspace-wide.** Every baseline and checkpoint is scoped to a single file entry. There is no global "snapshot the whole workspace" concept.
- **Guard git operations.** `DocumentTracker` suppresses capture during a detected git operation regardless of how many files it touches.

## Non-Goals

- **Full Claude-attribution.** Making diffs immune to *all* untracked edits (raw `bash`, `sed`, `apply_patch`, format-on-save, manual edits) is deferred. If such an edit is the *first* change to a file, the baseline the hook later captures will include it. Documented as a known limitation.
- **`.diff`/patch storage or edit-history timeline.** Full-content snapshots are retained; no unified-patch format.
- **git as a baseline source.** The no-git design decision stands — git is only *peeked at* (if present) to detect operations, never required.

## Baseline Semantics

`FileEntry.originalContent` is redefined from "the pre-Claude content" to **the review baseline**: the content the current pending diff is measured against. It holds one of:

- the **true origin** — the file's content the first time Claude touched it (or `null` if Claude created it), or
- the **last-approved content** — set when the user Accepts the file.

**Invariant:** while `reviewStatus === "pending"`, `originalContent` is immutable. The diff is always `originalContent ↔ current-on-disk`.

## Architecture

```
                 ┌──────────────────────────── terminal path ──┐
Claude edit ─► hook.py (PreToolUse, reads file BEFORE write)
                 │   new entry     → freeze originalContent
                 │   pending entry → NO-OP (baseline frozen)     ← changed
                 │   accepted/rej. → re-baseline to current, re-pending
                 └──────────────────────────────────────────────┘
                 ┌──────────────────────────── GUI path ───────┐
Claude edit ─► DocumentTracker (FS watch, debounced batch)
                 │   git op active?  → refresh snapshots, skip   ← NEW
                 │   bulk (≥8 files)? → refresh snapshots, skip  (kept)
                 │   else            → trackFileChange(snapshot)
                 └──────────────────────────────────────────────┘
                                   │
                                   ▼
        SessionManager  ── acceptFile/Folder/All: baseline := current  ← changed
                        ── trackFileChange: pending baseline preserved (guarded)
                                   │
                                   ▼
        diffProvider: originalContent (left) ↔ current on disk (right)
```

## Components

### Modified: `src/sessionManager.ts`

- **`acceptFile(filePath)`** — before setting `reviewStatus = "accepted"`, read the current on-disk content and assign it to `entry.originalContent` (the checkpoint). On read failure, log a warning and leave the existing baseline unchanged (accept still proceeds).
- **`acceptFolder(folderPath)` / `acceptAll()`** — same checkpoint step for each pending, in-workspace file transitioned. Read failures are per-file and non-fatal.
- **`trackFileChange(filePath, originalContent)`** — no behavior change; add an explicit guard/comment documenting that a `pending` entry's `originalContent` must never be overwritten, so the freeze can't regress. The existing `accepted/rejected → pending` branch (which re-baselines to the passed content) is retained — it is the GUI-path equivalent of the checkpoint.
- Extract a small helper `readFileOrNull(filePath): string | null` if it reduces duplication across accept paths (optional, only if it stays clearer).

### Modified: `hooks/hook.py`

- Remove the null-fill branch (`elif existing["reviewStatus"] == "pending" and existing.get("originalContent") is None and original_content is not None:`). A `pending` entry is now left entirely untouched — baseline frozen.
- Keep new-entry creation and the `accepted/rejected → pending` re-baseline branch (it reads the file *before* the write, so it correctly re-baselines to the approved content, matching the accept-time checkpoint).
- Users must re-run **Setup Hook** to deploy the updated script (auto-sync on activate also covers this per existing behavior).

### Modified: `src/documentTracker.ts`

- Add `isGitOperationActive(): boolean`:
  - Resolve `gitDir = path.join(workspacePath, ".git")`. If it is not an existing directory (no repo, or a worktree/submodule `.git` *file*), return `false` — detection is skipped, behavior unchanged.
  - Return `true` if `.git/index.lock` exists, **or** if any of `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `FETCH_HEAD`, `index` has an `mtimeMs` within `GIT_OP_WINDOW_MS` of now.
- In `processFsEventBatch()`, after building `candidates` and before the existing bulk check: if `isGitOperationActive()`, refresh snapshots for all candidates to their current content and return (same shape as the bulk-external branch), logging `"[INFO] DocumentTracker: ignored git operation (N file(s))"`.
- New constant: `GIT_OP_WINDOW_MS = 3000`.
- The `BULK_FILE_THRESHOLD` bulk check is retained as a secondary net for non-git bulk writes (npm install, codegen).

### Modified: `src/diffProvider.ts`

- In `openDiff`, when `originalContent !== null`, choose the diff title by whether the baseline is the origin or an approved checkpoint: `(original ↔ current)` vs `(since approved ↔ current)`. Requires knowing which state the entry is in — see schema note below. This is optional polish; if the state flag is not added, keep the current `(original ↔ current)` title unchanged.

### Session JSON schema

No required change. Full-content snapshots and the three review statuses are unchanged. **Optional:** add `baselineKind?: "origin" | "approved"` to `FileEntry`, set to `"approved"` when `acceptFile` checkpoints, to drive the diff-title polish above. Absence is treated as `"origin"` for backward compatibility. If the title polish is dropped, this field is not added.

### Unchanged

- `reviewPanel.ts`, `decorationProvider.ts` — no change.
- Reject / reapply / clear logic — unchanged (reject still restores the frozen origin; `claudeContent` undo still works).

## Error Handling

- **Accept-time read failure** — logged at WARN to the output channel; the accept proceeds with the prior baseline. No modal.
- **Git detection** — all `fs` probes are wrapped so a missing/locked `.git` never throws; on any error, `isGitOperationActive()` returns `false` (fail open to normal capture).
- **False negative window** — a genuine Claude edit within `GIT_OP_WINDOW_MS` of a git op is suppressed; the snapshot refresh means the *next* Claude edit still diffs correctly. Accepted trade-off.

## Testing

**Automated:** `npm run compile` and `npm run typecheck` must pass.

**`SessionManager` (unit-level where feasible):**
1. Accept a pending file → `originalContent` equals the current on-disk content; status `accepted`.
2. Repeated `trackFileChange` on a pending entry → `originalContent` never changes.
3. Reject → file restored to the frozen origin; `claudeContent` saved.
4. Reapply after reject → still works.

**`hook.py`:**
5. Existing *pending* entry with non-null `originalContent` → second invocation leaves it byte-identical.
6. New file → entry created with correct `originalContent` (or `null`).
7. `accepted`/`rejected` entry re-edited → re-baselined to pre-write content, status `pending`.

**`DocumentTracker` / manual:**
8. step0 → step1 → step2 while pending (via intercepted tools) → diff shows step0 ↔ step2.
9. Accept at step1, then Claude edits to step2 → diff shows step1 ↔ step2.
10. `git pull` touching 1–2 files → no phantom pending entries; `.git`-less directory behaves as before.
11. `git pull` touching ≥8 files → still ignored (bulk net intact).
12. Normal single Claude GUI edit (no git op) → still captured.

## Release

- Patch/minor version bump; CHANGELOG **Fixed** (baseline drift, phantom git-pull reviews) + **Changed** (accept now checkpoints the baseline).
- Release notes: re-run **Setup Hook** (or rely on activate auto-sync) to pick up the `hook.py` change.
