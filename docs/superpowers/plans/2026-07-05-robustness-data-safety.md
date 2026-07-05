# Robustness & Data-Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three data-safety/durability holes — reject deleting an unreadable existing file, non-atomic working-file restores, and dual-writer lost updates — without regressing activation time.

**Architecture:** `hook.py` gains explicit existence-checking so `null` reliably means "new file." `sessionManager` routes working-file restores through the existing atomic writer and reconciles concurrent hook captures at persist time via a pure `mergeFreshCaptures`, gated by a cheap mtime fast-path so the common case costs one `stat`.

**Tech Stack:** TypeScript (VS Code extension), Python 3 (hook), esbuild unit tests + `python -m unittest`.

## Global Constraints

- **No new npm/Python dependencies.**
- **No activation-time regression** — nothing added to `activate()`; the changes run only in the hook process, on user actions, or in `persist()`.
- **Steady-state budget:** ≤ one `os.path.exists` per hook fire; ≤ one `stat` per `persist()` when the file is unchanged since load (no extra read/parse/merge unless the on-disk mtime differs).
- **`mergeFreshCaptures` must be O(pending files)** — never iterate `accepted[]`.
- **Ships as `1.3.1`** (patch).

---

### Task 1: Reliable new-file detection in the hook

**Files:**
- Modify: `hooks/hook.py` (the original-content capture block, ~lines 111-115)
- Test: `hooks/tests/test_hook.py`

**Interfaces:**
- Produces: hook behavior — a genuinely absent file → `originalContent: null`; an existing-but-unreadable file → **no session entry** (hook exits 0).

- [ ] **Step 1: Write the failing tests**

Add to `hooks/tests/test_hook.py` (before the `if __name__` block):

```python
    def test_nonexistent_file_records_null(self):
        # Hook fires before Claude creates the file → it does not exist yet.
        self.assertFalse(os.path.exists(self.file))
        self.run_hook()
        self.assertIsNone(self.read_entry()["originalContent"])

    def test_existing_unreadable_file_is_skipped(self):
        # An existing file we cannot read must NOT be recorded as a null "new"
        # file (that would let a reject delete it). It is skipped entirely.
        with open(self.file, "w") as f:
            f.write("secret")
        os.chmod(self.file, 0)
        try:
            if os.access(self.file, os.R_OK):
                self.skipTest("cannot make file unreadable (running as root?)")
            self.run_hook()
            files = {}
            if os.path.exists(self.session_file):
                with open(self.session_file) as f:
                    files = json.load(f).get("files", {})
            self.assertNotIn(self.file, files)
        finally:
            os.chmod(self.file, 0o644)
```

- [ ] **Step 2: Run to verify `test_existing_unreadable_file_is_skipped` fails**

Run: `python3 -m unittest discover -s hooks/tests -p 'test_*.py' -v`
Expected: `test_existing_unreadable_file_is_skipped` FAILS (current hook records the file with `originalContent: null` instead of skipping). `test_nonexistent_file_records_null` passes (already-correct behavior).

- [ ] **Step 3: Implement the existence check**

In `hooks/hook.py`, replace:

```python
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            original_content: str | None = f.read()
    except (FileNotFoundError, PermissionError):
        original_content = None
```

with:

```python
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                original_content: str | None = f.read()
        except OSError:
            # Exists but unreadable (permissions, etc). We cannot safely baseline
            # or later restore it, and must NOT record it as a null "new" file —
            # that would let a reject delete the user's real file. Skip capture.
            sys.exit(0)
    else:
        original_content = None  # genuinely new — Claude is creating it
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest discover -s hooks/tests -p 'test_*.py' -v`
Expected: all tests PASS (11 total — the 9 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add hooks/hook.py hooks/tests/test_hook.py
git commit -m "fix: skip unreadable existing files in hook so reject can't delete them"
```

---

### Task 2: `mergeFreshCaptures` pure reducer

**Files:**
- Modify: `src/reviewModel.ts` (add the function)
- Test: `src/reviewModel.test.ts` (append cases)

**Interfaces:**
- Consumes: `Session`, `FileEntry` (already in `reviewModel.ts`).
- Produces: `export function mergeFreshCaptures(mine: Session, disk: Session, lastLoadedAtMs: number): Session` — mutates and returns `mine`, adding `disk.files` entries absent from `mine.files` whose `capturedAt` parses to a time `> lastLoadedAtMs`. Never touches `accepted`/`rejected`; O(disk.files).

- [ ] **Step 1: Write the failing test**

Append to `src/reviewModel.test.ts` (before the final `console.log("done")`):

```ts
// mergeFreshCaptures: reconcile concurrent hook captures at persist time.
{
  const T = 1_000_000;
  const pend = (oc: string | null, capturedAt?: string): FileEntry =>
    ({ originalContent: oc, reviewStatus: "pending", capturedAt });
  const iso = (ms: number) => new Date(ms).toISOString();
  const sess = (files: Record<string, FileEntry>, accepted = [] as any[]): Session =>
    ({ sessionId: "s", status: "active", files, accepted, rejected: {} });

  // fresh disk capture (capturedAt > lastLoaded), absent from mine → merged
  {
    const mine = sess({});
    const disk = sess({ "/b": pend("B", iso(T + 100)) });
    mergeFreshCaptures(mine, disk, T);
    assert.ok(mine.files["/b"], "fresh capture merged in");
  }
  // stale/removed (capturedAt <= lastLoaded), absent from mine → NOT merged
  {
    const mine = sess({});
    const disk = sess({ "/a": pend("A", iso(T - 100)) });
    mergeFreshCaptures(mine, disk, T);
    assert.equal(mine.files["/a"], undefined, "stale/removed entry not re-added");
  }
  // path already in mine.files → mine kept (not overwritten)
  {
    const mine = sess({ "/f": pend("MINE", iso(T + 100)) });
    const disk = sess({ "/f": pend("DISK", iso(T + 200)) });
    mergeFreshCaptures(mine, disk, T);
    assert.equal(mine.files["/f"].originalContent, "MINE", "existing entry kept");
  }
  // coexistence: fresh capture whose path is in mine.accepted → merged as pending
  {
    const mine = sess({}, [{ id: "t::/f", path: "/f", before: "A", after: "B", decidedAt: "t" }]);
    const disk = sess({ "/f": pend("B", iso(T + 100)) });
    mergeFreshCaptures(mine, disk, T);
    assert.ok(mine.files["/f"], "re-captured accepted file re-appears as pending");
    assert.equal(mine.accepted.length, 1, "accept record preserved");
  }
  // disk entry with no capturedAt → skipped (can't prove fresh)
  {
    const mine = sess({});
    const disk = sess({ "/x": pend("X", undefined) });
    mergeFreshCaptures(mine, disk, T);
    assert.equal(mine.files["/x"], undefined, "no-capturedAt entry skipped");
  }
  console.log("ok - mergeFreshCaptures (dual-writer reconcile)");
}
```

Ensure the import at the top of `src/reviewModel.test.ts` includes `mergeFreshCaptures` (add it to the existing `{ ... }` import from `./reviewModel`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: FAIL — esbuild/import error (`mergeFreshCaptures` not exported yet).

- [ ] **Step 3: Implement `mergeFreshCaptures`**

Add to `src/reviewModel.ts` (after `shouldPruneNoOp`):

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck && npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: typecheck clean; test prints `ok - mergeFreshCaptures (dual-writer reconcile)` then `done`.

- [ ] **Step 5: Commit**

```bash
git add src/reviewModel.ts src/reviewModel.test.ts
git commit -m "feat: mergeFreshCaptures reducer for dual-writer reconcile"
```

---

### Task 3: sessionManager — atomic restore + merge-on-write

**Files:**
- Modify: `src/sessionManager.ts` (field decls; import; `loadSession`; `persist`; reject/reapply writes)

**Interfaces:**
- Consumes: `mergeFreshCaptures` (Task 2), existing `migrateSession`, existing `private atomicWrite(filePath, content)`.
- Produces: no new public API; behavior — working-file restores are atomic; `persist()` reconciles concurrent hook captures via an mtime fast-path.

- [ ] **Step 1: Add the import and tracking fields**

In `src/sessionManager.ts`, add `mergeFreshCaptures` to the existing import from `./reviewModel`:

```ts
import {
  Session, FileEntry, ReviewRecord, hasRealChange, shouldPruneNoOp, acceptEntry,
  rejectEntry, migrateSession, mergeFreshCaptures,
} from "./reviewModel";
```

Add two fields alongside the other private fields (after `reconcileTimer`):

```ts
  private lastLoadedAtMs = 0;
  private loadedMtimeMs = 0;
```

- [ ] **Step 2: Record load time + mtime in `loadSession`**

Replace the body of `loadSession`'s `try` (the part before `const migrated`) so the timestamps are set right after a successful read:

```ts
  private loadSession(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionPath, "utf-8"));
      this.lastLoadedAtMs = Date.now();
      try { this.loadedMtimeMs = fs.statSync(this.sessionPath).mtimeMs; } catch { this.loadedMtimeMs = 0; }
      const migrated = migrateSession(raw);
      const changed = JSON.stringify(migrated) !== JSON.stringify(raw);
      this.session = migrated;
      this.log.appendLine(
        `[INFO] Session loaded: ${Object.keys(this.session.files).length} pending, ` +
        `${this.session.accepted.length} accepted, ${Object.keys(this.session.rejected).length} rejected`
      );
      this.pruneOutOfWorkspaceEntries();
      if (changed) this.persist();
    } catch {
      this.session = null;
    }
    this._onSessionChange.fire(this.session);
    this.scheduleReconcile();
  }
```

- [ ] **Step 3: Merge-on-write in `persist` (mtime fast-path)**

Replace the whole `persist()` method with:

```ts
  private persist(): void {
    if (!this.session) return;

    // Dual-writer guard: if the on-disk file changed since we loaded it, a
    // concurrent writer (the hook) ran — re-read and merge its fresh captures
    // so they are not lost. Common case: mtime matches → just one stat, no
    // read/parse/merge.
    try {
      const currentMtime = fs.statSync(this.sessionPath).mtimeMs;
      if (currentMtime !== this.loadedMtimeMs) {
        const disk = migrateSession(JSON.parse(fs.readFileSync(this.sessionPath, "utf-8")));
        this.session = mergeFreshCaptures(this.session, disk, this.lastLoadedAtMs);
      }
    } catch {
      // stat/read/parse failed → write our own state (never lose it)
    }

    this.session.status = Object.keys(this.session.files).length === 0 ? "reviewed" : "active";

    try {
      this.atomicWrite(this.sessionPath, JSON.stringify(this.session, null, 2));
      try { this.loadedMtimeMs = fs.statSync(this.sessionPath).mtimeMs; } catch { /* keep prior */ }
      this.lastLoadedAtMs = Date.now();
    } catch (err) {
      this.log.appendLine(`[ERROR] ` + `Failed to persist session: ${(err as Error).message}`);
    }

    this._onSessionChange.fire(this.session);
  }
```

- [ ] **Step 4: Route working-file restores through `atomicWrite`**

In `src/sessionManager.ts`, change the three reject-restore writes and the reapply write from `fs.writeFileSync(..., "utf-8")` to `this.atomicWrite(...)`. Each currently reads:

```ts
        else fs.writeFileSync(fp, entry.originalContent, "utf-8");
```
or (single-file reject):
```ts
      else fs.writeFileSync(filePath, entry.originalContent, "utf-8");
```
Replace the write call with `this.atomicWrite(fp, entry.originalContent)` (or `this.atomicWrite(filePath, entry.originalContent)`), keeping the surrounding `if (entry.originalContent === null) fs.unlinkSync(...)` branch unchanged.

And in `reapplyRejectedRecord`, replace:
```ts
      fs.writeFileSync(filePath, rec.after, "utf-8");
```
with:
```ts
      this.atomicWrite(filePath, rec.after);
```
(`rec.after` is non-null there — guarded by the `rec.after == null` early return.)

- [ ] **Step 5: Verify build + full suite**

Run: `npm run typecheck && npm run compile && npm test`
Expected: typecheck/compile clean; all unit suites (incl. `mergeFreshCaptures`) and the Python hook suite pass.

- [ ] **Step 6: Commit**

```bash
git add src/sessionManager.ts
git commit -m "fix: atomic working-file restore + merge-on-write dual-writer guard"
```

---

### Task 4: Version bump + changelog (1.3.1)

**Files:**
- Modify: `package.json` (version)
- Modify: `CHANGELOG.md` (new `## [1.3.1]` section)

**Interfaces:** none.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.3.0"` to `"version": "1.3.1"`.

- [ ] **Step 2: Add the changelog section**

In `CHANGELOG.md`, insert directly under the `---` following the header block (immediately above `## [1.3.0]`):

```markdown
## [1.3.1] — 2026-07-05

### Fixed

- **Rejecting an unreadable file could delete it.** The hook recorded a file it couldn't read (e.g. a permissions error) as a new (null-baseline) file, so rejecting it deleted the real file. Such files are now skipped instead of captured; a `null` baseline now reliably means "the file did not exist."
- **Working-file restores are now atomic.** Rejecting (restore to baseline) and re-applying write your files via a temp-file + rename, so an interrupted write can no longer leave a half-written file.
- **Concurrent writes no longer drop changes.** The hook and the extension both write the session file; the extension now re-reads and merges any changes the hook made since it loaded (guarded by a cheap modification-time check), so a hook capture or an accept/reject decision isn't lost during a race.

### Notes

- Re-run **Claude Gate: Setup Hook** (or let activate auto-sync run) to deploy the updated `hook.py`.

---
```

- [ ] **Step 3: Verify**

Run: `node -e "require('./package.json')" && npm run typecheck`
Expected: no error (valid JSON), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to 1.3.1 with robustness/data-safety changelog"
```

---

## Self-Review

**Spec coverage:** Part 1 (hook new-file detection) → Task 1 ✓; Part 2 (atomic restore) → Task 3 Step 4 ✓; Part 3 (merge-on-write: pure fn → Task 2, wiring + mtime fast-path + load tracking → Task 3 Steps 1-3) ✓; performance (mtime fast-path, O(pending) merge, no activation work) → Task 3 + Global Constraints ✓; release 1.3.1 → Task 4 ✓; tests (hook unreadable/nonexistent, mergeFreshCaptures cases) → Tasks 1-2 ✓.

**Placeholder scan:** none — every code step has complete code and exact commands.

**Type consistency:** `mergeFreshCaptures(mine, disk, lastLoadedAtMs): Session` is defined in Task 2 and consumed identically in Task 3; `atomicWrite(filePath, content)` matches the existing signature; `lastLoadedAtMs`/`loadedMtimeMs` field names are used consistently across `loadSession` and `persist`.
