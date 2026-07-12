# Keyboard review stepper: next/prev pending + progress

**Date:** 2026-07-12
**Status:** Approved (brainstorming) — pending implementation plan

## Summary

ClaudeGate's one-at-a-time review flow (click a pending file → a two-pane diff
opens; ⌘+Enter accepts, ⌘+Backspace rejects, and `autoAdvance` opens the next
pending diff) already supports fast decision-making. Two things are missing to make
it a complete keyboard "stepper":

1. **Move without deciding** — there is no key to open the *next* / *previous*
   pending diff without first accepting or rejecting the current one. You cannot
   skip a file to revisit it, or step back.
2. **No progress signal** — nothing tells you where you are in the queue
   ("3 of 12").

This adds two navigation commands (`claudegate.nextPending`, `claudegate.prevPending`)
with conflict-safe default keybindings, and a `· N of M pending` suffix in the diff
title.

## Goals

- A key opens the next / previous pending file's diff relative to the one currently
  open, without changing its review state.
- The diff title shows the current file's position in the pending queue.
- Navigation, accept-advance, and the progress count all use **one** ordering, so
  they never disagree.

## Non-goals (YAGNI — explicitly decided during brainstorming)

- **No single-key `j`/`k`/`a`/`r` and no modal "review mode."** The diff's right
  pane is an editable text editor (this is what makes the shipped edit-before-accept
  feature work). VS Code gives extensions no way to intercept a bare keypress before
  the editor; a modal mode would either type those letters into the buffer or, if
  bound, make it impossible to type `j`/`k`/`a`/`r` while editing — breaking
  edit-before-accept. A true vim-style normal mode would require making the file
  editor read-only on demand, for which there is no clean API. Not worth the cost or
  the collision. (A conflict-free variant — single keys active only when the Pending
  tree view has focus — remains a possible *additive* future follow-up, not part of
  this work.)
- **No changes to the Review-All multi-diff view** (surface B).
- **No changes to the existing accept/reject keys** (⌘+Enter / ⌘+Backspace) or to
  `autoAdvance`.
- **No wrap-around** at the ends of the list.

## Current behavior (grounding)

- `src/extension.ts` `openNextPending()` (extension.ts:301) filters
  `session.files` to pending + in-workspace + not-excluded + `hasRealPendingChange`,
  sorts by `localeCompare`, and opens `[0]` via `claudegate.openDiff`; shows
  "all caught up ✓" when none remain. It is an internal closure invoked only as a
  side effect of accept/reject auto-advance — not a command, and there is no
  "previous".
- `getActivePendingFilePath()` (extension.ts:30) returns the pending file backing
  the active editor (handles `file:` and `claudegate:` schemes, win32 case), or
  `undefined`.
- `refreshActiveFilePendingContext()` (extension.ts:73) maintains the
  `claudegate.activeFileIsPending` context key used to gate the existing keybindings.
- `src/diffProvider.ts` `openDiff()` (diffProvider.ts:120) builds the diff title,
  already appending a `· <change-count>` suffix via `formatChangeCount`.
- Existing keybindings (`package.json` `contributes.keybindings`): `acceptCurrent`
  → ⌘+Enter, `rejectCurrent` → ⌘+Backspace, both `when: claudegate.activeFileIsPending`.

## Design

### New module: `src/reviewNav.ts` (pure, vscode-free — unit-tested)

Ordering and stepping logic as pure functions, so the navigation math is tested
without a VS Code host:

```ts
// Canonical order for the stepper. Alphabetical by path (localeCompare),
// matching what openNextPending already uses for auto-advance.
export function orderPending(paths: string[]): string[];

// Given the ordered pending list, the currently-open pending path (or undefined),
// and a direction, return where to go.
//   - current undefined / not in list:  dir +1 → first, dir -1 → last
//   - current in list, not at the edge:  the neighbor in that direction
//   - current at the edge in that direction:  { atEnd: "first" | "last" } (stay put)
//   - empty list: { empty: true }
export type Step =
  | { target: string }
  | { atEnd: "first" | "last" }
  | { empty: true };
export function stepPending(ordered: string[], current: string | undefined, dir: 1 | -1): Step;

// 1-based position of `path` in the ordered list, plus total. undefined if absent.
export function pendingProgress(ordered: string[], path: string): { index: number; total: number } | undefined;
```

Path comparison is exact-string on the caller-supplied list; the caller
(`extension.ts`) already resolves/normalizes paths from the session, so `reviewNav`
stays free of platform path logic.

### `src/extension.ts`

- **Extract `orderedPendingPaths(): string[]`** from `openNextPending` — returns the
  full filtered+ordered list (via `orderPending`). Refactor `openNextPending` to call
  it and open the first, preserving today's behavior (single source of truth).
- **Register `claudegate.nextPending` / `claudegate.prevPending`.** Each:
  1. `const ordered = orderedPendingPaths();`
  2. `const current = getActivePendingFilePath(managerFor);`
  3. `const step = stepPending(ordered, current, +1 | -1);`
  4. `target` → `executeCommand("claudegate.openDiff", target)`.
  5. `atEnd: "last"` → `showInformationMessage("Claude Gate: last pending file")`;
     `atEnd: "first"` → `"first pending file"`.
  6. `empty` → reuse the "all caught up ✓" message.

### `src/diffProvider.ts`

- In `openDiff`, compute `pendingProgress(orderedPending, filePath)` and append
  `· ${index} of ${total} pending` to the title (alongside the existing change-count
  suffix). `openDiff` already has `sessionManager`; it builds the ordered list the
  same way (shared helper — see plan for exact placement so `extension.ts` and
  `diffProvider.ts` don't duplicate the filter).

### `package.json`

- `contributes.commands`: add `claudegate.nextPending` ("Claude Gate: Next Pending
  File"), `claudegate.prevPending` ("Claude Gate: Previous Pending File").
- `contributes.keybindings`:
  - `nextPending` → `alt+]` (key), `alt+]` also serves win/linux; mac `alt+]`.
    Written as `{ command, key: "alt+]", when: "claudegate.activeFileIsPending" }`.
  - `prevPending` → `alt+[`, same `when`.
  - (⌥ on mac === `alt` in VS Code keybinding syntax, so one `key` covers all
    platforms; no separate `mac` field needed. Chosen because `alt+[` / `alt+]` are
    not default editor editing actions, so they don't clobber ⌘+]/⌘+[ indent in the
    now-editable right pane.)
- `contributes.menus.commandPalette`: show both commands only when
  `claudegate.activeFileIsPending` (or always — decide in plan; palette entries are
  low-risk).

## Edge cases

- **No diff open / active file not pending** → next opens the first pending, prev
  opens the last. (`getActivePendingFilePath` returns `undefined`, handled by
  `stepPending`.)
- **Only one pending file** → next/prev from it reports `atEnd` and stays put.
- **Zero pending** → `empty` → "all caught up ✓"; keybindings are gated by
  `activeFileIsPending` so this is mostly reachable only via the command palette.
- **Active file was just accepted/rejected** (no longer pending, so not in `ordered`)
  → treated as "current not in list": next → first, prev → last. Acceptable; the
  user is effectively re-entering the queue.
- **Worktree files:** `getActivePendingFilePath` resolves the owning manager, but the
  stepper's ordered list is built from the primary session (matching
  `openNextPending`'s existing scope). Cross-worktree stepping is out of scope, same
  as today's auto-advance.

## Testing

**Unit (`src/reviewNav.test.ts`, add to `test:unit` in `package.json`):**
- `orderPending` sorts by `localeCompare`; stable on already-sorted / reversed input.
- `stepPending`: mid-list next/prev returns the correct neighbor; at last + dir=+1 →
  `{atEnd:"last"}`; at first + dir=-1 → `{atEnd:"first"}`; current `undefined` →
  first (dir=+1) / last (dir=-1); current not in list → first/last; empty list →
  `{empty:true}`; single-element list → `atEnd` both directions.
- `pendingProgress`: correct 1-based index + total; `undefined` when path absent.
- No vscode import needed (bundles without the `--alias:vscode` flag).

**Manual (F5):**
- Open a pending diff; ⌥+] steps to the next pending, ⌥+[ to the previous, without
  changing review state; title shows `· N of M pending`.
- At the last pending, ⌥+] shows "last pending file" and stays; at the first, ⌥+[
  shows "first pending file".
- Confirm ⌘+]/⌘+[ still indent/outdent in the editable right pane (no clobber).
- Accept a file; the remaining diffs' `N of M` reflects the smaller total.

## Files touched

- `src/reviewNav.ts` — new pure module.
- `src/reviewNav.test.ts` — new unit test; register in `package.json` `test:unit`.
- `src/extension.ts` — extract `orderedPendingPaths`, register two commands.
- `src/diffProvider.ts` — progress suffix in `openDiff` title.
- `package.json` — two commands, two keybindings, palette entries.

No changes to `SessionManager`, accept/reject logic, `autoAdvance`, the multi-diff
view, or the session schema.
