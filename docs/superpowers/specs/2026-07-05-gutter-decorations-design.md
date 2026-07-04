# Gutter Decorations for Claude's Changed Lines

**Date:** 2026-07-05
**Status:** Approved for implementation
**Related:** `src/gutterDecorations.ts` (new), `src/lineDiff.ts` (new), `src/extension.ts`, `package.json`, `media/`; research item #2

## Goal

While viewing/editing a file that has a **pending** Claude change, show — in the editor gutter and overview ruler — which lines Claude changed vs the frozen baseline (`originalContent`), so you get inline awareness without opening the diff.

## Why not QuickDiffProvider

The clean standalone `window.registerQuickDiffProvider` is a **proposed API** (unshippable in a marketplace extension); the only stable quick-diff path is SCM-bound (`SourceControl.quickDiffProvider`), which forces creating a Source Control provider entry and may conflict with git's gutter diff. We already have the baseline + the `diff` lib, so we render our **own** decorations via the fully-stable `TextEditorDecorationType` API — no SCM entry, no proposed API, no git conflict.

## Product Decisions

- **3-way classification** (matches native quick-diff): added (green), modified (blue), deleted (red triangle).
- **On by default** — `claudegate.gutterDecorations.enabled` defaults to `true`.
- **Pending files only** — decorations show for `pending ∧ isInWorkspace ∧ !isExcluded` files; they naturally clear when a file is accepted (baseline advances → no diff) or rejected (restored).
- **Self-rendered, stable APIs only** — `TextEditorDecorationType` with bundled gutter SVGs + `ThemeColor` overview-ruler.

## Components

### New: `src/lineDiff.ts` (vscode-free, unit-tested)

```typescript
import { diffLines } from "diff";
export interface ChangedLines { added: number[]; modified: number[]; deleted: number[] }
// Walk diffLines(original, current); return 0-based CURRENT-document line indices.
//   removed-block immediately followed by added-block → those added lines are `modified`
//   lone added-block → `added`
//   lone removed-block → `deleted` = the boundary line in the current doc (clamped to [0, lastLine])
export function classifyChangedLines(original: string, current: string): ChangedLines;
```
Walk algorithm: track `cur` (current-doc line index). For a `removed` part, if the next part is `added` → mark those `next.count` lines `modified`, advance `cur` by `next.count`, skip both parts; else record a deletion at `min(cur, lastLine)` (clamp; if the doc is empty, `0`). For an `added` part (not consumed as modified) → mark `cur..cur+count-1` `added`, advance. For unchanged → advance `cur`. `lastLine = max(0, current.split("\n").length - 1)` (or the doc's line count − 1).

### New: `src/gutterDecorations.ts` (`GutterDecorator`)

`class GutterDecorator` with `start()` / `stop()` (mirrors `DocumentTracker`). Owns three `vscode.TextEditorDecorationType`s created once:
- `added` — `gutterIconPath: media/gutter-added.svg`, `overviewRulerColor: new ThemeColor("editorGutter.addedBackground")`, `overviewRulerLane: Left`, `gutterIconSize: "contain"`.
- `modified` — `media/gutter-modified.svg`, `ThemeColor("editorGutter.modifiedBackground")`.
- `deleted` — `media/gutter-deleted.svg`, `ThemeColor("editorGutter.deletedBackground")`.

Behavior:
- `refresh(editor)`: if not `file` scheme → return. `entry = session.files[fsPath]`. If the feature is enabled AND `entry?.reviewStatus === "pending"` AND `isInWorkspace(fsPath)` AND `!isExcluded(fsPath)` → `const c = classifyChangedLines(entry.originalContent ?? "", editor.document.getText())` → set each decoration type to the `Range`s for `c.added`/`c.modified`/`c.deleted` (each a whole-line `new vscode.Range(line, 0, line, 0)`). Else set all three to `[]` (clear).
- `refreshAllVisible()`: apply to every `vscode.window.visibleTextEditors`.
- Subscriptions (all pushed to an internal disposables array, disposed in `stop()`): `onDidChangeActiveTextEditor` → refresh that editor; `onDidChangeVisibleTextEditors` → refreshAllVisible; `onDidChangeTextDocument` → debounced (~300ms) refresh of the visible editors whose document changed; `sessionManager.onSessionChange` → refreshAllVisible.
- `start()`: `refreshAllVisible()` then register the subscriptions. `stop()`: dispose subscriptions + the three decoration types + clear the debounce timer.

Reads `claudegate.gutterDecorations.enabled` via `getConfiguration` at refresh time (default `true`).

### New assets: `media/gutter-added.svg`, `media/gutter-modified.svg`, `media/gutter-deleted.svg`

Small fixed-color marks (a vertical bar for added/modified, a small triangle for deleted) with colors that read on light + dark (e.g. green `#2ea043`, blue `#0969da`/`#4ea1f0`, red `#cf222e`). Shipped (`.vscodeignore` only excludes `media/icon.svg` + `media/icon-activity.svg`).

### Modified: `package.json`

Add `claudegate.gutterDecorations.enabled` (boolean, default `true`, description: shows Claude's changed lines in the gutter/overview ruler for pending files; turn off to hide).

### Modified: `src/extension.ts`

Construct `const gutterDecorator = new GutterDecorator(sessionManager, log)`; `gutterDecorator.start()`; `context.subscriptions.push({ dispose: () => gutterDecorator.stop() })` (mirroring `DocumentTracker`). Refresh on the `claudegate.gutterDecorations.enabled` config change (add to a config listener, or the GutterDecorator subscribes itself). `GutterDecorator` imports `isInWorkspace`/`isExcluded` from `./workspaceScope` directly, so no new wiring beyond construction.

### Unchanged

`sessionManager`, `reviewPanel`, `documentTracker`, `diffProvider`, matchers — no changes.

## Error Handling

- `classifyChangedLines` on `originalContent === null` (new file) uses `""` as the baseline → all current lines are `added`.
- Reading `editor.document.getText()` is in-memory (no fs), can't fail; a missing session entry → clear.
- Debounce guards against per-keystroke recompute cost on large files.
- Decoration types disposed in `stop()` (no leak); subscriptions in the internal disposables array.

## Testing

**Automated (`test:unit`):**
1. `classifyChangedLines("a\nb\nc\n", "a\nB\nc\n")` → `{ added: [], modified: [1], deleted: [] }` (line 1 modified).
2. Pure insert: `classifyChangedLines("a\nc\n", "a\nb\nc\n")` → `{ added: [1], modified: [], deleted: [] }`.
3. Pure delete: `classifyChangedLines("a\nb\nc\n", "a\nc\n")` → `deleted` contains the boundary line (`[1]`), `added`/`modified` empty.
4. No change: all three empty.
5. New file (`original = ""`): every current line in `added`.

**Manual (Extension Development Host):**
6. Claude edits a file → open it → changed lines show gutter bars (green/blue) + overview-ruler ticks; a deletion shows the red triangle.
7. Accept the file → decorations clear (baseline advanced). Reject → clear (restored).
8. `claudegate.gutterDecorations.enabled: false` → no decorations; back to `true` → they return.
9. Excluded / out-of-workspace files show no decorations.

## Release

- **No version bump** — folds into unreleased `1.3.0`; extend the `## [1.3.0]` CHANGELOG **Added** list.
- README: mention gutter decorations in the review-flow / features.
