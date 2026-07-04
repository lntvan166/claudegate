# Checkpoint Baseline & Diff Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review diff always start from a frozen per-file baseline, let approving a file checkpoint its current content as the new baseline, and stop `git pull` from creating phantom pending entries.

**Architecture:** Three independent changes. (1) `hooks/hook.py` stops touching a `pending` entry so its baseline can never drift. (2) `SessionManager.acceptFile/acceptFolder/acceptAll` set `originalContent` to the file's current on-disk content at approve time (the checkpoint). (3) `DocumentTracker` detects an in-progress git operation and skips capture, regardless of file count.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc), Python 3 (PreToolUse hook), Node `fs`. No new runtime dependencies. Python `unittest` for hook tests (already available).

## Global Constraints

- **No new dependencies** — runtime or dev. Python tests use stdlib `unittest`/`subprocess` only.
- **No git requirement** — git is only *peeked at* when `.git/` exists; a non-git workspace must behave exactly as before.
- **Per-file only** — no workspace-wide snapshot or global checkpoint.
- **Baseline freeze invariant** — while `reviewStatus === "pending"`, `originalContent` is never overwritten by any code path.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass after every TS task (project has no TS test runner; do not add one).
- **Hook redeploy** — `hooks/hook.py` changes require the user to re-run **Setup Hook** or rely on activate auto-sync; note in CHANGELOG.
- **Scope excludes** full Claude-attribution (untracked `bash`/`sed`/`apply_patch` edits) and any `.diff`/patch storage — do not implement these.

---

## File Structure

- `hooks/hook.py` — MODIFY: remove the null-fill branch that mutates a pending entry.
- `hooks/tests/test_hook.py` — CREATE: `unittest` suite exercising hook baseline behavior against a temp `$HOME`.
- `src/sessionManager.ts` — MODIFY: add `readFileOrNull` helper; checkpoint current content in `acceptFile`/`acceptFolder`/`acceptAll`; add freeze guard comment in `trackFileChange`.
- `src/documentTracker.ts` — MODIFY: add `GIT_OP_WINDOW_MS`, `isGitOperationActive()`, and a git-op skip branch in `processFsEventBatch`.
- `CHANGELOG.md` — MODIFY: add release entry.
- `package.json` — MODIFY: version bump.

---

## Task 1: Freeze the pending baseline in `hook.py`

**Files:**
- Modify: `hooks/hook.py:116-136` (the `existing` branches in `main()`)
- Test: `hooks/tests/test_hook.py` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no code consumed by later tasks. Establishes the invariant that a `pending` entry's `originalContent` is immutable in the hook.

- [ ] **Step 1: Write the failing test file**

Create `hooks/tests/test_hook.py`:

```python
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hook.py")


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


class HookBaselineTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.claudegate = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.claudegate, "sessions"))
        # Workspace root = a project dir under the temp home.
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        with open(os.path.join(self.claudegate, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.file = os.path.join(self.root, "a.txt")
        self.session_file = session_file_for(self.claudegate, self.root)

    def run_hook(self):
        payload = json.dumps({
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": self.file},
        })
        env = dict(os.environ, HOME=self.home)
        subprocess.run(
            [sys.executable, HOOK],
            input=payload, text=True, env=env, check=True,
        )

    def write_session(self, entry):
        session = {"sessionId": "t", "status": "active", "files": {self.file: entry}}
        with open(self.session_file, "w") as f:
            json.dump(session, f)

    def read_entry(self):
        with open(self.session_file) as f:
            return json.load(f)["files"][self.file]

    def test_new_file_records_current_as_original(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        entry = self.read_entry()
        self.assertEqual(entry["originalContent"], "v0")
        self.assertEqual(entry["reviewStatus"], "pending")

    def test_pending_nonnull_baseline_preserved(self):
        self.write_session({"originalContent": "v0", "reviewStatus": "pending"})
        with open(self.file, "w") as f:
            f.write("v1")
        self.run_hook()
        self.assertEqual(self.read_entry()["originalContent"], "v0")

    def test_pending_null_baseline_preserved(self):
        # Regression target: null-fill must NOT advance a pending baseline.
        self.write_session({"originalContent": None, "reviewStatus": "pending"})
        with open(self.file, "w") as f:
            f.write("v1")
        self.run_hook()
        self.assertIsNone(self.read_entry()["originalContent"])

    def test_accepted_entry_rebaselines_and_repends(self):
        self.write_session({"originalContent": "v0", "reviewStatus": "accepted"})
        with open(self.file, "w") as f:
            f.write("v1")  # the accepted content, present before Claude's next write
        self.run_hook()
        entry = self.read_entry()
        self.assertEqual(entry["originalContent"], "v1")
        self.assertEqual(entry["reviewStatus"], "pending")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify the null-fill test fails**

Run: `python3 -m unittest discover -s hooks/tests -v`
Expected: `test_pending_null_baseline_preserved` FAILS (asserts `None` but hook rewrote it to `"v1"`). The other three PASS.

- [ ] **Step 3: Remove the null-fill branch in `hook.py`**

In `hooks/hook.py`, delete the entire `elif` null-fill branch so a pending entry is left untouched. The block currently reads:

```python
    elif existing["reviewStatus"] == "pending" and existing.get("originalContent") is None and original_content is not None:
        # DocumentTracker may have recorded this file first without a snapshot.
        existing["originalContent"] = original_content
        save_session(session, session_file)

    elif existing["reviewStatus"] in ("accepted", "rejected"):
```

Replace it with (drop the pending branch, keep the accepted/rejected branch and add a clarifying comment):

```python
    # A pending entry is left untouched: its originalContent is the frozen
    # review baseline and must never advance while the file awaits review.

    elif existing["reviewStatus"] in ("accepted", "rejected"):
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `python3 -m unittest discover -s hooks/tests -v`
Expected: all four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/hook.py hooks/tests/test_hook.py
git commit -m "fix: freeze pending baseline in hook.py (remove null-fill)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Checkpoint current content on approve in `SessionManager`

**Files:**
- Modify: `src/sessionManager.ts:137-143` (`acceptFile`), `:145-158` (`acceptFolder`), `:393-404` (`acceptAll`), `:94-135` (`trackFileChange` comment)
- Verify: `npm run typecheck`, `npm run compile`, manual repro

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `acceptFile`, `acceptFolder`, `acceptAll` now set `entry.originalContent` to the file's current on-disk content before marking it `accepted`. New private helper `private readFileOrNull(filePath: string): string | null`.

- [ ] **Step 1: Add the `readFileOrNull` helper**

In `src/sessionManager.ts`, add this private method next to the other file helpers (e.g. just above `private persist()` at line 550):

```typescript
  // Read a file's current content, or null if it cannot be read. Used to
  // checkpoint the review baseline at approve time.
  private readFileOrNull(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }
```

- [ ] **Step 2: Checkpoint in `acceptFile`**

Replace the body of `acceptFile` (lines 137-143):

```typescript
  acceptFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;
    entry.reviewStatus = "accepted";
    this.log.appendLine(`[INFO] ` + `Accepted: ${filePath}`);
    this.persist();
  }
```

with:

```typescript
  acceptFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry || entry.reviewStatus !== "pending") return;
    // Checkpoint: the approved content becomes the new baseline so the next
    // Claude edit diffs from here, not the original.
    const current = this.readFileOrNull(filePath);
    if (current !== null) {
      entry.originalContent = current;
    } else {
      this.log.appendLine(`[WARN] Accept: could not read ${filePath}; baseline unchanged`);
    }
    entry.reviewStatus = "accepted";
    this.log.appendLine(`[INFO] ` + `Accepted: ${filePath}`);
    this.persist();
  }
```

- [ ] **Step 3: Checkpoint in `acceptFolder`**

Replace the loop body in `acceptFolder` (lines 149-154):

```typescript
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "pending") {
        entry.reviewStatus = "accepted";
        count++;
      }
    }
```

with:

```typescript
    for (const [fp, entry] of Object.entries(this.session.files)) {
      if (fp.startsWith(prefix) && entry.reviewStatus === "pending") {
        const current = this.readFileOrNull(fp);
        if (current !== null) entry.originalContent = current;
        else this.log.appendLine(`[WARN] Accept folder: could not read ${fp}; baseline unchanged`);
        entry.reviewStatus = "accepted";
        count++;
      }
    }
```

- [ ] **Step 4: Checkpoint in `acceptAll`**

Replace the loop body in `acceptAll` (lines 396-401):

```typescript
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus === "pending" && isInWorkspace(filePath)) {
        entry.reviewStatus = "accepted";
        count++;
      }
    }
```

with:

```typescript
    for (const [filePath, entry] of Object.entries(this.session.files)) {
      if (entry.reviewStatus === "pending" && isInWorkspace(filePath)) {
        const current = this.readFileOrNull(filePath);
        if (current !== null) entry.originalContent = current;
        else this.log.appendLine(`[WARN] Accept all: could not read ${filePath}; baseline unchanged`);
        entry.reviewStatus = "accepted";
        count++;
      }
    }
```

- [ ] **Step 5: Add the freeze-guard comment to `trackFileChange`**

In `trackFileChange`, above the `// If already pending, no-op` block (line 121), add:

```typescript
    // INVARIANT: a pending entry's originalContent is the frozen review
    // baseline — never overwrite it here. It advances only on accept
    // (checkpoint) or when a previously accepted/rejected file is re-edited.
```

- [ ] **Step 6: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0, no errors.

- [ ] **Step 7: Manual verification**

In the Extension Development Host (F5):
1. Have Claude edit an existing file (step0 → step1). Confirm the Pending diff shows step0 ↔ step1.
2. Click **Accept** on that file.
3. Inspect `~/.claudegate/sessions/<hash>.json` — the entry's `originalContent` now equals the current file content, `reviewStatus` is `accepted`.
4. Have Claude edit the same file again (step2). The new Pending diff shows the approved content ↔ step2 (not the ancient origin).

Expected: all four observations hold.

- [ ] **Step 8: Commit**

```bash
git add src/sessionManager.ts
git commit -m "feat: checkpoint current content as baseline on approve

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Git-operation guard in `DocumentTracker`

**Files:**
- Modify: `src/documentTracker.ts:17-19` (constants), `:34-44` (class fields/constructor), `:95-161` (`processFsEventBatch`), add `isGitOperationActive` method
- Verify: `npm run typecheck`, `npm run compile`, manual repro

**Interfaces:**
- Consumes: existing `this.workspacePath`, `refreshSnapshot`, `this.log`.
- Produces: `private isGitOperationActive(): boolean`; new module constant `GIT_OP_WINDOW_MS`.

- [ ] **Step 1: Add the time-window constant**

In `src/documentTracker.ts`, next to the existing timing constants (after line 19 `const FS_BATCH_DEBOUNCE_MS = 300;`):

```typescript
// A git pull/merge/checkout/rebase touches .git telltales; suppress capture
// for a short window after any of them change, regardless of file count.
const GIT_OP_WINDOW_MS = 3000;
const GIT_TELLTALES = ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "FETCH_HEAD", "index"];
```

- [ ] **Step 2: Add the `isGitOperationActive` method**

Add this private method to the `DocumentTracker` class (e.g. just above `private isInWorkspace` at line 183):

```typescript
  // True if a git operation appears to be in progress or just completed.
  // Fails open (returns false) on any error so normal capture is unaffected.
  private isGitOperationActive(): boolean {
    if (!this.workspacePath) return false;
    const gitDir = path.join(this.workspacePath, ".git");
    try {
      // Worktrees/submodules use a .git *file*; skip detection for those.
      if (!fs.statSync(gitDir).isDirectory()) return false;
    } catch {
      return false; // no repo
    }

    try {
      if (fs.existsSync(path.join(gitDir, "index.lock"))) return true;
    } catch { /* ignore */ }

    const now = Date.now();
    for (const name of GIT_TELLTALES) {
      try {
        const { mtimeMs } = fs.statSync(path.join(gitDir, name));
        if (now - mtimeMs < GIT_OP_WINDOW_MS) return true;
      } catch { /* missing telltale is fine */ }
    }
    return false;
  }
```

- [ ] **Step 3: Wire the guard into `processFsEventBatch`**

In `processFsEventBatch`, immediately after the `if (candidates.length === 0) return;` line (line 131) and before the `allNewCreatesWithoutSnapshot` computation, insert:

```typescript
    if (this.isGitOperationActive()) {
      for (const c of candidates) {
        this.refreshSnapshot(c.filePath, c.currentContent);
      }
      this.log.appendLine(
        `[INFO] DocumentTracker: ignored git operation (${candidates.length} file(s))`
      );
      return;
    }
```

- [ ] **Step 4: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0, no errors.

- [ ] **Step 5: Manual verification**

In the Extension Development Host (F5), open a git repo workspace:
1. Ensure no Claude session is active for a test file. Run `git pull` (or simulate: `git fetch` then `git merge`) that changes 1–2 tracked files.
2. Confirm those files do **not** appear in the Pending panel; the Output channel logs `ignored git operation`.
3. In a **non-git** directory (no `.git`), have Claude edit a file — confirm it is still captured normally (guard is skipped).
4. With no git op running, have Claude make a single GUI edit — confirm it is still captured (guard returns false).

Expected: all four observations hold.

- [ ] **Step 6: Commit**

```bash
git add src/documentTracker.ts
git commit -m "fix: skip capture during git operations to stop phantom reviews

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Release notes and version bump

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the behavior changes from Tasks 1–3.
- Produces: nothing consumed by code.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.1.12"` to `"version": "1.2.0"` (a minor bump — new checkpoint behavior).

- [ ] **Step 2: Add the CHANGELOG entry**

Add a new section directly above the `## [1.1.12] — 2026-06-03` entry, matching the file's `## [version] — YYYY-MM-DD` heading style and its `---` separators:

```markdown
## [1.2.0] — 2026-07-04

### Changed
- **Accept now checkpoints the baseline.** Approving a file makes its current content the new diff baseline, so the next Claude edit is compared against the approved version instead of the original.

### Fixed
- The review baseline is now frozen while a file is pending — a diff can no longer silently drop the original and show only the latest edit-to-edit change.
- `git pull` / `merge` / `checkout` no longer create phantom "pending" entries: changes made while a git operation is detected are ignored regardless of file count.

### Notes
- Re-run **Setup Hook** (or let activate auto-sync run) to deploy the updated `hook.py`.
```

- [ ] **Step 3: Verify the package still builds**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release 1.2.0 (checkpoint baseline, git-op guard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Freeze invariant → Task 1 (hook) + Task 2 Step 5 (tracker comment; tracker code already preserves). Checkpoint on approve → Task 2. Per-file scope → inherent (no workspace-wide code added). Git guard → Task 3. Diff-title/`baselineKind` polish → intentionally dropped (YAGNI: schema-churn and reject/reapply edge cases outweigh a cosmetic label; noted for the user). Release → Task 4. Non-goals (attribution, `.diff`) → not implemented, per Global Constraints.
- **Placeholder scan:** none — all steps carry concrete code/commands.
- **Type consistency:** `readFileOrNull` used consistently across Task 2; `isGitOperationActive`/`GIT_OP_WINDOW_MS`/`GIT_TELLTALES` used consistently in Task 3.
