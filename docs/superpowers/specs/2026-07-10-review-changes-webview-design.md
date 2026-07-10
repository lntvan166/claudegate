# Design — "Review Changes" Webview Panel

**Date:** 2026-07-10
**Status:** Approved for planning
**Topic:** A Cursor-inspired, unified multi-file review surface for ClaudeGate, rendered as a custom Webview editor tab, with per-file accept/reject, split/unified diffs, reason-on-revert, and a copyable "Feedback to AI" log.

---

## 1. Goal

Replace ClaudeGate's current "Review All Pending" experience — a static native `vscode.changes` multi-diff that flickers on refresh and cannot be acted on in place — with a single, information-dense **Review Changes** surface where the user can see every pending change and **keep/undo each file without leaving the view**.

The design is drawn from Cursor's aggregated review UX (competitive audit in the session), adapted to what a *VS Code extension* (not an editor fork) can do. Deliberately **no AI features** — ClaudeGate stays a review gateway. The one nod to the AI workflow is a purely mechanical **Feedback to AI** log: the extension formats the user's keep/undo decisions (and optional revert reasons) into text the user copies and pastes into their AI agent. The extension never calls a model.

## 2. Current state (what we're building on)

- **Sidebar panels** (`reviewPanel.ts`): Pending / Accepted / Rejected trees. Kept as the entry point.
- **Per-file native diff** (`diffProvider.ts`): `openDiff` shows baseline ↔ disk in VS Code's native diff editor. **Kept** for single-file clicks (native editing, language services).
- **Multi-diff** (`extension.ts`, `reviewAllPending` + `vscode.changes`): static, flickers, no inline actions. **Replaced** by this webview.
- **Session model** (`sessionManager.ts`, `reviewModel.ts`): `files{}` (pending), `accepted[]` (log), `rejected{}` (latest per path). `acceptFile` / `rejectFile` / `acceptFolder` / `rejectFolder` / `acceptAll` / `rejectAll`. `ReviewRecord { id, path, before, after, decidedAt, sessionId, newFile? }`.
- **Dependency `diff`** (`^9.0.0`) already used (`diffLines`, `countChanges`).

## 3. Non-goals

- **No AI / "Find Issues" / bug detection.** No model calls of any kind.
- **No per-hunk accept/reject.** Accept/reject is **per file** (and folder/all). Per-hunk was explicitly dropped.
- **No workspace checkpoints / time-travel** (fork-only; out of scope).
- **No git commit-from-review** in this iteration (possible later, not designed here).
- **No syntax highlighting inside the webview diff for the MVP** — only add/delete line coloring. Token-level syntax coloring is a possible later enhancement.

## 4. Approach & alternatives

**Chosen: Option 2 — custom `WebviewPanel` in the editor area.**

A single editor tab renders all pending files stacked, with our own HTML/CSS diff. Full control over layout (matches the target UX), per-file actions, folds, and the feedback panel.

Alternatives considered and rejected:
- **Orchestrated native flow** (drive native diffs + progress): cheapest, native fidelity, but cannot host inline per-file keep/undo or the stacked aggregated view — the core ask.
- **Hybrid** (webview hub + native diff beside): keeps native diff fidelity but splits attention across two panes and adds sync complexity; the user chose the single-surface webview.

**Accepted trade-off:** inside the webview we render the diff ourselves, so there is **no in-place editing and no language-server/hover/syntax intelligence** within the tab. Single-file clicks in the sidebar still open the **native** diff editor, which retains those. The webview is the *review-and-decide* surface; the native diff is the *inspect-closely/edit* surface.

## 5. Architecture

```
SessionManager ──onSessionChange──▶ ReviewWebviewPanel (new: src/reviewWebview.ts)
      ▲                                   │  builds ReviewModelDTO (pure, src/reviewWebviewModel.ts)
      │  acceptFile/rejectFile(reason?)   │  posts { type:"render", model } to webview
      │                                   ▼
      └──── postMessage handler ◀──── webview HTML/JS (media/review/*.js,*.css)
                                          user clicks Keep / Undo(+reason) / toggle / copy
```

### New units

1. **`src/reviewWebviewModel.ts` (pure, tested)** — builds the data the webview renders and the feedback text, with no VS Code dependency.
   - `buildReviewModel(session, opts)`: for each in-scope pending file, produce `{ path, relDir, basename, protected, newFile, added, removed, hunks }` where `hunks` are computed from `originalContent` ↔ current disk content via `diffLines`, collapsed to changed regions plus N lines of context (the "⋯ N hidden lines ⋯" folds). Also includes already-decided files from this review batch, marked `kept`/`undone` with any `reason`.
   - `buildFeedbackText(session, batch)`: pure `string` — the "Feedback to AI" clipboard text (Kept / Reverted+reason / Still reviewing). **Unit-tested** for format stability.
   - Split vs. unified is a *render-time* concern in the webview JS; the model is layout-agnostic (it provides aligned left/right line pairs; the JS collapses to one column for unified).

2. **`src/reviewWebview.ts`** — owns the `WebviewPanel` lifecycle.
   - Singleton: `ReviewWebviewPanel.showOrReveal(context, sessionManager)`. If a panel exists, reveal it; else create it (`viewType: "claudegate.reviewChanges"`, title `"Claude Gate: Review Changes"`, editor column).
   - Subscribes to `sessionManager.onSessionChange` → recompute model → **`postMessage({type:"render", model})`**. The webview JS **diffs and patches the DOM** (or re-renders cheaply), so updates are **incremental — no tab close/reopen, no flicker** (fixing the core failing of the `vscode.changes` approach).
   - Handles inbound messages: `keep {path}`, `undo {path, reason?}`, `keepAll`, `undoAll`, `toggleFeedback`, `copyFeedback`, `setDiffMode {split|unified}`, `openNative {path}` (escape hatch: open the real native diff).
   - Preserves scroll position and per-file collapse state across re-renders (the JS keeps UI state keyed by path).
   - CSP: strict — `default-src 'none'`, script/style from the extension's `media/` via `webview.asWebviewUri` with a per-load `nonce`. No remote resources.

3. **Reason capture (cross-surface)** — a small shared helper so **every** revert path captures an optional reason and writes it to the record:
   - `reviewModel.ts`: `ReviewRecord` gains `reason?: string`; `rejectEntry(session, path, after, decidedAt, reason?)` stores it. `migrateSession` leaves it absent for legacy records (optional field).
   - `sessionManager.ts`: `rejectFile(filePath, reason?)`, `rejectFolder(folderPath, reason?)`, `rejectAll(reason?)` thread the reason through to `rejectEntry`.
   - `extension.ts`: the existing **modal confirm** on sidebar `rejectFile`, diff-title `rejectCurrent`, and keyboard `Cmd+Backspace` is **replaced by `vscode.window.showInputBox`** — prompt "Reason to feed back to AI (optional) — leave blank to just revert", `placeHolder` example, no validation (empty allowed). Submitting (even empty) confirms the revert; pressing Esc cancels. The webview's inline reason field posts `undo {path, reason}` to the same `rejectFile` path.

### Data flow for a keep/undo from the webview
1. User clicks **Keep** on a file → JS posts `keep {path}`.
2. Handler calls `sessionManager.acceptFile(path)` → session file rewritten → `onSessionChange` fires.
3. Panel recomputes model → posts `render`. The file's row flips to `✓ kept` (collapsed), progress advances. No flicker.
4. **Undo** is identical but the JS first reveals the inline reason field; on **Revert** it posts `undo {path, reason?}` → `sessionManager.rejectFile(path, reason)`.

## 6. UI specification (from approved mockup v4)

**Editor tab: "Claude Gate: Review Changes".**

- **Toolbar** (sticky top): title `All Changes`; **progress** `N of M reviewed` + thin progress bar; **Split / Unified** segmented toggle (persisted to config, default **Split**); **💬 Feedback to AI** toggle button; **Undo All**; **Keep All**.
- **File sections** (stacked), each:
  - Header: collapse chevron, ⚠ icon if `protected`, basename, dimmed relative dir, `+adds` / `−dels` badges.
  - Right side of header: **Keep** / **Undo** buttons when pending; `✓ kept` / `✗ undone` status label when decided (decided files stay in the list, collapsed).
  - Body (when expanded): the diff.
    - **Split**: two columns — left `Original`, right `Current (Claude's edit)` — aligned rows with blank filler rows for adds/removes; add rows green, delete rows red, changed gutters tinted.
    - **Unified**: single column, `+`/`-` prefixed lines (GitHub-style).
    - **Folds**: unchanged regions beyond context collapse to `⋯ N hidden lines ⋯` (click to expand — optional for MVP; at minimum render the fold markers).
  - **Reason-on-undo**: clicking **Undo** opens an inline field under the header — label "Reverting to original. Add a reason to feed back to AI (optional):", an input, and **Cancel** / **Revert** buttons. Reason is **optional**, **undo-only** (no note on Keep).
- **Feedback panel** (toggled by the toolbar button; **off by default**; docked at the **bottom** of the tab): collapsible header `💬 Feedback to AI` with a **📋 Copy** button inside it, over a read-only preview of the generated text. Copy writes to `vscode.env.clipboard`.

### Feedback text format (v1, from mockup)
```
I reviewed your changes. Per file:

KEPT:
- <relpath>
- ...

REVERTED (don't re-apply as-is):
- <relpath> — <reason if given>
- <relpath>            (no reason → path only)

Still reviewing:
- <relpath>
```
Sections with no entries are omitted. Format lives in `buildFeedbackText` and is unit-tested.

### Review "batch" semantics
On open, the panel snapshots the current in-scope pending set as the **review batch** (drives `M` in "N of M"). Files kept/undone during the session **remain visible** (collapsed, marked) so progress reads sensibly. Newly captured pending files that arrive while the panel is open are appended to the list and increment `M`.

## 7. Integration points & commands

- **`claudegate.reviewAllPending`** (existing `$(diff-multiple)` toolbar action + welcome CTA): repointed from `vscode.changes` to `ReviewWebviewPanel.showOrReveal`. The old `openPendingMultiDiff` / `closePendingMultiDiff` / refresh-on-change plumbing in `extension.ts` is **removed**.
- **New command `claudegate.reviewChanges`** (palette + Pending panel title) — same action; clearer name. (Keep `reviewAllPending` as an alias to avoid breaking muscle memory/keybindings.)
- Sidebar single-file click → still `openDiff` (native). Add a per-file **"Open in native diff"** action inside the webview (`openNative`) for close inspection/editing.
- Accept/reject/keyboard flows unchanged except for the reason input replacing the confirm modal.

## 8. Config

- **`claudegate.review.diffMode`**: `"split" | "unified"`, default `"split"`. The toolbar toggle writes it; remembered across sessions.
- (Reuse existing `claudegate.exclude` / `claudegate.protected` — the webview honors the same scope filters as the sidebar.)

## 9. Error handling & edge cases

- **File unreadable / deleted** at render time: show the row with a `(file missing)` note instead of a diff; Keep/Undo still work via the session record.
- **No-op pending entry** (baseline == disk, not yet pruned): the model reuses `hasRealPendingChange`; such a file is shown collapsed with `no changes` rather than a blank diff (mirrors `openDiff`'s current guard).
- **New file** (`originalContent === null`): left side shows empty/"new file"; Undo deletes the file (existing `rejectFile` behavior, `newFile` marker preserved through the record + `reason`).
- **Large file / many files**: render is windowed by collapsing unchanged regions; if a single file's changed region is huge, cap rendered lines with an "expand" affordance. Never block the UI thread — diff computation happens in the extension host per `render`, not in the webview.
- **Panel open across session reloads**: `onSessionChange` re-renders; UI state (scroll, collapse) preserved by path key. Panel auto-updates to empty state ("All changes reviewed 🎉") when the batch is fully decided; it does **not** auto-close (user closes the tab).
- **Concurrent hook writes**: unchanged — all mutations go through `SessionManager`'s existing locked read-modify-write; the webview only sends intents.

## 10. Testing

- **`reviewWebviewModel.test.ts`** (pure, node): `buildReviewModel` — add/remove counts, fold regions, protected flag, new-file, no-op; `buildFeedbackText` — each section, reason with/without, omission of empty sections, path formatting. Format is locked by snapshot-style assertions.
- **`reviewModel.test.ts`** (extend): `rejectEntry` persists `reason`; `migrateSession` tolerates records without `reason`.
- **`sessionManager.test.ts`** (extend): `rejectFile(path, reason)` writes the reason onto the rejected record.
- **Manual/integration**: open panel with mixed pending set → keep one, undo one with reason → verify no flicker, progress advances, feedback text matches, sidebar reject prompts for reason and feeds the same log.

## 11. Rollout / open questions (non-blocking)

- **Folds interactivity**: MVP may render static fold markers; click-to-expand can be a fast follow.
- **Syntax coloring** inside the webview diff: deferred; add/delete coloring only for v1.
- **Commit-from-review** and **whole-session revert**: explicitly deferred (see non-goals).
- **Feedback text wording**: v1 format above; easy to tweak since it's one pure function.

---

## File-change summary (for the plan)

| File | Change |
|---|---|
| `src/reviewWebviewModel.ts` | **New.** Pure model + feedback-text builders. |
| `src/reviewWebviewModel.test.ts` | **New.** Unit tests for the above. |
| `src/reviewWebview.ts` | **New.** `WebviewPanel` provider, message handling, incremental render. |
| `media/review/review.js`, `review.css` | **New.** Webview client: render, split/unified, collapse, reason field, feedback panel. |
| `src/reviewModel.ts` | `ReviewRecord.reason?`; `rejectEntry(..., reason?)`. |
| `src/sessionManager.ts` | `rejectFile/rejectFolder/rejectAll(..., reason?)`. |
| `src/extension.ts` | Repoint `reviewAllPending`; add `reviewChanges`; remove `vscode.changes` plumbing; replace reject confirm modal with reason input box. |
| `package.json` | New command `claudegate.reviewChanges`; config `claudegate.review.diffMode`. |
| `.vscodeignore` | Ensure `media/review/**` ships (and dev dirs stay excluded). |
