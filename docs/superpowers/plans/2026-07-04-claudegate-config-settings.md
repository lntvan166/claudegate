# ClaudeGate Configuration Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two settings — `claudegate.fileWatcher.enabled` (turn the GUI file watcher off so terminal users rely only on the CLI hook) and `claudegate.exclude` (a `search.exclude`-style glob map to hide files from review) — plus docs.

**Architecture:** A new `vscode`-free `excludeMatcher.ts` compiles glob patterns to RegExp and answers `isExcluded(filePath)`. `workspaceScope.ts` exposes a thin `isExcluded` delegating to a shared matcher instance, applied everywhere `isInWorkspace` already is. `extension.ts` gates the watcher on the toggle and reloads the matcher on config change — both live via `onDidChangeConfiguration`, no reload needed.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc). Node's built-in `assert` + esbuild for the one unit-testable module. No new dependencies.

## Global Constraints

- **No new dependencies** (runtime or dev).
- **No version bump** — this folds into the unreleased `1.2.0`; do not add a new CHANGELOG version heading, extend the existing `## [1.2.0] — 2026-07-04` entry.
- **Watcher default ON** — `claudegate.fileWatcher.enabled` defaults to `true` so existing GUI users are unaffected.
- **Exclusion is non-destructive** — never delete session entries; excluded files are only skipped-at-capture (watcher) and hidden-at-display (both paths). The Python hook is NOT modified.
- **Exclude config shape mirrors `search.exclude`** — `claudegate.exclude` is an object map `{ "<glob>": true|false }`; a `false` value is inactive.
- **Settings apply live** via `onDidChangeConfiguration` — no window reload required.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass after every task.
- `excludeMatcher.ts` MUST NOT import `vscode` (so it bundles+runs under plain Node for tests).

---

## File Structure

- `src/excludeMatcher.ts` — CREATE: pure `globToRegExp` + `ExcludeMatcher` class (no `vscode`).
- `src/excludeMatcher.test.ts` — CREATE: Node `assert` tests, bundled+run via esbuild.
- `package.json` — MODIFY: `contributes.configuration` (two settings), `scripts.test:unit`, `description`.
- `src/extension.ts` — MODIFY: gate watcher on toggle; construct/load/refresh matcher; live config listeners; count filter.
- `src/workspaceScope.ts` — MODIFY: add `isExcluded` + `setExcludeMatcher` delegating to a shared instance.
- `src/sessionManager.ts` — MODIFY: `getPendingCount`/`acceptAll`/`rejectAll` also drop `isExcluded`.
- `src/reviewPanel.ts` — MODIFY: two tree filters also drop `isExcluded`.
- `src/decorationProvider.ts` — MODIFY: no badge for excluded files.
- `src/documentTracker.ts` — MODIFY: skip excluded files at capture.
- `readme.md`, `CHANGELOG.md` — MODIFY: docs.

---

## Task 1: `excludeMatcher` module + unit tests

**Files:**
- Create: `src/excludeMatcher.ts`
- Create: `src/excludeMatcher.test.ts`
- Modify: `package.json` (add `scripts.test:unit`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function globToRegExp(glob: string): RegExp`
  - `export class ExcludeMatcher { reload(excludeMap: Record<string, boolean> | undefined, workspaceRoot?: string): void; isExcluded(filePath: string): boolean }`

- [ ] **Step 1: Add the `test:unit` npm script**

In `package.json` `"scripts"`, add (keep existing scripts; add this key):

```json
"test:unit": "esbuild src/excludeMatcher.test.ts --bundle --platform=node --format=cjs --outfile=out/excludeMatcher.test.cjs && node out/excludeMatcher.test.cjs"
```

- [ ] **Step 2: Write the failing test**

Create `src/excludeMatcher.test.ts`:

```typescript
import assert from "node:assert";
import { globToRegExp, ExcludeMatcher } from "./excludeMatcher";

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

run("globToRegExp **/*.pb.go matches at any depth, not plain .go", () => {
  const re = globToRegExp("**/*.pb.go");
  assert.ok(re.test("api/user.pb.go"));
  assert.ok(re.test("/Users/x/api/user.pb.go"));
  assert.ok(!re.test("api/user.go"));
});

run("globToRegExp **/dist/** matches dist dir, not distinct", () => {
  const re = globToRegExp("**/dist/**");
  assert.ok(re.test("pkg/dist/index.js"));
  assert.ok(re.test("/repo/pkg/dist/index.js"));
  assert.ok(!re.test("pkg/distinct/index.js"));
});

run("globToRegExp ? matches exactly one non-separator char", () => {
  const re = globToRegExp("a?.ts");
  assert.ok(re.test("ab.ts"));
  assert.ok(!re.test("abc.ts"));
  assert.ok(!re.test("a/.ts"));
});

run("globToRegExp escapes regex metacharacters literally", () => {
  const re = globToRegExp("a+b.ts");
  assert.ok(re.test("a+b.ts"));
  assert.ok(!re.test("aaab.ts"));
});

run("ExcludeMatcher empty map excludes nothing", () => {
  const m = new ExcludeMatcher();
  m.reload({});
  assert.equal(m.isExcluded("/x/y.pb.go"), false);
  m.reload(undefined);
  assert.equal(m.isExcluded("/x/y.pb.go"), false);
});

run("ExcludeMatcher honors active(true) and ignores inactive(false)", () => {
  const m = new ExcludeMatcher();
  m.reload({ "**/*.pb.go": true, "**/skip/**": false });
  assert.equal(m.isExcluded("/x/y.pb.go"), true);
  assert.equal(m.isExcluded("/x/skip/z.ts"), false);
  assert.equal(m.isExcluded("/x/y.ts"), false);
});

run("ExcludeMatcher matches workspace-relative path via root", () => {
  const m = new ExcludeMatcher();
  m.reload({ "dist/**": true }, "/repo");
  assert.equal(m.isExcluded("/repo/dist/a.js"), true);
  assert.equal(m.isExcluded("/other/dist/a.js"), false);
});

console.log("done");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — esbuild errors that `./excludeMatcher` (module) cannot be resolved / has no exports.

- [ ] **Step 4: Write the implementation**

Create `src/excludeMatcher.ts`:

```typescript
// Glob exclusion for ClaudeGate. Kept free of `vscode` imports so it can be
// bundled and run under plain Node for unit tests.

// Translate a glob to an anchored RegExp.
//   **  → any characters, including path separators (matches across segments)
//   *   → any characters except the path separator (within one segment)
//   ?   → exactly one character except the path separator
// A `**` immediately followed by `/` also consumes that slash, so `**/x`
// matches both `x` and `a/b/x`.
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++; // consume the second '*'
        if (g[i + 1] === "/") i++; // consume an optional trailing slash
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export class ExcludeMatcher {
  private patterns: RegExp[] = [];
  private root = "";

  // Rebuild the active pattern set. Only entries mapped to `true` are active.
  // An individual glob that fails to compile is skipped (fail open).
  reload(excludeMap: Record<string, boolean> | undefined, workspaceRoot?: string): void {
    this.root = (workspaceRoot ?? "").replace(/\\/g, "/");
    this.patterns = [];
    if (!excludeMap) return;
    for (const [glob, active] of Object.entries(excludeMap)) {
      if (!active) continue;
      try {
        this.patterns.push(globToRegExp(glob));
      } catch {
        // Ignore an invalid glob rather than throwing; the file is simply not excluded.
      }
    }
  }

  // True if the file matches any active pattern, tested against both the
  // absolute path and (when under the workspace root) the relative path.
  isExcluded(filePath: string): boolean {
    if (this.patterns.length === 0) return false;
    const abs = filePath.replace(/\\/g, "/");
    let rel = abs;
    if (this.root && abs.startsWith(this.root + "/")) {
      rel = abs.slice(this.root.length + 1);
    }
    return this.patterns.some((re) => re.test(abs) || re.test(rel));
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: seven `ok - ...` lines then `done`, process exit 0.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (test file is `.ts`; it is excluded from the bundle but must still typecheck).

- [ ] **Step 7: Commit**

```bash
git add src/excludeMatcher.ts src/excludeMatcher.test.ts package.json
git commit -m "feat: add excludeMatcher (glob→RegExp) with unit tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Watcher toggle setting (`claudegate.fileWatcher.enabled`)

**Files:**
- Modify: `package.json` (add `contributes.configuration` with the `fileWatcher.enabled` property)
- Modify: `src/extension.ts:299-300` (gate `documentTracker.start()`), plus a new `onDidChangeConfiguration` listener

**Interfaces:**
- Consumes: existing `documentTracker` (has `start()`/`stop()`), `log`.
- Produces: a live-toggle behavior; a `contributes.configuration` block that Task 3 will extend with a second property.

- [ ] **Step 1: Declare the setting in `package.json`**

Add a `configuration` key inside `contributes` (alongside `commands`, `menus`, etc.):

```json
"configuration": {
  "title": "Claude Gate",
  "properties": {
    "claudegate.fileWatcher.enabled": {
      "type": "boolean",
      "default": true,
      "markdownDescription": "Capture Claude Code GUI-extension edits by watching the filesystem. Disable if you use only the terminal CLI (the PreToolUse hook) — the hook is more accurate, and the watcher can surface manual edits, formatter/codegen output, and git operations as false review items."
    }
  }
}
```

- [ ] **Step 2: Gate the watcher start on the setting**

In `src/extension.ts`, replace lines 299-300:

```typescript
    documentTracker.start();
    context.subscriptions.push({ dispose: () => documentTracker.stop() });
```

with:

```typescript
    const isWatcherEnabled = () =>
      vscode.workspace.getConfiguration("claudegate").get<boolean>("fileWatcher.enabled", true);

    if (isWatcherEnabled()) {
      documentTracker.start();
    } else {
      log.appendLine("[INFO] File watcher disabled (claudegate.fileWatcher.enabled=false); using CLI hook only.");
    }
    context.subscriptions.push({ dispose: () => documentTracker.stop() });

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("claudegate.fileWatcher.enabled")) return;
        if (isWatcherEnabled()) {
          documentTracker.start();
          log.appendLine("[INFO] File watcher enabled.");
        } else {
          documentTracker.stop();
          log.appendLine("[INFO] File watcher disabled.");
        }
      })
    );
```

Note: `DocumentTracker.start()` is idempotent enough for a toggle — calling `start()` after `stop()` re-registers listeners and re-snapshots open documents.

- [ ] **Step 3: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 4: Manual verification (Extension Development Host)**

1. Default (setting unset) → GUI edits still captured (watcher on).
2. Set `"claudegate.fileWatcher.enabled": false` in settings (no reload) → Output logs "File watcher disabled."; a GUI-extension edit is NOT captured; a terminal CLI edit (hook) still is.
3. Set it back to `true` (no reload) → Output logs "File watcher enabled."; GUI edits captured again.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: add claudegate.fileWatcher.enabled toggle (live)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Exclude patterns (`claudegate.exclude`) enforcement

**Files:**
- Modify: `package.json` (add the `claudegate.exclude` property to the existing `contributes.configuration.properties`)
- Modify: `src/workspaceScope.ts` (add `isExcluded` + `setExcludeMatcher`)
- Modify: `src/extension.ts` (construct/load matcher; count filter; live reload listener)
- Modify: `src/sessionManager.ts` (`getPendingCount`, `acceptAll`, `rejectAll`)
- Modify: `src/reviewPanel.ts:124,143` (tree filters)
- Modify: `src/decorationProvider.ts:30-43` (skip excluded)
- Modify: `src/documentTracker.ts:111` (skip excluded at capture)

**Interfaces:**
- Consumes from Task 1: `ExcludeMatcher`, `globToRegExp`.
- Produces: `workspaceScope.isExcluded(filePath: string): boolean` and `workspaceScope.setExcludeMatcher(m: ExcludeMatcher): void`, used across the consumer files.

- [ ] **Step 1: Declare the setting in `package.json`**

Add a second property inside the existing `contributes.configuration.properties` (created in Task 2):

```json
"claudegate.exclude": {
  "type": "object",
  "default": {},
  "additionalProperties": { "type": "boolean" },
  "markdownDescription": "Glob patterns whose matching files are hidden from ClaudeGate review (shaped like `search.exclude`). Matching files are skipped by the file watcher and hidden from the panel, counts, and badges even if captured by the CLI hook — nothing is deleted. Use `**/`-prefixed patterns to match at any depth. Example: `{ \"**/*.pb.go\": true, \"**/dist/**\": true }`."
}
```

- [ ] **Step 2: Add `isExcluded` + `setExcludeMatcher` to `workspaceScope.ts`**

Replace the entire contents of `src/workspaceScope.ts`:

```typescript
import * as path from "path";
import * as vscode from "vscode";
import { ExcludeMatcher } from "./excludeMatcher";

/** True if filePath is under any open VS Code workspace folder. */
export function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
}

// Shared exclusion matcher, wired once at activation. Until set, nothing is excluded.
let _excludeMatcher: ExcludeMatcher | null = null;

export function setExcludeMatcher(m: ExcludeMatcher): void {
  _excludeMatcher = m;
}

/** True if filePath matches an active claudegate.exclude glob. */
export function isExcluded(filePath: string): boolean {
  return _excludeMatcher?.isExcluded(filePath) ?? false;
}
```

- [ ] **Step 3: Construct + load the matcher and filter counts in `extension.ts`**

In `src/extension.ts`, update the import on line 18:

```typescript
import { isInWorkspace } from "./workspaceScope";
```

to:

```typescript
import { isInWorkspace, isExcluded, setExcludeMatcher } from "./workspaceScope";
import { ExcludeMatcher } from "./excludeMatcher";
```

After line 59 (`const workspacePath = ...`), add:

```typescript
    const excludeMatcher = new ExcludeMatcher();
    const loadExclude = () =>
      excludeMatcher.reload(
        vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("exclude"),
        workspacePath
      );
    loadExclude();
    setExcludeMatcher(excludeMatcher);
```

In the `sessionManager.onSessionChange` handler, change the count-loop guard (line 279) from:

```typescript
          if (!isInWorkspace(filePath)) continue;
```

to:

```typescript
          if (!isInWorkspace(filePath) || isExcluded(filePath)) continue;
```

- [ ] **Step 4: Add `notifyChanged()` to `SessionManager`**

The exclude listener needs to re-fire the session-change event so the badge/status-bar counts recompute even though the session itself did not change. In `src/sessionManager.ts`, add this public method immediately after `getSession()`:

```typescript
  // Re-fire the current session to consumers (used when a display filter,
  // e.g. claudegate.exclude, changes without the session itself changing).
  notifyChanged(): void {
    this._onSessionChange.fire(this.session);
  }
```

- [ ] **Step 5: Add a live reload listener for `claudegate.exclude` in `extension.ts`**

Immediately after the `sessionManager.onSessionChange(...)` registration (after line 294), add:

```typescript
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("claudegate.exclude")) return;
        loadExclude();
        // Re-render trees and recompute counts/badges without a session change.
        pendingProvider.refresh();
        acceptedProvider.refresh();
        rejectedProvider.refresh();
        sessionManager.notifyChanged();
      })
    );
```

- [ ] **Step 6: Filter excluded files in `sessionManager.ts` bulk ops + count**

Update the import (line 6) if needed — it already imports `isInWorkspace`; change to:

```typescript
import { isInWorkspace, isExcluded } from "./workspaceScope";
```

In `getPendingCount()` change the filter to also drop excluded:

```typescript
  getPendingCount(): number {
    if (!this.session) return 0;
    return Object.entries(this.session.files).filter(
      ([fp, f]) => f.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
    ).length;
  }
```

In `acceptAll()` change its guard `if (entry.reviewStatus === "pending" && isInWorkspace(filePath))` to:

```typescript
      if (entry.reviewStatus === "pending" && isInWorkspace(filePath) && !isExcluded(filePath)) {
```

In `rejectAll()` change its guard `if (entry.reviewStatus !== "pending" || !isInWorkspace(filePath)) continue;` to:

```typescript
      if (entry.reviewStatus !== "pending" || !isInWorkspace(filePath) || isExcluded(filePath)) continue;
```

- [ ] **Step 7: Filter excluded files in `reviewPanel.ts`**

Update the import (line 5):

```typescript
import { isInWorkspace, isExcluded } from "./workspaceScope";
```

Line 124 — change:

```typescript
        .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp))
```

to:

```typescript
        .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp) && !isExcluded(fp))
```

Line 143 (inside the folder-grouping filter) — change:

```typescript
            isInWorkspace(fp)
```

to:

```typescript
            isInWorkspace(fp) && !isExcluded(fp)
```

- [ ] **Step 8: Skip decoration for excluded files in `decorationProvider.ts`**

Add the import at the top of `src/decorationProvider.ts`:

```typescript
import { isExcluded } from "./workspaceScope";
```

In `provideFileDecoration`, after line 34 (`if (!entry) return undefined;`), add:

```typescript
    if (isExcluded(uri.fsPath)) return undefined;
```

- [ ] **Step 9: Skip excluded files at capture in `documentTracker.ts`**

Add the import at the top of `src/documentTracker.ts`:

```typescript
import { isExcluded } from "./workspaceScope";
```

In `processFsEventBatch`, right after the existing `if (this.isIgnoredPath(filePath)) continue;` (line 111), add:

```typescript
      if (isExcluded(filePath)) continue;
```

- [ ] **Step 10: Typecheck, compile, and re-run unit tests**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0; unit tests still print `ok`/`done`.

- [ ] **Step 11: Manual verification (Extension Development Host)**

1. Set `"claudegate.exclude": { "**/*.pb.go": true }` (no reload). Have Claude (CLI hook) edit a `*.pb.go` file → it does NOT appear in the Pending panel and is not counted in the badge/status bar; a normal `.ts` edit still appears.
2. Clear the pattern (no reload) → the previously hidden `*.pb.go` entry reappears on refresh (non-destructive).
3. With the pattern set, `Accept All` / `Reject All` do not touch the excluded file (verify it is untouched on disk and absent from the modal count).
4. With the watcher on, a GUI edit to an excluded file is not captured.

- [ ] **Step 12: Commit**

```bash
git add package.json src/workspaceScope.ts src/extension.ts src/sessionManager.ts src/reviewPanel.ts src/decorationProvider.ts src/documentTracker.ts
git commit -m "feat: add claudegate.exclude glob patterns (hide files from review)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Documentation & CHANGELOG

**Files:**
- Modify: `package.json` (`description`)
- Modify: `readme.md` (add Extension Settings section)
- Modify: `CHANGELOG.md` (extend the existing `## [1.2.0]` entry)

**Interfaces:**
- Consumes: the settings from Tasks 2–3.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update the marketplace description**

In `package.json`, update the `description` field to mention both detection paths and the accuracy tip. Set it to:

```json
"description": "Review Claude Code's file changes in a native diff panel — accept or reject each edit. Works with the terminal CLI (via a PreToolUse hook) and the in-editor Claude extension (via a file watcher). Terminal-only users can set claudegate.fileWatcher.enabled to false for maximum accuracy.",
```

- [ ] **Step 2: Add an Extension Settings section to `readme.md`**

Add this section to `readme.md` (place it after the existing features/usage section, before any Publishing/Development section):

```markdown
## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `claudegate.fileWatcher.enabled` | `true` | Capture Claude Code **GUI-extension** edits by watching the filesystem. Turn this **off** if you only use the **terminal CLI** — the `PreToolUse` hook is more accurate, and the watcher can surface manual edits, formatter/codegen output, and git operations as false review items. |
| `claudegate.exclude` | `{}` | Glob patterns (shaped like VS Code's `search.exclude`) whose matching files are hidden from review. Matching files are skipped by the watcher and hidden from the panel, counts, and badges even if the CLI hook captured them — nothing is deleted. Use `**/`-prefixed patterns to match at any depth. |

Example `settings.json`:

```jsonc
{
  // Terminal-CLI user: rely on the hook only.
  "claudegate.fileWatcher.enabled": false,
  // Hide generated files from review.
  "claudegate.exclude": {
    "**/*.pb.go": true,
    "**/dist/**": true
  }
}
```
```

- [ ] **Step 3: Extend the existing 1.2.0 CHANGELOG entry**

In `CHANGELOG.md`, inside the existing `## [1.2.0] — 2026-07-04` section (do NOT add a new version heading), add an **Added** subsection above its `### Changed`:

```markdown
### Added

- **`claudegate.fileWatcher.enabled` setting** (default `true`) — turn off the GUI file watcher so terminal-CLI users rely only on the more-accurate `PreToolUse` hook. Applies live (no reload).
- **`claudegate.exclude` setting** — `search.exclude`-style glob map to hide files (e.g. generated `**/*.pb.go`) from the review panel, counts, badges, and the watcher. Non-destructive and applies live.
```

- [ ] **Step 4: Verify the package still builds**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json readme.md CHANGELOG.md
git commit -m "docs: document fileWatcher.enabled and exclude settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Settings surface → Tasks 2 (declare `fileWatcher.enabled`) + 3 (declare `exclude`). Watcher toggle live → Task 2. `excludeMatcher` module → Task 1. `workspaceScope.isExcluded` + wiring → Task 3 (steps 2–5). Capture-time skip → Task 3 step 9. Display/action filter across counts/trees/bulk/decoration → Task 3 steps 3,6,7,8. Non-destructive → no delete anywhere (verified: only filters added). Docs → Task 4. No version bump → Global Constraints + Task 4 step 3. Error handling (invalid glob fail-open, missing config defaults) → Task 1 `reload` try/catch + `get(..., default)`. No new deps → tests use esbuild+node only.
- **Placeholder scan:** none — every code step carries full code.
- **Type consistency:** `ExcludeMatcher.reload(map, workspaceRoot?)` / `isExcluded(path)` used identically in Task 1, `workspaceScope` (Task 3 step 2), and `extension.ts` (Task 3 step 3). `setExcludeMatcher`/`isExcluded`/`notifyChanged` names consistent across steps. `isWatcherEnabled` (Task 2) and `loadExclude` (Task 3) are distinct locals, no collision.
- **Note on two config listeners:** Task 2 and Task 3 each register a separate `onDidChangeConfiguration` listener (one for `fileWatcher.enabled`, one for `exclude`). This is intentional and valid — keeps the two features independently reviewable; VS Code fires all listeners.
