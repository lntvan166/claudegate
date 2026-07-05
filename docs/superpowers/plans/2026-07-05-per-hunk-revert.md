# Per-Hunk Revert (CodeLens) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user revert an individual hunk of a pending file (undo just those lines to the frozen baseline) via a "↩ Revert this change" CodeLens above each hunk.

**Architecture:** A pure `src/hunks.ts` (`computeHunks` for lens placement/label, `revertHunkText` to rebuild the file with one hunk reverted); a `HunkCodeLensProvider` renders a revert lens per hunk for pending files; the `claudegate.revertHunk` command applies the rebuilt text as a whole-document `WorkspaceEdit` (undoable), or reuses `rejectFile` when the last hunk is reverted.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc), bundled `diff`. No new deps. `test:unit` for the pure module; typecheck/compile + manual for the vscode-coupled parts.

## Global Constraints

- **No new dependencies.**
- **Revert-only** — no per-hunk accept, no per-hunk reviewed state; the frozen `originalContent` baseline is never modified.
- **Revert via `WorkspaceEdit`** (undoable), **no confirmation prompt**.
- **Last-hunk revert reuses `sessionManager.rejectFile(fp)`** — do NOT change `SessionManager`.
- **`src/hunks.ts` stays vscode-free.**
- **Setting `claudegate.hunkCodeLens.enabled`, default `true`.**
- **Folds into unreleased `1.3.0`** — extend the existing `## [1.3.0]` CHANGELOG entry; no version bump.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` pass after every task; `npm run test:unit` stays green.

---

## File Structure

- `src/hunks.ts` — CREATE: `computeHunks` + `revertHunkText` + `Hunk`.
- `src/hunks.test.ts` — CREATE: Node `assert` tests.
- `package.json` — MODIFY: extend `test:unit`; add the setting.
- `src/hunkCodeLens.ts` — CREATE: `HunkCodeLensProvider`.
- `src/extension.ts` — MODIFY: register the provider + the `revertHunk` command.
- `README.md`, `CHANGELOG.md` — MODIFY: docs (Task 3).

---

## Task 1: `src/hunks.ts` + unit tests

**Files:**
- Create: `src/hunks.ts`, `src/hunks.test.ts`
- Modify: `package.json` (extend `test:unit`)

**Interfaces:**
- Produces: `export interface Hunk { startLine: number; label: string }`, `export function computeHunks(original: string, current: string): Hunk[]`, `export function revertHunkText(original: string, current: string, hunkIndex: number): string`.

- [ ] **Step 1: Extend `test:unit` in `package.json`**

Append to the existing `test:unit` value a fourth stage:

```
 && esbuild src/hunks.test.ts --bundle --platform=node --format=cjs --outfile=out/hunks.test.cjs && node out/hunks.test.cjs
```

- [ ] **Step 2: Write the failing test `src/hunks.test.ts`**

```typescript
import assert from "node:assert";
import { computeHunks, revertHunkText } from "./hunks";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("computeHunks: single modified line → one hunk at its line", () => {
  const h = computeHunks("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(h.length, 1);
  assert.equal(h[0].startLine, 1);
  assert.equal(h[0].label, "+1 -1");
});

run("computeHunks: two separated changes → two hunks", () => {
  const h = computeHunks("a\nb\nc\nd\n", "A\nb\nC\nd\n");
  assert.equal(h.length, 2);
  assert.equal(h[0].startLine, 0);
  assert.equal(h[1].startLine, 2);
});

run("revertHunkText: reverting the only hunk yields the baseline", () => {
  assert.equal(revertHunkText("a\nb\nc\n", "a\nB\nc\n", 0), "a\nb\nc\n");
});

run("revertHunkText: two hunks — revert hunk 0 keeps hunk 1", () => {
  assert.equal(revertHunkText("a\nb\nc\nd\n", "A\nb\nC\nd\n", 0), "a\nb\nC\nd\n");
  assert.equal(revertHunkText("a\nb\nc\nd\n", "A\nb\nC\nd\n", 1), "A\nb\nc\nd\n");
});

run("revertHunkText: pure addition revert removes the added lines", () => {
  assert.equal(revertHunkText("a\nc\n", "a\nb\nc\n", 0), "a\nc\n");
});

run("revertHunkText: pure deletion revert re-inserts baseline lines", () => {
  assert.equal(revertHunkText("a\nb\nc\n", "a\nc\n", 0), "a\nb\nc\n");
});

run("revertHunkText: new file (baseline empty) revert → empty", () => {
  assert.equal(revertHunkText("", "x\ny\n", 0), "");
});

console.log("done");
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — esbuild can't resolve `./hunks`.

- [ ] **Step 4: Implement `src/hunks.ts`**

```typescript
// Hunk model for per-hunk revert. Kept free of `vscode` imports so it bundles+runs
// under Node for unit tests.
import { diffLines } from "diff";

export interface Hunk {
  startLine: number; // 0-based current-doc line where the hunk begins (for the CodeLens)
  label: string;     // "+A -R" summary
}

// A hunk = a maximal run of consecutive changed diff parts (added/removed),
// bounded by unchanged runs.
export function computeHunks(original: string, current: string): Hunk[] {
  const parts = diffLines(original, current);
  const lastLine = Math.max(0, current.split("\n").length - 1);
  const hunks: Hunk[] = [];
  let cur = 0;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) { cur += p.count ?? 0; i++; continue; }
    const start = cur;
    let added = 0;
    let removed = 0;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      const n = q.count ?? 0;
      if (q.added) { added += n; cur += n; } else { removed += n; }
      i++;
    }
    hunks.push({ startLine: Math.min(start, lastLine), label: `+${added} -${removed}` });
  }
  return hunks;
}

// Rebuild the full file text with the Nth hunk reverted to baseline: emit the
// CURRENT side for every part except the target hunk's parts, which emit the
// ORIGINAL side. Part values carry their own newlines, so this is newline-safe.
export function revertHunkText(original: string, current: string, hunkIndex: number): string {
  const parts = diffLines(original, current);
  let out = "";
  let hunk = -1;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) { out += p.value; i++; continue; }
    hunk++;
    const target = hunk === hunkIndex;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      if (target) {
        if (q.removed) out += q.value; // revert → original side
      } else {
        if (q.added) out += q.value;   // keep → current side
      }
      i++;
    }
  }
  return out;
}
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npm run test:unit && npm run typecheck`
Expected: all `ok -` (incl. the 7 new) + `done`; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/hunks.ts src/hunks.test.ts package.json
git commit -m "feat: add hunk model (computeHunks/revertHunkText) + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CodeLens provider + `revertHunk` command + setting + wiring

**Files:**
- Create: `src/hunkCodeLens.ts`
- Modify: `package.json` (add the setting)
- Modify: `src/extension.ts` (register provider + command)

**Interfaces:**
- Consumes from Task 1: `computeHunks`, `revertHunkText`. Also `SessionManager`, `isInWorkspace`/`isExcluded`, existing `sessionManager.rejectFile`/`notifyChanged`.
- Produces: `export class HunkCodeLensProvider implements vscode.CodeLensProvider { constructor(sessionManager: SessionManager, disposables: vscode.Disposable[]) }`; command `claudegate.revertHunk`.

- [ ] **Step 1: Create `src/hunkCodeLens.ts`**

```typescript
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { computeHunks } from "./hunks";
import { isInWorkspace, isExcluded } from "./workspaceScope";

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly sessionManager: SessionManager,
    disposables: vscode.Disposable[]
  ) {
    disposables.push(
      sessionManager.onSessionChange(() => this._onDidChangeCodeLenses.fire()),
      vscode.workspace.onDidChangeTextDocument(() => this._onDidChangeCodeLenses.fire())
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") return [];
    const enabled = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("hunkCodeLens.enabled", true);
    if (!enabled) return [];
    const fp = document.uri.fsPath;
    const entry = this.sessionManager.getSession()?.files[fp];
    if (entry?.reviewStatus !== "pending" || !isInWorkspace(fp) || isExcluded(fp)) return [];
    return computeHunks(entry.originalContent ?? "", document.getText()).map(
      (h, i) =>
        new vscode.CodeLens(new vscode.Range(h.startLine, 0, h.startLine, 0), {
          title: `↩ Revert this change · ${h.label}`,
          command: "claudegate.revertHunk",
          arguments: [document.uri, i],
        })
    );
  }
}
```

- [ ] **Step 2: Add the setting in `package.json`**

In `contributes.configuration.properties`:

```json
"claudegate.hunkCodeLens.enabled": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Show a \"Revert this change\" CodeLens above each of Claude's hunks in a pending file, so you can undo an individual hunk (reverting just those lines to the baseline). Turn off to hide the lenses."
}
```

- [ ] **Step 3: Register the provider + command in `src/extension.ts`**

Add imports:

```typescript
import { HunkCodeLensProvider } from "./hunkCodeLens";
import { revertHunkText } from "./hunks";
```

Where the other providers/views are set up (near `documentTracker.start()` / the gutter decorator wiring), register the CodeLens provider:

```typescript
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        new HunkCodeLensProvider(sessionManager, context.subscriptions)
      )
    );
```

Inside the existing `context.subscriptions.push( ... )` command block, register the command:

```typescript
      vscode.commands.registerCommand(
        "claudegate.revertHunk",
        async (uri: vscode.Uri, hunkIndex: number) => {
          const entry = sessionManager.getSession()?.files[uri.fsPath];
          if (entry?.reviewStatus !== "pending") return;
          const doc = await vscode.workspace.openTextDocument(uri);
          const baseline = entry.originalContent ?? "";
          const newText = revertHunkText(baseline, doc.getText(), hunkIndex);
          if (newText === baseline) {
            // Last remaining change reverted → fully back to baseline. rejectFile
            // saves current-on-disk as claudeContent (Re-apply still works) and
            // restores the baseline / deletes a new file.
            sessionManager.rejectFile(uri.fsPath);
            return;
          }
          try {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length)
            );
            edit.replace(uri, fullRange, newText);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            sessionManager.notifyChanged();
          } catch (err) {
            log.appendLine(`[ERROR] revertHunk failed for ${uri.fsPath}: ${(err as Error).message}`);
            vscode.window.showErrorMessage(
              `Claude Gate: could not revert hunk — ${(err as Error).message}`
            );
          }
        }
      ),
```

(`log`, `sessionManager`, `context` are all in scope in `activate`.)

- [ ] **Step 4: Typecheck, compile, package parse**

Run: `npm run typecheck && npm run compile && node -e "require('./package.json')"`
Expected: both exit 0; package.json parses.

- [ ] **Step 5: Manual verification (Extension Development Host)**

1. Open a pending file with ≥2 hunks → a "↩ Revert this change · +A -R" CodeLens sits above each hunk.
2. Click one → just that hunk reverts to baseline (others stay); gutter marks + any open diff update; `Cmd+Z` undoes it.
3. Revert the last remaining hunk → the file moves to the Rejected panel (fully back to baseline); Re-apply restores it.
4. `claudegate.hunkCodeLens.enabled: false` → no lenses; back to `true` → they return.
5. Excluded / accepted / rejected files show no lenses.

- [ ] **Step 6: Commit**

```bash
git add src/hunkCodeLens.ts package.json src/extension.ts
git commit -m "feat: per-hunk revert via CodeLens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Docs & CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README — features / review flow**

In `README.md`, add a Features bullet:

```markdown
- **Per-hunk revert** — a "↩ Revert this change" CodeLens above each of Claude's hunks lets you undo an individual hunk (just those lines) while keeping the rest; toggle with `claudegate.hunkCodeLens.enabled`.
```

And a settings-table row:

```markdown
| `claudegate.hunkCodeLens.enabled` | `true` | Show a "Revert this change" CodeLens above each hunk in a pending file to undo individual hunks. |
```

- [ ] **Step 2: CHANGELOG — extend the 1.3.0 Added list**

In `CHANGELOG.md`, inside the existing `## [1.3.0]` → `### Added` list, append:

```markdown
- **Per-hunk revert** — a "Revert this change" CodeLens above each of Claude's hunks reverts just those lines to the baseline (undoable), leaving the file's other changes pending.
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document per-hunk revert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** `computeHunks`/`revertHunkText` + tests → Task 1; CodeLens provider (gate, lens per hunk, refresh on session/doc change) → Task 2 Step 1; setting → Task 2 Step 2; `revertHunk` command (WorkspaceEdit whole-doc replace, no confirm, last-hunk→rejectFile) → Task 2 Step 3; wiring → Task 2 Step 3; docs/no-bump → Task 3.
- **Placeholder scan:** none — full code in every step.
- **Type consistency:** `computeHunks`/`revertHunkText`/`Hunk` defined Task 1, consumed by the provider + command in Task 2; `HunkCodeLensProvider(sessionManager, disposables)` matches its construction; command id `claudegate.revertHunk` identical in provider args, package.json (implicitly via registerCommand — note: this command takes args so it is NOT added to contributes.commands/palette, matching other arg-only internal commands like `claudegate.openDiff`), and `registerCommand`; `rejectFile(fp)`/`notifyChanged()` are existing `SessionManager` methods.
- **Note:** `claudegate.revertHunk` is invoked only from the CodeLens (needs args), so — like `claudegate.openDiff` — it is intentionally NOT declared in `contributes.commands` and not shown in the palette.
