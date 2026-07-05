# Watcher Delete-Safety + Test/CI Hardening + UX Polish (1.3.1)

**Date:** 2026-07-05
**Status:** Approved for implementation
**Related:** `hooks/hook.py`, `src/documentTracker.ts`, `src/sessionManager.ts`, `src/reviewModel.ts`, `src/diffProvider.ts`, `hooks/tests/test_hook.py`, `src/reviewModel.test.ts`, `.github/workflows/ci.yml` (new), `src/test-stubs/vscode.ts` (new), `src/sessionManager.test.ts` (new), `package.json`, `CHANGELOG.md`

Three folded-in improvements for the already-in-progress 1.3.1 patch. All share the release's data-safety/robustness theme; none change the version beyond 1.3.1.

## Part A — DocumentTracker delete-safety

**Problem.** A `null` baseline authorizes reject to `fs.unlinkSync` the file (assumed Claude-created). The hook now sets `null` only for genuinely-absent files, but the opt-in DocumentTracker's create-without-snapshot branch (`documentTracker.ts:169-171`) records `null` for a file whose prior existence it can't know — an atomic-replace (temp+rename) of an existing file is reported as a create on some platforms. Rejecting such an entry deletes a real user file.

**Design — a confidence flag; deletion requires confidence.**

- `FileEntry` gains `newFile?: boolean`. It means "the extension is confident this file did not exist before capture, so reject may delete it."
- `hook.py`: when it records `originalContent: null` (the existence check found the file absent), it also writes `"newFile": true`.
- `documentTracker`: the create-without-snapshot branch records `null` **without** `newFile` (origin uncertain).
- `SessionManager.trackFileChange(filePath, originalContent, newFile = false)` — third param stored on the entry.
- **Reject** (all sites — `rejectFile`, `rejectFolder`, `rejectAll`):
  - `originalContent !== null` → restore baseline via `atomicWrite` (unchanged).
  - `originalContent === null && entry.newFile === true` → `fs.unlinkSync` (confident new — unchanged behavior for the hook path).
  - `originalContent === null && !entry.newFile` → **do not delete.** Leave the file on disk, still move the entry to the Rejected store (with `after` = current content, so nothing is lost), and show one info message: `Claude Gate: left "<name>" on disk (created outside Claude Code — not auto-deleted).`
- **Migration:** existing `null` entries without `newFile` default to the safe (no-delete) path. Sessions are transient; a lingering pre-1.3.1 new file can be deleted manually.

**Scope note:** this makes reject *safe* on the watcher path; it does not make the watcher able to distinguish new-vs-replaced (that would need a pre-existing snapshot). Watcher-created genuinely-new files, when rejected, are left on disk by design.

## Part B — Test & CI hardening

**B1 — CI workflow (new `.github/workflows/ci.yml`).** On push and pull_request: checkout, set up Node (match `engines`/the dev Node) + Python 3, `npm ci`, `npm run typecheck`, `npm run compile`, `npm test`. `npm test` already chains the TS unit suites and the Python hook suite. No new dependencies.

**B2 — `sessionManager` integration tests (dependency-free).** `sessionManager` uses only ~7 `vscode.` members (an `EventEmitter`, `window.showErrorMessage`/`showWarningMessage`, `window.showInformationMessage`). Add:
- `src/test-stubs/vscode.ts` — a minimal hand-written stub exporting a working `EventEmitter` (subscribe/fire) and a no-op `window` with the used methods. No runtime dependency.
- `src/sessionManager.test.ts` — bundled with esbuild using `--alias:vscode=./src/test-stubs/vscode.ts`, exercising a real `SessionManager` against a temp `HOME`/session dir with real `fs`. Cover: accept → record appended + working file untouched; reject (existing file) → baseline restored on disk (atomic) + record in `rejected`; reject (`newFile:true`) → file deleted; reject (`null` without `newFile`) → file **kept** + record in `rejected`; reconcile prunes a settled no-op but keeps a real change; merge-on-write recovers a concurrent-hook capture written directly to the session file while preserving an accept.
- `package.json`: add the build+run of `sessionManager.test.ts` to the `test:unit` chain (esbuild with the vscode alias → node).

## Part C — UX polish

**Empty-diff-on-click.** `openDiff(filePath)` for a pending entry whose baseline equals the current disk content (a transient no-op, before the reconcile prunes it) currently opens a blank diff. Instead, when `!sessionManager.hasRealPendingChange(filePath)` for a pending file, show `vscode.window.showInformationMessage("Claude Gate: no changes to review in <name>.")` and return without opening the diff. (Record diffs and real pending diffs are unaffected.)

Accepted-log growth is **out of scope** (YAGNI): *Clear All Accepted* already exists and the reconcile keeps Pending clean.

## Data Model Delta

```ts
interface FileEntry {
  originalContent: string | null;
  reviewStatus: "pending";
  newFile?: boolean;      // NEW: true ⇒ confident the file didn't exist ⇒ reject may delete
  sessionId?: string;
  capturedAt?: string;
}
```
`mergeFreshCaptures`, `acceptEntry`, `rejectEntry`, `hasRealChange`, `shouldPruneNoOp` are unchanged in signature; `newFile` rides along on the entry.

## Error Handling

- Part A: if `unlinkSync` fails on a confident-new reject, the existing try/catch reports it (unchanged). The uncertain-null path performs no destructive fs op, so it can't fail destructively.
- Part B: the vscode stub only implements what `sessionManager` uses; if a future call hits an unimplemented member the test fails loudly (acceptable — signals the stub needs extending).

## Performance

- No activation-path change. `newFile` is a plain field (no I/O). The empty-diff guard reads disk once on a user click (same as the diff it replaces). CI runs off-machine.

## Testing

**Automated (`npm test`, now including `sessionManager.test.ts`):**
1. `hook.py`: a null-recording (absent file) capture also sets `newFile: true` (extend an existing new-file test to assert the flag).
2. `sessionManager` integration (Part B2 list above), including the `newFile` reject matrix and merge-on-write.
3. Existing suites stay green.

**Manual (Extension Development Host):**
4. With the file watcher enabled, have a non-Claude tool create a file → it appears pending; **reject → the file is deleted** only if captured as confident-new (hook path); a watcher-uncertain new file is **left on disk** with the info message.
5. Click a pending file with no real change → info message, no blank diff.
6. CI: push a branch → the Actions run is green.

## Release

- Stays **1.3.1** (already bumped). Extend the `## [1.3.1]` CHANGELOG **Fixed** list: watcher-path reject no longer risks deleting a real file; add a **Changed/Internal** note for CI + integration tests if desired. Update the existing "null reliably means didn't exist" wording — with `newFile`, the delete-safety now holds on both paths.
