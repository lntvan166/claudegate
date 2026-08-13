# Open Folder in New Window — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming)

## Problem

The Pending panel already offers **"Open Worktree in New Window"** on git-worktree
group nodes, but there is no equivalent for ordinary folder nodes. In multi-repo /
`go.work` layouts (e.g. `monorepo/ws-beta`), the directory a user wants to open
is a plain folder, not a worktree ClaudeGate can detect — so no such action exists.
The user wants to right-click any folder in the Pending tree and open it as a new
VS Code window.

## Scope

- **Pending panel only** (`claudegate.folder.pending`). Accepted/Rejected folder
  nodes are out of scope.
- **Context-menu only** — no inline hover icon.
- Folder nodes exist only in **tree view mode** (list mode has no folders). This is
  inherent to the tree shape, not a limitation introduced here.

## Approach

New dedicated command that reuses the existing `vscode.openFolder(..., { forceNewWindow: true })`
call, factored into a shared helper so it cannot drift from the worktree command.

Rejected alternatives:
- Generalizing `claudegate.openWorktreeWindow` to accept either item type —
  `WorktreeGroupItem.worktreeRoot` and `FolderItem.folderPath` are different fields
  with different `when` clauses; one command doing double duty is muddier than two
  thin ones.
- Duplicating the `openFolder` call inline in both commands — drift risk.

## Behavior

Right-clicking a folder node in the Pending panel shows **"Open in New Window"**.
Selecting it opens that folder's absolute path (`FolderItem.folderPath`) as a new
VS Code window via `vscode.openFolder(Uri.file(folderPath), { forceNewWindow: true })`.

## Changes

1. **`src/reviewPanel.ts`** — extract `openFolderInNewWindow(dir: string)` helper
   wrapping the `vscode.openFolder` call. `FolderItem` is unchanged: its existing
   `contextValue` (`claudegate.folder.pending`) and `folderPath` are exactly what
   the menu binding and command need.
2. **`src/extension.ts`** — register `claudegate.openFolderInNewWindow`, no-op if
   `folderPath` is falsy (mirrors `openWorktreeWindow`'s `if (!item?.worktreeRoot) return`),
   delegate to the helper. Refactor the existing `openWorktreeWindow` body to call
   the same helper.
3. **`package.json`** —
   - `contributes.commands`: add `claudegate.openFolderInNewWindow`, title
     `"Open in New Window"`, `category: "Claude Gate"`.
   - `contributes.menus["view/item/context"]`: add an entry with
     `when: "view == claudegate.pendingPanel && viewItem == claudegate.folder.pending"`.

## Error handling

- No-op when `folderPath` is falsy.
- `vscode.openFolder` surfaces any invalid-path error itself; no extra handling.

## Testing

`src/reviewPanel.test.ts` (new file, added to the `test:unit` script), driving the
real code against the `vscode` test stub:

- **Helper behavior:** `openFolderInNewWindow(dir)` dispatches exactly one
  `vscode.openFolder` command, with a file URI for `dir` and `{ forceNewWindow: true }`
  (asserted via the stub's `executedCommands` recorder). This is the real logic the
  feature adds.
- **Menu-binding contract:** a Pending `FolderItem` carries
  `contextValue === "claudegate.folder.pending"` and its `folderPath` — locks what the
  `package.json` `when` clause and the command argument depend on.
- The command registration in `extension.ts` is a thin delegation to the tested helper
  (like the untested `openWorktreeWindow`), so it gets no separate unit test.
