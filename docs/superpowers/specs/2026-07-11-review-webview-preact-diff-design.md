# All-in-one Review webview — Preact + react-diff-view

**Date:** 2026-07-11
**Status:** approved (design)

## Problem

Reviewers want to see **every pending change in one scrollable surface** and act on
each — accept per file, reject-with-a-note per file — while the notes accumulate
into a **Feedback-to-AI** log to paste back to the agent. VS Code's native
multi-file diff editor (today's *Review All Pending*) renders all diffs perfectly
but **cannot host per-file Keep/Reject buttons or a note field**, so this feature
requires a webview.

The 1.6.0 webview had exactly the right *function* but was **ugly and its layout
crashed**: it hand-rolled the diff as a two-column CSS grid that overflowed,
misaligned, and couldn't scroll/resize; no syntax highlighting; hardcoded dark
colors. It was reverted in 1.6.1 back to the native multi-diff.

## Goal

Rebuild that all-in-one interactive review as a webview, this time on a proper
component framework and a **battle-tested diff renderer** so the layout can't
crash — supporting **both unified and split** views, with **native VS Code
theming** and **real syntax highlighting**. Keep the native multi-diff as the
default; the webview ships behind a toggle until it's polished.

## Decision

- **Rendering stack:** **Preact** (~4 KB React-compatible) for components/state +
  **`react-diff-view`** for diff rendering (unified *and* split, alignment,
  per-side scroll, tokenized syntax highlighting via `refractor`/Prism). Never
  hand-roll diff layout again — `react-diff-view` owns it.
- **Theming:** all colors from `--vscode-*` CSS variables; Prism token classes
  remapped to VS Code editor token colors. Looks native in light/dark/HC themes.
- **Bundling:** a **separate esbuild entry** for the webview app (JSX via Preact),
  output to `media/review/`. No new build system; no external network (CSP-safe,
  everything inlined/bundled, nonce'd script).
- **Native stays default:** *Review All Pending* keeps opening the native
  multi-diff. The webview is a distinct, opt-in surface (see Rollout) so it can be
  developed and dogfooded without disrupting production.

### Rejected alternatives

- **Monaco DiffEditor per file** — editor-grade split with a draggable sash, but
  ~MBs and one heavy editor instance per file in an all-files view. Overkill here.
- **Shiki** for highlighting — exact theme match but heavier; `refractor`/Prism is
  lighter and adequate. (Revisit if token colors look off.)
- **Hand-rolled diff (the 1.6.0 approach)** — the root cause of the crash. Out.

## Architecture

Two isolated sides talking over the existing webview message channel.

### Extension host — `src/reviewWebview.ts` (already exists, extend)
- Owns the panel lifecycle, session wiring (primary + worktree via
  `WorktreeSessionRegistry`), and message routing. Reuses the current
  `ReviewWebviewPanel` shape.
- **Data:** `items()` already yields per-file `{relPath, before, after, status,
  isNew, isProtected, reason}` (worktree-aware). `buildReviewModel` (summary) and
  `buildFeedbackText` are already implemented and tested.
- **Message protocol (host → webview):** `render { files:[{relPath, before,
  after, status, isProtected, isNew, added, removed, reason}], reviewedCount,
  totalCount, feedbackText }`.
- **Message protocol (webview → host):** `ready`, `keep {path}`,
  `undo {path, reason?}`, `keepAll`, `undoAll` (modal-confirmed host-side),
  `copyFeedback`, `openNative {path}` (open the file in the real editor for close
  inspection).
- **Diff mode (split/unified) is client-side only** — persisted with the webview's
  own `getState()/setState()`, not a setting (the `review.diffMode` config was
  removed in 1.6.1 and is not reintroduced). So no `setDiffMode` message and no
  `diffMode` in the render payload.
- Sends full `before`/`after` per file (strict-UTF-8 read; binary/missing → null →
  "no preview"). This mirrors today's payload.

### Webview app — `src/webview/` (new), bundled to `media/review/`
- `main.tsx` — mounts the Preact app, wires `acquireVsCodeApi()` messaging + state.
- `App.tsx` — top-level state (files, diffMode, feedbackOpen, focusedIndex,
  per-file note drafts).
- `Toolbar.tsx` — the **gate rail** (tri-state kept/rejected/pending meter) +
  progress, `Unified ↔ Split` toggle, `Feedback to AI` toggle, `Keep all` /
  `Reject all`.
- `FileCard.tsx` — per-file header (name, dir, `+/−`, protected ⚠, Keep/Reject),
  collapsible; hosts the diff and the reject-note field.
- `DiffView.tsx` — wraps `react-diff-view`: build a unified patch from
  `before`/`after` with `jsdiff` (`createTwoFilesPatch`) → `parseDiff` → render
  `<Diff viewType={split|unified}>` with tokenized highlighting.
- `FeedbackPanel.tsx` — the collected Feedback-to-AI text + Copy.
- **Keyboard:** `j/k` move focus, `Enter` open native diff, `a` keep, `x` reject
  (opens note), `Esc` cancel note. Visible focus ring; ARIA roles/labels.
- **Theming:** a small CSS layer mapping `--vscode-*` vars onto `react-diff-view`
  and Prism classes.

### Build & packaging
- New esbuild entry (e.g. `bundle:webview`) compiling `src/webview/main.tsx` →
  `media/review/review.js` (+ css), `--format=iife`, JSX set to Preact
  (`--jsx-factory`/automatic). Wire into `compile`, `bundle`, `watch`.
- `.vscodeignore` already ships `media/`; ensure `src/webview/` is excluded from
  the `.vsix` (it's source) — `src/` is already excluded.

## Rollout / native-stays-default toggle

- `claudegate.reviewAllPending` → **unchanged**: native multi-diff (default,
  production).
- New command `claudegate.reviewChangesPanel` → opens the **webview**. Available in
  the palette so it can be dogfooded.
- Setting `claudegate.reviewPanel.enabled` (boolean, default **false**). While
  false, the webview is reachable only via its palette command (dev/beta). When we
  judge it polished, flip the default (or wire the Pending-panel title icon to it).
- This satisfies "keep native as default, switch to the webview when the dev is
  done" with a single flag and no disruption to shipped behavior.

## Error handling

- Binary / missing / unreadable files → `before`/`after` null → the card shows a
  quiet "no preview available" instead of rendering a broken diff.
- Large files → `react-diff-view` handles big hunks; fold unchanged regions
  (its `Decoration`/collapse) to keep the DOM bounded. Cap extreme cases with a
  "diff too large — open in native editor" fallback link (`openNative`).
- CSP: strict `default-src 'none'`, `script-src 'nonce-…'`, `style-src` the webview
  source; no external hosts (all deps bundled). No `eval` (esbuild output is fine).
- Worktree decision sync already fans into `onSessionChange`; a single
  subscription re-renders on any change (primary or worktree).

## Testing

- **Patch generation lives in the webview** (`DiffView` builds it from
  `before`/`after` with `jsdiff`), so the host stays diff-free.
- **Pure/host logic (unit, existing harness):** `buildReviewModel` and
  `buildFeedbackText` are already tested. Add tests for any new pure helper we
  extract on the host side (e.g. language-id-from-file-extension).
- **Webview UI:** rendered by `react-diff-view` (a mature dependency) — not
  unit-tested here; verified manually (package + install to Cursor) across a light
  and a dark theme, unified and split, with a long-line file, a binary file, a
  protected file, and a nested-worktree file.
- No regression to the native path: `reviewAllPending` tests/behavior unchanged.

## Non-goals

- **Hunk-level partial accept** — explicitly dropped earlier; whole-file Keep/Reject
  only.
- **Replacing the native multi-diff** — it stays as the default.
- **Exact-to-the-pixel theme token matching** for syntax colors — Prism
  approximation is acceptable for v1; Shiki is a later option if needed.

## Components summary (isolation)

| Unit | Responsibility | Depends on |
|---|---|---|
| `reviewWebview.ts` (host) | panel lifecycle, session data, message routing | SessionManager, WorktreeSessionRegistry, reviewWebviewModel |
| `reviewWebviewModel.ts` | pure summary model + feedback text | `diff`, changeCount |
| `src/webview/App` | client state + messaging | Preact |
| `src/webview/DiffView` | render one diff (unified/split) | react-diff-view, jsdiff, refractor |
| `src/webview/Toolbar/FileCard/FeedbackPanel` | chrome, per-file actions, feedback | App state |
