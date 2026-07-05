# Per-Hunk Revert (CodeLens)

**Date:** 2026-07-05
**Status:** Approved for implementation
**Related:** `src/hunks.ts` (new), `src/hunkCodeLens.ts` (new), `src/extension.ts`, `package.json`, `src/lineDiff.ts` (sibling); research item #3

## Goal

Let the user **revert an individual hunk** of a pending file — undo just those lines back to the frozen baseline (`originalContent`), leaving the file's other Claude changes intact — via a **"↩ Revert this change" CodeLens** above each hunk in the editor.

## Product Decisions

- **Revert-only** (no per-hunk accept). A change left in place is accepted when you Accept the file; there is no per-hunk "accept" or per-hunk reviewed state.
- **CodeLens surface** — one lens per hunk at the hunk's start line, in the normal editor (CodeLens doesn't render in the diff editor). Pairs with the gutter marks (feature #4).
- **Revert via `WorkspaceEdit`** on the open document (the CodeLens only appears when the doc is open), so **`Cmd/Ctrl+Z` undoes it**. **No confirmation prompt** (granular + undoable, like git "discard hunk").
- **Baseline stays frozen** — reverting rewrites the working file only; `originalContent` is untouched. Whole-file Accept still checkpoints whatever remains.
- **Reverting the last remaining hunk** (result equals baseline) → the file is treated as fully rejected (moves to Rejected, `claudeContent` saved for re-apply).
- **Toggle** — `claudegate.hunkCodeLens.enabled` (boolean, default `true`).
- **Folds into unreleased `1.3.0`.**

## Components

### New: `src/hunks.ts` (pure, vscode-free, unit-tested)

```typescript
import { diffLines } from "diff";
export interface Hunk { startLine: number; label: string } // startLine = 0-based current-doc line for the lens; label e.g. "+2 −1"
export function computeHunks(original: string, current: string): Hunk[];
export function revertHunkText(original: string, current: string, hunkIndex: number): string;
```
- `computeHunks`: walk `diffLines(original, current)`; a **hunk** = a maximal run of consecutive changed parts (`added`/`removed`) bounded by unchanged runs. For each hunk record `startLine` (the current-doc line where it begins; for a pure deletion, the boundary line, clamped) and `label` (`+A −R` from that hunk's added/removed counts). Hunk ordinals are the order returned.
- `revertHunkText`: recompute `diffLines(original, current)` (deterministic → same hunk ordinals), then rebuild the **whole file text** emitting the *current* side for every part **except** the parts belonging to `hunkIndex`, for which it emits the *original* side. Returns the new full text. (Whole-text rebuild avoids fragile per-line range/newline math; the command applies it as one edit.) Preserves the input's trailing-newline convention.

### New: `src/hunkCodeLens.ts` (`HunkCodeLensProvider implements vscode.CodeLensProvider`)

- `provideCodeLenses(document)`: if `document.uri.scheme !== "file"` → `[]`. Read `claudegate.hunkCodeLens.enabled` (default true); `entry = session.files[fsPath]`. If not enabled, or `entry?.reviewStatus !== "pending"`, or `!isInWorkspace(fsPath)`, or `isExcluded(fsPath)` → `[]`. Else `computeHunks(entry.originalContent ?? "", document.getText())` → for each hunk `h` at index `i`, a `CodeLens(new vscode.Range(h.startLine, 0, h.startLine, 0), { title: \`↩ Revert this change · ${h.label}\`, command: "claudegate.revertHunk", arguments: [document.uri, i] })`.
- `refresh()` fires `_onDidChangeCodeLenses`; the provider subscribes to `sessionManager.onSessionChange` and `vscode.workspace.onDidChangeTextDocument` (so lenses track edits) — both call `refresh()`.
- Registered via `vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider)`.

### New command: `claudegate.revertHunk(uri: vscode.Uri, hunkIndex: number)` (in `extension.ts`)

1. `entry = sessionManager.getSession()?.files[uri.fsPath]`; if `entry?.reviewStatus !== "pending"` → return.
2. `const doc = await vscode.workspace.openTextDocument(uri)`; `const current = doc.getText()`.
3. `const newText = revertHunkText(entry.originalContent ?? "", current, hunkIndex)`.
4. **Full-revert (last hunk):** if `newText === (entry.originalContent ?? "")` → the file is now fully back to baseline. Do **not** apply a WorkspaceEdit; instead call `sessionManager.rejectFile(uri.fsPath)` and return. `rejectFile` already saves the current on-disk content as `claudeContent` (so **Re-apply** still works) and restores the baseline to disk / deletes the file if it was a new file — exactly the right behavior, reusing existing code with no change to `SessionManager`.
5. **Partial revert:** else apply a `WorkspaceEdit` that replaces the whole document (`new vscode.Range(0, 0, doc.lineCount, 0)`) with `newText`, `await vscode.workspace.applyEdit(edit)`, then `await doc.save()`. The file stays pending; `sessionManager.notifyChanged()` refreshes panels/decorations/lenses; the frozen `originalContent` is unchanged.
- No confirmation prompt. Undoable via editor undo (WorkspaceEdit). Replacing the whole document (rather than a per-hunk range) avoids fragile line/newline math; `revertHunkText` already produced the exact target text.

### Modified: `package.json`

Add `claudegate.hunkCodeLens.enabled` (boolean, default `true`, description: show a "Revert this change" CodeLens above each of Claude's hunks in pending files).

### Modified: `src/extension.ts`

Construct `HunkCodeLensProvider(sessionManager)`, register it via `languages.registerCodeLensProvider` (push to subscriptions), and register the `claudegate.revertHunk` command. Imports: `computeHunks`/`revertHunkText` (used by the provider/command), `isInWorkspace`/`isExcluded` (already imported).

### Unchanged

`sessionManager` public API, `reviewPanel`, `diffProvider`, `gutterDecorations`, matchers — no changes (the command reuses existing reject behavior for the full-revert case).

## Error Handling

- Stale `hunkIndex` (doc changed between lens render and click): `revertHunkText` clamps — if `hunkIndex` is out of range for the freshly recomputed hunks, the command no-ops (logs at WARN). Lenses refresh on doc change, so this is rare.
- `originalContent === null` (new file): baseline is `""`; reverting a hunk of a new file removes those added lines; reverting all → empty file == baseline `""` → full-reject path (which deletes the new file, per existing reject-of-new-file behavior).
- `applyEdit`/`save` failure → caught, `showErrorMessage`, no partial state (WorkspaceEdit is atomic).

## Testing

**Automated (`test:unit`, extend the chain to run `src/hunks.test.ts`):**
1. `computeHunks` returns one hunk with correct `startLine`/`label` for a single modified line; multiple separated hunks return multiple entries with correct start lines.
2. `revertHunkText("a\nb\nc\n", "a\nB\nc\n", 0)` → `"a\nb\nc\n"` (revert the only hunk = baseline).
3. Two-hunk file: reverting hunk 0 restores hunk 0's baseline lines but **keeps** hunk 1's change; reverting hunk 1 keeps hunk 0's change.
4. Pure addition hunk revert removes the added lines; pure deletion hunk revert re-inserts the deleted baseline lines.
5. New file (`original = ""`): `revertHunkText` of the sole hunk → `""`.

**Manual (Extension Development Host):**
6. Open a pending file with ≥2 hunks → a "↩ Revert this change" CodeLens sits above each; clicking one reverts just that hunk (others remain), gutter marks + diff update, and `Cmd+Z` undoes it.
7. Revert the last remaining hunk → the file moves to Rejected (fully back to baseline); Re-apply still works.
8. `claudegate.hunkCodeLens.enabled: false` → no lenses.
9. Excluded / non-pending files show no lenses.

## Release

- **No version bump** — folds into unreleased `1.3.0`; extend the `## [1.3.0]` CHANGELOG **Added** list.
- README: mention per-hunk revert in the review-flow / features.
