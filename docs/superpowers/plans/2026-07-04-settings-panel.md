# ClaudeGate Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Settings" TreeView to the Claude Gate sidebar that toggles the file watcher, lists/adds/removes exclude patterns, and shows hook status / runs Setup Hook.

**Architecture:** A new `SettingsTreeProvider` (native `vscode.TreeDataProvider`) is the fourth view in the existing `claudegate` activity-bar container. It reads state from the `claudegate.*` settings and from a new `HookInstaller.getStatus()`; its rows fire commands (`toggleFileWatcher`, `addExcludePattern`, `removeExcludePattern`, existing `setupHook`) that write config at Workspace scope. No new persisted state.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc). No new dependencies. No unit-test runner for `vscode`-coupled code → verification is `npm run typecheck`/`compile` + manual in the Extension Development Host.

## Global Constraints

- **No new dependencies.**
- **No version bump** — folds into the unreleased `1.2.0`; extend the existing `## [1.2.0] — 2026-07-04` CHANGELOG entry, no new version heading.
- **View type: native TreeView** (no webview), consistent with the existing panes.
- **Write scope: Workspace** when a workspace folder is open (writes `.vscode/settings.json`), else **Global**. Never prompt.
- **Remove pattern = delete the key** from the `claudegate.exclude` map (not set `false`).
- **Thin front-end** — surfaces existing `claudegate.exclude` / `claudegate.fileWatcher.enabled` and hook status only; no new settings or detection behavior.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass after every task.

---

## File Structure

- `src/hookInstaller.ts` — MODIFY: add `getStatus(): HookStatus` + export `HookStatus`.
- `src/settingsPanel.ts` — CREATE: `SettingsTreeProvider` + `SettingsItem` type.
- `package.json` — MODIFY: add the `claudegate.settingsPanel` view; add 3 commands; add the inline remove menu.
- `src/extension.ts` — MODIFY: construct/register the provider + view; register 3 commands + `updateClaudegateConfig` helper; refresh the provider after `setupHook`.
- `CHANGELOG.md`, `readme.md` — MODIFY: docs.

---

## Task 1: `HookInstaller.getStatus()`

**Files:**
- Modify: `src/hookInstaller.ts` (add exported `HookStatus` interface + public `getStatus()` method; reuse existing `hookPyDest`, `claudeSettingsPath`, `installedHookHash()`, `bundledHookHash()`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export interface HookStatus { scriptInstalled: boolean; registered: boolean; upToDate: boolean }` and `HookInstaller.getStatus(): HookStatus`.

- [ ] **Step 1: Add the `HookStatus` interface**

At the top of `src/hookInstaller.ts` (after the imports, before the class), add:

```typescript
export interface HookStatus {
  scriptInstalled: boolean;
  registered: boolean;
  upToDate: boolean;
}
```

- [ ] **Step 2: Add the `getStatus()` method**

Add this public method to the `HookInstaller` class (e.g. immediately after `warnIfHookNotRegisteredInSettings()`):

```typescript
  // Snapshot of hook install/registration state for the Settings panel.
  // Fails safe (false) on any read error rather than throwing.
  getStatus(): HookStatus {
    const scriptInstalled = fs.existsSync(this.hookPyDest);

    let registered = false;
    try {
      registered = fs.readFileSync(this.claudeSettingsPath, "utf-8").includes("claudegate");
    } catch {
      registered = false;
    }

    let upToDate = false;
    if (scriptInstalled) {
      try {
        upToDate = this.installedHookHash() === this.bundledHookHash();
      } catch {
        upToDate = false;
      }
    }

    return { scriptInstalled, registered, upToDate };
  }
```

- [ ] **Step 3: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0. (No standalone test — this is exercised by the Settings panel's hook row in Task 2's manual verification.)

- [ ] **Step 4: Commit**

```bash
git add src/hookInstaller.ts
git commit -m "feat: add HookInstaller.getStatus() for settings panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `SettingsTreeProvider` + view (rendering)

**Files:**
- Create: `src/settingsPanel.ts`
- Modify: `package.json` (add the view under `contributes.views.claudegate`)
- Modify: `src/extension.ts` (construct provider, create the tree view, refresh after `setupHook`)

**Interfaces:**
- Consumes from Task 1: `HookInstaller.getStatus()`, `HookStatus`.
- Produces: `export interface SettingsItem { kind: "watcher" | "excludeHeader" | "excludePattern" | "excludeAdd" | "hook"; pattern?: string }` and `export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsItem> { constructor(hookInstaller: HookInstaller, disposables: vscode.Disposable[]); refresh(): void }`. Rows reference command IDs `claudegate.toggleFileWatcher`, `claudegate.addExcludePattern`, `claudegate.setupHook` (the first two are registered in Task 3; clicking them before Task 3 lands is a no-op error, which is fine mid-plan).

- [ ] **Step 1: Create `src/settingsPanel.ts`**

```typescript
import * as vscode from "vscode";
import { HookInstaller } from "./hookInstaller";

type SettingsKind =
  | "watcher"
  | "excludeHeader"
  | "excludePattern"
  | "excludeAdd"
  | "hook";

export interface SettingsItem {
  kind: SettingsKind;
  pattern?: string; // set only for kind === "excludePattern"
}

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly hookInstaller: HookInstaller,
    disposables: vscode.Disposable[]
  ) {
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudegate.exclude") ||
          e.affectsConfiguration("claudegate.fileWatcher.enabled")
        ) {
          this.refresh();
        }
      })
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: SettingsItem): SettingsItem[] {
    if (!element) {
      return [{ kind: "watcher" }, { kind: "excludeHeader" }, { kind: "hook" }];
    }
    if (element.kind === "excludeHeader") {
      const rows: SettingsItem[] = this.activePatterns().map((p) => ({
        kind: "excludePattern" as const,
        pattern: p,
      }));
      rows.push({ kind: "excludeAdd" });
      return rows;
    }
    return [];
  }

  getTreeItem(item: SettingsItem): vscode.TreeItem {
    switch (item.kind) {
      case "watcher": {
        const enabled = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("fileWatcher.enabled", true);
        const ti = new vscode.TreeItem("File Watcher");
        ti.description = enabled ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(enabled ? "eye" : "eye-closed");
        ti.tooltip = `Click to turn the GUI file watcher ${enabled ? "off" : "on"}`;
        ti.command = { command: "claudegate.toggleFileWatcher", title: "Toggle File Watcher" };
        return ti;
      }
      case "excludeHeader": {
        const ti = new vscode.TreeItem(
          "Exclude Patterns",
          vscode.TreeItemCollapsibleState.Expanded
        );
        ti.description = String(this.activePatterns().length);
        ti.iconPath = new vscode.ThemeIcon("filter");
        return ti;
      }
      case "excludePattern": {
        const ti = new vscode.TreeItem(item.pattern ?? "");
        ti.contextValue = "claudegate.excludePattern";
        ti.iconPath = new vscode.ThemeIcon("circle-small-filled");
        ti.tooltip = "Excluded from ClaudeGate review";
        return ti;
      }
      case "excludeAdd": {
        const ti = new vscode.TreeItem("Add pattern…");
        ti.iconPath = new vscode.ThemeIcon("add");
        ti.command = { command: "claudegate.addExcludePattern", title: "Add Exclude Pattern" };
        return ti;
      }
      case "hook": {
        const s = this.hookInstaller.getStatus();
        const ti = new vscode.TreeItem("Hook");
        if (!s.scriptInstalled) {
          ti.description = "Not installed";
          ti.iconPath = new vscode.ThemeIcon("error");
        } else if (!s.registered) {
          ti.description = "Not registered";
          ti.iconPath = new vscode.ThemeIcon("warning");
        } else if (!s.upToDate) {
          ti.description = "Update available";
          ti.iconPath = new vscode.ThemeIcon("warning");
        } else {
          ti.description = "Installed & registered";
          ti.iconPath = new vscode.ThemeIcon("check");
        }
        ti.tooltip = "Click to run Setup Hook";
        ti.command = { command: "claudegate.setupHook", title: "Setup Hook" };
        return ti;
      }
    }
  }

  private activePatterns(): string[] {
    const map = vscode.workspace
      .getConfiguration("claudegate")
      .get<Record<string, boolean>>("exclude", {});
    return Object.entries(map)
      .filter(([, active]) => active)
      .map(([glob]) => glob);
  }
}
```

- [ ] **Step 2: Declare the view in `package.json`**

In `contributes.views.claudegate`, append this entry after the `rejectedPanel` entry (no `when` — always visible):

```json
{
  "id": "claudegate.settingsPanel",
  "name": "Settings"
}
```

- [ ] **Step 3: Register the provider + view in `extension.ts`**

Add the import near the other provider imports (top of `src/extension.ts`):

```typescript
import { SettingsTreeProvider } from "./settingsPanel";
```

After the existing tree views are created and pushed (`context.subscriptions.push(pendingView, acceptedView, rejectedView);`, ~line 113), add:

```typescript
    const settingsProvider = new SettingsTreeProvider(hookInstaller, context.subscriptions);
    const settingsView = vscode.window.createTreeView("claudegate.settingsPanel", {
      treeDataProvider: settingsProvider,
    });
    context.subscriptions.push(settingsView);
```

(`hookInstaller` already exists in `activate` — it's constructed earlier at ~line 61.)

- [ ] **Step 4: Refresh the panel after Setup Hook runs**

`setupHook` changes hook install/registration state but not `claudegate.*` config, so the provider's config listener won't fire. Update the existing `claudegate.setupHook` command registration so it refreshes the panel afterward. Find it (it currently reads roughly):

```typescript
      vscode.commands.registerCommand("claudegate.setupHook", () =>
        hookInstaller.setup()
      ),
```

Replace with:

```typescript
      vscode.commands.registerCommand("claudegate.setupHook", async () => {
        await hookInstaller.setup();
        settingsProvider.refresh();
      }),
```

(Ensure `settingsProvider` is declared before this command registration; if the command block precedes the provider construction in the file, move the provider construction from Step 3 to just above the command-registration block so `settingsProvider` is in scope.)

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 6: Manual verification (Extension Development Host)**

1. A fourth view "Settings" appears in the Claude Gate container, always visible.
2. **File Watcher** row shows `On`/`Off` matching `claudegate.fileWatcher.enabled`.
3. **Exclude Patterns** expands: one row per active glob in `claudegate.exclude` (add one in settings.json to confirm), plus an `Add pattern…` row; count in the description is correct.
4. **Hook** row description matches reality: with hook installed+registered → `Installed & registered` (check icon); temporarily rename `~/.claudegate/hook.py` → `Not installed` (error icon); restore it.
5. Clicking the Hook row runs Setup Hook and the row refreshes afterward.
6. (Toggle/Add rows will error on click until Task 3 — expected.)

- [ ] **Step 7: Commit**

```bash
git add src/settingsPanel.ts package.json src/extension.ts
git commit -m "feat: add Settings TreeView (rendering) to Claude Gate sidebar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Settings commands (toggle / add / remove)

**Files:**
- Modify: `package.json` (add 3 commands + the inline remove menu)
- Modify: `src/extension.ts` (register the 3 commands + `updateClaudegateConfig` helper)

**Interfaces:**
- Consumes from Task 2: `SettingsItem` (imported for the remove handler's arg type), `settingsProvider` (in scope in `activate`).
- Produces: commands `claudegate.toggleFileWatcher`, `claudegate.addExcludePattern`, `claudegate.removeExcludePattern`.

- [ ] **Step 1: Declare the commands in `package.json`**

Add to `contributes.commands`:

```json
{ "command": "claudegate.toggleFileWatcher", "title": "Claude Gate: Toggle File Watcher" },
{ "command": "claudegate.addExcludePattern", "title": "Claude Gate: Add Exclude Pattern", "icon": "$(add)" },
{ "command": "claudegate.removeExcludePattern", "title": "Claude Gate: Remove Exclude Pattern", "icon": "$(trash)" }
```

- [ ] **Step 2: Declare the inline remove menu in `package.json`**

In `contributes.menus`, add (or extend the existing) `view/item/context` array with:

```json
{
  "command": "claudegate.removeExcludePattern",
  "when": "view == claudegate.settingsPanel && viewItem == claudegate.excludePattern",
  "group": "inline"
}
```

- [ ] **Step 3: Add the `updateClaudegateConfig` helper in `extension.ts`**

Inside `activate` (so it closes over `log`), near the top of the function body, add:

```typescript
    const updateClaudegateConfig = async (key: string, value: unknown): Promise<void> => {
      const target =
        (vscode.workspace.workspaceFolders?.length ?? 0) > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await vscode.workspace.getConfiguration("claudegate").update(key, value, target);
      } catch (err) {
        log.appendLine(`[ERROR] Failed to update claudegate.${key}: ${(err as Error).message}`);
        vscode.window.showErrorMessage(
          `Claude Gate: could not update ${key} — ${(err as Error).message}`
        );
      }
    };
```

- [ ] **Step 4: Import `SettingsItem` and register the three commands in `extension.ts`**

Extend the settings import from Task 2 to also import the type:

```typescript
import { SettingsTreeProvider, SettingsItem } from "./settingsPanel";
```

Add these three registrations inside the existing `context.subscriptions.push( ... )` command block:

```typescript
      vscode.commands.registerCommand("claudegate.toggleFileWatcher", async () => {
        const cur = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("fileWatcher.enabled", true);
        await updateClaudegateConfig("fileWatcher.enabled", !cur);
        // Provider auto-refreshes via its onDidChangeConfiguration listener.
      }),

      vscode.commands.registerCommand("claudegate.addExcludePattern", async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Glob to exclude from ClaudeGate review",
          placeHolder: "**/*.pb.go",
          validateInput: (v) => (v.trim().length === 0 ? "Enter a non-empty glob" : undefined),
        });
        if (!input) return;
        const glob = input.trim();
        const map = {
          ...vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("exclude", {}),
        };
        if (map[glob] === true) {
          vscode.window.showInformationMessage(`Claude Gate: "${glob}" is already excluded.`);
          return;
        }
        map[glob] = true;
        await updateClaudegateConfig("exclude", map);
      }),

      vscode.commands.registerCommand(
        "claudegate.removeExcludePattern",
        async (item: SettingsItem) => {
          const glob = item?.pattern;
          if (!glob) return;
          const map = {
            ...vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("exclude", {}),
          };
          delete map[glob];
          await updateClaudegateConfig("exclude", map);
        }
      ),
```

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 6: Manual verification (Extension Development Host)**

1. **Toggle:** click the File Watcher row → flips On↔Off; `.vscode/settings.json` gains `claudegate.fileWatcher.enabled`; the watcher actually starts/stops (Output log); the row updates.
2. **Add:** click `Add pattern…` → enter `**/*.pb.go` → row appears under Exclude Patterns; `.vscode/settings.json` `claudegate.exclude` gains `{ "**/*.pb.go": true }`; a matching pending file disappears from the Pending panel.
3. **Add duplicate** → info message, no change. **Empty input** → rejected by validation.
4. **Remove:** hover a pattern row → inline 🗑 → click → key removed from config; row disappears; the matching file reappears in Pending.
5. All writes land in Workspace settings (`.vscode/settings.json`) when a folder is open.

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: settings panel commands (toggle watcher, add/remove exclude)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs & CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (extend the existing `## [1.2.0] — 2026-07-04` **Added** section)
- Modify: `readme.md` (mention the Settings pane in the Extension Settings section)

**Interfaces:**
- Consumes: the panel from Tasks 1–3.
- Produces: nothing consumed by code.

- [ ] **Step 1: Extend the CHANGELOG 1.2.0 Added section**

In `CHANGELOG.md`, inside the existing `## [1.2.0] — 2026-07-04` → `### Added` list (do NOT add a new version heading), append:

```markdown
- **Settings pane** in the Claude Gate sidebar — toggle the file watcher, view/add/remove exclude patterns, and see hook status / run Setup Hook, all in one place.
```

- [ ] **Step 2: Mention the pane in `readme.md`**

In `readme.md`, at the end of the "Extension Settings" section added earlier, append:

```markdown
You can manage these from the **Settings** pane in the Claude Gate sidebar — toggle the file watcher, add/remove exclude patterns, and check hook status without editing `settings.json` by hand.
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md readme.md
git commit -m "docs: document the Settings pane

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** TreeView view → Task 2 (package.json + provider). File Watcher toggle row + command → Task 2 (render) + Task 3 (command). Exclude list/add/remove → Task 2 (render) + Task 3 (add/remove commands + inline menu). Hook status row + getStatus → Task 1 + Task 2. Workspace write scope → Task 3 `updateClaudegateConfig`. Remove = delete key → Task 3 remove handler. Refresh on config change → provider's own listener (Task 2); refresh after setupHook → Task 2 Step 4. Always-visible view (no `when`) → Task 2 Step 2. No version bump / CHANGELOG Added → Task 4. Error handling (add validation, dup no-op, write failure) → Task 3.
- **Placeholder scan:** none — all code steps carry full code.
- **Type consistency:** `SettingsItem { kind, pattern? }` defined in Task 2, imported and used in Task 3's remove handler. `HookStatus`/`getStatus()` defined Task 1, consumed Task 2. `contextValue: "claudegate.excludePattern"` (Task 2) matches the menu `when` (Task 3 Step 2). Command IDs identical across package.json declarations and `registerCommand` calls: `claudegate.toggleFileWatcher`, `claudegate.addExcludePattern`, `claudegate.removeExcludePattern`.
- **Ordering note:** `settingsProvider` must be constructed before both the `setupHook` refresh (Task 2 Step 4) and the Task 3 commands reference it only indirectly (via config listener), so construct it above the command-registration block — called out in Task 2 Step 4.
