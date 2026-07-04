# Review Ergonomics: Keyboard Shortcuts, Change Counts & Row Actions

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Related:** `src/extension.ts`, `src/diffProvider.ts`, `src/reviewPanel.ts`, `package.json`

## Problem

Three small UX gaps in day-to-day review:
1. **No keyboard shortcuts** — every accept/reject requires a mouse click on a tree button. There are zero keybindings today.
2. **No sense of change size** — nothing shows how big a change is before opening it.
3. **Sparse right-click menu** — ClaudeGate tree rows have no file actions (Open File, Reveal in Explorer, Copy Path), and a custom TreeView cannot inherit the File Explorer's context menu, so other extensions' file actions never appear there.

## Goal

- **A — Keyboard review flow:** `Cmd+Enter` accept / `Cmd+Backspace` reject the currently focused diff, then auto-advance to the next pending file.
- **B′ — Change counts:** show `+A -R` line counts in the diff tab title (and, lazily, in the row hover tooltip).
- **D′ — Row actions:** a right-click file-actions menu on rows (Open File, Open to the Side, Reveal in Explorer, Copy Path, Copy Relative Path, and "Add to Claude Chat" when the `lntvan166.claude-context` extension is present).

## Non-Goals

- **Not** reimplementing built-in file actions — we delegate to VS Code's built-in commands (`vscode.open`, `revealInExplorer`) and to the existing `claude-context.addFile` command. Only the two clipboard copies are a one-line `clipboard.writeText`.
- **Not** inheriting the Explorer's context menu (impossible for a custom view) — "Reveal in Explorer" is the bridge to it.
- No version bump — folds into the unreleased `1.2.0`.
- No change counts rendered in the row *label/description* (would clutter rows) — only in the diff title and the hover tooltip.

## A — Keyboard shortcuts + auto-advance

**Commands** (`extension.ts`):
- `claudegate.acceptCurrent` / `claudegate.rejectCurrent` — resolve the active editor's file via the existing `getActivePendingFilePath(sessionManager)`; if it's a pending file, call the existing `sessionManager.acceptFile(fp)` / `rejectFile(fp)`, close its diff (`closeDiffEditor`), then auto-advance.
- Both are no-ops when there is no active pending file (safe to invoke from anywhere).

**Keybindings** (`package.json` `contributes.keybindings`):
- `claudegate.acceptCurrent` → `mac: cmd+enter`, `key: ctrl+enter`
- `claudegate.rejectCurrent` → `mac: cmd+backspace`, `key: ctrl+shift+backspace`
- Both `"when": "claudegate.activeFileIsPending"` (context key already maintained in `extension.ts`). The narrow `when` keeps conflicts with editor defaults inert unless a ClaudeGate diff is the active, pending editor.

**Auto-advance:** after a successful accept/reject via these commands, if `claudegate.autoAdvance` (new setting, default `true`) is on, open the diff of the **first remaining pending file** (pending ∧ `isInWorkspace` ∧ `!isExcluded`, sorted by path — the tree's order). If none remain, show an info message "Claude Gate: all caught up ✓". Auto-advance applies **only** to `acceptCurrent`/`rejectCurrent`, not to the tree's own accept/reject buttons (keeps mouse clicks predictable).

**Setting:** `claudegate.autoAdvance` (boolean, default `true`) — "After accepting or rejecting from the diff view (keyboard), automatically open the next pending file."

**Incidental fix (required for auto-advance):** `closeDiffEditor` (`reviewPanel.ts`) matches tab labels with prefix `"ClaudeGate: "`, but diff titles produced by `openDiff` start with `"Claude Gate: "` (with a space). The prefix never matches, so it currently never closes a tab (this also silently breaks Accept All / Reject All tab-closing). Fix the prefix to `"Claude Gate: " + path.basename(filePath)`. Appending the change count to the end of the title (B′) preserves the `startsWith` match.

## B′ — Change counts

**New `vscode`-free module `src/changeCount.ts`** (so it is unit-testable under plain Node, like `excludeMatcher`):

```typescript
import { diffLines } from "diff";
export interface ChangeCount { added: number; removed: number; }
export function countChanges(original: string, current: string): ChangeCount;   // sum added/removed line counts
export function formatChangeCount(c: ChangeCount): string;                        // "+12 -3", "+7", "-4", or "no changes"
```

- **Diff title** (`diffProvider.ts` `openDiff`): compute counts up front from `entry.originalContent` (or `""` for a new file) vs the current on-disk content, and append to the title: `Claude Gate: file.ts  (original ↔ current · +12 -3)`. New file → `(new file · +40)`. The existing `diffLines`-based scroll logic is retained (or shares the same computation).
- **Row tooltip** (`reviewPanel.ts`): implement `FilteredTreeProvider.resolveTreeItem(item, element, token)` to append the change count to the hover tooltip **lazily** (only on hover — no per-refresh cost). Compute for **pending** file items only (original ↔ current-on-disk); leave accepted/rejected tooltips unchanged. Read failures degrade to the existing tooltip.

## D′ — Row context-menu actions

**Wrapper commands** (`extension.ts`), each receiving the clicked `FileReviewItem` and extracting `filePath`:
- `claudegate.openFile` → `executeCommand("vscode.open", Uri.file(fp))`
- `claudegate.openToSide` → `executeCommand("vscode.open", Uri.file(fp), { viewColumn: vscode.ViewColumn.Beside })`
- `claudegate.revealInExplorer` → `executeCommand("revealInExplorer", Uri.file(fp))`
- `claudegate.copyPath` → `vscode.env.clipboard.writeText(fp)`
- `claudegate.copyRelativePath` → `vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(fp))`
- `claudegate.addToClaudeChat` → `executeCommand("claude-context.addFile", uri, [uri])`, wrapped in try/catch → warning "Claude Gate: 'Claude Context' extension not available." on failure.

**Menu** (`package.json` `view/item/context`): all entries `"when": "viewItem =~ /^claudegate\\.file\\./"` so they show on file rows in all three panes, grouped:
- group `navigation@1..3`: Open File, Open to the Side, Reveal in Explorer
- group `9_copy@1..2`: Copy Path, Copy Relative Path
- group `z_claude@1`: Add to Claude Chat — additional `when` clause `&& claudegate.claudeContextAvailable`

**Conditional Add-to-Chat:** at activation set a context key `claudegate.claudeContextAvailable = !!vscode.extensions.getExtension("lntvan166.claude-context")` via `setContext`, so the item only appears when that extension is installed.

**Command palette:** the six D′ commands and any that require a row argument get `{ "command": "…", "when": "false" }` in the `commandPalette` menu block (matching the existing convention). `acceptCurrent`/`rejectCurrent` take no argument and may stay palette-visible.

## Files

- Create: `src/changeCount.ts`, `src/changeCount.test.ts`.
- Modify: `package.json` (keybindings, `autoAdvance` setting, ~8 commands, `view/item/context` + `commandPalette` menu entries, `test:unit` script to also run the changeCount test).
- Modify: `src/extension.ts` (register `acceptCurrent`/`rejectCurrent` + auto-advance helper; the six row-action wrappers; set `claudegate.claudeContextAvailable`).
- Modify: `src/diffProvider.ts` (change count in title, using `changeCount`).
- Modify: `src/reviewPanel.ts` (`resolveTreeItem` tooltip; fix `closeDiffEditor` prefix).

## Error Handling

- `acceptCurrent`/`rejectCurrent` with no active pending file: silent no-op.
- Auto-advance with nothing left: info toast, not an error.
- Row wrappers: a missing/invalid item → guard `if (!item?.filePath) return`. `addToClaudeChat` catches command-not-found and warns.
- Tooltip / title count read failure: fall back to the existing tooltip/title (no throw).

## Testing

**Automated (`npm run test:unit`, extended to run `changeCount.test.ts` too):**
1. `countChanges("a\nb\nc\n","a\nB\nc\n")` → `{ added: 1, removed: 1 }` (a modified line is a remove+add).
2. `countChanges("", "x\ny\n")` → `{ added: 2, removed: 0 }`.
3. `countChanges("x\ny\n", "x\ny\n")` → `{ added: 0, removed: 0 }`.
4. `formatChangeCount` → `"+12 -3"`, `"+7"`, `"-4"`, `"no changes"` for the respective inputs.

Plus `npm run typecheck` / `compile` pass.

**Manual (Extension Development Host):**
5. Open a pending diff, `Cmd+Enter` → file accepted, diff closes, next pending diff opens; on last file → "all caught up".
6. `Cmd+Backspace` → file rejected (restored), advances.
7. Set `claudegate.autoAdvance: false` → after accept/reject the diff closes but no next diff opens.
8. Diff tab title shows `· +A -R`; hovering a pending row shows the same in the tooltip.
9. Right-click a row: Open File / Open to the Side / Reveal in Explorer / Copy Path / Copy Relative Path all work; "Add to Claude Chat" appears only with `claude-context` installed and adds the file to its chat.
10. Accept All / Reject All now actually close open diff tabs (closeDiffEditor fix).

## Release

- No version bump — extend the existing `## [1.2.0] — 2026-07-04` CHANGELOG **Added** section (keyboard shortcuts + auto-advance; change counts in diff title; row context-menu file actions incl. Add to Claude Chat) and note the `closeDiffEditor` fix under **Fixed**.
- No hook changes.
