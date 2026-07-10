# Review Changes Webview Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cursor-inspired "Review Changes" webview editor tab where the user sees all pending Claude changes stacked, keeps/undoes each file inline (with an optional revert reason), toggles split/unified diffs, and copies a mechanical "Feedback to AI" text log — replacing the static `vscode.changes` multi-diff.

**Architecture:** A pure, vscode-free model module (`reviewWebviewModel.ts`) computes per-file diff pieces + the feedback text and is unit-tested under plain Node. A `WebviewPanel` provider (`reviewWebview.ts`) subscribes to `SessionManager.onSessionChange`, builds the model, and posts it to a webview client (`media/review/*`) that renders incrementally (no tab close/reopen, no flicker). Revert reason is captured on `ReviewRecord.reason` across every reject surface.

**Tech Stack:** TypeScript, VS Code Extension API (`WebviewPanel`, `webview.postMessage`), the `diff` npm package (`diffLines`, already a dependency), esbuild bundling, hand-rolled `run()`-style Node unit tests (no framework).

## Global Constraints

- **Engine floor:** VS Code `^1.85.0` (`package.json` `engines.vscode`). Do not use APIs newer than 1.85.
- **No AI / no model calls anywhere.** "Feedback to AI" is pure text formatting the user copies manually.
- **No per-hunk accept/reject.** Accept/reject is per-file (plus folder/all).
- **Pure model stays vscode-free.** `reviewWebviewModel.ts` must not `import "vscode"` (it is bundled and run under plain Node for tests, exactly like `changeCount.ts`).
- **All session mutations go through `SessionManager`.** The webview only sends intent messages; it never writes the session file.
- **Webview CSP is strict:** `default-src 'none'`; scripts/styles loaded from the extension's `media/` via `webview.asWebviewUri` with a per-load `nonce`. No remote resources, no inline event handlers in shipped HTML (use `addEventListener` in `review.js`).
- **Test runner:** unit tests are added to the `test:unit` `&&` chain in `package.json`; vscode-free tests bundle without the `--alias:vscode` flag.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Do NOT bump version, edit CHANGELOG, tag, or publish** — releasing is gated behind the maintainer's `release` skill.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/reviewModel.ts` | **Modify.** Add `reason?` to `ReviewRecord`; `rejectEntry(..., reason?)`. |
| `src/reviewModel.test.ts` | **Modify.** Assert `reason` round-trips through `rejectEntry`. |
| `src/sessionManager.ts` | **Modify.** `rejectFile/rejectFolder/rejectAll(..., reason?)` thread reason to `rejectEntry`. |
| `src/sessionManager.test.ts` | **Modify.** Assert `rejectFile(path, reason)` stores reason on the record. |
| `src/reviewWebviewModel.ts` | **Create.** Pure builders: `computeDiffPieces`, `buildReviewModel`, `buildFeedbackText`, shared message-protocol types. |
| `src/reviewWebviewModel.test.ts` | **Create.** Unit tests for the above. |
| `src/reviewWebview.ts` | **Create.** `ReviewWebviewPanel` — panel lifecycle, batch tracking, model build, message handling, incremental render. |
| `media/review/review.css` | **Create.** Webview styles (mirrors approved mockup v4). |
| `media/review/review.js` | **Create.** Webview client: render, split/unified, collapse, per-file keep/undo, reason-on-undo, feedback panel + copy. |
| `src/extension.ts` | **Modify.** Repoint `reviewAllPending`→webview; add `reviewChanges`; remove `vscode.changes` plumbing; replace reject confirm modal with a reason input box. |
| `package.json` | **Modify.** New command `claudegate.reviewChanges`; config `claudegate.review.diffMode`. |
| `.vscodeignore` | **Modify.** Ensure `media/review/**` ships. |

---

## Task 1: Add `reason` to the review record model

**Files:**
- Modify: `src/reviewModel.ts` (`ReviewRecord` interface ~line 12; `rejectEntry` ~line 157)
- Test: `src/reviewModel.test.ts`

**Interfaces:**
- Consumes: existing `Session`, `FileEntry`, `makeRecordId`.
- Produces: `ReviewRecord.reason?: string`; `rejectEntry(session, path, after, decidedAt, reason?): void` — a reject writes `reason` onto `session.rejected[path]` when provided.

- [ ] **Step 1: Write the failing test**

Add to `src/reviewModel.test.ts` (it uses the same `run()` harness already present near the top of that file — reuse it; do not redefine it):

```ts
run("rejectEntry stores an optional reason on the record", () => {
  const session = {
    sessionId: "s", status: "active" as const,
    files: { "/w/a.ts": { originalContent: "old", reviewStatus: "pending" as const } },
    accepted: [], rejected: {},
  };
  rejectEntry(session, "/w/a.ts", "new", "2026-07-10T00:00:00.000Z", "broke the API");
  assert.equal(session.rejected["/w/a.ts"].reason, "broke the API");
  assert.equal(session.files["/w/a.ts"], undefined); // entry removed from files{}
});

run("rejectEntry omits reason when none is given", () => {
  const session = {
    sessionId: "s", status: "active" as const,
    files: { "/w/b.ts": { originalContent: "old", reviewStatus: "pending" as const } },
    accepted: [], rejected: {},
  };
  rejectEntry(session, "/w/b.ts", "new", "2026-07-10T00:00:00.000Z");
  assert.equal(session.rejected["/w/b.ts"].reason, undefined);
});
```

Ensure `rejectEntry` is in the file's import list from `./reviewModel` (add it if the test file does not already import it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: FAIL — `rejectEntry` currently takes 4 args and does not set `reason` (the reason assertion fails, or a TS/arg error surfaces).

- [ ] **Step 3: Add the field and parameter**

In `src/reviewModel.ts`, add to the `ReviewRecord` interface (after `newFile?`):

```ts
  reason?: string;       // optional revert reason, fed into the "Feedback to AI" log (reject only)
```

Change `rejectEntry` to accept and store it:

```ts
export function rejectEntry(session: Session, path: string, after: string | null, decidedAt: string, reason?: string): void {
  const entry = session.files[path];
  if (!entry) return;
  session.rejected[path] = {
    id: makeRecordId(decidedAt, path),
    path,
    before: entry.originalContent,
    after,
    decidedAt,
    sessionId: entry.sessionId,
    newFile: entry.newFile,
    ...(reason ? { reason } : {}),
  };
  delete session.files[path];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: PASS — all `run(...)` lines print `ok -`, `done` prints, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/reviewModel.ts src/reviewModel.test.ts
git commit -m "feat: store optional revert reason on ReviewRecord

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Thread `reason` through SessionManager reject methods

**Files:**
- Modify: `src/sessionManager.ts` (`rejectFile` ~line 211; `rejectFolder` ~line 235; add `rejectAll` — locate the existing `rejectAll` in the file and update it the same way)
- Test: `src/sessionManager.test.ts`

**Interfaces:**
- Consumes: `rejectEntry(session, path, after, decidedAt, reason?)` from Task 1.
- Produces: `SessionManager.rejectFile(filePath: string, reason?: string): void`, `rejectFolder(folderPath: string, reason?: string): void`, `rejectAll(reason?: string): void`. The reason is written onto each produced rejected record.

- [ ] **Step 1: Write the failing test**

Open `src/sessionManager.test.ts` and mirror the existing setup pattern used by the other tests there (they construct a `SessionManager` against a temp dir and drive it through public methods). Add:

```ts
run("rejectFile records the revert reason", () => {
  const { mgr, workspace } = makeManagerWithPending("c.ts", "original\n", "claude-edited\n");
  const file = path.join(workspace, "c.ts");
  mgr.rejectFile(file, "reverted: wrong approach");
  const rec = mgr.getSession()!.rejected[file];
  assert.equal(rec.reason, "reverted: wrong approach");
  assert.equal(rec.after, "claude-edited\n"); // Claude's discarded version preserved
});
```

If a `makeManagerWithPending(...)` helper does not already exist in that test file, add a small one modeled on the file's existing manager-construction code: create a temp workspace dir, write the file with the "claude-edited" content on disk, construct the `SessionManager`, and call `trackFileChange(file, original)` so an entry lands in `files{}`. Reuse the file's existing `run()`/`assert` imports and temp-dir helper rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild src/sessionManager.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/sessionManager.test.cjs && node out/sessionManager.test.cjs`
Expected: FAIL — `rejectFile` ignores the second arg, so `rec.reason` is `undefined`.

- [ ] **Step 3: Thread the reason through**

In `src/sessionManager.ts`:

`rejectFile` — change signature and the `rejectEntry` call:

```ts
  rejectFile(filePath: string, reason?: string): void {
```
```ts
    rejectEntry(this.session!, filePath, after, new Date().toISOString(), reason);
```

`rejectFolder` — change signature and its `rejectEntry` call:

```ts
  rejectFolder(folderPath: string, reason?: string): void {
```
```ts
      rejectEntry(s, fp, after, decidedAt, reason);
```

`rejectAll` — change signature and its `rejectEntry` call the same way (add `reason?: string` param; pass `reason` as the 5th arg to `rejectEntry`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx esbuild src/sessionManager.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/sessionManager.test.cjs && node out/sessionManager.test.cjs`
Expected: PASS — new test prints `ok -`, no regressions in the other lines.

- [ ] **Step 5: Commit**

```bash
git add src/sessionManager.ts src/sessionManager.test.ts
git commit -m "feat: accept optional reason on SessionManager reject methods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure review-webview model (`reviewWebviewModel.ts`)

**Files:**
- Create: `src/reviewWebviewModel.ts`
- Create: `src/reviewWebviewModel.test.ts`
- Modify: `package.json` (`scripts.test:unit`)

**Interfaces:**
- Consumes: `diffLines` from `diff`; `countChanges` from `./changeCount`.
- Produces (imported by `reviewWebview.ts` and `media/review/review.js` shares the shapes structurally):
  - `type LineKind = "context" | "add" | "del"`
  - `interface DiffLine { type: "line"; kind: LineKind; oldNum: number | null; newNum: number | null; text: string }`
  - `interface Fold { type: "fold"; hidden: number }`
  - `type DiffPiece = DiffLine | Fold`
  - `interface ReviewItemInput { relPath: string; before: string | null; after: string | null; status: "pending" | "kept" | "undone"; isNew: boolean; isProtected: boolean; reason?: string }`
  - `interface FileDiff { relPath: string; isProtected: boolean; isNew: boolean; missing: boolean; noChange: boolean; added: number; removed: number; pieces: DiffPiece[]; status: "pending" | "kept" | "undone"; reason?: string }`
  - `interface ReviewModel { files: FileDiff[]; reviewedCount: number; totalCount: number }`
  - `computeDiffPieces(before: string, after: string, contextLines?: number): DiffPiece[]`
  - `buildReviewModel(items: ReviewItemInput[], contextLines?: number): ReviewModel`
  - `buildFeedbackText(items: ReviewItemInput[]): string`

- [ ] **Step 1: Write the failing test**

Create `src/reviewWebviewModel.test.ts`:

```ts
import assert from "node:assert";
import {
  computeDiffPieces, buildReviewModel, buildFeedbackText, ReviewItemInput,
} from "./reviewWebviewModel";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("computeDiffPieces marks add/del/context and counts", () => {
  const pieces = computeDiffPieces("a\nb\nc\n", "a\nB\nc\n", 3);
  const lines = pieces.filter((p): p is Extract<typeof p, {type:"line"}> => p.type === "line");
  assert.equal(lines.filter(l => l.kind === "del").length, 1);
  assert.equal(lines.filter(l => l.kind === "add").length, 1);
  assert.ok(lines.some(l => l.kind === "context" && l.text === "a"));
});

run("computeDiffPieces folds large unchanged runs into a fold marker", () => {
  const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n") + "\n";
  const edited = big.replace("line25", "CHANGED25");
  const pieces = computeDiffPieces(big, edited, 3);
  const folds = pieces.filter(p => p.type === "fold") as { type: "fold"; hidden: number }[];
  assert.ok(folds.length >= 1, "expected at least one fold");
  assert.ok(folds.every(f => f.hidden > 0));
  // context is preserved around the change (3 lines each side)
  const lines = pieces.filter(p => p.type === "line") as { text: string }[];
  assert.ok(lines.some(l => l.text === "line22"));
  assert.ok(lines.some(l => l.text === "line28"));
});

run("buildReviewModel summarizes counts, status, missing, no-change, new", () => {
  const items: ReviewItemInput[] = [
    { relPath: "a.ts", before: "x\n", after: "y\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "new.ts", before: null, after: "hello\n", status: "pending", isNew: true, isProtected: false },
    { relPath: "same.ts", before: "z\n", after: "z\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "gone.ts", before: "q\n", after: null, status: "pending", isNew: false, isProtected: false },
    { relPath: "kept.ts", before: "a\n", after: "b\n", status: "kept", isNew: false, isProtected: true },
  ];
  const model = buildReviewModel(items);
  assert.equal(model.totalCount, 5);
  assert.equal(model.reviewedCount, 1); // only "kept.ts"
  const same = model.files.find(f => f.relPath === "same.ts")!;
  assert.equal(same.noChange, true);
  const gone = model.files.find(f => f.relPath === "gone.ts")!;
  assert.equal(gone.missing, true);
  const nw = model.files.find(f => f.relPath === "new.ts")!;
  assert.equal(nw.isNew, true);
  const kept = model.files.find(f => f.relPath === "kept.ts")!;
  assert.equal(kept.status, "kept");
  assert.equal(kept.isProtected, true);
});

run("buildFeedbackText groups kept/reverted(with reason)/still-reviewing; omits empty sections", () => {
  const items: ReviewItemInput[] = [
    { relPath: "proto/carrier.proto", before: "a", after: "b", status: "kept", isNew: false, isProtected: false },
    { relPath: "internal/x.go", before: "a", after: "b", status: "undone", isNew: false, isProtected: false, reason: "still used by batch job" },
    { relPath: "internal/y.go", before: "a", after: "b", status: "undone", isNew: false, isProtected: false },
    { relPath: "proto/vendor.proto", before: "a", after: "b", status: "pending", isNew: false, isProtected: false },
  ];
  const text = buildFeedbackText(items);
  assert.ok(text.includes("KEPT:\n- proto/carrier.proto"));
  assert.ok(text.includes("REVERTED (don't re-apply as-is):"));
  assert.ok(text.includes("- internal/x.go — still used by batch job"));
  assert.ok(text.includes("- internal/y.go\n")); // no reason → path only
  assert.ok(text.includes("Still reviewing:\n- proto/vendor.proto"));
});

run("buildFeedbackText omits sections with no members", () => {
  const text = buildFeedbackText([
    { relPath: "a.ts", before: "x", after: "y", status: "kept", isNew: false, isProtected: false },
  ]);
  assert.ok(text.includes("KEPT:"));
  assert.ok(!text.includes("REVERTED"));
  assert.ok(!text.includes("Still reviewing"));
});

console.log("done");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild src/reviewWebviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewWebviewModel.test.cjs && node out/reviewWebviewModel.test.cjs`
Expected: FAIL — `Could not resolve "./reviewWebviewModel"` (module does not exist yet).

- [ ] **Step 3: Implement the module**

Create `src/reviewWebviewModel.ts`:

```ts
// Pure, vscode-free model for the Review Changes webview. Bundled and run under
// plain Node for unit tests (mirrors changeCount.ts) — must NOT import "vscode".
import { diffLines } from "diff";
import { countChanges } from "./changeCount";

export type LineKind = "context" | "add" | "del";
export interface DiffLine { type: "line"; kind: LineKind; oldNum: number | null; newNum: number | null; text: string; }
export interface Fold { type: "fold"; hidden: number; }
export type DiffPiece = DiffLine | Fold;

export interface ReviewItemInput {
  relPath: string;                       // workspace-relative, '/'-separated (display + feedback)
  before: string | null;                 // baseline; null ⇒ Claude created the file
  after: string | null;                  // current disk content (pending) or record.after (decided); null ⇒ missing on disk
  status: "pending" | "kept" | "undone";
  isNew: boolean;
  isProtected: boolean;
  reason?: string;                       // undone-only
}

export interface FileDiff {
  relPath: string;
  isProtected: boolean;
  isNew: boolean;
  missing: boolean;                      // after === null
  noChange: boolean;                     // before === after (transient no-op)
  added: number;
  removed: number;
  pieces: DiffPiece[];
  status: "pending" | "kept" | "undone";
  reason?: string;
}

export interface ReviewModel { files: FileDiff[]; reviewedCount: number; totalCount: number; }

// Split diffLines output into a stream of line/fold pieces, collapsing unchanged
// runs longer than 2*contextLines into a single fold marker (keeping contextLines
// of context on each side of every change).
export function computeDiffPieces(before: string, after: string, contextLines = 3): DiffPiece[] {
  const parts = diffLines(before, after);
  // First, expand to a flat list of tagged lines with old/new line numbers.
  const flat: DiffLine[] = [];
  let oldNum = 1, newNum = 1;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing empty from final "\n"
    for (const text of lines) {
      if (part.added) flat.push({ type: "line", kind: "add", oldNum: null, newNum: newNum++, text });
      else if (part.removed) flat.push({ type: "line", kind: "del", oldNum: oldNum++, newNum: null, text });
      else flat.push({ type: "line", kind: "context", oldNum: oldNum++, newNum: newNum++, text });
    }
  }
  // Then fold long context runs. A run of context lines longer than 2*ctx gets
  // its middle replaced by a fold; ctx lines are retained adjacent to changes.
  const changedIdx = new Set<number>();
  flat.forEach((l, i) => { if (l.kind !== "context") changedIdx.add(i); });
  const keep = new Array(flat.length).fill(false);
  if (changedIdx.size === 0) {
    // No changes at all — nothing to render (caller treats as noChange).
    return [];
  }
  for (const i of changedIdx) {
    for (let j = Math.max(0, i - contextLines); j <= Math.min(flat.length - 1, i + contextLines); j++) keep[j] = true;
  }
  const out: DiffPiece[] = [];
  let hidden = 0;
  for (let i = 0; i < flat.length; i++) {
    if (keep[i]) {
      if (hidden > 0) { out.push({ type: "fold", hidden }); hidden = 0; }
      out.push(flat[i]);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push({ type: "fold", hidden });
  return out;
}

export function buildReviewModel(items: ReviewItemInput[], contextLines = 3): ReviewModel {
  const files: FileDiff[] = items.map((it) => {
    const missing = it.after === null;
    const before = it.before ?? "";
    const after = it.after ?? "";
    const noChange = !missing && before === after;
    const counts = missing ? { added: 0, removed: 0 } : countChanges(before, after);
    const pieces = missing || noChange ? [] : computeDiffPieces(before, after, contextLines);
    return {
      relPath: it.relPath,
      isProtected: it.isProtected,
      isNew: it.isNew,
      missing,
      noChange,
      added: counts.added,
      removed: counts.removed,
      pieces,
      status: it.status,
      ...(it.reason ? { reason: it.reason } : {}),
    };
  });
  const reviewedCount = items.filter((i) => i.status !== "pending").length;
  return { files, reviewedCount, totalCount: items.length };
}

export function buildFeedbackText(items: ReviewItemInput[]): string {
  const kept = items.filter((i) => i.status === "kept");
  const undone = items.filter((i) => i.status === "undone");
  const pending = items.filter((i) => i.status === "pending");
  const blocks: string[] = ["I reviewed your changes. Per file:"];
  if (kept.length) blocks.push("KEPT:\n" + kept.map((i) => `- ${i.relPath}`).join("\n"));
  if (undone.length) {
    blocks.push(
      "REVERTED (don't re-apply as-is):\n" +
      undone.map((i) => (i.reason ? `- ${i.relPath} — ${i.reason}` : `- ${i.relPath}`)).join("\n")
    );
  }
  if (pending.length) blocks.push("Still reviewing:\n" + pending.map((i) => `- ${i.relPath}`).join("\n"));
  return blocks.join("\n\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx esbuild src/reviewWebviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewWebviewModel.test.cjs && node out/reviewWebviewModel.test.cjs`
Expected: PASS — every `run(...)` prints `ok -`, `done` prints, exit code 0.

- [ ] **Step 5: Wire the test into `test:unit`**

In `package.json`, inside the `test:unit` script string, append immediately before the `changeCount` no-vscode block ends — i.e. add this segment to the `&&` chain (place it next to the other vscode-free test, `changeCount.test.ts`):

```
&& esbuild src/reviewWebviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewWebviewModel.test.cjs && node out/reviewWebviewModel.test.cjs
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS — all bundled test files print `ok -` lines and `done`; process exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/reviewWebviewModel.ts src/reviewWebviewModel.test.ts package.json
git commit -m "feat: pure model + feedback-text builders for review webview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Webview panel provider + client (opens, renders, live-updates)

This task delivers a working, non-interactive-yet Review Changes tab: it opens from the existing "Review All Pending" action, renders all pending files (split diff), and re-renders on session change without flicker. Interactivity (keep/undo/toggle/feedback) lands in Task 5.

**Files:**
- Create: `src/reviewWebview.ts`
- Create: `media/review/review.css`
- Create: `media/review/review.js`
- Modify: `src/extension.ts` (imports; `reviewAllPending` command ~line 487; remove `openPendingMultiDiff`/`closePendingMultiDiff`/`isPendingMultiDiffOpen` helpers ~lines 184-231 and the multi-diff refresh block ~lines 513-528)
- Modify: `package.json` (add `claudegate.reviewChanges` command + menu; add `claudegate.review.diffMode` config)
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: `SessionManager` (`getSession`, `onSessionChange`, `hasRealPendingChange`); `buildReviewModel`, `buildFeedbackText`, `ReviewItemInput` from `reviewWebviewModel`; `isInWorkspace`, `isExcluded`, `isProtected` from `workspaceScope`.
- Produces: `class ReviewWebviewPanel { static showOrReveal(context: vscode.ExtensionContext, sessionManager: SessionManager): void }`.

- [ ] **Step 1: Create the webview client stylesheet**

Create `media/review/review.css` (mirrors approved mockup v4; VS Code theme variables so it adapts to the user's theme):

```css
:root {
  --add-bg: rgba(78,201,148,.10); --add-fg: var(--vscode-gitDecoration-addedResourceForeground, #4ec994);
  --del-bg: rgba(224,108,117,.12); --del-fg: var(--vscode-gitDecoration-deletedResourceForeground, #e06c75);
  --keep: #3fb950; --undo: #f85149;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  font-size: var(--vscode-editor-font-size, 12px); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.title { font-weight: 600; color: var(--vscode-foreground); }
.progress { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.progbar { width: 130px; height: 5px; background: var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
.progbar > i { display: block; height: 100%; background: var(--keep); width: 0; }
.spacer { flex: 1; }
.seg { display: flex; border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; }
.seg button { padding: 4px 10px; background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer; }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn { padding: 4px 12px; border-radius: 5px; border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-button-secondaryBackground, #33333a); color: var(--vscode-button-secondaryForeground, #ccc); cursor: pointer; }
.btn.keep { color: var(--keep); border-color: rgba(63,185,80,.4); }
.btn.undo { color: var(--undo); border-color: rgba(248,81,73,.35); }
.file { border-bottom: 1px solid var(--vscode-panel-border); }
.fhead { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--vscode-sideBarSectionHeader-background, #252526); cursor: pointer; }
.chev { width: 12px; color: var(--vscode-descriptionForeground); }
.fname { color: var(--vscode-foreground); }
.fpath { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.badge.add { color: var(--add-fg); } .badge.del { color: var(--del-fg); }
.warn { color: var(--vscode-editorWarning-foreground, #e5c07b); }
.factions { display: flex; gap: 6px; }
.status { font-size: 11px; } .status.kept { color: var(--keep); } .status.undone { color: var(--undo); }
.diff { overflow-x: auto; }
.split { display: grid; grid-template-columns: 1fr 1fr; }
.side.left { border-right: 1px solid var(--vscode-panel-border); }
.sidehdr { padding: 3px 10px; font-size: 11px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorGroupHeader-tabsBackground, #232323); border-bottom: 1px solid var(--vscode-panel-border); }
.row { display: flex; min-height: 18px; white-space: pre; }
.gut { width: 46px; flex: none; text-align: right; padding: 0 8px; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
.src { padding-left: 8px; }
.row.del { background: var(--del-bg); } .row.del .src { color: var(--del-fg); }
.row.add { background: var(--add-bg); } .row.add .src { color: var(--add-fg); }
.row.empty { background: var(--vscode-editor-inactiveSelectionBackground, #1a1a1a); }
.fold { text-align: center; color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorGroupHeader-tabsBackground, #232323); padding: 3px; font-size: 11px; }
.note, .reason { padding: 8px 12px 10px 34px; background: rgba(248,81,73,.06); border-top: 1px solid rgba(248,81,73,.25); }
.reason .rl { color: var(--undo); font-size: 11px; display: block; margin-bottom: 5px; }
.reason .rrow { display: flex; gap: 8px; }
.reason input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, #4a262a); border-radius: 4px; padding: 5px 8px; font-family: inherit; }
.fbpanel { border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background, #161616); }
.fbpanel.hidden { display: none; }
.fbhdr { display: flex; align-items: center; gap: 8px; padding: 7px 12px; color: var(--vscode-textLink-foreground); }
.fbbody { padding: 10px 12px 12px; white-space: pre-wrap; color: var(--vscode-descriptionForeground); font-size: 11.5px; line-height: 1.5; }
.empty-state { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
```

- [ ] **Step 2: Create the webview client script (render only for now)**

Create `media/review/review.js`. This full file also contains the Task 5 interactivity so the file is written once; wiring the message handlers that mutate state is exercised in Task 5. Use `addEventListener` (no inline handlers, per CSP):

```js
// @ts-nocheck
const vscode = acquireVsCodeApi();
let state = { model: { files: [], reviewedCount: 0, totalCount: 0 }, diffMode: "split", feedbackText: "", feedbackOpen: false };
const ui = { collapsed: {}, reasonOpen: {} }; // per-relPath UI state, preserved across renders

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function splitRows(pieces) {
  // Build aligned left/right rows from the unified piece stream.
  const rows = []; let buf = { del: [], add: [] };
  const flush = () => {
    const n = Math.max(buf.del.length, buf.add.length);
    for (let i = 0; i < n; i++) rows.push({ left: buf.del[i] || null, right: buf.add[i] || null });
    buf = { del: [], add: [] };
  };
  for (const p of pieces) {
    if (p.type === "fold") { flush(); rows.push({ fold: p.hidden }); continue; }
    if (p.kind === "context") { flush(); rows.push({ left: p, right: p, ctx: true }); }
    else if (p.kind === "del") buf.del.push(p);
    else buf.add.push(p);
  }
  flush();
  return rows;
}

function diffHtml(file) {
  if (file.missing) return `<div class="fold">(file missing on disk)</div>`;
  if (file.noChange) return `<div class="fold">(no changes to review)</div>`;
  if (state.diffMode === "unified") {
    return `<div class="side">` + file.pieces.map((p) => {
      if (p.type === "fold") return `<div class="fold">⋯ ${p.hidden} hidden lines ⋯</div>`;
      const num = p.kind === "del" ? p.oldNum : p.newNum;
      return `<div class="row ${p.kind === "context" ? "" : p.kind}"><span class="gut">${num ?? ""}</span><span class="src">${esc(p.text)}</span></div>`;
    }).join("") + `</div>`;
  }
  const rows = splitRows(file.pieces);
  const cell = (c, side) => {
    if (!c) return `<div class="row empty"><span class="gut"></span><span class="src"></span></div>`;
    if (c.fold !== undefined) return `<div class="fold">⋯ ${c.fold} hidden lines ⋯</div>`;
    const p = side === "left" ? c.left : c.right;
    if (!p) return `<div class="row empty"><span class="gut"></span><span class="src"></span></div>`;
    const num = side === "left" ? p.oldNum : p.newNum;
    const kind = c.ctx ? "" : p.kind;
    return `<div class="row ${kind}"><span class="gut">${num ?? ""}</span><span class="src">${esc(p.text)}</span></div>`;
  };
  const left = rows.map((r) => r.fold !== undefined ? `<div class="fold">⋯ ${r.fold} hidden lines ⋯</div>` : cell(r, "left")).join("");
  const right = rows.map((r) => r.fold !== undefined ? `<div class="fold">&nbsp;</div>` : cell(r, "right")).join("");
  return `<div class="split"><div class="side left"><div class="sidehdr">Original</div>${left}</div><div class="side"><div class="sidehdr">Current (Claude's edit)</div>${right}</div></div>`;
}

function fileHtml(file) {
  const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/") + 1) : "";
  const base = file.relPath.slice(dir.length);
  const collapsed = ui.collapsed[file.relPath] ?? (file.status !== "pending");
  const badges = [file.added ? `<span class="badge add">+${file.added}</span>` : "", file.removed ? `<span class="badge del">−${file.removed}</span>` : ""].join(" ");
  let actions = "";
  if (file.status === "pending") actions = `<div class="factions"><button class="btn undo" data-undo="${esc(file.relPath)}">Undo</button><button class="btn keep" data-keep="${esc(file.relPath)}">Keep</button></div>`;
  else actions = `<span class="status ${file.status}">${file.status === "kept" ? "✓ kept" : "✗ undone"}</span>`;
  const head = `<div class="fhead" data-toggle="${esc(file.relPath)}"><span class="chev">${collapsed ? "▸" : "▾"}</span>${file.isProtected ? '<span class="warn">⚠</span>' : ""}<span class="fname">${esc(base)}</span><span class="fpath">${esc(dir)}</span>${badges}<div class="spacer"></div>${actions}</div>`;
  let body = "";
  if (!collapsed) body += diffHtml(file);
  if (ui.reasonOpen[file.relPath]) {
    body += `<div class="reason"><span class="rl">Reverting to original. Add a reason to feed back to AI (optional):</span><div class="rrow"><input data-reason-input="${esc(file.relPath)}" placeholder="e.g. don't drop legacyDropoff — still called by the batch job" /><button class="btn" data-reason-cancel="${esc(file.relPath)}">Cancel</button><button class="btn undo" data-reason-confirm="${esc(file.relPath)}">Revert</button></div></div>`;
  }
  return `<div class="file">${head}${body}</div>`;
}

function render() {
  const m = state.model;
  const app = document.getElementById("app");
  if (!m.files.length) { app.innerHTML = `<div class="empty-state">All changes reviewed 🎉</div>`; return; }
  const pct = m.totalCount ? Math.round((m.reviewedCount / m.totalCount) * 100) : 0;
  const toolbar = `<div class="toolbar"><span class="title">All Changes</span><span class="progress">${m.reviewedCount} of ${m.totalCount} reviewed</span><div class="progbar"><i style="width:${pct}%"></i></div><div class="spacer"></div><div class="seg"><button class="${state.diffMode === "split" ? "on" : ""}" data-mode="split">Split</button><button class="${state.diffMode === "unified" ? "on" : ""}" data-mode="unified">Unified</button></div><button class="btn" data-fb-toggle>💬 Feedback to AI</button><button class="btn undo" data-undo-all>Undo All</button><button class="btn keep" data-keep-all>Keep All</button></div>`;
  const files = m.files.map(fileHtml).join("");
  const fb = `<div class="fbpanel ${state.feedbackOpen ? "" : "hidden"}"><div class="fbhdr"><span>💬 Feedback to AI</span><div class="spacer"></div><button class="btn" data-fb-copy>📋 Copy</button></div><div class="fbbody">${esc(state.feedbackText)}</div></div>`;
  app.innerHTML = toolbar + `<div id="files">${files}</div>` + fb;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-keep],[data-undo],[data-toggle],[data-mode],[data-keep-all],[data-undo-all],[data-fb-toggle],[data-fb-copy],[data-reason-cancel],[data-reason-confirm]");
  if (!t) return;
  if (t.dataset.keep) vscode.postMessage({ type: "keep", path: t.dataset.keep });
  else if (t.dataset.undo) { ui.reasonOpen[t.dataset.undo] = true; ui.collapsed[t.dataset.undo] = ui.collapsed[t.dataset.undo] ?? false; render(); }
  else if (t.dataset.reasonCancel) { delete ui.reasonOpen[t.dataset.reasonCancel]; render(); }
  else if (t.dataset.reasonConfirm) { const inp = document.querySelector(`[data-reason-input="${CSS.escape(t.dataset.reasonConfirm)}"]`); vscode.postMessage({ type: "undo", path: t.dataset.reasonConfirm, reason: inp ? inp.value.trim() : "" }); delete ui.reasonOpen[t.dataset.reasonConfirm]; }
  else if (t.dataset.toggle) { ui.collapsed[t.dataset.toggle] = !(ui.collapsed[t.dataset.toggle] ?? false); render(); }
  else if (t.dataset.mode) { state.diffMode = t.dataset.mode; vscode.postMessage({ type: "setDiffMode", mode: t.dataset.mode }); render(); }
  else if (t.hasAttribute("data-keep-all")) vscode.postMessage({ type: "keepAll" });
  else if (t.hasAttribute("data-undo-all")) vscode.postMessage({ type: "undoAll" });
  else if (t.hasAttribute("data-fb-toggle")) { state.feedbackOpen = !state.feedbackOpen; render(); }
  else if (t.hasAttribute("data-fb-copy")) vscode.postMessage({ type: "copyFeedback" });
});

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "render") {
    state.model = msg.model; state.diffMode = msg.diffMode; state.feedbackText = msg.feedbackText;
    render();
  }
});

vscode.postMessage({ type: "ready" });
```

- [ ] **Step 3: Create the panel provider**

Create `src/reviewWebview.ts`:

```ts
import * as vscode from "vscode";
import * as fs from "fs";
import { SessionManager } from "./sessionManager";
import { buildReviewModel, buildFeedbackText, ReviewItemInput } from "./reviewWebviewModel";
import { isInWorkspace, isExcluded, isProtected } from "./workspaceScope";

export class ReviewWebviewPanel {
  private static current: ReviewWebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private batchOrder: string[] = []; // stable display order: seed pending, then late arrivals

  static showOrReveal(context: vscode.ExtensionContext, sessionManager: SessionManager): void {
    if (ReviewWebviewPanel.current) {
      ReviewWebviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ReviewWebviewPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudegate.reviewChanges",
      "Claude Gate: Review Changes",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] }
    );
    ReviewWebviewPanel.current = new ReviewWebviewPanel(panel, context, sessionManager);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: SessionManager
  ) {
    this.batchOrder = this.currentPendingPaths();
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.sessionManager.onSessionChange(() => this.render(), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private currentPendingPaths(): string[] {
    const s = this.sessionManager.getSession();
    if (!s) return [];
    return Object.keys(s.files)
      .filter((fp) => isInWorkspace(fp) && !isExcluded(fp))
      .sort((a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b));
  }

  // Assemble the review items in stable batch order: every path seen while this
  // panel is open (seed pending set + any later captures), each tagged with its
  // current status (pending / kept / undone) and diff content.
  private items(): ReviewItemInput[] {
    const s = this.sessionManager.getSession();
    if (!s) return [];
    for (const fp of this.currentPendingPaths()) if (!this.batchOrder.includes(fp)) this.batchOrder.push(fp);

    const items: ReviewItemInput[] = [];
    for (const fp of this.batchOrder) {
      if (!isInWorkspace(fp) || isExcluded(fp)) continue;
      const rel = vscode.workspace.asRelativePath(fp, false).split(/[\\/]/).join("/");
      const pending = s.files[fp];
      if (pending) {
        const after = this.readOrNull(fp);
        items.push({
          relPath: rel, before: pending.originalContent, after,
          status: "pending", isNew: pending.originalContent === null, isProtected: isProtected(fp),
        });
        continue;
      }
      const rejected = s.rejected[fp];
      if (rejected) {
        items.push({ relPath: rel, before: rejected.before, after: rejected.after, status: "undone",
          isNew: !!rejected.newFile, isProtected: isProtected(fp), reason: rejected.reason });
        continue;
      }
      const accepted = [...s.accepted].reverse().find((r) => r.path === fp);
      if (accepted) {
        items.push({ relPath: rel, before: accepted.before, after: accepted.after, status: "kept",
          isNew: !!accepted.newFile, isProtected: isProtected(fp) });
      }
    }
    return items;
  }

  private readOrNull(fp: string): string | null {
    try { return fs.readFileSync(fp, "utf-8"); } catch { return null; }
  }

  private render(): void {
    const items = this.items();
    this.panel.webview.postMessage({
      type: "render",
      model: buildReviewModel(items),
      diffMode: vscode.workspace.getConfiguration("claudegate").get<string>("review.diffMode", "split"),
      feedbackText: buildFeedbackText(items),
    });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "ready": this.render(); break;
      case "keep": if (m.path) this.sessionManager.acceptFile(this.abs(m.path)); break;
      case "undo": if (m.path) this.sessionManager.rejectFile(this.abs(m.path), m.reason || undefined); break;
      case "keepAll": this.sessionManager.acceptAll(); break;
      case "undoAll": {
        const answer = await vscode.window.showWarningMessage(
          "Revert all pending files to their original content?", { modal: true }, "Revert All");
        if (answer === "Revert All") this.sessionManager.rejectAll();
        break;
      }
      case "setDiffMode":
        if (m.mode === "split" || m.mode === "unified")
          await vscode.workspace.getConfiguration("claudegate").update("review.diffMode", m.mode,
            (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        break;
      case "copyFeedback": {
        await vscode.env.clipboard.writeText(buildFeedbackText(this.items()));
        vscode.window.showInformationMessage("Claude Gate: review feedback copied to clipboard.");
        break;
      }
    }
  }

  // relPath from the webview → absolute fs path via the first workspace folder.
  private abs(rel: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, rel).fsPath : rel;
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = getNonce();
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "review", "review.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "review", "review.js"));
    return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';" />
<link href="${css}" rel="stylesheet" /></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private dispose(): void {
    ReviewWebviewPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
```

- [ ] **Step 4: Repoint the command and remove the old multi-diff plumbing**

In `src/extension.ts`:

Add the import near the other local imports (after the `diffProvider` import line):

```ts
import { ReviewWebviewPanel } from "./reviewWebview";
```

Replace the body of the `claudegate.reviewAllPending` command (~line 487) with:

```ts
      vscode.commands.registerCommand("claudegate.reviewAllPending", () =>
        ReviewWebviewPanel.showOrReveal(context, sessionManager)
      ),
      vscode.commands.registerCommand("claudegate.reviewChanges", () =>
        ReviewWebviewPanel.showOrReveal(context, sessionManager)
      ),
```

Delete the now-unused helpers `closePendingMultiDiff`, `openPendingMultiDiff`, `isPendingMultiDiffOpen` (~lines 203-231) and the entire `multiDiffRefreshing` / `onSessionChange`-rebuild block (~lines 513-528). Keep `pendingReviewPaths` only if still referenced elsewhere; if nothing references it after this edit, delete it too. (Run `npm run typecheck` in Step 7 to catch any dangling reference.)

- [ ] **Step 5: Register the command and config in `package.json`**

Add to `contributes.commands`:

```json
{
  "command": "claudegate.reviewChanges",
  "title": "Claude Gate: Review Changes",
  "icon": "$(diff-multiple)"
}
```

Add to `contributes.configuration.properties`:

```json
"claudegate.review.diffMode": {
  "type": "string",
  "enum": ["split", "unified"],
  "default": "split",
  "markdownDescription": "Diff layout in the **Review Changes** panel: `split` (side-by-side, original ↔ current) or `unified` (single column, GitHub-style). The panel's toggle updates this."
}
```

Add to `contributes.menus.commandPalette` (so it is invokable but the internal ones stay hidden — `reviewChanges` should be visible, so do NOT set `when: false` for it). No extra `view/title` entry is required (the existing `reviewAllPending` button remains and now opens the webview).

- [ ] **Step 6: Ensure `media/review/**` ships**

Open `.vscodeignore`. Confirm nothing excludes `media/` (icons already ship from there). If there is a broad `media/**` pattern that would strip subfolders, add an explicit un-ignore `!media/review/**`. If `media/` is already fully included, no change is needed — note that in the commit body.

- [ ] **Step 7: Type-check and build**

Run: `npm run typecheck && npm run compile`
Expected: no TypeScript errors; `out/extension.js` is produced.

- [ ] **Step 8: Manual verification in the Extension Development Host**

1. Press **F5** to launch the dev host.
2. In a test workspace, have Claude Code (or the file watcher) produce 2-3 pending changes.
3. Click the **Review All Pending** button (`$(diff-multiple)`) in the Pending panel title, or run **Claude Gate: Review Changes** from the palette.
4. Verify: a "Claude Gate: Review Changes" editor tab opens, showing each file stacked with a side-by-side diff, `+/−` badges, and `⋯ N hidden lines ⋯` folds; the toolbar shows "0 of N reviewed".
5. With the tab open, make another Claude edit → verify the panel updates in place (no tab flicker/close-reopen) and the count increases.
6. Toggle a file header → it collapses/expands.

Expected: renders correctly and live-updates without flicker. (Keep/Undo buttons are wired in Task 5 — clicking them already posts messages that the provider handles, so they may already work; the confirm-modal replacement and cross-surface consistency are finalized in Task 5.)

- [ ] **Step 9: Commit**

```bash
git add src/reviewWebview.ts media/review/review.css media/review/review.js src/extension.ts package.json .vscodeignore
git commit -m "feat: Review Changes webview panel (render + live update)

Replaces the static vscode.changes multi-diff with a custom WebviewPanel that
stacks all pending files as split/unified diffs and re-renders in place on
session change (no flicker).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Reason-on-undo across all surfaces + finalize webview interactivity

Task 4 already wired the webview's keep/undo/keepAll/undoAll/toggle/copy messages into the provider. This task makes the **reject confirm modal** consistent everywhere by replacing it with an optional-reason input box, so a revert from the sidebar, the diff title bar, or the keyboard captures the same reason the webview does.

**Files:**
- Modify: `src/extension.ts` (`claudegate.rejectFile` command ~line 255; `claudegate.rejectCurrent` ~line 281; `claudegate.rejectFolder` ~line 297 optional)

**Interfaces:**
- Consumes: `SessionManager.rejectFile(path, reason?)`, `rejectFolder(path, reason?)` from Task 2.
- Produces: a shared `promptRevertReason(basename: string): Promise<{ ok: boolean; reason?: string }>` helper used by the reject command handlers.

- [ ] **Step 1: Add the shared reason-prompt helper**

In `src/extension.ts`, add near the top-level helpers (e.g. after `getActivePendingFilePath`):

```ts
// Replaces the old yes/no revert confirm with an optional reason capture: the
// input box IS the confirmation (submit = revert, Esc = cancel). Empty reason
// is allowed. The reason feeds the "Feedback to AI" log via ReviewRecord.reason.
async function promptRevertReason(basename: string): Promise<{ ok: boolean; reason?: string }> {
  const input = await vscode.window.showInputBox({
    title: `Revert "${basename}" to its original content`,
    prompt: "Reason to feed back to AI (optional) — leave blank to just revert. Press Esc to cancel.",
    placeHolder: "e.g. don't drop legacyDropoff — still called by the batch job",
  });
  if (input === undefined) return { ok: false };          // Esc / dismissed → cancel
  return { ok: true, reason: input.trim() || undefined }; // submitted (empty allowed) → revert
}
```

- [ ] **Step 2: Use it in `rejectFile`**

Replace the `showWarningMessage(... "Revert")` block in the `claudegate.rejectFile` handler with:

```ts
          const { ok, reason } = await promptRevertReason(path.basename(filePath));
          if (ok) {
            sessionManager.rejectFile(filePath, reason);
            await closeDiffEditor(filePath);
          }
```

- [ ] **Step 3: Use it in `rejectCurrent` (keyboard `Cmd+Backspace`)**

The current `rejectCurrent` handler rejects immediately with no prompt. Update it to capture a reason first (keeping auto-advance):

```ts
      vscode.commands.registerCommand("claudegate.rejectCurrent", async () => {
        const fp = getActivePendingFilePath(sessionManager);
        if (!fp) return;
        const { ok, reason } = await promptRevertReason(path.basename(fp));
        if (!ok) return;
        sessionManager.rejectFile(fp, reason);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
```

- [ ] **Step 4: (Optional) folder reject reason**

In `claudegate.rejectFolder`, the existing modal can stay as a plain confirm (a folder-wide reason is less useful). Leave it unchanged, OR, for consistency, swap its confirm for `promptRevertReason(path.basename(item.folderPath))` and pass `reason` to `sessionManager.rejectFolder(item.folderPath, reason)`. Choose the swap only if it reads cleanly; otherwise leave as-is and note the choice in the commit body.

- [ ] **Step 5: Type-check and build**

Run: `npm run typecheck && npm run compile`
Expected: no errors; `out/extension.js` produced.

- [ ] **Step 6: Manual verification (F5)**

1. Launch the dev host (F5) with pending changes present.
2. **Sidebar Reject**: click the ✗ on a pending file → an input box appears asking for an optional reason → submit with text → file reverts, and the reason shows on the Rejected panel record tooltip (and in webview feedback text).
3. **Keyboard**: open a pending diff, press `Cmd+Backspace` (mac) / `Ctrl+Shift+Backspace` → same input box → Esc cancels (no revert), submit reverts.
4. **Webview**: open Review Changes → click **Undo** on a file → inline reason field appears → type a reason → **Revert** → file flips to "✗ undone", progress advances.
5. Open the **💬 Feedback to AI** panel → **📋 Copy** → paste into an editor → confirm the text lists KEPT / REVERTED (with your reason) / Still reviewing.
6. Toggle **Split/Unified** → layout switches and persists after closing/reopening the tab.

Expected: every revert path prompts for the optional reason; the reason lands on the record and in the feedback text; no yes/no confirm modal remains for single-file reject.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: `test:unit` all green; `test:hook` (python) unaffected and green.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat: capture optional revert reason on every reject surface

Replaces the single-file reject confirm modal with an optional-reason input box
(submit = revert, Esc = cancel) shared by the sidebar, diff title bar, keyboard
shortcut, and the webview Undo flow. The reason feeds the Feedback to AI log.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Custom `WebviewPanel` editor tab → Task 4. ✓
- Stacked files, split/unified toggle (default split) → Tasks 3 (model), 4 (client + config). ✓
- Collapsible folds ("N hidden lines") → `computeDiffPieces` (Task 3) + client render (Task 4). ✓
- Progress indicator → `reviewedCount`/`totalCount` (Task 3) + toolbar (Task 4). ✓
- Per-file Keep/Undo, Keep All/Undo All → client + provider message handlers (Tasks 4/5). ✓
- Incremental re-render, no flicker → `postMessage` render loop, no tab reopen (Task 4, verified Step 8). ✓
- Reason-on-undo replaces confirm modal on all surfaces → Task 5; stored on `ReviewRecord.reason` → Tasks 1/2. ✓
- "Feedback to AI" toggle panel + copy, pure text, no AI → `buildFeedbackText` (Task 3), panel + `copyFeedback` (Tasks 4/5). ✓
- Replaces `vscode.changes` multi-diff; keeps native per-file diff → Task 4 Step 4 (old plumbing removed; `openDiff` untouched). ✓
- Protected-file flag, exclude scope honored → provider uses `isProtected`/`isInWorkspace`/`isExcluded` (Task 4). ✓
- Edge cases: missing file, no-op, new file → modeled in `buildReviewModel` + client `diffHtml` (Tasks 3/4). ✓
- Config `claudegate.review.diffMode` → Task 4 Step 5. ✓
- Tests for model + feedback + reason round-trip → Tasks 1/2/3. ✓

**Placeholder scan:** No TBD/TODO; the one "(Optional)" step (Task 5 Step 4) is a genuine either/or with both branches specified, not a deferral. Full code given for every code step.

**Type consistency:** `rejectEntry(session, path, after, decidedAt, reason?)` (Task 1) matches all callers in `SessionManager` (Task 2) and the provider's `rejectFile(abs, reason)` (Task 4). `ReviewItemInput`/`ReviewModel`/`DiffPiece` shapes defined in Task 3 are consumed unchanged by `reviewWebview.ts` (Task 4) and structurally by `review.js`. Message protocol (`ready`/`keep`/`undo`/`keepAll`/`undoAll`/`setDiffMode`/`copyFeedback` ↔ `render`) is identical between `review.js` (Task 4 Step 2) and the provider `onMessage`/`render` (Task 4 Step 3). Config key `claudegate.review.diffMode` is spelled identically in provider, client persistence, and `package.json`.

**Deviations noted for the implementer:** `pendingReviewPaths` in `extension.ts` may become dead after Task 4 Step 4 — the typecheck in Step 7 will flag it; delete if unreferenced.
