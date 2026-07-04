# ClaudeGate Settings Panel

**Date:** 2026-07-04  
**Status:** Approved for implementation  
**Related:** `package.json`, `src/extension.ts`, `src/hookInstaller.ts`, `src/reviewPanel.ts` (pattern reference), and the settings added in `2026-07-04-claudegate-config-settings-design.md`

## Problem

The two settings we added (`claudegate.fileWatcher.enabled`, `claudegate.exclude`) and the **Setup Hook** action are only reachable through VS Code's settings UI / command palette. There is no in-context place in the Claude Gate sidebar to see or change them. Users want a **Settings pane** alongside the Pending / Accepted / Rejected panes to view and toggle these from one place.

## Goal

A fourth TreeView in the Claude Gate activity-bar container, "Settings", surfacing three items:
1. **File Watcher** — show On/Off, click to toggle.
2. **Exclude Patterns** — list active globs, add via input box, remove inline.
3. **Hook** — show install/registration status, click to run Setup Hook.

It is a thin front-end over existing state (config + hook status) — no new persisted state.

## Non-Goals

- No new settings or detection behavior — this only surfaces what already exists.
- No webview / custom HTML UI (native TreeView, consistent with the other panes).
- No "Utilities" rows (Clear Session, Output log, Verify) — out of scope for this pass.
- No version bump — folds into the unreleased `1.2.0`.

## Product Decisions

- **View type: native TreeView** (`vscode.TreeDataProvider`), consistent with the existing three panes; minimal code.
- **Write scope: Workspace** (`ConfigurationTarget.WorkspaceFolder`, falling back to `Workspace`, then `Global` when no folder is open). Exclude globs and the watcher choice are usually project-specific and should travel with the repo.
- **Remove pattern = delete the key** from the `claudegate.exclude` map (cleaner than setting `false`).
- **Always visible** — unlike Accepted/Rejected (which are gated on counts), the Settings view has no `when` clause.

## Architecture

```
contributes.views: claudegate.settingsPanel  ("Settings", 4th view)
        │
        ▼
src/settingsPanel.ts — SettingsTreeProvider implements TreeDataProvider<SettingsItem>
   reads:  vscode.workspace.getConfiguration("claudegate")  (exclude, fileWatcher.enabled)
           HookInstaller.getStatus()
   rows fire commands:
     claudegate.toggleFileWatcher      → update fileWatcher.enabled (Workspace)
     claudegate.addExcludePattern      → showInputBox → update exclude (Workspace)
     claudegate.removeExcludePattern   → delete key   → update exclude (Workspace)
     claudegate.setupHook (existing)   → hook install
        │
        ▼
   refresh on: onDidChangeConfiguration("claudegate.*"), and after each command
```

The `toggleFileWatcher` command writes the same `claudegate.fileWatcher.enabled` key the extension's existing config listener already watches — so the live watcher start/stop wiring is reused, not duplicated.

## Components

### New: `src/settingsPanel.ts`

`SettingsTreeProvider implements vscode.TreeDataProvider<SettingsItem>`.

- `SettingsItem` is a discriminated shape carrying a `kind`: `"watcher" | "excludeHeader" | "excludePattern" | "excludeAdd" | "hook"`, plus `pattern?: string` for `excludePattern`.
- `getChildren(element?)`:
  - **root** → `[watcher, excludeHeader, hook]`.
  - **excludeHeader** → one `excludePattern` per active (true) glob in `claudegate.exclude`, then one `excludeAdd` row.
  - others → no children.
- `getTreeItem(item)`:
  - **watcher** — `label: "File Watcher"`, `description: enabled ? "On" : "Off"`, `iconPath: ThemeIcon("eye")`/`ThemeIcon("eye-closed")`, `command: claudegate.toggleFileWatcher`.
  - **excludeHeader** — `label: "Exclude Patterns"`, `description: <count>`, `collapsibleState: Expanded`, `iconPath: ThemeIcon("filter")`.
  - **excludePattern** — `label: <glob>` (monospace via `resourceUri` not needed; plain label), `contextValue: "claudegate.excludePattern"` (drives the inline remove menu), no default command.
  - **excludeAdd** — `label: "Add pattern…"`, `iconPath: ThemeIcon("add")`, `command: claudegate.addExcludePattern`.
  - **hook** — label/description/icon from `HookInstaller.getStatus()` (see below), `command: claudegate.setupHook`.
- `refresh()` fires `_onDidChangeTreeData`.
- Constructor subscribes to `vscode.workspace.onDidChangeConfiguration` (refresh when `claudegate.exclude` or `claudegate.fileWatcher.enabled` changes).

### Modified: `src/hookInstaller.ts`

Add `getStatus(): { scriptInstalled: boolean; registered: boolean; upToDate: boolean }` composing the checks the class already performs internally (script present at `~/.claudegate/hook.py`; entry present in `~/.claude/settings.json` PreToolUse; installed hash matches the bundled hash). Used by the provider to render the hook row:
- `!scriptInstalled` → `✖ Not installed` (ThemeIcon "error"), tooltip "Click to set up".
- `scriptInstalled && !registered` → `⚠ Not registered` (ThemeIcon "warning").
- `scriptInstalled && registered && !upToDate` → `⚠ Update available` (ThemeIcon "warning").
- all true → `✔ Installed & registered` (ThemeIcon "check").

### Modified: `package.json`

- `contributes.views.claudegate` — append `{ "id": "claudegate.settingsPanel", "name": "Settings" }` (no `when`).
- `contributes.commands` — add `claudegate.toggleFileWatcher` ("Toggle File Watcher"), `claudegate.addExcludePattern` ("Add Exclude Pattern"), `claudegate.removeExcludePattern` ("Remove Exclude Pattern", icon `$(trash)`).
- `contributes.menus.view/item/context` — `claudegate.removeExcludePattern` with `"when": "view == claudegate.settingsPanel && viewItem == claudegate.excludePattern"`, `"group": "inline"`.

### Modified: `src/extension.ts`

- Construct `SettingsTreeProvider`; `vscode.window.createTreeView("claudegate.settingsPanel", { treeDataProvider })` (or `registerTreeDataProvider`).
- Register the three new commands:
  - `toggleFileWatcher`: read current `fileWatcher.enabled` (default true), write the negation via `updateClaudegateConfig("fileWatcher.enabled", !cur)`; then `settingsProvider.refresh()`.
  - `addExcludePattern`: `showInputBox({ prompt: "Glob to exclude (e.g. **/*.pb.go)", validateInput })`; on accept, `{ ...exclude, [glob]: true }` → write; refresh.
  - `removeExcludePattern`: takes the `SettingsItem`; delete its `pattern` key from the map → write; refresh.
- Shared helper `updateClaudegateConfig(key, value)`: writes with `ConfigurationTarget.WorkspaceFolder` when a workspace folder is open, else `Workspace`, else `Global`.
- Refresh the settings provider from the existing `claudegate.exclude` config listener too (or rely on the provider's own `onDidChangeConfiguration` subscription — pick one to avoid double refresh; the provider owning it is cleaner).

### Unchanged

`sessionManager`, `documentTracker`, `reviewPanel`, `diffProvider`, `decorationProvider`, `excludeMatcher`, `hook.py` — no changes. The exclusion/watcher behavior is already implemented; this only adds a UI surface.

## Error Handling

- **Add pattern validation:** reject empty/whitespace; if the glob already exists, no-op with an info message. `showInputBox` cancel → no change.
- **Config write failure:** `getConfiguration().update(...)` rejection is caught, logged at WARN, and surfaced via `showErrorMessage`.
- **No workspace folder open:** falls back to Global target so the action still works (documented in the row tooltip is not required; behavior is silent).
- **Hook status probe:** any `fs`/parse error in `getStatus()` fails safe to the most cautious state (`scriptInstalled: false`) rather than throwing.

## Testing

**Automated:** `npm run typecheck` and `npm run compile` must pass. `npm run test:unit` still green (unaffected).

**Manual (Extension Development Host):**
1. Settings pane appears as the 4th view, always visible.
2. **File Watcher** row shows On; click → flips to Off, `.vscode/settings.json` gains `claudegate.fileWatcher.enabled: false`, and the watcher actually stops (Output log). Click again → On, watcher restarts.
3. **Exclude Patterns**: `Add pattern…` → enter `**/*.pb.go` → row appears, written to Workspace settings, and a matching file disappears from Pending. Inline 🗑 on the row → key removed, file reappears.
4. Add a duplicate pattern → no-op + info message. Empty input → rejected.
5. **Hook** row matches reality: with hook installed+registered shows `✔`; rename `~/.claudegate/hook.py` away → shows `✖ Not installed`; click → Setup Hook runs and the row updates.
6. Edits made directly in `settings.json` (outside the pane) refresh the pane live.

## Release

- **No version bump** — folds into the unreleased `1.2.0`.
- Extend the existing `## [1.2.0] — 2026-07-04` CHANGELOG **Added** section: "Settings pane in the Claude Gate sidebar — toggle the file watcher, view/add/remove exclude patterns, and see hook status / run Setup Hook."
- No hook changes → no Setup Hook re-run required.
