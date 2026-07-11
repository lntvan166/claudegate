# All-in-one Review Webview (Preact + react-diff-view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the all-in-one interactive review (every pending diff in one scroll, per-file keep / reject-with-note, Feedback-to-AI) as a webview using a proper component framework and a battle-tested diff renderer, so the layout can no longer crash.

**Architecture:** A Preact app (bundled by esbuild into `media/review/`) renders the review UI and talks to the existing `ReviewWebviewPanel` host over the current postMessage channel. Diffs are rendered by `react-diff-view` (unified + split) — never hand-rolled. The host sends per-file `before`/`after`; the webview builds the patch (`jsdiff`) and renders it. The native multi-diff (`Review All Pending`) stays the default; the webview ships behind a setting + its own command.

**Tech Stack:** TypeScript, esbuild (existing), Preact (+ `preact/compat` alias for React libs), `react-diff-view`, `refractor` (Prism tokenizer), `diff` (jsdiff, already a dep), VS Code webview API.

## Global Constraints

- **Framework:** Preact; React-targeting libraries are aliased to `preact/compat`. No React proper.
- **Diff rendering:** `react-diff-view` only — never hand-roll split/unified diff layout.
- **No external network:** everything bundled; CSP stays `default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'`. No CDNs, no CSS-in-JS that injects inline `<style>`.
- **Theming:** all colors from `--vscode-*` CSS variables (light/dark/HC correct). No hardcoded hex for themable surfaces.
- **Native stays default:** `claudegate.reviewAllPending` keeps opening the native multi-diff. The webview is opt-in via `claudegate.reviewPanel.enabled` (default `false`) + the `claudegate.reviewChangesPanel` command.
- **Whole-file only:** Keep / Reject per file. No hunk-level partial accept.
- **Diff mode (split/unified):** client-side state via webview `getState()/setState()`. No config setting (the removed `review.diffMode` is NOT reintroduced).
- **Packaging:** `src/**` is excluded from the `.vsix`; `media/**` ships. The webview source lives in `src/webview/` (not shipped); its build output `media/review/review.js` + `media/review/review.css` ships.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Do not bump version / release** — that's the maintainer's separate `release` step.

---

### Task 1: Dependencies + webview build pipeline

Establish the toolchain first: a trivial Preact app that bundles to `media/review/` and mounts in the panel. Nothing else works until this does.

**Files:**
- Modify: `package.json` (dependencies + build scripts)
- Modify: `tsconfig.json` (JSX + `preact/compat` paths + DOM lib)
- Create: `src/webview/main.tsx`
- Create: `src/webview/vscodeApi.ts`

**Interfaces:**
- Produces: `media/review/review.js` (IIFE) + `media/review/review.css`, mounted into `#app`.
- Produces: `vscode` singleton — `{ postMessage(msg: unknown): void; getState<T>(): T | undefined; setState<T>(s: T): void }` exported from `src/webview/vscodeApi.ts`.

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install preact@^10 react-diff-view@^3 refractor@^4
npm install -D @types/react@^18
```
(`react-diff-view` and `refractor` ship their own types; `@types/react` satisfies `react-diff-view`'s peer types under `preact/compat`.)

- [ ] **Step 2: Add JSX + compat config to `tsconfig.json`**

Merge into `compilerOptions`:
```json
{
  "jsx": "react-jsx",
  "jsxImportSource": "preact",
  "lib": ["ES2020", "DOM", "DOM.Iterable"],
  "paths": {
    "react": ["node_modules/preact/compat/"],
    "react-dom": ["node_modules/preact/compat/"],
    "react/jsx-runtime": ["node_modules/preact/jsx-runtime"]
  }
}
```
Keep existing options. If `baseUrl` is unset, add `"baseUrl": "."` (required for `paths`).

- [ ] **Step 3: Create the vscode API wrapper**

`src/webview/vscodeApi.ts`:
```ts
// Thin typed wrapper around the webview host bridge. acquireVsCodeApi() may be
// called only once per webview, so we capture it here and share the singleton.
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
```

- [ ] **Step 4: Create a minimal app entry**

`src/webview/main.tsx`:
```tsx
import { render } from "preact";
import { vscode } from "./vscodeApi";

function App() {
  return <div style="padding:12px">Claude Gate review — webview toolchain OK</div>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
vscode.postMessage({ type: "ready" });
```

- [ ] **Step 5: Add webview build scripts to `package.json`**

Add these scripts (keep the existing `bundle`/`compile`/`watch` for the extension; chain the webview build into them):
```json
{
  "bundle:webview": "esbuild src/webview/main.tsx --bundle --outfile=media/review/review.js --format=iife --jsx=automatic --jsx-import-source=preact --alias:react=preact/compat --alias:react-dom=preact/compat --loader:.css=css --minify",
  "compile:webview": "esbuild src/webview/main.tsx --bundle --outfile=media/review/review.js --format=iife --jsx=automatic --jsx-import-source=preact --alias:react=preact/compat --alias:react-dom=preact/compat --loader:.css=css --sourcemap",
  "bundle": "esbuild src/extension.ts --bundle --outfile=out/extension.js --external:vscode --platform=node --minify && npm run bundle:webview",
  "compile": "esbuild src/extension.ts --bundle --outfile=out/extension.js --external:vscode --platform=node --sourcemap && npm run compile:webview"
}
```
(The `vscode:prepublish` hook already runs `bundle`, so the webview is built for the `.vsix` automatically.)

- [ ] **Step 6: Build and typecheck**

Run:
```bash
npm run compile:webview && npm run typecheck
```
Expected: `media/review/review.js` produced (a `review.css` may not exist yet — no CSS imported so far, that's fine); `tsc --noEmit` exits clean.

- [ ] **Step 7: Manually verify in the panel**

Run `npm run compile`, package, install to Cursor (`vsce package` → `cursor --install-extension <vsix> --force`), reload, open the panel via the existing `claudegate.reviewChanges` command. Expected: the panel shows "Claude Gate review — webview toolchain OK".

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/webview/main.tsx src/webview/vscodeApi.ts
git commit -m "build: Preact webview toolchain for the review panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Host render payload with per-file before/after

The Preact app needs each file's `before`/`after` to render a diff. Extend the model with a payload builder and switch the host to send it.

**Files:**
- Modify: `src/reviewWebviewModel.ts`
- Modify: `src/reviewWebview.ts:123-130` (the `render()` method)
- Test: `src/reviewWebviewModel.test.ts`

**Interfaces:**
- Consumes: existing `ReviewItemInput { relPath, before, after, status, isNew, isProtected, reason? }` and `countChanges(before, after)`.
- Produces:
  ```ts
  export interface ReviewPayloadFile {
    relPath: string; before: string | null; after: string | null;
    status: "pending" | "kept" | "undone"; isNew: boolean; isProtected: boolean;
    added: number; removed: number; missing: boolean; noChange: boolean; reason?: string;
  }
  export function buildReviewPayload(items: ReviewItemInput[]):
    { files: ReviewPayloadFile[]; reviewedCount: number; totalCount: number };
  ```
- Render message becomes: `{ type: "render", files: ReviewPayloadFile[], reviewedCount, totalCount, feedbackText }`.

- [ ] **Step 1: Write the failing test**

Append to `src/reviewWebviewModel.test.ts`:
```ts
run("buildReviewPayload passes before/after through and computes counts/flags", () => {
  const items: ReviewItemInput[] = [
    { relPath: "a.ts", before: "x\n", after: "y\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "gone.ts", before: "q\n", after: null, status: "pending", isNew: false, isProtected: false },
    { relPath: "same.ts", before: "z\n", after: "z\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "k.ts", before: "a\n", after: "b\n", status: "kept", isNew: false, isProtected: true },
  ];
  const { files, reviewedCount, totalCount } = buildReviewPayload(items);
  assert.equal(totalCount, 4);
  assert.equal(reviewedCount, 1);
  const a = files.find(f => f.relPath === "a.ts")!;
  assert.equal(a.before, "x\n"); assert.equal(a.after, "y\n");
  assert.ok(a.added >= 1 && a.removed >= 1);
  assert.equal(files.find(f => f.relPath === "gone.ts")!.missing, true);
  assert.equal(files.find(f => f.relPath === "same.ts")!.noChange, true);
  assert.equal(files.find(f => f.relPath === "k.ts")!.isProtected, true);
});
```
Import `buildReviewPayload` in the test's import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `buildReviewPayload is not a function`.

- [ ] **Step 3: Implement `buildReviewPayload`**

Add to `src/reviewWebviewModel.ts` (below `buildReviewModel`):
```ts
export interface ReviewPayloadFile {
  relPath: string;
  before: string | null;
  after: string | null;
  status: "pending" | "kept" | "undone";
  isNew: boolean;
  isProtected: boolean;
  added: number;
  removed: number;
  missing: boolean;
  noChange: boolean;
  reason?: string;
}

export function buildReviewPayload(
  items: ReviewItemInput[]
): { files: ReviewPayloadFile[]; reviewedCount: number; totalCount: number } {
  const files: ReviewPayloadFile[] = items.map((it) => {
    const missing = it.after === null;
    const before = it.before ?? "";
    const after = it.after ?? "";
    const noChange = !missing && before === after;
    const counts = missing ? { added: 0, removed: 0 } : countChanges(before, after);
    return {
      relPath: it.relPath,
      before: it.before,
      after: it.after,
      status: it.status,
      isNew: it.isNew,
      isProtected: it.isProtected,
      added: counts.added,
      removed: counts.removed,
      missing,
      noChange,
      ...(it.reason ? { reason: it.reason } : {}),
    };
  });
  const reviewedCount = items.filter((i) => i.status !== "pending").length;
  return { files, reviewedCount, totalCount: items.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit`
Expected: PASS (all existing tests still green).

- [ ] **Step 5: Switch the host `render()` to the payload**

In `src/reviewWebview.ts`, update the import and `render()`:
```ts
import { buildReviewModel, buildReviewPayload, buildFeedbackText, ReviewItemInput } from "./reviewWebviewModel";
```
```ts
  private render(): void {
    const items = this.items();
    const { files, reviewedCount, totalCount } = buildReviewPayload(items);
    this.panel.webview.postMessage({
      type: "render",
      files,
      reviewedCount,
      totalCount,
      feedbackText: buildFeedbackText(items),
    });
  }
```
(`buildReviewModel` may now be unused by the host — leave it exported; its tests stay. Remove the unused import if `tsc`/eslint flags it.)

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck && npm run test:unit`
Expected: clean / PASS.
```bash
git add src/reviewWebviewModel.ts src/reviewWebviewModel.test.ts src/reviewWebview.ts
git commit -m "feat: send per-file before/after payload to the review webview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Language detection + DiffView component

Render one file's diff with `react-diff-view`, from `before`/`after`, in unified or split.

**Files:**
- Create: `src/webview/language.ts`
- Test: `src/webview/language.test.ts` (+ register in `package.json` `test:unit`)
- Create: `src/webview/DiffView.tsx`

**Interfaces:**
- Produces: `languageFromPath(relPath: string): string` — a refractor language id (`"typescript"`, `"json"`, …), default `"text"`.
- Produces: `DiffView` — `function DiffView(props: { before: string | null; after: string | null; relPath: string; viewType: "unified" | "split" }): JSX.Element`.

- [ ] **Step 1: Write the failing test for `languageFromPath`**

`src/webview/language.test.ts`:
```ts
import * as assert from "assert";
import { languageFromPath } from "./language";

assert.equal(languageFromPath("src/a.ts"), "typescript");
assert.equal(languageFromPath("a.tsx"), "tsx");
assert.equal(languageFromPath("pkg.json"), "json");
assert.equal(languageFromPath("hook.py"), "python");
assert.equal(languageFromPath("README"), "text");
assert.equal(languageFromPath("weird.xyz"), "text");
console.log("ok - languageFromPath maps extensions to refractor ids");
```

- [ ] **Step 2: Register the test + run it (fails)**

Append to the `test:unit` script in `package.json` (chained with `&&`):
```
&& esbuild src/webview/language.test.ts --bundle --platform=node --format=cjs --outfile=out/language.test.cjs && node out/language.test.cjs
```
Run: `npm run test:unit`
Expected: FAIL — cannot find `./language`.

- [ ] **Step 3: Implement `language.ts`**

`src/webview/language.ts`:
```ts
// Map a file path to a refractor (Prism) language id for syntax highlighting.
// Unknown extensions fall back to "text" (no highlighting, still renders).
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml",
  html: "markup", xml: "markup", css: "css", scss: "scss", sql: "sql", swift: "swift",
  kt: "kotlin", dart: "dart",
};

export function languageFromPath(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] ?? "text";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Implement `DiffView.tsx`**

`src/webview/DiffView.tsx`:
```tsx
import { useMemo } from "preact/hooks";
import { parseDiff, Diff, Hunk, tokenize } from "react-diff-view";
import { createTwoFilesPatch } from "diff";
import { refractor } from "refractor";
import { languageFromPath } from "./language";

interface Props {
  before: string | null;
  after: string | null;
  relPath: string;
  viewType: "unified" | "split";
}

export function DiffView({ before, after, relPath, viewType }: Props) {
  const body = useMemo(() => {
    if (after === null) return { kind: "missing" as const };
    if (before === after) return { kind: "nochange" as const };
    // Build a git-style unified patch, then parse it for react-diff-view.
    const patch = createTwoFilesPatch(relPath, relPath, before ?? "", after ?? "", "", "");
    const parsed = parseDiff(patch, { nearbySequences: "zip" });
    if (!parsed.length) return { kind: "nochange" as const };
    const file = parsed[0];
    let tokens;
    try {
      tokens = tokenize(file.hunks, {
        highlight: true,
        language: languageFromPath(relPath),
        refractor,
      });
    } catch {
      tokens = undefined; // unknown grammar → render without highlighting
    }
    return { kind: "diff" as const, file, tokens };
  }, [before, after, relPath]);

  if (body.kind === "missing") return <div class="cg-empty">No preview (file is missing or binary).</div>;
  if (body.kind === "nochange") return <div class="cg-empty">No changes to review.</div>;

  return (
    <Diff viewType={viewType} diffType={body.file.type} hunks={body.file.hunks} tokens={body.tokens}>
      {(hunks: any[]) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
    </Diff>
  );
}
```

- [ ] **Step 6: Build to verify it compiles/bundles**

Run: `npm run compile:webview && npm run typecheck`
Expected: bundles (now emits `media/review/review.css` once `DiffView`/theme CSS is imported in a later task; for now no CSS import yet — fine) and typechecks. If `react-diff-view` types complain under `preact/compat`, ensure `@types/react` is installed (Task 1) and `paths` map `react` → `preact/compat`.

- [ ] **Step 7: Commit**

```bash
git add src/webview/language.ts src/webview/language.test.ts src/webview/DiffView.tsx package.json
git commit -m "feat: DiffView (react-diff-view) + language detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: App shell, Toolbar (gate rail), and message wiring

Wire the live data: receive `render`, hold state, draw the toolbar + gate rail + file list, and send decisions back.

**Files:**
- Create: `src/webview/types.ts`
- Create: `src/webview/Toolbar.tsx`
- Rewrite: `src/webview/main.tsx` → `App`
- (FileCard is stubbed here, fully built in Task 5.)

**Interfaces:**
- Produces `src/webview/types.ts`:
  ```ts
  export interface PayloadFile {
    relPath: string; before: string | null; after: string | null;
    status: "pending" | "kept" | "undone"; isNew: boolean; isProtected: boolean;
    added: number; removed: number; missing: boolean; noChange: boolean; reason?: string;
  }
  export interface RenderMessage {
    type: "render"; files: PayloadFile[]; reviewedCount: number; totalCount: number; feedbackText: string;
  }
  export type DiffMode = "unified" | "split";
  ```
- Consumes: `vscode` (Task 1), `DiffView` (Task 3).
- Produces: `Toolbar` — `function Toolbar(props: { reviewedCount: number; totalCount: number; counts: { kept: number; rejected: number; pending: number }; diffMode: DiffMode; onDiffMode(m: DiffMode): void; onFeedback(): void; onKeepAll(): void; onRejectAll(): void }): JSX.Element`.

- [ ] **Step 1: Create shared types**

`src/webview/types.ts` — exactly the interface block above.

- [ ] **Step 2: Implement the Toolbar with the gate rail**

`src/webview/Toolbar.tsx`:
```tsx
import type { DiffMode } from "./types";

interface Props {
  reviewedCount: number; totalCount: number;
  counts: { kept: number; rejected: number; pending: number };
  diffMode: DiffMode;
  onDiffMode(m: DiffMode): void;
  onFeedback(): void; onKeepAll(): void; onRejectAll(): void;
}

export function Toolbar(p: Props) {
  const total = Math.max(1, p.counts.kept + p.counts.rejected + p.counts.pending);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div class="cg-toolbar">
      <span class="cg-title">◈ Claude <b>Gate</b> — Review</span>
      <div class="cg-rail" role="img"
           aria-label={`${p.counts.kept} kept, ${p.counts.rejected} rejected, ${p.counts.pending} pending`}>
        <i class="k" style={{ width: pct(p.counts.kept) }} />
        <i class="r" style={{ width: pct(p.counts.rejected) }} />
        <i class="p" style={{ width: pct(p.counts.pending) }} />
      </div>
      <span class="cg-tally">{p.reviewedCount} of {p.totalCount} reviewed</span>
      <span class="cg-spacer" />
      <div class="cg-seg" role="group" aria-label="Diff layout">
        <button class={p.diffMode === "unified" ? "on" : ""} aria-pressed={p.diffMode === "unified"}
                onClick={() => p.onDiffMode("unified")}>Unified</button>
        <button class={p.diffMode === "split" ? "on" : ""} aria-pressed={p.diffMode === "split"}
                onClick={() => p.onDiffMode("split")}>Split</button>
      </div>
      <button class="cg-btn" onClick={p.onFeedback}>💬 Feedback to AI</button>
      <button class="cg-btn undo" onClick={p.onRejectAll}>Reject all</button>
      <button class="cg-btn keep" onClick={p.onKeepAll}>Keep all</button>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `main.tsx` as the App with state + messaging**

`src/webview/main.tsx`:
```tsx
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { vscode } from "./vscodeApi";
import { Toolbar } from "./Toolbar";
import { DiffView } from "./DiffView";
import type { PayloadFile, RenderMessage, DiffMode } from "./types";
import "react-diff-view/style/index.css";
import "./theme.css";

function App() {
  const [files, setFiles] = useState<PayloadFile[]>([]);
  const [reviewed, setReviewed] = useState(0);
  const [total, setTotal] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    (vscode.getState<{ diffMode?: DiffMode }>()?.diffMode) ?? "split"
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data as RenderMessage;
      if (m?.type === "render") {
        setFiles(m.files); setReviewed(m.reviewedCount); setTotal(m.totalCount); setFeedbackText(m.feedbackText);
      }
    };
    window.addEventListener("message", onMsg);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const changeMode = (m: DiffMode) => { setDiffMode(m); vscode.setState({ diffMode: m }); };

  const counts = {
    kept: files.filter(f => f.status === "kept").length,
    rejected: files.filter(f => f.status === "undone").length,
    pending: files.filter(f => f.status === "pending").length,
  };

  if (!files.length) {
    return <div class="cg-empty-state">✓ All caught up — no pending changes to review.</div>;
  }

  return (
    <div class="cg">
      <Toolbar reviewedCount={reviewed} totalCount={total} counts={counts} diffMode={diffMode}
               onDiffMode={changeMode}
               onFeedback={() => setFeedbackOpen(o => !o)}
               onKeepAll={() => vscode.postMessage({ type: "keepAll" })}
               onRejectAll={() => vscode.postMessage({ type: "undoAll" })} />
      <div class="cg-files">
        {files.map(f => (
          <div class="cg-file" key={f.relPath}>
            <div class="cg-fhead">
              <span class="cg-fn">{f.relPath}</span>
              <span class="cg-cnt"><span class="a">+{f.added}</span> <span class="d">−{f.removed}</span></span>
              <span class="cg-spacer" />
              {f.status === "pending"
                ? <>
                    <button class="cg-btn undo" onClick={() => vscode.postMessage({ type: "undo", path: f.relPath })}>Reject</button>
                    <button class="cg-btn keep" onClick={() => vscode.postMessage({ type: "keep", path: f.relPath })}>Keep</button>
                  </>
                : <span class={`cg-status ${f.status}`}>{f.status === "kept" ? "✓ kept" : "✗ rejected"}</span>}
            </div>
            {f.status === "pending" && <DiffView before={f.before} after={f.after} relPath={f.relPath} viewType={diffMode} />}
          </div>
        ))}
      </div>
      {feedbackOpen && (
        <div class="cg-fb">
          <div class="cg-fbhead"><span>💬 Feedback to AI</span><span class="cg-spacer" />
            <button class="cg-btn" onClick={() => vscode.postMessage({ type: "copyFeedback" })}>📋 Copy</button></div>
          <pre class="cg-fbbody">{feedbackText}</pre>
        </div>
      )}
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
```
(FileCard extraction + reject-note + collapsing come in Task 5. `theme.css` is created in Task 7 — create an empty `src/webview/theme.css` now so the import resolves: `touch src/webview/theme.css`.)

- [ ] **Step 4: Create the empty theme stylesheet placeholder**

Run: `printf "/* filled in Task 7 */\n" > src/webview/theme.css`

- [ ] **Step 5: Build + typecheck**

Run: `npm run compile:webview && npm run typecheck`
Expected: emits `media/review/review.js` **and** `media/review/review.css` (now that CSS is imported); typechecks clean.

- [ ] **Step 6: Manual verify**

`npm run compile`, package, install, reload. Open the panel with pending changes. Expected: toolbar with gate rail + counts, file rows with unified/split diffs (unstyled tokens are fine pre-Task-7), Keep/Reject buttons post messages (accept/reject works, list refreshes).

- [ ] **Step 7: Commit**

```bash
git add src/webview/types.ts src/webview/Toolbar.tsx src/webview/main.tsx src/webview/theme.css
git commit -m "feat: review webview app shell, toolbar + gate rail, live wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: FileCard — collapsing + reject-with-note

Extract the per-file row into its own component and add the collapsible body and the reject-note flow.

**Files:**
- Create: `src/webview/FileCard.tsx`
- Modify: `src/webview/main.tsx` (use `FileCard`)

**Interfaces:**
- Produces: `FileCard` — `function FileCard(props: { file: PayloadFile; diffMode: DiffMode; onKeep(path: string): void; onReject(path: string, reason?: string): void; onOpenNative(path: string): void }): JSX.Element`.

- [ ] **Step 1: Implement `FileCard.tsx`**

`src/webview/FileCard.tsx`:
```tsx
import { useState } from "preact/hooks";
import { DiffView } from "./DiffView";
import type { PayloadFile, DiffMode } from "./types";

interface Props {
  file: PayloadFile;
  diffMode: DiffMode;
  onKeep(path: string): void;
  onReject(path: string, reason?: string): void;
  onOpenNative(path: string): void;
}

export function FileCard({ file: f, diffMode, onKeep, onReject, onOpenNative }: Props) {
  const [collapsed, setCollapsed] = useState(f.status !== "pending");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  return (
    <div class="cg-file">
      <div class="cg-fhead">
        <button class="cg-chev" aria-label={collapsed ? "Expand" : "Collapse"}
                onClick={() => setCollapsed(c => !c)}>{collapsed ? "▸" : "▾"}</button>
        {f.isProtected && <span class="cg-warn" title="Protected file">⚠</span>}
        <span class="cg-fn">{f.relPath}</span>
        <span class="cg-cnt"><span class="a">+{f.added}</span> <span class="d">−{f.removed}</span></span>
        <span class="cg-spacer" />
        <button class="cg-btn" onClick={() => onOpenNative(f.relPath)} title="Open in native diff">Open diff</button>
        {f.status === "pending"
          ? <>
              <button class="cg-btn undo" onClick={() => setNoteOpen(true)}>Reject</button>
              <button class="cg-btn keep" onClick={() => onKeep(f.relPath)}>Keep</button>
            </>
          : <span class={`cg-status ${f.status}`}>{f.status === "kept" ? "✓ kept" : "✗ rejected"}</span>}
      </div>

      {!collapsed && f.status === "pending" &&
        <DiffView before={f.before} after={f.after} relPath={f.relPath} viewType={diffMode} />}

      {f.status === "undone" && f.reason &&
        <div class="cg-note-shown">reason: {f.reason}</div>}

      {noteOpen &&
        <div class="cg-note">
          <span class="cg-note-label">Reject — note to AI (optional):</span>
          <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)}
                 placeholder="e.g. keep the old signature — still called by the batch job"
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { onReject(f.relPath, note.trim() || undefined); setNoteOpen(false); }
                   if (e.key === "Escape") { setNoteOpen(false); setNote(""); }
                 }} />
          <button class="cg-btn" onClick={() => { setNoteOpen(false); setNote(""); }}>Cancel</button>
          <button class="cg-btn undo" onClick={() => { onReject(f.relPath, note.trim() || undefined); setNoteOpen(false); }}>Reject</button>
        </div>}
    </div>
  );
}
```

- [ ] **Step 2: Use `FileCard` in `main.tsx`**

Replace the inline `files.map(...)` block in `main.tsx` with:
```tsx
<div class="cg-files">
  {files.map(f => (
    <FileCard key={f.relPath} file={f} diffMode={diffMode}
              onKeep={(p) => vscode.postMessage({ type: "keep", path: p })}
              onReject={(p, reason) => vscode.postMessage({ type: "undo", path: p, reason })}
              onOpenNative={(p) => vscode.postMessage({ type: "openNative", path: p })} />
  ))}
</div>
```
Add `import { FileCard } from "./FileCard";` and remove the now-unused inline `DiffView` import if lint flags it.

- [ ] **Step 3: Build + typecheck + manual verify**

Run: `npm run compile:webview && npm run typecheck`
Expected: clean. Manual: reject a file → inline note field appears; Enter or Reject submits with the note; the reason shows on the rejected row; Cancel/Esc closes it. `Open diff` opens the native editor.

- [ ] **Step 4: Commit**

```bash
git add src/webview/FileCard.tsx src/webview/main.tsx
git commit -m "feat: per-file card with collapse + reject-with-note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Theming — VS Code tokens for react-diff-view + Prism

Make it look native. Map `--vscode-*` variables onto the diff and token classes.

**Files:**
- Modify: `src/webview/theme.css`

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Fill `src/webview/theme.css`**

```css
:root {
  --cg-add-bg: var(--vscode-diffEditor-insertedTextBackground, rgba(78,201,148,.10));
  --cg-del-bg: var(--vscode-diffEditor-removedTextBackground, rgba(224,108,117,.12));
  --cg-keep: var(--vscode-charts-green, #3fb950);
  --cg-undo: var(--vscode-charts-red, #f85149);
  --cg-focus: var(--vscode-focusBorder, #007fd4);
  --cg-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family, system-ui); font-size: var(--vscode-font-size, 13px); }

.cg-toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.cg-title b { color: var(--cg-keep); }
.cg-tally { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.cg-spacer { flex: 1; }
.cg-rail { display: flex; width: 160px; height: 7px; border-radius: 4px; overflow: hidden; background: var(--vscode-panel-border); }
.cg-rail i { display: block; height: 100%; } .cg-rail .k { background: var(--cg-keep); } .cg-rail .r { background: var(--cg-undo); } .cg-rail .p { background: #6a6a6a; }
.cg-seg { display: flex; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
.cg-seg button { padding: 3px 11px; background: transparent; color: var(--vscode-descriptionForeground); border: 0; cursor: pointer; }
.cg-seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.cg-btn { padding: 4px 11px; border-radius: 5px; border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; }
.cg-btn.keep { color: var(--cg-keep); border-color: rgba(63,185,80,.4); }
.cg-btn.undo { color: var(--cg-undo); border-color: rgba(248,81,73,.35); }

.cg-file { border-bottom: 1px solid var(--vscode-panel-border); }
.cg-fhead { display: flex; align-items: center; gap: 9px; padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); }
.cg-chev { background: none; border: 0; color: var(--vscode-descriptionForeground); cursor: pointer; }
.cg-fn { font-weight: 600; }
.cg-cnt { font-family: var(--cg-mono); font-size: 11.5px; } .cg-cnt .a { color: var(--cg-keep); } .cg-cnt .d { color: var(--cg-undo); }
.cg-warn { color: var(--vscode-editorWarning-foreground, #e5c07b); }
.cg-status { font-size: 11.5px; } .cg-status.kept { color: var(--cg-keep); } .cg-status.undone { color: var(--cg-undo); }

/* react-diff-view surface → editor look */
.diff { font-family: var(--cg-mono); font-size: 12px; background: var(--vscode-editor-background); width: 100%; }
.diff-gutter { color: var(--vscode-editorLineNumber-foreground); }
.diff-code-insert, .diff-gutter-insert { background: var(--cg-add-bg); }
.diff-code-delete, .diff-gutter-delete { background: var(--cg-del-bg); }
.diff-code { overflow-x: auto; }

.cg-note { display: flex; gap: 8px; align-items: center; padding: 9px 12px 11px 34px; background: rgba(248,81,73,.06); border-top: 1px solid rgba(248,81,73,.22); }
.cg-note-label { color: var(--cg-undo); font-size: 11px; }
.cg-note input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 5px; padding: 6px 9px; font: inherit; }
.cg-note-shown { padding: 8px 12px 10px 34px; color: var(--vscode-descriptionForeground); background: rgba(248,81,73,.05); }

.cg-fb { border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.cg-fbhead { display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--vscode-textLink-foreground); }
.cg-fbbody { margin: 0; padding: 8px 12px 12px; white-space: pre-wrap; font-family: var(--cg-mono); font-size: 11.5px; color: var(--vscode-descriptionForeground); }

.cg-empty, .cg-empty-state { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
:focus-visible { outline: 1px solid var(--cg-focus); outline-offset: -1px; }
```
(Prism token colors: `react-diff-view`'s `tokenize` emits `<span class="token …">`. If default token colors clash with the theme, add a small block mapping `.token.keyword`, `.token.string`, `.token.comment`, `.token.function` to `--vscode-*` editor token colors — verify visually in Step 2 and add only if needed.)

- [ ] **Step 2: Build + manual verify in light AND dark themes**

`npm run compile`, package, install, reload. Switch VS Code between a dark and a light theme. Expected: backgrounds, borders, add/del tints, and text all follow the theme; no hardcoded-dark artifacts; long lines scroll inside `.diff-code`; split mode shows balanced, aligned columns.

- [ ] **Step 3: Commit**

```bash
git add src/webview/theme.css
git commit -m "feat: native VS Code theming for the review webview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Keyboard navigation + ARIA

Make the batch reviewable without the mouse.

**Files:**
- Modify: `src/webview/main.tsx` (focus state + keydown)

**Interfaces:** none new (internal `focusedIndex` state).

- [ ] **Step 1: Add focus state + global keydown to `App`**

In `main.tsx`, add `const [focused, setFocused] = useState(0);` and, inside the same `useEffect` that registers `message`, register a `keydown` handler:
```tsx
const onKey = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (t && t.matches && t.matches("input, textarea")) return; // let inputs handle keys
  setFiles((cur) => {
    if (!cur.length) return cur;
    const i = Math.min(Math.max(focusedRef.current, 0), cur.length - 1);
    const f = cur[i];
    switch (e.key) {
      case "j": case "ArrowDown": setFocused(Math.min(i + 1, cur.length - 1)); e.preventDefault(); break;
      case "k": case "ArrowUp": setFocused(Math.max(i - 1, 0)); e.preventDefault(); break;
      case "a": if (f.status === "pending") vscode.postMessage({ type: "keep", path: f.relPath }); e.preventDefault(); break;
      case "x": if (f.status === "pending") vscode.postMessage({ type: "undo", path: f.relPath }); e.preventDefault(); break;
      case "Enter": vscode.postMessage({ type: "openNative", path: f.relPath }); e.preventDefault(); break;
    }
    return cur;
  });
};
window.addEventListener("keydown", onKey);
```
Add `const focusedRef = useRef(0);` (import `useRef`) and keep it in sync: `useEffect(() => { focusedRef.current = focused; }, [focused]);`. Pass `focused === index` down to `FileCard` as a `focused` prop; in `FileCard`, add `class={"cg-file" + (focused ? " focused" : "")}`, set `tabIndex` on the header, and `useEffect` to `scrollIntoView({ block: "nearest" })` when focused. Add `.cg-file.focused > .cg-fhead { outline: 2px solid var(--cg-focus); outline-offset: -2px; }` to `theme.css`.

- [ ] **Step 2: Add a keyboard hint to the Toolbar**

In `Toolbar.tsx`, before `.cg-spacer`, add:
```tsx
<span class="cg-kbd">j/k move · Enter open · a keep · x reject</span>
```
and `.cg-kbd { color: var(--vscode-descriptionForeground); font-size: 11px; }` in `theme.css`.

- [ ] **Step 3: Build + manual verify**

`npm run compile`, package, install, reload. Expected: `j`/`k` move a visible focus ring; `a`/`x` decide the focused file; `Enter` opens native diff; typing in the reject-note input is unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/webview/main.tsx src/webview/FileCard.tsx src/webview/Toolbar.tsx src/webview/theme.css
git commit -m "feat: keyboard navigation + focus ring in the review webview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Rollout — opt-in command + setting; native stays default

Ship the webview behind a flag; keep `Review All Pending` native.

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.configuration`)
- Modify: `src/extension.ts` (register `claudegate.reviewChangesPanel`)

**Interfaces:**
- Consumes: `ReviewWebviewPanel.showOrReveal(context, sessionManager, worktreeRegistry)` (existing).
- Produces: command `claudegate.reviewChangesPanel`; setting `claudegate.reviewPanel.enabled` (boolean, default false).

- [ ] **Step 1: Add the command + setting to `package.json`**

In `contributes.commands`:
```json
{ "command": "claudegate.reviewChangesPanel", "title": "Claude Gate: Review Changes (Panel — beta)", "icon": "$(preview)" }
```
In `contributes.configuration.properties`:
```json
"claudegate.reviewPanel.enabled": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "Enable the experimental all-in-one **Review Changes** webview panel (per-file keep/reject with notes + Feedback to AI). Off by default; the native multi-file diff (`Review All Pending`) remains the standard review surface."
}
```

- [ ] **Step 2: Register the command in `extension.ts`**

Next to the existing `claudegate.reviewAllPending` registration, add:
```ts
vscode.commands.registerCommand("claudegate.reviewChangesPanel", () =>
  ReviewWebviewPanel.showOrReveal(context, sessionManager, worktreeRegistry)
),
```
Add `import { ReviewWebviewPanel } from "./reviewWebview";` at the top (it was removed in 1.6.1 — restore it). Leave `claudegate.reviewAllPending` (native) as-is.

- [ ] **Step 3: Gate the palette entry on the setting (optional menu wiring)**

Leave the command palette-only (no title-bar icon yet). It is discoverable via the palette for dogfooding regardless of the setting; when the setting flips to default `true` in a future release, wire it to the Pending-panel title bar. (No `menus` change needed now.)

- [ ] **Step 4: Typecheck + build + manual verify**

Run: `npm run typecheck && npm run compile`
Expected: clean. Manual: `Cmd+Shift+P` → "Claude Gate: Review Changes (Panel — beta)" opens the webview; `Review All Pending` still opens the native multi-diff.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: opt-in Review Changes webview command + setting (native stays default)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Full verification pass + docs

**Files:**
- Modify: `README.md` (document the beta panel, one line)
- Verify: whole suite + manual matrix

- [ ] **Step 1: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: all TS + Python tests pass; typecheck clean.

- [ ] **Step 2: Package + install + manual matrix**

`vsce package` → `cursor --install-extension <vsix> --force`, reload. Verify, in the beta panel:
- Unified and Split both render; toggle persists across panel close/reopen (getState).
- A long-line file scrolls horizontally inside the diff (no page overflow).
- A binary/missing file shows "No preview".
- A protected file shows the ⚠ and amber treatment.
- A nested-worktree pending file appears and its Keep/Reject works.
- Reject-with-note writes the reason; Feedback-to-AI shows it; Copy works.
- Keyboard: j/k/Enter/a/x.
- Dark and light theme both look native.
- `.vsix` file list includes `media/review/review.js` + `media/review/review.css`, and excludes `src/webview/**`.

- [ ] **Step 3: One-line README note**

Add under the features list in `README.md`:
```
- **Review Changes panel (beta)** — enable `claudegate.reviewPanel.enabled`, then run `Claude Gate: Review Changes (Panel — beta)` to review every pending change in one scrollable panel with per-file keep/reject, revert notes, and a Feedback-to-AI log. The native `Review All Pending` multi-diff remains the default.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: note the beta Review Changes panel in the README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **If `react-diff-view` types fight `preact/compat`:** confirm `@types/react` is installed and `tsconfig` `paths` map `react`/`react-dom` → `preact/compat`; esbuild `--alias` handles the runtime.
- **CSP:** if any dependency injects inline `<style>` at runtime (it shouldn't — `react-diff-view` uses static CSS), do NOT add `'unsafe-inline'`; instead import that CSS statically so esbuild bundles it into `review.css`.
- **Bundle size:** check `media/review/review.js` stays reasonable (Preact + react-diff-view + refractor ≈ low hundreds of KB). If refractor pulls too many grammars, import only the needed languages from `refractor/lib/common` instead of the full build.
- **Do not touch** the native `reviewAllPending` path or the data-loss/robustness code — this feature is additive and behind a flag.
