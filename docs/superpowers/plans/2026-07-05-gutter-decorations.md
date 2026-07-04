# Gutter Decorations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude's changed lines (vs the frozen baseline) as gutter + overview-ruler decorations in the editor for pending files, using stable VS Code APIs.

**Architecture:** A pure `classifyChangedLines(original, current)` (in `src/lineDiff.ts`) returns added/modified/deleted current-doc line indices; a `GutterDecorator` (in `src/gutterDecorations.ts`) owns three `TextEditorDecorationType`s (bundled gutter SVGs + `ThemeColor` ruler) and applies/clears them for visible editors of pending files, refreshing on editor/document/session/config events.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc), the bundled `diff` lib. No new deps. `test:unit` for the pure module; typecheck/compile + manual for the vscode-coupled decorator.

## Global Constraints

- **No new dependencies.**
- **Stable APIs only** — `TextEditorDecorationType` + bundled SVGs + `ThemeColor`; NO QuickDiffProvider / SCM / proposed API.
- **Pending files only** — decorate `pending ∧ isInWorkspace ∧ !isExcluded`; clear otherwise (so accept/reject naturally clears).
- **3-way classification** — added (green), modified (blue), deleted (red triangle).
- **On by default** — `claudegate.gutterDecorations.enabled` defaults to `true`.
- **`src/lineDiff.ts` stays vscode-free** (bundle+run under Node for tests).
- **Folds into unreleased `1.3.0`** — extend the existing `## [1.3.0]` CHANGELOG entry; no version bump.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` pass after every task; `npm run test:unit` stays green.

---

## File Structure

- `src/lineDiff.ts` — CREATE: `classifyChangedLines` + `ChangedLines`.
- `src/lineDiff.test.ts` — CREATE: Node `assert` tests.
- `package.json` — MODIFY: add `test:unit` chain for the new test; add the `gutterDecorations.enabled` setting.
- `src/gutterDecorations.ts` — CREATE: `GutterDecorator`.
- `media/gutter-added.svg`, `media/gutter-modified.svg`, `media/gutter-deleted.svg` — CREATE.
- `src/extension.ts` — MODIFY: construct + start the decorator.
- `README.md`, `CHANGELOG.md` — MODIFY: docs (Task 3).

---

## Task 1: `classifyChangedLines` + unit tests

**Files:**
- Create: `src/lineDiff.ts`, `src/lineDiff.test.ts`
- Modify: `package.json` (extend `test:unit` to also run the new test)

**Interfaces:**
- Produces: `export interface ChangedLines { added: number[]; modified: number[]; deleted: number[] }` and `export function classifyChangedLines(original: string, current: string): ChangedLines` from `./lineDiff`.

- [ ] **Step 1: Extend the `test:unit` script in `package.json`**

Append to the existing `test:unit` value (which already chains excludeMatcher + changeCount) a third stage:

```
 && esbuild src/lineDiff.test.ts --bundle --platform=node --format=cjs --outfile=out/lineDiff.test.cjs && node out/lineDiff.test.cjs
```

(So the full script bundles+runs excludeMatcher.test.ts, changeCount.test.ts, and lineDiff.test.ts in sequence.)

- [ ] **Step 2: Write the failing test `src/lineDiff.test.ts`**

```typescript
import assert from "node:assert";
import { classifyChangedLines } from "./lineDiff";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("modified line", () => {
  assert.deepEqual(classifyChangedLines("a\nb\nc\n", "a\nB\nc\n"), { added: [], modified: [1], deleted: [] });
});
run("pure insertion", () => {
  assert.deepEqual(classifyChangedLines("a\nc\n", "a\nb\nc\n"), { added: [1], modified: [], deleted: [] });
});
run("pure deletion marks the boundary line", () => {
  const r = classifyChangedLines("a\nb\nc\n", "a\nc\n");
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.modified, []);
  assert.deepEqual(r.deleted, [1]);
});
run("no change → all empty", () => {
  assert.deepEqual(classifyChangedLines("a\nb\n", "a\nb\n"), { added: [], modified: [], deleted: [] });
});
run("new file → every current line added", () => {
  assert.deepEqual(classifyChangedLines("", "x\ny\n"), { added: [0, 1], modified: [], deleted: [] });
});

console.log("done");
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — esbuild can't resolve `./lineDiff` (module not created yet).

- [ ] **Step 4: Implement `src/lineDiff.ts`**

```typescript
// Classify which CURRENT-document lines changed vs a baseline. vscode-free so
// it bundles+runs under Node for unit tests.
import { diffLines } from "diff";

export interface ChangedLines {
  added: number[];
  modified: number[];
  deleted: number[];
}

// removed-block immediately followed by added-block → those added lines are `modified`;
// lone added-block → `added`; lone removed-block → `deleted` (boundary line, clamped).
// Line indices are 0-based positions in `current`.
export function classifyChangedLines(original: string, current: string): ChangedLines {
  const added: number[] = [];
  const modified: number[] = [];
  const deleted: number[] = [];
  const parts = diffLines(original, current);
  const lastLine = Math.max(0, current.split("\n").length - 1);
  let cur = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        const n = next.count ?? 0;
        for (let k = 0; k < n; k++) modified.push(cur + k);
        cur += n;
        i++; // consume the paired added part
      } else {
        deleted.push(Math.min(cur, lastLine));
      }
    } else if (p.added) {
      const n = p.count ?? 0;
      for (let k = 0; k < n; k++) added.push(cur + k);
      cur += n;
    } else {
      cur += p.count ?? 0;
    }
  }
  return { added, modified, deleted };
}
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: all `ok -` lines incl. the 5 new ones + `done`; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lineDiff.ts src/lineDiff.test.ts package.json
git commit -m "feat: add classifyChangedLines (line-level diff classification) + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `GutterDecorator` + assets + setting + wiring

**Files:**
- Create: `src/gutterDecorations.ts`
- Create: `media/gutter-added.svg`, `media/gutter-modified.svg`, `media/gutter-deleted.svg`
- Modify: `package.json` (add the setting)
- Modify: `src/extension.ts` (construct + start)

**Interfaces:**
- Consumes from Task 1: `classifyChangedLines`. Also `isInWorkspace`/`isExcluded` (workspaceScope), `SessionManager`.
- Produces: `export class GutterDecorator { constructor(sessionManager: SessionManager, context: vscode.ExtensionContext, log: vscode.OutputChannel); start(): void; stop(): void }`.

- [ ] **Step 1: Create the three gutter SVGs**

`media/gutter-added.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18" viewBox="0 0 6 18"><rect x="1" width="3" height="18" fill="#2ea043"/></svg>
```
`media/gutter-modified.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18" viewBox="0 0 6 18"><rect x="1" width="3" height="18" fill="#4ea1f0"/></svg>
```
`media/gutter-deleted.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="8" height="18" viewBox="0 0 8 18"><path d="M0 5 L7 9 L0 13 Z" fill="#cf222e"/></svg>
```

- [ ] **Step 2: Create `src/gutterDecorations.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";
import { classifyChangedLines } from "./lineDiff";
import { isInWorkspace, isExcluded } from "./workspaceScope";

const DEBOUNCE_MS = 300;

export class GutterDecorator {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly modified: vscode.TextEditorDecorationType;
  private readonly deleted: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sessionManager: SessionManager,
    context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    const icon = (name: string) =>
      vscode.Uri.file(path.join(context.extensionPath, "media", name));
    const make = (svg: string, ruler: string) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon(svg),
        gutterIconSize: "contain",
        overviewRulerColor: new vscode.ThemeColor(ruler),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
    this.added = make("gutter-added.svg", "editorGutter.addedBackground");
    this.modified = make("gutter-modified.svg", "editorGutter.modifiedBackground");
    this.deleted = make("gutter-deleted.svg", "editorGutter.deletedBackground");
  }

  start(): void {
    this.refreshAllVisible();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) this.refresh(ed); }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAllVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleForDoc(e.document)),
      this.sessionManager.onSessionChange(() => this.refreshAllVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudegate.gutterDecorations.enabled")) this.refreshAllVisible();
      })
    );
  }

  stop(): void {
    if (this.debounce !== undefined) { clearTimeout(this.debounce); this.debounce = undefined; }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.added.dispose();
    this.modified.dispose();
    this.deleted.dispose();
  }

  private scheduleForDoc(doc: vscode.TextDocument): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document === doc) this.refresh(ed);
      }
    }, DEBOUNCE_MS);
  }

  private refreshAllVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) this.refresh(ed);
  }

  private refresh(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") return;
    const fp = editor.document.uri.fsPath;
    const enabled = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("gutterDecorations.enabled", true);
    const entry = this.sessionManager.getSession()?.files[fp];
    if (!enabled || entry?.reviewStatus !== "pending" || !isInWorkspace(fp) || isExcluded(fp)) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.modified, []);
      editor.setDecorations(this.deleted, []);
      return;
    }
    const c = classifyChangedLines(entry.originalContent ?? "", editor.document.getText());
    const toRanges = (lines: number[]) => lines.map((l) => new vscode.Range(l, 0, l, 0));
    editor.setDecorations(this.added, toRanges(c.added));
    editor.setDecorations(this.modified, toRanges(c.modified));
    editor.setDecorations(this.deleted, toRanges(c.deleted));
  }
}
```

- [ ] **Step 3: Add the setting in `package.json`**

In `contributes.configuration.properties`:

```json
"claudegate.gutterDecorations.enabled": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Show Claude's changed lines (vs the frozen baseline) as gutter marks and overview-ruler ticks in the editor while a file is pending review. Turn off to hide them."
}
```

- [ ] **Step 4: Construct + start the decorator in `src/extension.ts`**

Add the import near the other provider imports:

```typescript
import { GutterDecorator } from "./gutterDecorations";
```

Near where `documentTracker.start()` is called (after the tree views / providers are set up), add:

```typescript
    const gutterDecorator = new GutterDecorator(sessionManager, context, log);
    gutterDecorator.start();
    context.subscriptions.push({ dispose: () => gutterDecorator.stop() });
```

- [ ] **Step 5: Typecheck, compile, package parse**

Run: `npm run typecheck && npm run compile && node -e "require('./package.json')"`
Expected: both exit 0; package.json parses.

- [ ] **Step 6: Manual verification (Extension Development Host)**

1. Have Claude edit a file, open it → changed lines show green/blue gutter bars + overview-ruler ticks; a deletion shows the red triangle.
2. Edit the file manually → decorations update (debounced).
3. Accept the file → decorations clear (baseline advanced). Reject → clear.
4. Set `claudegate.gutterDecorations.enabled: false` → decorations disappear; `true` → return.
5. An excluded / out-of-workspace file shows none.

- [ ] **Step 7: Commit**

```bash
git add src/gutterDecorations.ts media/gutter-added.svg media/gutter-modified.svg media/gutter-deleted.svg package.json src/extension.ts
git commit -m "feat: gutter + overview-ruler decorations for Claude's changed lines

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Docs & CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README — features + settings**

In `README.md`, add a Features bullet:

```markdown
- **Gutter change marks** — while a file is pending, Claude's changed lines are marked in the editor gutter (added/modified/deleted) and the overview ruler; toggle with `claudegate.gutterDecorations.enabled`.
```

And add a settings-table row:

```markdown
| `claudegate.gutterDecorations.enabled` | `true` | Show Claude's changed lines as gutter marks + overview-ruler ticks in the editor while a file is pending. |
```

- [ ] **Step 2: CHANGELOG — extend the 1.3.0 Added list**

In `CHANGELOG.md`, inside the existing `## [1.3.0]` → `### Added` list, append:

```markdown
- **Gutter change marks** — pending files show Claude's added/modified/deleted lines in the editor gutter and overview ruler (`claudegate.gutterDecorations.enabled`, on by default).
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document gutter change marks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** `classifyChangedLines` + tests → Task 1; `GutterDecorator` (types, refresh/clear, debounce, subscriptions, dispose) → Task 2 Step 2; SVG assets → Task 2 Step 1; setting → Task 2 Step 3; extension wiring → Task 2 Step 4; pending∧workspace∧!excluded gate + default-on + clear-when-not-pending → Task 2 `refresh`; docs/no-bump → Task 3.
- **Placeholder scan:** none — full code/SVG/commands in every step.
- **Type consistency:** `classifyChangedLines`/`ChangedLines` defined Task 1, consumed Task 2; `GutterDecorator(sessionManager, context, log)` constructed with the same arg order in Task 2 Step 4; setting key `claudegate.gutterDecorations.enabled` identical in package.json, `refresh`, and the config listener; SVG filenames identical between Task 2 Step 1 and the `make(...)` calls.
