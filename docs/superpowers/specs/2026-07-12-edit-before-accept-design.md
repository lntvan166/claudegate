# Edit-before-accept: honor unsaved edits on Accept

**Date:** 2026-07-12
**Status:** Approved (brainstorming) — pending implementation plan

## Summary

When reviewing a pending change, ClaudeGate opens a diff whose **right pane is the
live on-disk file** (`vscode.Uri.file(filePath)`), so it is already editable — a
user can tweak Claude's change before accepting it. But Accept captures the "after"
content by reading disk (`fs.readFileSync` via `SessionManager.readFileOrNull`). If
the user edits the right pane and does **not** save, Accept reads stale disk content
and the edits are silently lost.

This feature closes that gap: **on Accept, save any dirty editor for the affected
file(s) first, then read disk as today.** Disk always equals the accepted content.

This is effectively a data-loss bugfix, not a new UI surface.

## Goals

- Editing the right pane of a pending diff and clicking Accept (without a manual
  Save) records the edited content as the accepted `after` and leaves it on disk.
- No behavior change when nothing is dirty.
- Works for new files (`originalContent === null`) identically — no special-casing.

## Non-goals (YAGNI)

- **Reject stays untouched.** Reject means "discard Claude's change," so discarding
  any unsaved edits along with it is the correct semantics.
- **No discoverability UI.** No title hint, no toast. The capability works; power
  users find it. (Explicitly decided during brainstorming.)
- **No hunk-level / partial accept.** Separate, larger feature.

## Current behavior (grounding)

- `src/diffProvider.ts` `openDiff()` — left pane is the read-only `claudegate:`
  virtual baseline; right pane is `vscode.Uri.file(filePath)`, the real editable
  file. (diffProvider.ts:139–158)
- `src/sessionManager.ts` accept methods are **synchronous** and capture `after`
  via `this.readFileOrNull(fp)` (reads disk):
  - `acceptFile` (sessionManager.ts:160)
  - `acceptFolder` (sessionManager.ts:176) — iterates `session.files` keys under
    `folderPath + path.sep`
  - `acceptAll` (sessionManager.ts:194) — iterates all in-workspace pending keys
- `src/extension.ts` command handlers (already `async`):
  - `claudegate.acceptFile` (extension.ts:344)
  - `claudegate.acceptCurrent` (extension.ts:366) — delegates to `acceptFile`
  - `claudegate.acceptFolder` (extension.ts:389)
  - `claudegate.acceptAll` (extension.ts:470)

## Design (Approach A — save at the command layer)

Keep `SessionManager` a pure, synchronous disk/session engine. Do the save at the
vscode boundary, in the already-async command handlers, before delegating to the
sync accept method.

### New helper

A small async helper (new file `src/saveEdits.ts`, or colocated near the command
registrations) with no `SessionManager` dependency:

```ts
// Saves any open, dirty text documents whose path is in `scope`.
// Case-tolerant on win32 to match hook-stored session keys (drive-letter case
// can differ from Uri.file). Returns after all saves settle.
export async function saveDirtyPending(scope: Iterable<string>): Promise<void> {
  const caseInsensitive = process.platform === "win32";
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const want = new Set([...scope].map(fold));
  const dirty = vscode.workspace.textDocuments.filter(
    (d) => d.isDirty && want.has(fold(d.uri.fsPath))
  );
  await Promise.all(dirty.map((d) => d.save()));
}
```

### Scope set per command

The scope (which pending paths to save) is derived in the handler from
`manager.getSession()?.files`:

| Command | Scope passed to `saveDirtyPending` |
|---|---|
| `acceptFile` / `acceptCurrent` | `[filePath]` |
| `acceptFolder` | pending keys under `folderPath + path.sep` (reuse `pathIsUnder` from `workspaceScope.ts`, or the same `startsWith(prefix)` test `acceptFolder` uses) |
| `acceptAll` | all pending keys (`Object.keys(session.files)`) |

Saving is deliberately restricted to **pending** paths in scope: an unrelated dirty
file the user happens to have open is never force-saved by an Accept.

### Control flow (example — acceptFile)

```ts
// extension.ts, claudegate.acceptFile handler
await saveDirtyPending([filePath]);
managerFor(filePath).acceptFile(filePath); // unchanged, still sync, reads disk
```

`SessionManager` accept methods and `readFileOrNull` are **unchanged**. Because the
save resolves before the sync accept runs, `readFileOrNull` now reads the just-saved
(edited) content.

## Why not Approach B (save inside SessionManager)

Making each accept method `async` to `await` a save turns the tested session API
async, rippling into `acceptCurrent` and every `acceptFile/Folder/All` unit test.
Approach A keeps the save (a UI concern) at the vscode boundary and the session
engine synchronous and untouched.

## Edge cases

- **Nothing dirty** → `dirty` is empty, `saveDirtyPending` resolves immediately,
  behavior identical to today.
- **New file** (`originalContent === null`) → the right pane is still the on-disk
  file; save + read disk captures edits the same way. No special-casing.
- **Accept All / Folder with several dirty pending files** → all in-scope dirty docs
  are saved concurrently before the (still synchronous) accept loop reads them.
- **File open but not dirty** → skipped (no needless save / file-watcher churn).
- **Save failure** (e.g. read-only file) → `d.save()` rejects; the handler should
  not silently accept stale content. Surface a warning and abort that file's accept
  (decide exact handling in the plan; simplest: let the rejection propagate so the
  Accept does not proceed, matching "don't lose edits").

## Testing

**Unit (`src/saveEdits.test.ts`, add to `test:unit` in `package.json`):**
- Dirty doc whose path is in scope → `save()` called.
- Dirty doc whose path is **not** in scope → `save()` not called.
- Clean (non-dirty) in-scope doc → `save()` not called.
- win32 drive-letter case mismatch between scope path and `uri.fsPath` → still
  matched and saved.
- Uses the `vscode` test stub (`src/test-stubs/vscode.ts`), extended with a
  `textDocuments` fixture exposing `isDirty`, `uri.fsPath`, and a spy `save()`.

**Manual:**
- Open a pending diff, edit the right pane, do **not** save, click Accept →
  Accepted panel's `after` and the on-disk file both show the edit.
- Repeat for a new-file change, and for Accept All with two edited files.

## Files touched

- `src/saveEdits.ts` — new helper.
- `src/extension.ts` — call `saveDirtyPending(scope)` in the four accept handlers.
- `src/saveEdits.test.ts` — new unit test; register in `package.json` `test:unit`.
- `src/test-stubs/vscode.ts` — extend stub with `workspace.textDocuments` if needed.

No changes to `SessionManager`, `readFileOrNull`, reject, or the session schema.
