# Review Changes → review queue + native diff

**Date:** 2026-07-11
**Status:** approved

## Problem

The "Review Changes" webview (added in 1.6.0) renders diffs with a hand-written
HTML diff engine (`computeDiffPieces` + split/unified rendering in `review.js`).
It reimplements what VS Code's diff editor already does, and does it worse:

- long lines overflow the viewport with no working per-pane horizontal scroll
  (content bleeds under the sticky toolbar);
- no syntax highlighting;
- aggressive context folding makes real changes feel missing;
- column alignment breaks on large insertions.

## Decision

Delete the custom HTML diff renderer. Keep the webview as a **review queue**: a
summary list of the batch. All actual diffs open in **VS Code's native diff
editor**, which the extension already serves via `diffProvider` (`claudegate:`
virtual documents with real file paths for correct syntax highlighting).

Hunk-level review is **dropped entirely** (it only existed inside the custom
renderer): model functions, `applyPartial`, the `applyHunks` message, UI, and
tests are removed. Whole-file Keep/Undo only.

### Rejected alternatives

- **Full native (remove the webview):** simplest, but loses the editor-area
  aggregate panel + one-place "Feedback to AI" the user wants to keep.
- **Fix the custom renderer:** keeps a hand-maintained mini diff editor forever;
  syntax highlighting remains impractical in HTML.

## Design

### Webview panel (`reviewWebview.ts`, `review.js`, `review.css`)

- **Toolbar:** progress (`N of M reviewed` + bar), `Keep All`, `Undo All`
  (modal confirm retained), `💬 Feedback to AI` toggle + `Copy`. The
  **Split/Unified toggle is removed** (no custom diff; the native editor has its
  own layout toggle).
- **Rows:** one per file — status icon, filename, directory, `+N −M` badges,
  `⚠` for protected files. **No chevron, no inline diff.** Clicking a row (or its
  `Open diff` button) posts `openNative` → opens the native diff editor. Pending
  rows keep inline `[Keep]` `[Undo]`; decided rows show `✓ kept` / `✗ undone`
  and still open their before→after record diff on click.
- **Undo** keeps the inline optional-reason field (plain text → "Feedback to AI").
- **Keyboard:** `j`/`k` navigate, `Enter` opens the native diff (was: expand),
  `a` keep, `x` undo, `Esc` cancels the reason field. Focus ring + ARIA retained.

### Model (`reviewWebviewModel.ts`)

- Remove `computeDiffPieces`, `countHunks`, `applyHunkDecisions`, the
  `DiffPiece`/`DiffLine`/`Fold`/`HunkDecision` types, and `pieces` from
  `FileDiff`.
- `buildReviewModel` keeps: `relPath`, `isProtected`, `isNew`, `missing`,
  `noChange`, `added`, `removed`, `status`, `reason` (counts via `countChanges`).
- `buildFeedbackText` unchanged.

### SessionManager

- Remove `applyPartial`. All other methods (incl. the dual-writer merge guards)
  unchanged.

## What stays

Everything from the prior round: the data-loss fixes (settings-wipe guard,
worktree accepted/rejected reconciliation), robustness (corrupt-session
surfacing, guarded hook, self-healing size cap), binary-safe reads, bulk-action
confirmations + toasts, theme-safe CSS tokens, and the "all caught up" empty
state.

## Testing

- Update `reviewWebviewModel.test.ts`: drop `computeDiffPieces`/hunk tests;
  `buildReviewModel` test asserts counts/status/flags but no `pieces`.
- Remove the `applyPartial` test from `sessionManager.test.ts`.
- Native-diff path is exercised by existing `diffProvider` behavior (unchanged).
- Manual: open the queue, click rows → native diff opens; Keep/Undo/Undo-reason;
  Feedback-to-AI copy; keyboard nav.
