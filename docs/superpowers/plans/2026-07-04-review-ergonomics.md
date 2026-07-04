# Review Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyboard accept/reject + auto-advance, `+A -R` change counts in the diff title/tooltip, and a right-click file-actions menu (incl. "Add to Claude Chat") to ClaudeGate rows.

**Architecture:** A new `vscode`-free `changeCount.ts` (diff line counting, unit-tested). `diffProvider`/`reviewPanel` consume it for the diff title and lazy row tooltip. `extension.ts` gains keybinding commands (`acceptCurrent`/`rejectCurrent`) with auto-advance, and six row-action wrapper commands delegating to built-in / existing commands. `package.json` declares keybindings, one setting, commands, and menus.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc), the already-bundled `diff` lib. No new dependencies. Node `assert` unit tests via `test:unit` for the pure module; typecheck/compile + manual for `vscode`-coupled code.

## Global Constraints

- **No new dependencies.**
- **No version bump** — folds into unreleased `1.2.0`; extend the existing `## [1.2.0] — 2026-07-04` CHANGELOG entry, no new heading.
- **Delegate, don't rebuild** — file actions call built-in commands (`vscode.open`, `revealInExplorer`) or the existing `claude-context.addFile`; only the two copies use a one-line `clipboard.writeText`.
- **Change counts** appear only in the diff title and hover tooltip — never in the row label/description.
- **Auto-advance** applies only to `acceptCurrent`/`rejectCurrent`, gated by `claudegate.autoAdvance` (default `true`).
- **`changeCount.ts` must not import `vscode`** (so it bundles+runs under plain Node for tests).
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass after every task.
- Change-count string format: `formatChangeCount` → `"+12 -3"`, `"+7"`, `"-4"`, or `"no changes"` (ASCII hyphen).

---

## File Structure

- `src/changeCount.ts` — CREATE: `countChanges` + `formatChangeCount` (no `vscode`).
- `src/changeCount.test.ts` — CREATE: Node `assert` tests.
- `package.json` — MODIFY: `test:unit` (also run changeCount test), `keybindings`, `autoAdvance` setting, 8 commands, `view/item/context` + `commandPalette` menu entries.
- `src/diffProvider.ts` — MODIFY: `openDiff` appends change count to the title.
- `src/reviewPanel.ts` — MODIFY: `resolveTreeItem` tooltip; fix `closeDiffEditor` prefix.
- `src/extension.ts` — MODIFY: `acceptCurrent`/`rejectCurrent` + `openNextPending`; six row-action wrappers; `claudegate.claudeContextAvailable` context key.
- `CHANGELOG.md`, `readme.md` — MODIFY: docs.

---

## Task 1: `changeCount` module + unit tests

**Files:**
- Create: `src/changeCount.ts`, `src/changeCount.test.ts`
- Modify: `package.json` (`scripts.test:unit`)

**Interfaces:**
- Consumes: the `diff` package (`diffLines`), already a dependency.
- Produces: `export interface ChangeCount { added: number; removed: number }`, `export function countChanges(original: string, current: string): ChangeCount`, `export function formatChangeCount(c: ChangeCount): string`.

- [ ] **Step 1: Extend `test:unit` to also run the changeCount test**

In `package.json`, replace the current `test:unit` script value with:

```json
"test:unit": "esbuild src/excludeMatcher.test.ts --bundle --platform=node --format=cjs --outfile=out/excludeMatcher.test.cjs && node out/excludeMatcher.test.cjs && esbuild src/changeCount.test.ts --bundle --platform=node --format=cjs --outfile=out/changeCount.test.cjs && node out/changeCount.test.cjs"
```

- [ ] **Step 2: Write the failing test**

Create `src/changeCount.test.ts`:

```typescript
import assert from "node:assert";
import { countChanges, formatChangeCount } from "./changeCount";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    console.error("FAIL -", name);
    console.error(e);
    process.exitCode = 1;
  }
}

run("countChanges: a modified line is 1 added + 1 removed", () => {
  assert.deepEqual(countChanges("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
});

run("countChanges: pure additions", () => {
  assert.deepEqual(countChanges("", "x\ny\n"), { added: 2, removed: 0 });
});

run("countChanges: identical content is zero", () => {
  assert.deepEqual(countChanges("x\ny\n", "x\ny\n"), { added: 0, removed: 0 });
});

run("formatChangeCount variants", () => {
  assert.equal(formatChangeCount({ added: 12, removed: 3 }), "+12 -3");
  assert.equal(formatChangeCount({ added: 7, removed: 0 }), "+7");
  assert.equal(formatChangeCount({ added: 0, removed: 4 }), "-4");
  assert.equal(formatChangeCount({ added: 0, removed: 0 }), "no changes");
});

console.log("done");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — esbuild cannot resolve `./changeCount` (module not created yet).

- [ ] **Step 4: Write the implementation**

Create `src/changeCount.ts`:

```typescript
// Line-level change counting for ClaudeGate. Kept free of `vscode` imports so
// it can be bundled and run under plain Node for unit tests.
import { diffLines } from "diff";

export interface ChangeCount {
  added: number;
  removed: number;
}

// Count added/removed lines between two versions.
export function countChanges(original: string, current: string): ChangeCount {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(original, current)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

// "+12 -3" / "+7" / "-4" / "no changes".
export function formatChangeCount(c: ChangeCount): string {
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added}`);
  if (c.removed) parts.push(`-${c.removed}`);
  return parts.length ? parts.join(" ") : "no changes";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: all `ok - …` lines (excludeMatcher + changeCount) and `done`, exit 0.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/changeCount.ts src/changeCount.test.ts package.json
git commit -m "feat: add changeCount (diff line counting) with unit tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Change count in the diff title

**Files:**
- Modify: `src/diffProvider.ts` (`openDiff` — the block from `const currentUri` through the `vscode.diff` call)

**Interfaces:**
- Consumes from Task 1: `countChanges`, `formatChangeCount`.
- Produces: diff tab titles of the form `Claude Gate: <file>  (original ↔ current · +A -B)` / `(new file · +N)`. No new exports.

- [ ] **Step 1: Import the helpers**

At the top of `src/diffProvider.ts`, add:

```typescript
import { countChanges, formatChangeCount } from "./changeCount";
```

- [ ] **Step 2: Compute the count and put it in the title**

In `openDiff`, replace this block:

```typescript
  const currentUri = vscode.Uri.file(filePath);
  const title =
    entry.originalContent === null
      ? `Claude Gate: ${label}  (new file)`
      : `Claude Gate: ${label}  (original ↔ current)`;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);
```

with:

```typescript
  const currentUri = vscode.Uri.file(filePath);

  // Change-size suffix for the title (best-effort; empty on read failure).
  let suffix = "";
  try {
    const currentText = (await vscode.workspace.openTextDocument(filePath)).getText();
    suffix = ` · ${formatChangeCount(countChanges(entry.originalContent ?? "", currentText))}`;
  } catch {
    suffix = "";
  }

  const title =
    entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);
```

(The existing scroll-to-first-change block that follows is unchanged.)

- [ ] **Step 3: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 4: Manual verification**

Open a pending diff → the tab title reads e.g. `Claude Gate: foo.ts  (original ↔ current · +12 -3)`; a new file reads `(new file · +40)`.

- [ ] **Step 5: Commit**

```bash
git add src/diffProvider.ts
git commit -m "feat: show +A -B change count in the diff tab title

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Row tooltip counts + `closeDiffEditor` fix

**Files:**
- Modify: `src/reviewPanel.ts` (add `resolveTreeItem` to `FilteredTreeProvider`; fix `closeDiffEditor` prefix; add `fs` + changeCount imports)

**Interfaces:**
- Consumes from Task 1: `countChanges`, `formatChangeCount`.
- Produces: hover tooltips on pending file rows include the change count; `closeDiffEditor(filePath)` now actually matches and closes the diff tab.

- [ ] **Step 1: Add imports**

At the top of `src/reviewPanel.ts`, add:

```typescript
import * as fs from "fs";
import { countChanges, formatChangeCount } from "./changeCount";
```

- [ ] **Step 2: Add `resolveTreeItem` to `FilteredTreeProvider`**

Add this method to the `FilteredTreeProvider` class (e.g. right after `getChildren`). `this.sessionManager` is the provider's existing field.

```typescript
  // Lazily enrich a pending file row's tooltip with its change count (only on
  // hover — no per-refresh cost). Non-pending rows keep their default tooltip.
  resolveTreeItem(
    item: vscode.TreeItem,
    element: vscode.TreeItem
  ): vscode.TreeItem {
    if (element instanceof FileReviewItem && element.reviewStatus === "pending") {
      const entry = this.sessionManager.getSession()?.files[element.filePath];
      if (entry) {
        try {
          const current = fs.readFileSync(element.filePath, "utf-8");
          const counts = countChanges(entry.originalContent ?? "", current);
          item.tooltip = new vscode.MarkdownString(
            `**${path.basename(element.filePath)}**\n\n${element.filePath}\n\nStatus: *pending* · ${formatChangeCount(counts)}`
          );
        } catch {
          // Keep the existing tooltip on read failure.
        }
      }
    }
    return item;
  }
```

- [ ] **Step 3: Fix the `closeDiffEditor` prefix**

In `closeDiffEditor`, change the prefix (the diff titles produced by `openDiff` start with `"Claude Gate: "`, not `"ClaudeGate: "`):

```typescript
export async function closeDiffEditor(filePath: string): Promise<void> {
  const prefix = `Claude Gate: ${path.basename(filePath)}`;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label.startsWith(prefix)) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}
```

- [ ] **Step 4: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 5: Manual verification**

1. Hover a pending file row → tooltip shows `Status: pending · +12 -3`.
2. Open a pending diff, then run **Accept All** (or accept via any path that calls `closeDiffEditor`) → the open diff tab actually closes now.

- [ ] **Step 6: Commit**

```bash
git add src/reviewPanel.ts
git commit -m "feat: change count in row tooltip; fix closeDiffEditor title prefix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Keyboard shortcuts + auto-advance

**Files:**
- Modify: `package.json` (`keybindings`, `autoAdvance` setting, 2 commands)
- Modify: `src/extension.ts` (`acceptCurrent`/`rejectCurrent` commands + `openNextPending` helper)

**Interfaces:**
- Consumes: existing module fn `getActivePendingFilePath(sessionManager)`, `sessionManager.acceptFile`/`rejectFile`, `closeDiffEditor` (imported from `./reviewPanel`), `isInWorkspace`/`isExcluded` (already imported), the `claudegate.openDiff` command, and the `claudegate.activeFileIsPending` context key. From Task 3: the fixed `closeDiffEditor`.
- Produces: commands `claudegate.acceptCurrent`, `claudegate.rejectCurrent`; setting `claudegate.autoAdvance`.

- [ ] **Step 1: Declare the setting in `package.json`**

Add to `contributes.configuration.properties`:

```json
"claudegate.autoAdvance": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "After accepting or rejecting from the diff view via keyboard (Cmd+Enter / Cmd+Backspace), automatically open the next pending file's diff."
}
```

- [ ] **Step 2: Declare the two commands in `package.json`**

Add to `contributes.commands`:

```json
{ "command": "claudegate.acceptCurrent", "title": "Claude Gate: Accept Current Diff" },
{ "command": "claudegate.rejectCurrent", "title": "Claude Gate: Reject Current Diff" }
```

- [ ] **Step 3: Declare the keybindings in `package.json`**

Add a top-level `contributes.keybindings` array (sibling of `commands`, `menus`, `configuration`):

```json
"keybindings": [
  { "command": "claudegate.acceptCurrent", "key": "ctrl+enter",           "mac": "cmd+enter",     "when": "claudegate.activeFileIsPending" },
  { "command": "claudegate.rejectCurrent", "key": "ctrl+shift+backspace", "mac": "cmd+backspace", "when": "claudegate.activeFileIsPending" }
]
```

- [ ] **Step 4: Add the `openNextPending` helper + commands in `extension.ts`**

Inside `activate` (where `sessionManager` and the command block live), add the helper near the other local helpers:

```typescript
    const openNextPending = async (): Promise<void> => {
      const session = sessionManager.getSession();
      const next = session
        ? Object.entries(session.files)
            .filter(([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp))
            .map(([fp]) => fp)
            .sort((a, b) => a.localeCompare(b))[0]
        : undefined;
      if (next) {
        await vscode.commands.executeCommand("claudegate.openDiff", next);
      } else {
        vscode.window.showInformationMessage("Claude Gate: all caught up ✓");
      }
    };
```

Register the two commands inside the existing `context.subscriptions.push( ... )` command block:

```typescript
      vscode.commands.registerCommand("claudegate.acceptCurrent", async () => {
        const fp = getActivePendingFilePath(sessionManager);
        if (!fp) return;
        sessionManager.acceptFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
      vscode.commands.registerCommand("claudegate.rejectCurrent", async () => {
        const fp = getActivePendingFilePath(sessionManager);
        if (!fp) return;
        sessionManager.rejectFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
```

(If `closeDiffEditor` is not already imported in `extension.ts`, add it to the existing `import { … } from "./reviewPanel";` line — it is used by the Accept All / Reject All handlers, so it should already be imported.)

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 6: Manual verification**

1. Open a pending file's diff, focus it, press `Cmd+Enter` → file accepted, its diff closes, the next pending diff opens; on the last one → "all caught up ✓".
2. `Cmd+Backspace` on a pending diff → file rejected (restored to original), advances.
3. Set `"claudegate.autoAdvance": false` → after `Cmd+Enter` the diff closes but no next diff opens.
4. With no ClaudeGate diff focused, the keys do nothing (context key false).

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: keyboard accept/reject current diff with auto-advance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Row context-menu file actions

**Files:**
- Modify: `package.json` (6 commands, `view/item/context` entries, `commandPalette` hides)
- Modify: `src/extension.ts` (6 wrapper commands + `claudegate.claudeContextAvailable` context key; import `FileReviewItem`)

**Interfaces:**
- Consumes: `FileReviewItem` (has `.filePath`) from `./reviewPanel`; built-in commands `vscode.open`, `revealInExplorer`; the existing `claude-context.addFile` command.
- Produces: commands `claudegate.openFile`, `claudegate.openToSide`, `claudegate.revealInExplorer`, `claudegate.copyPath`, `claudegate.copyRelativePath`, `claudegate.addToClaudeChat`; context key `claudegate.claudeContextAvailable`.

- [ ] **Step 1: Declare the six commands in `package.json`**

Add to `contributes.commands`:

```json
{ "command": "claudegate.openFile",         "title": "Claude Gate: Open File" },
{ "command": "claudegate.openToSide",       "title": "Claude Gate: Open to the Side" },
{ "command": "claudegate.revealInExplorer", "title": "Claude Gate: Reveal in Explorer" },
{ "command": "claudegate.copyPath",         "title": "Claude Gate: Copy Path" },
{ "command": "claudegate.copyRelativePath", "title": "Claude Gate: Copy Relative Path" },
{ "command": "claudegate.addToClaudeChat",  "title": "Claude Gate: Add to Claude Chat" }
```

- [ ] **Step 2: Declare the row menu + palette hides in `package.json`**

Add to `contributes.menus.view/item/context`:

```json
{ "command": "claudegate.openFile",         "when": "viewItem =~ /^claudegate\\.file\\./",                                          "group": "navigation@1" },
{ "command": "claudegate.openToSide",       "when": "viewItem =~ /^claudegate\\.file\\./",                                          "group": "navigation@2" },
{ "command": "claudegate.revealInExplorer", "when": "viewItem =~ /^claudegate\\.file\\./",                                          "group": "navigation@3" },
{ "command": "claudegate.copyPath",         "when": "viewItem =~ /^claudegate\\.file\\./",                                          "group": "9_copy@1" },
{ "command": "claudegate.copyRelativePath", "when": "viewItem =~ /^claudegate\\.file\\./",                                          "group": "9_copy@2" },
{ "command": "claudegate.addToClaudeChat",  "when": "viewItem =~ /^claudegate\\.file\\./ && claudegate.claudeContextAvailable",     "group": "z_claude@1" }
```

Add to `contributes.menus.commandPalette` (these need a row argument):

```json
{ "command": "claudegate.openFile",         "when": "false" },
{ "command": "claudegate.openToSide",       "when": "false" },
{ "command": "claudegate.revealInExplorer", "when": "false" },
{ "command": "claudegate.copyPath",         "when": "false" },
{ "command": "claudegate.copyRelativePath", "when": "false" },
{ "command": "claudegate.addToClaudeChat",  "when": "false" }
```

- [ ] **Step 3: Set the `claudeContextAvailable` context key in `extension.ts`**

Near the top of `activate` (after `log` is created), add:

```typescript
    vscode.commands.executeCommand(
      "setContext",
      "claudegate.claudeContextAvailable",
      !!vscode.extensions.getExtension("lntvan166.claude-context")
    );
```

- [ ] **Step 4: Import `FileReviewItem` and register the six wrappers in `extension.ts`**

Add `FileReviewItem` to the existing `import { … } from "./reviewPanel";` line. Then register these inside the existing command `push(...)` block:

```typescript
      vscode.commands.registerCommand("claudegate.openFile", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.openToSide", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.filePath), {
          viewColumn: vscode.ViewColumn.Beside,
        });
      }),
      vscode.commands.registerCommand("claudegate.revealInExplorer", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.copyPath", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.env.clipboard.writeText(item.filePath);
      }),
      vscode.commands.registerCommand("claudegate.copyRelativePath", (item: FileReviewItem) => {
        if (!item?.filePath) return;
        void vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(item.filePath));
      }),
      vscode.commands.registerCommand("claudegate.addToClaudeChat", async (item: FileReviewItem) => {
        if (!item?.filePath) return;
        const uri = vscode.Uri.file(item.filePath);
        try {
          await vscode.commands.executeCommand("claude-context.addFile", uri, [uri]);
        } catch {
          vscode.window.showWarningMessage("Claude Gate: 'Claude Context' extension not available.");
        }
      }),
```

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0. Also confirm `node -e "require('./package.json')"` parses.

- [ ] **Step 6: Manual verification**

1. Right-click a file row in any pane → Open File, Open to the Side, Reveal in Explorer, Copy Path, Copy Relative Path all present and working.
2. With `lntvan166.claude-context` installed → "Add to Claude Chat" appears and adds the file to its chat; uninstall/disable it → the item disappears.
3. None of these six appear in the Command Palette.

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: row context-menu file actions (open/reveal/copy/add-to-chat)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Docs & CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (extend the existing `## [1.2.0] — 2026-07-04` entry)
- Modify: `readme.md` (short "Reviewing" note)

**Interfaces:**
- Consumes: the features from Tasks 1–5.
- Produces: nothing consumed by code.

- [ ] **Step 1: Extend the CHANGELOG 1.2.0 entry**

In `CHANGELOG.md`, in the existing `## [1.2.0] — 2026-07-04` → `### Added` list, append:

```markdown
- **Keyboard review** — `Cmd+Enter` accept / `Cmd+Backspace` reject the focused diff, with auto-advance to the next pending file (`claudegate.autoAdvance`, default on).
- **Change counts** — the diff tab title and pending-row tooltip show `+A -B` line counts.
- **Row file actions** — right-click a file in the panel for Open File, Open to the Side, Reveal in Explorer, Copy Path / Relative Path, and Add to Claude Chat (when the Claude Context extension is installed).
```

And in that version's `### Fixed` list (create it just below `### Changed` if absent), append:

```markdown
- `closeDiffEditor` matched the wrong tab-title prefix, so open diff tabs were never closed on accept/reject; the diff tab now closes correctly.
```

- [ ] **Step 2: Add a short note to `readme.md`**

In `readme.md`, near the review workflow / features section, append:

```markdown
### Reviewing with the keyboard

With a ClaudeGate diff focused, press **Cmd+Enter** to accept or **Cmd+Backspace** to reject the file; ClaudeGate then opens the next pending diff automatically (disable via `claudegate.autoAdvance`). Right-click any file row for Open File, Reveal in Explorer, Copy Path, and (with the Claude Context extension) Add to Claude Chat.
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md readme.md
git commit -m "docs: document keyboard review, change counts, row actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** A (keys+auto-advance) → Task 4; the `closeDiffEditor` fix A depends on → Task 3. B′ diff title → Task 2; B′ tooltip → Task 3; `changeCount` module+tests → Task 1. D′ row actions (open/side/reveal/copy×2/add-to-chat) → Task 5; conditional Add-to-Chat context key → Task 5 Step 3; palette hides → Task 5 Step 2. `autoAdvance` setting → Task 4. Docs/no-version-bump → Task 6.
- **Placeholder scan:** none — every code step carries full code.
- **Type consistency:** `countChanges`/`formatChangeCount`/`ChangeCount` defined in Task 1, consumed in Tasks 2 & 3. `getActivePendingFilePath`, `closeDiffEditor`, `FileReviewItem`, `isInWorkspace`, `isExcluded` are existing symbols used as-is. Command IDs identical between `contributes.commands`, `keybindings`, `menus`, and `registerCommand`. `viewItem =~ /^claudegate\.file\./` matches the existing `claudegate.file.pending|accepted|rejected` contextValues set in `reviewPanel.ts`.
- **Ordering:** Task 3 (closeDiffEditor fix) precedes Task 4 (auto-advance depends on it). Tasks 2/3 depend on Task 1.
