# Review All Pending — Multi-File Diff View

**Date:** 2026-07-05
**Status:** Approved for implementation
**Related:** `package.json`, `src/extension.ts`, `src/diffProvider.ts` (reuses `originalUri`); research item #6

## Goal

A single command that opens **all pending Claude changes** in VS Code's multi-file diff editor (one scrollable tab, original ↔ current per file), so multi-file refactors are easy to scan. View-only.

## API (verified)

VS Code's built-in `vscode.changes` command opens the multi-diff editor:
```
executeCommand("vscode.changes", title: string, resourceList: [Uri, Uri, Uri][])
```
Each entry is `[resourceUri, originalUri, modifiedUri]` (resource for label/icon, left, right). This is a **semi-internal** command — callable via `executeCommand` at runtime but not in the public type defs and its `resourceList` shape is undocumented (it's the established ecosystem form). So the call is wrapped in try/catch with a graceful fallback.

## Product Decisions

- **View-only** — no accept/reject inside the multi-diff. The panel and keyboard shortcuts (`Cmd+Enter`/`Cmd+Backspace` on the focused sub-diff) remain the way to decide.
- **Reuse existing pieces** — the left side is `originalUri(fp)` (the `claudegate:` baseline served by `ClaudeGateContentProvider`, incl. the "// New file" placeholder for new files); the right side is `Uri.file(fp)` (current on disk); filtering is the existing `pending ∧ isInWorkspace ∧ !isExcluded`.
- **Ordering** — protected-first then by path, consistent with the tree.
- **Folds into unreleased `1.3.0`** — extend the existing CHANGELOG entry; no version bump.

## Components

### Modified: `src/extension.ts`

New command `claudegate.reviewAllPending`:
1. From `sessionManager.getSession()`, collect pending file paths where `isInWorkspace(fp) && !isExcluded(fp)`.
2. Sort protected-first then by path: `(Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)`.
3. If none → `vscode.window.showInformationMessage("Claude Gate: no pending changes to review.")` and return.
4. Build `resourceList = paths.map(fp => [vscode.Uri.file(fp), originalUri(fp), vscode.Uri.file(fp)])`.
5. `try { await executeCommand("vscode.changes", \`Claude Gate: Pending (${paths.length})\`, resourceList) } catch { showWarningMessage("Claude Gate: the multi-file diff view isn't available in this VS Code version.") }`.

Imports: `originalUri` from `./diffProvider`; `isInWorkspace`, `isExcluded`, `isProtected` are already imported.

### Modified: `package.json`

- `contributes.commands`: add `{ "command": "claudegate.reviewAllPending", "title": "Claude Gate: Review All Pending", "icon": "$(diff-multiple)" }`.
- `contributes.menus.view/title`: add `{ "command": "claudegate.reviewAllPending", "when": "view == claudegate.pendingPanel", "group": "navigation@5" }` (appears in the Pending panel title bar after the existing actions). Palette-visible (no argument), so no `commandPalette` hide.

### Unchanged

`diffProvider` (already exports `originalUri`), `sessionManager`, `reviewPanel`, matchers — no changes.

## Error Handling

- No pending files → info toast, no error.
- `vscode.changes` unavailable / throws → caught, warning toast; no crash.
- A file deleted between collection and open → VS Code shows it as missing in the multi-diff; harmless (rare).

## Testing

**Automated:** `npm run typecheck` and `npm run compile` pass; `npm run test:unit` unaffected.

**Manual (Extension Development Host):**
1. With several pending files, run **Review All Pending** (title button or palette) → a single multi-diff tab opens showing every pending file's original ↔ current; protected files appear first.
2. A pending new file shows the "// New file" placeholder on the left.
3. Excluded / out-of-workspace / accepted / rejected files are **not** included.
4. No pending files → info toast, no tab.
5. Keyboard accept/reject still works on the focused sub-diff.

## Release

- **No version bump** — folds into unreleased `1.3.0`; extend the `## [1.3.0]` CHANGELOG **Added** list with the Review-All-Pending multi-diff.
- README: mention the "Review All Pending" action in the review-flow section.
