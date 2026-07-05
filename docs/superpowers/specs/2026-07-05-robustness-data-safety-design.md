# Robustness & Data-Safety (1.3.1)

**Date:** 2026-07-05
**Status:** Draft for approval
**Related:** `hooks/hook.py`, `src/sessionManager.ts`, `src/reviewModel.ts`, `hooks/tests/test_hook.py`, `src/reviewModel.test.ts`, `package.json`, `CHANGELOG.md`

## Problem

Three data-safety / durability weak spots surfaced while building the review-log model. For a tool whose whole job is to be a trustworthy change gate, these matter more than features.

1. **Reject can delete a real file (data loss).** `hook.py` records `originalContent: null` both when a file *doesn't exist* (Claude is creating it) and when it *exists but can't be read* (`PermissionError`/OS error). The model treats `null` as "Claude created it," so rejecting such an entry runs `fs.unlinkSync` — deleting a pre-existing user file. Rare (needs an unreadable file) but unrecoverable.
2. **Working-file restore is not atomic.** Reject's baseline-restore and re-apply's write to *your* files use plain `fs.writeFileSync` (`sessionManager.ts:183,210,249,331`). An interrupted write (crash, power loss) can leave a half-written or truncated file.
3. **Dual-writer lost updates.** `hook.py` and the extension both read-modify-write the session JSON with no coordination. Atomic rename prevents torn reads, but a concurrent write can still drop a hook-captured pending change or an accept/reject decision (the last writer wins).

## Global Constraints

- **No new npm/Python dependencies.**
- **No activation-time regression.** `activate()` must do no more work than today (one `loadSession` read+parse + registration). None of these changes may run on the activation path.
- **Steady-state cost budget:** at most one extra `os.path.exists` per hook fire, and one extra `stat` per session persist in the common (no-concurrent-writer) case. No extra full read/parse unless the on-disk file actually changed since load.
- **Ships as `1.3.1`** (patch; bug-fixes/hardening). 1.3.0 is already released.

## Part 1 — Reliable new-file detection (`hook.py`)

Replace the blanket read-or-null with an explicit existence check so `null` unambiguously means "the file did not exist."

```python
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                original_content: str | None = f.read()
        except OSError:
            # File exists but is unreadable (permissions, etc). We cannot safely
            # baseline or later restore it, and must NOT record it as a "new"
            # (null) file — that would let a reject delete the user's real file.
            # Skip capture entirely.
            sys.exit(0)
    else:
        original_content = None  # genuinely new — Claude is creating it
```

(`OSError` is the base class for `PermissionError`, `IsADirectoryError`, etc.) After this, the model's `originalContent === null ⇒ new file ⇒ reject deletes` invariant is sound.

**Cost:** one `os.path.exists` per hook fire, in the hook process. Zero extension impact.

## Part 2 — Atomic working-file restore (`sessionManager.ts`)

The private session-file writer is already atomic (temp + `os.rename`-style replace via `crypto`-suffixed temp). Generalize it and use it for the *working-file* writes too.

- Ensure `atomicWrite(filePath, content)` is a general helper (it already takes a path + content).
- In `rejectFile` / `rejectFolder` / `rejectAll`: replace `fs.writeFileSync(fp, entry.originalContent, "utf-8")` with `this.atomicWrite(fp, entry.originalContent)`. (The `fs.unlinkSync` delete-of-new-file path is unchanged.)
- In `reapplyRejectedRecord`: replace `fs.writeFileSync(filePath, rec.after, "utf-8")` with `this.atomicWrite(filePath, rec.after)`.

Behavior is identical except a crash mid-write can no longer corrupt the file. **Cost:** one extra rename per user-triggered reject/reapply (not a hot path).

## Part 3 — Merge-on-write dual-writer guard (`sessionManager.ts` + pure `reviewModel.ts`)

The hook is the practical "other writer," and it only ever **adds** pending entries to `files{}` (it never touches `accepted`/`rejected`). So the extension can safely reconcile at write time by re-reading the on-disk session and merging in any hook captures it doesn't yet know about, while keeping its own decisions.

### New pure function (`reviewModel.ts`)

```ts
// Merge hook-captured pending entries that landed on disk since we loaded.
// Only `files{}` is reconciled (the hook's sole territory); `mine`'s accepted[]
// / rejected{} / files removals are authoritative and preserved. A disk entry
// is "fresh" iff it is absent from mine.files AND its capturedAt is newer than
// when we last loaded. O(disk.files) — never walks the accepted log.
export function mergeFreshCaptures(mine: Session, disk: Session, lastLoadedAtMs: number): Session {
  for (const [path, entry] of Object.entries(disk.files)) {
    if (mine.files[path]) continue;                 // we already know this path
    if (!entry.capturedAt) continue;                // no timestamp → can't prove fresh → skip
    if (Date.parse(entry.capturedAt) > lastLoadedAtMs) {
      mine.files[path] = entry;                      // a hook capture we missed → merge in
    }
  }
  return mine;
}
```

Coexistence bonus: if the extension just accepted `P` (moved it to `accepted[]`, removed from `files`) while the hook re-captured `P` (a re-edit), the fresh capture is re-added as pending — `P` correctly ends up in *both* the Accepted log (old approval) and Pending (new change), exactly the review-log model's intent.

### `sessionManager` wiring

- Track two fields set in `loadSession`: `lastLoadedAtMs = Date.now()` and `loadedMtimeMs = fs.statSync(sessionPath).mtimeMs` (both wrapped; default `0` on failure).
- `persist()` gains an **mtime fast-path** before the atomic write:

```ts
private persist(): void {
  if (!this.session) return;
  try {
    const currentMtime = fs.statSync(this.sessionPath).mtimeMs;
    if (currentMtime !== this.loadedMtimeMs) {          // someone wrote since we loaded
      const disk = migrateSession(JSON.parse(fs.readFileSync(this.sessionPath, "utf-8")));
      this.session = mergeFreshCaptures(this.session, disk, this.lastLoadedAtMs);
    }
  } catch {
    // stat/read/parse failed → fall back to writing our own state (never lose it)
  }
  this.session.status = Object.keys(this.session.files).length === 0 ? "reviewed" : "active";
  try {
    this.atomicWrite(this.sessionPath, JSON.stringify(this.session, null, 2));
    this.loadedMtimeMs = fs.statSync(this.sessionPath).mtimeMs; // adopt our own write
    this.lastLoadedAtMs = Date.now();
  } catch (err) {
    this.log.appendLine(`[ERROR] Failed to persist session: ${(err as Error).message}`);
  }
  this._onSessionChange.fire(this.session);
}
```

In the common case (no concurrent writer) the mtime matches → **no re-read/parse/merge**, just the atomic write already performed today, plus one `stat`. Updating `loadedMtimeMs`/`lastLoadedAtMs` right after our own write avoids a spurious self-triggered merge before `fs.watch` re-fires `loadSession`.

**Residual window (documented, not closed):** a writer that writes between our `stat` and our `rename` can still be overwritten — but the window shrinks from "the whole review action" to "a few syscalls," and hook captures (the frequent case) are recovered. Two extension windows on the *same* workspace are out of scope (rare).

## Data Flow (the race that's now safe)

1. Extension loads session (`lastLoadedAtMs = T0`, `loadedMtimeMs = M0`).
2. User clicks Accept on file A → extension removes A from `files`, appends to `accepted[]`.
3. Meanwhile the hook captures file B (a new pending edit), atomically writing the JSON (`mtime → M1`, `B.capturedAt ≈ T0+δ`).
4. Extension `persist()`: `stat` shows `M1 ≠ M0` → re-read disk → `mergeFreshCaptures` adds B (fresh: `capturedAt > T0`), keeps A's accept → atomic write. **Neither the accept nor B's capture is lost.**

## Error Handling

- Part 1: unreadable existing file → hook exits 0 (no entry, no capture). Acceptable — better a missed rare edit than a deleted file.
- Part 3: any failure of the `stat`/read/parse in `persist()` → fall back to writing `this.session` unchanged (the extension's own state is never lost).
- Atomic writes (session + working files) leave the original intact on failure (temp file discarded).

## Performance Requirements (must verify)

- `activate()` does no additional work vs. today. (Manual: extension host activation feels unchanged; no new sync I/O in the activation path.)
- `persist()` common path adds exactly one `stat` (no read/parse/merge) when the file is unchanged since load.
- `mergeFreshCaptures` is O(pending files), independent of `accepted[]` length.

## Testing

**Automated — `npm test` (TS unit + Python hook):**
1. `hook.py` (`test_hook.py`): an **existing-but-unreadable** file (chmod 000, skip on platforms/roots where that can't be enforced) → **no session entry created**; a **non-existent** file → entry with `originalContent: null`; existing-readable new file still records `null` (existing test stays green).
2. `mergeFreshCaptures` (`reviewModel.test.ts`): fresh disk capture (capturedAt > lastLoaded, absent from mine) → merged; stale/removed (capturedAt ≤ lastLoaded) → **not** merged; path already in `mine.files` → mine kept; path in `mine.accepted` with a fresh disk pending capture → merged into `files` (coexistence); disk entry with no `capturedAt` → skipped.
3. Existing suites remain green.

**Manual (Extension Development Host):**
4. Reject flow still restores/deletes correctly (spot-check via the seeder); reapply still works.
5. Merge-on-write: with a session open, run `manual-test-seed.py --reedit <file>` (simulates a hook write) while the panel is open, then accept a *different* file in the UI → both the accept and the re-edit survive (nothing dropped).
6. Activation: reload the window on a populated workspace — panels appear promptly (no perceptible regression).

## Release

- **Bump `package.json` version to `1.3.1`.**
- `CHANGELOG.md`: new `## [1.3.1]` section — Fixed (reject could delete an unreadable existing file; atomic working-file restore; dual-writer lost-update guard), with a note to re-run **Setup Hook** (auto-synced on activate) to pick up the updated `hook.py`.
- README needs no change (no user-facing surface change).
