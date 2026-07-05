# Watcher Delete-Safety + Test/CI + UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reject safe on the opt-in file-watcher path, cover the sessionManager orchestration with real integration tests + CI, and stop blank diffs on no-op pending rows — all folded into 1.3.1.

**Architecture:** A `newFile` confidence flag lets only the hook (which knows a file was absent) authorize reject-deletion; the watcher's uncertain creates are left on disk. A tiny hand-written `vscode` stub (aliased in at esbuild time) enables dependency-free integration tests of `SessionManager` against real `fs`, run in a new GitHub Actions workflow.

**Tech Stack:** TypeScript (VS Code extension), Python 3 (hook), esbuild unit tests, GitHub Actions.

## Global Constraints

- **No new npm/Python dependencies.**
- **No activation-time regression.**
- **Ships as `1.3.1`** (already bumped; do not change the version).
- Reject may hard-delete a file **only** when `originalContent === null && entry.newFile === true`.

---

### Task 1: Integration-test harness for SessionManager

**Files:**
- Create: `src/test-stubs/vscode.ts`
- Create: `src/sessionManager.test.ts`
- Modify: `package.json` (add to the `test:unit` chain)

**Interfaces:**
- Produces: a `vscode` stub (`EventEmitter`, `window.show*Message`) and an esbuild alias pattern (`--alias:vscode=./src/test-stubs/vscode.ts`) that later tasks reuse to test `SessionManager` against real `fs`.

- [ ] **Step 1: Write the vscode stub**

Create `src/test-stubs/vscode.ts`:

```ts
// Minimal hand-written vscode stub so vscode-light modules (SessionManager) can
// be unit-tested. esbuild aliases "vscode" to this file for the test bundle;
// real @types/vscode is still used for typechecking.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void { for (const l of [...this.listeners]) l(data); }
  dispose(): void { this.listeners = []; }
}
export const window = {
  showErrorMessage: (..._args: unknown[]): undefined => undefined,
  showWarningMessage: (..._args: unknown[]): undefined => undefined,
  showInformationMessage: (..._args: unknown[]): undefined => undefined,
};
```

- [ ] **Step 2: Write the failing integration test**

Create `src/sessionManager.test.ts`:

```ts
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";

const fakeLog = { appendLine() {} } as any;

function sessionPathFor(home: string, ws: string): string {
  const hash = crypto.createHash("md5").update(path.resolve(ws)).digest("hex");
  return path.join(home, ".claudegate", "sessions", `${hash}.json`);
}
function newEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ws-"));
  process.env.HOME = home; // SessionManager reads os.homedir() → $HOME on POSIX
  return { home, ws, sp: sessionPathFor(home, ws) };
}
function readSession(sp: string): any {
  return JSON.parse(fs.readFileSync(sp, "utf-8"));
}

// accept: appends a record, removes the pending entry, leaves the file on disk
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "a.ts");
  fs.writeFileSync(fp, "NEW");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "OLD");
  sm.acceptFile(fp);
  const s = readSession(sp);
  assert.equal(s.files[fp], undefined, "accepted entry removed from files");
  assert.equal(s.accepted.length, 1, "one accepted record");
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["OLD", "NEW"]);
  assert.equal(fs.readFileSync(fp, "utf-8"), "NEW", "working file untouched by accept");
  sm.stopWatching();
  console.log("ok - accept records + leaves file");
}

// reject of an existing file restores the baseline on disk (atomically)
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "b.ts");
  fs.writeFileSync(fp, "CLAUDE");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "BASE");
  sm.rejectFile(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "BASE", "reject restored baseline");
  const s = readSession(sp);
  assert.ok(s.rejected[fp], "rejected record stored");
  assert.equal(s.rejected[fp].after, "CLAUDE", "discarded content saved");
  sm.stopWatching();
  console.log("ok - reject restores baseline on disk");
}

// merge-on-write: a concurrent write to the session file (a fresh hook capture)
// is preserved when the extension persists.
{
  const { ws, sp } = newEnv();
  const a = path.join(ws, "a.ts");
  fs.writeFileSync(a, "A");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(a, "A0"); // persists the session (mtime recorded)
  // Simulate a hook writing a NEW pending entry directly to the session file:
  const disk = readSession(sp);
  const b = path.join(ws, "b.ts");
  disk.files[b] = {
    originalContent: "B0", reviewStatus: "pending",
    capturedAt: new Date(Date.now() + 1000).toISOString(),
  };
  fs.writeFileSync(sp, JSON.stringify(disk));
  // Now the extension persists (via accept of A); merge must keep b.
  sm.acceptFile(a);
  const s = readSession(sp);
  assert.ok(s.files[b], "concurrent hook capture merged, not lost");
  assert.equal(s.accepted.length, 1, "the accept was still recorded");
  sm.stopWatching();
  console.log("ok - merge-on-write preserves concurrent hook capture");
}

console.log("done");
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx esbuild src/sessionManager.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/sessionManager.test.cjs && node out/sessionManager.test.cjs`
Expected: FAIL — the stub/test wiring isn't in the chain yet and any assertion mismatch surfaces. (If the aliasing is wrong you'll get a "Could not resolve 'vscode'" error.) Iterate until the three `ok - …` lines print. If merge-on-write fails, that's a real signal — but per the current code it should pass; the point of this step is to prove the harness runs.

- [ ] **Step 4: Wire into the test chain**

In `package.json`, append to `test:unit` (after the `reviewModel.test.cjs` run):

```
 && esbuild src/sessionManager.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/sessionManager.test.cjs && node out/sessionManager.test.cjs
```

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean (the stub + test typecheck; the test passes `fakeLog as any`); all suites incl. `sessionManager.test` and the Python hook suite pass.

```bash
git add src/test-stubs/vscode.ts src/sessionManager.test.ts package.json
git commit -m "test: dependency-free SessionManager integration harness (vscode stub)"
```

---

### Task 2: Watcher delete-safety (`newFile` confidence flag)

**Files:**
- Modify: `src/reviewModel.ts` (add `newFile?` to `FileEntry`)
- Modify: `hooks/hook.py` (set `newFile` when recording a null baseline) + `hooks/tests/test_hook.py`
- Modify: `src/sessionManager.ts` (`trackFileChange` param; `applyReject` helper; the 3 reject sites)
- Modify: `src/documentTracker.ts` (unchanged call is fine — it passes no `newFile`; verify)
- Modify: `src/sessionManager.test.ts` (append the reject matrix)

**Interfaces:**
- Consumes: the Task 1 harness.
- Produces: `FileEntry.newFile?: boolean`; `SessionManager.trackFileChange(filePath, originalContent, newFile?: boolean)`; reject deletes only when `originalContent === null && entry.newFile === true`.

- [ ] **Step 1: Add the field**

In `src/reviewModel.ts`, add to `FileEntry`:

```ts
export interface FileEntry {
  originalContent: string | null;
  reviewStatus: "pending";
  newFile?: boolean;   // true ⇒ confident the file did not exist ⇒ reject may delete it
  sessionId?: string;
  capturedAt?: string;
}
```

- [ ] **Step 2: Hook sets the flag + test**

In `hooks/hook.py`, in the entry-creation dict (inside `if existing is None or existing.get("reviewStatus") != "pending":`), add the `newFile` key:

```python
        session["files"][file_path] = {
            "originalContent": original_content,
            "reviewStatus": "pending",
            "newFile": original_content is None,
            "sessionId": session_id,
            "capturedAt": captured_at,
        }
```

(`original_content is None` is true only in the `else` branch where the file was absent — the unreadable/binary case already `sys.exit(0)`s.)

Add to `hooks/tests/test_hook.py`:

```python
    def test_nonexistent_file_marked_new(self):
        self.assertFalse(os.path.exists(self.file))
        self.run_hook()
        self.assertTrue(self.read_entry()["newFile"])

    def test_existing_file_not_marked_new(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        self.assertFalse(self.read_entry().get("newFile", False))
```

- [ ] **Step 3: Run hook tests to verify the new ones fail then pass**

Run: `python3 -m unittest discover -s hooks/tests -p 'test_*.py' -v`
Expected: after adding the tests they FAIL (no `newFile` key yet), then PASS once Step 2's hook edit is in. All hook tests green (14 total).

- [ ] **Step 4: Thread `newFile` through `trackFileChange`**

In `src/sessionManager.ts`, change `trackFileChange`:

```ts
  trackFileChange(filePath: string, originalContent: string | null, newFile = false): void {
    if (!this.session) {
      this.session = { sessionId: new Date().toISOString(), status: "active", files: {}, accepted: [], rejected: {} };
    }
    if (this.session.files[filePath]) return;
    this.session.files[filePath] = { originalContent, reviewStatus: "pending", newFile };
    if (this.session.status === "reviewed") this.session.status = "active";
    this.log.appendLine(`[INFO] Tracking: ${filePath}`);
    this.persist();
  }
```

`documentTracker.ts` calls `this.sessionManager.trackFileChange(filePath, originalContent)` (no third arg → `newFile` defaults to `false`) — leave it as-is; the uncertain watcher create is correctly not-confident. (Verify no other caller passes a third arg.)

- [ ] **Step 5: Add `applyReject` and use it at all three reject sites**

Add the helper to `src/sessionManager.ts`:

```ts
  // The on-disk effect of rejecting one entry. Deletes only a confident-new
  // file; an uncertain null-baseline file (watcher create-without-snapshot) is
  // left on disk rather than risking deletion of a real file.
  private applyReject(filePath: string, entry: FileEntry): "restored" | "deleted" | "left" {
    if (entry.originalContent !== null) {
      this.atomicWrite(filePath, entry.originalContent, true);
      return "restored";
    }
    if (entry.newFile) {
      fs.unlinkSync(filePath);
      return "deleted";
    }
    return "left";
  }
```

Rewrite `rejectFile` to use it:

```ts
  rejectFile(filePath: string): void {
    const entry = this.session?.files[filePath];
    if (!entry) return;
    const after = this.readFileOrNull(filePath); // Claude's discarded version
    let outcome: "restored" | "deleted" | "left";
    try {
      outcome = this.applyReject(filePath, entry);
    } catch (err) {
      this.log.appendLine(`[ERROR] reject ${filePath}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate: Could not restore ${path.basename(filePath)} — ${(err as Error).message}`
      );
      return;
    }
    rejectEntry(this.session!, filePath, after, new Date().toISOString());
    if (outcome === "left") {
      vscode.window.showInformationMessage(
        `Claude Gate: left "${path.basename(filePath)}" on disk (created outside Claude Code — not auto-deleted).`
      );
    }
    this.log.appendLine(`[INFO] Rejected: ${filePath}`);
    this.persist();
  }
```

In `rejectFolder` and `rejectAll`, replace the inner try body:

```ts
      try {
        if (entry.originalContent === null) fs.unlinkSync(fp);
        else this.atomicWrite(fp, entry.originalContent, true);
      } catch (err) { ... }
```

with (track how many were left on disk):

```ts
      try {
        if (this.applyReject(fp, entry) === "left") left++;
      } catch (err) {
        errors.push(`${path.basename(fp)}: ${(err as Error).message}`);
        this.log.appendLine(`[ERROR] reject failed for ${fp}: ${(err as Error).message}`);
        continue;
      }
```

Declare `let left = 0;` next to `let count = 0;` in each, and after the existing error toast add:

```ts
    if (left > 0) {
      vscode.window.showInformationMessage(
        `Claude Gate: left ${left} file(s) created outside Claude Code on disk (not auto-deleted).`
      );
    }
```

- [ ] **Step 6: Append the reject matrix to the integration test**

In `src/sessionManager.test.ts`, before the final `console.log("done")`, add:

```ts
// reject matrix for null baselines: confident-new deletes; uncertain leaves.
{
  const { ws, sp } = newEnv();
  const del = path.join(ws, "created.ts");
  fs.writeFileSync(del, "hi");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(del, null, true);   // confident new (hook path)
  sm.rejectFile(del);
  assert.ok(!fs.existsSync(del), "confident-new reject deletes the file");
  sm.stopWatching();

  const { ws: ws2, sp: sp2 } = newEnv();
  const keep = path.join(ws2, "maybe-real.ts");
  fs.writeFileSync(keep, "user data");
  const sm2 = new SessionManager(fakeLog, ws2);
  sm2.startWatching();
  sm2.trackFileChange(keep, null);       // uncertain (watcher path, newFile=false)
  sm2.rejectFile(keep);
  assert.ok(fs.existsSync(keep), "uncertain-new reject leaves the file on disk");
  assert.equal(fs.readFileSync(keep, "utf-8"), "user data", "file content untouched");
  assert.ok(readSession(sp2).rejected[keep], "still recorded as rejected");
  sm2.stopWatching();
  console.log("ok - reject deletes only confident-new files");
}
```

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck && npm run compile && npm test`
Expected: all green — hook suite (14), TS suites incl. the new reject-matrix assertions.

```bash
git add src/reviewModel.ts hooks/hook.py hooks/tests/test_hook.py src/sessionManager.ts src/sessionManager.test.ts
git commit -m "fix: reject deletes only confident-new files (watcher delete-safety)"
```

---

### Task 3: UX — no blank diff on a no-op pending file

**Files:**
- Modify: `src/diffProvider.ts` (`openDiff`)

**Interfaces:**
- Consumes: `sessionManager.hasRealPendingChange(filePath)`.

- [ ] **Step 1: Guard `openDiff` for pending no-ops**

In `src/diffProvider.ts`, at the start of `openDiff` (after `const entry = session.files[filePath];` guard, before building the diff), add:

```ts
  // A pending entry whose baseline already equals disk (a transient no-op, not
  // yet pruned) would open a blank diff — show a note instead.
  if (!sessionManager.hasRealPendingChange(filePath)) {
    vscode.window.showInformationMessage(
      `Claude Gate: no changes to review in ${path.basename(filePath)}.`
    );
    return;
  }
```

(`openDiff` only handles pending file entries — record diffs go through `openReviewRecord`, which is unaffected. `hasRealPendingChange` returns `false` for a non-pending/absent entry too, which is fine here since this path is only reached for a pending file.)

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck && npm run compile && npm test`
Expected: all green (no test change; this is a UI guard verified manually in the Extension Host — clicking a no-op pending row shows the info message instead of a blank diff).

```bash
git add src/diffProvider.ts
git commit -m "feat: show a note instead of a blank diff for no-op pending files"
```

---

### Task 4: CI workflow + changelog

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: Add the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: npm ci
      - run: npm run typecheck
      - run: npm run compile
      - run: npm test
```

- [ ] **Step 2: Verify the commands the workflow runs pass locally**

Run: `npm ci && npm run typecheck && npm run compile && npm test`
Expected: all steps exit 0 (this mirrors the CI job).

- [ ] **Step 3: Extend the changelog**

In `CHANGELOG.md`, under the existing `## [1.3.1]` → `### Fixed` list, add:

```markdown
- **The file watcher can no longer delete a real file on reject.** A file the watcher captured as "new" without a prior snapshot (e.g. an atomic save over an existing file) is no longer deleted when rejected — only files confidently known to be new (created via Claude's hook) are removed; uncertain ones are left on disk with a note.
- **No more blank diffs.** Clicking a pending file that has no real change (a transient no-op) now shows a short note instead of an empty diff.
```

And add an `### Internal` subsection under `## [1.3.1]`:

```markdown
### Internal

- Added a GitHub Actions CI workflow (typecheck, compile, unit + hook tests) and a dependency-free integration-test harness for `SessionManager`.
```

- [ ] **Step 4: Verify + commit**

Run: `node -e "require('./package.json')" && npm run typecheck`
Expected: valid JSON, typecheck clean.

```bash
git add .github/workflows/ci.yml CHANGELOG.md
git commit -m "ci: add GitHub Actions workflow; document 1.3.1 safety/UX fixes"
```

---

## Self-Review

**Spec coverage:** Part A (newFile flag → hook Task 2 Step 2, FileEntry Task 2 Step 1, trackFileChange Task 2 Step 4, applyReject + reject sites Task 2 Step 5, migration = default-false via optional field) ✓; Part B1 (CI) → Task 4 ✓; Part B2 (vscode stub + integration tests) → Task 1 + Task 2 Step 6 ✓; Part C (empty-diff guard) → Task 3 ✓; changelog → Task 4 ✓.

**Placeholder scan:** the `catch (err) { ... }` in Task 2 Step 5's "replace this" block is quoted *existing* code being replaced, not new code — the replacement below it is complete. No other ellipses in new code.

**Type consistency:** `newFile?: boolean` defined in Task 2 Step 1, written by the hook (Task 2 Step 2), threaded via `trackFileChange(..., newFile = false)` (Task 2 Step 4), read in `applyReject` (Task 2 Step 5); `hasRealPendingChange` (Task 3) matches its existing signature; the esbuild `--alias:vscode=./src/test-stubs/vscode.ts` flag is identical in Task 1 Step 3, Step 4, and the `test:unit` chain.
