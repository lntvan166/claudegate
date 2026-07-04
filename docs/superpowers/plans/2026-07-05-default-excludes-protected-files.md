# Default Excludes & Protected Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sensible default exclude patterns (editable, seeded into `claudegate.exclude`) and a "protected files" concept (`claudegate.protected`) that flags sensitive files and sorts them to the top of review.

**Architecture:** Both reuse the existing `ExcludeMatcher` glob engine. Defaults ship as the registered `default` value of the two object settings; a second `ExcludeMatcher` instance (`protectedMatcher`) answers `isProtected(fp)`; `reviewPanel`/`decorationProvider` flag protected pending files and sort them first; the Settings-pane add/remove is made scope-aware so pane edits never bake defaults into `settings.json`.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc). No new dependencies. Node `assert` unit tests via `test:unit` for the pure matcher; typecheck/compile + manual for `vscode`-coupled code.

## Global Constraints

- **No new dependencies.**
- **Seed defaults into the settings' `default` values** (`files.exclude`-style) — no on/off toggle. Users see and edit them; deactivate any default with `"<glob>": false`.
- **Relies on VS Code merging the registered object default with the user's value** (per-key, user wins) — verified in Task 2's manual step; documented in-code fallback if it doesn't hold.
- **Protected is visual-only, non-blocking** — flag + sort to top; accept/reject unchanged; protected files are never hidden.
- **Settings-pane Add/Remove writes only user-scope keys** (via `inspect()`): Add → user `true`; Remove a default → user `false`; Remove a user key → delete.
- **`excludeMatcher.ts` stays `vscode`-free.**
- **Folds into unreleased `1.3.0`** — extend the existing `## [1.3.0]` CHANGELOG entry; no version bump.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` pass after every task; `npm run test:unit` stays green.

---

## File Structure

- `src/excludeMatcher.ts` — MODIFY: export `DEFAULT_EXCLUDES` + `DEFAULT_PROTECTED` constants.
- `src/excludeMatcher.test.ts` — MODIFY: default-set + protected + false-deactivation tests.
- `package.json` — MODIFY: seed `claudegate.exclude` default; add `claudegate.protected`.
- `src/workspaceScope.ts` — MODIFY: `setProtectedMatcher` + `isProtected`.
- `src/extension.ts` — MODIFY: construct/load `protectedMatcher`; config listener; scope-aware add/remove; import `DEFAULT_EXCLUDES`.
- `src/reviewPanel.ts` — MODIFY: protected flag on `FileReviewItem` + sort-to-top.
- `src/decorationProvider.ts` — MODIFY: protected pending decoration.
- `src/settingsPanel.ts` — MODIFY: collapse the Exclude Patterns section by default.
- `README.md`, `CHANGELOG.md` — MODIFY: docs (Task 5).

---

## Task 1: Default constants + settings seeds + unit tests

**Files:**
- Modify: `src/excludeMatcher.ts` (export constants)
- Modify: `src/excludeMatcher.test.ts` (tests)
- Modify: `package.json` (seed `claudegate.exclude`; add `claudegate.protected`)

**Interfaces:**
- Produces: `export const DEFAULT_EXCLUDES: string[]`, `export const DEFAULT_PROTECTED: string[]` from `./excludeMatcher`.

- [ ] **Step 1: Add the constants to `src/excludeMatcher.ts`**

At the top of the file (after the header comment, before `globToRegExp`):

```typescript
// Shipped as the default VALUE of claudegate.exclude (editable by users).
export const DEFAULT_EXCLUDES: string[] = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/npm-shrinkwrap.json",
  "**/bun.lockb", "**/Cargo.lock", "**/poetry.lock", "**/Pipfile.lock", "**/Gemfile.lock",
  "**/composer.lock", "**/go.sum", "**/*.min.js", "**/*.min.css", "**/*.map", "**/node_modules/**",
];

// Shipped as the default VALUE of claudegate.protected (editable by users).
export const DEFAULT_PROTECTED: string[] = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
  "**/id_rsa", "**/id_ed25519", "**/.npmrc", "**/credentials",
];
```

- [ ] **Step 2: Add failing tests to `src/excludeMatcher.test.ts`**

Add these `run(...)` blocks before the final `console.log("done");`:

```typescript
import { DEFAULT_EXCLUDES, DEFAULT_PROTECTED } from "./excludeMatcher";

run("default excludes match lock/minified/map/node_modules, not source", () => {
  const m = new ExcludeMatcher();
  m.reload(Object.fromEntries(DEFAULT_EXCLUDES.map((g) => [g, true])), "/repo");
  assert.equal(m.isExcluded("/repo/pkg/package-lock.json"), true);
  assert.equal(m.isExcluded("/repo/a/b.min.js"), true);
  assert.equal(m.isExcluded("/repo/dist/app.js.map"), true);
  assert.equal(m.isExcluded("/repo/node_modules/foo/index.js"), true);
  assert.equal(m.isExcluded("/repo/src/main.ts"), false);
});

run("a user false entry deactivates a default", () => {
  const m = new ExcludeMatcher();
  const map = Object.fromEntries(DEFAULT_EXCLUDES.map((g) => [g, true]));
  map["**/go.sum"] = false;
  m.reload(map, "/repo");
  assert.equal(m.isExcluded("/repo/go.sum"), false);
  assert.equal(m.isExcluded("/repo/yarn.lock"), true);
});

run("default protected globs match secrets, not normal files", () => {
  const m = new ExcludeMatcher();
  m.reload(Object.fromEntries(DEFAULT_PROTECTED.map((g) => [g, true])), "/repo");
  assert.equal(m.isExcluded("/repo/.env"), true);
  assert.equal(m.isExcluded("/repo/config/.env.local"), true);
  assert.equal(m.isExcluded("/repo/keys/server.pem"), true);
  assert.equal(m.isExcluded("/repo/README.md"), false);
});
```

(The `import` line goes with the existing imports at the top of the test file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `DEFAULT_EXCLUDES`/`DEFAULT_PROTECTED` not exported yet (until Step 1 is saved; if Step 1 already saved, tests pass — in that case reorder: this step confirms the new tests execute).

- [ ] **Step 4: Seed the settings in `package.json`**

In `contributes.configuration.properties`:
- Change `claudegate.exclude`'s `default` from `{}` to the object map of every `DEFAULT_EXCLUDES` glob → `true`, e.g.:

```json
"claudegate.exclude": {
  "type": "object",
  "default": {
    "**/package-lock.json": true, "**/yarn.lock": true, "**/pnpm-lock.yaml": true,
    "**/npm-shrinkwrap.json": true, "**/bun.lockb": true, "**/Cargo.lock": true,
    "**/poetry.lock": true, "**/Pipfile.lock": true, "**/Gemfile.lock": true,
    "**/composer.lock": true, "**/go.sum": true, "**/*.min.js": true,
    "**/*.min.css": true, "**/*.map": true, "**/node_modules/**": true
  },
  "additionalProperties": { "type": "boolean" },
  "markdownDescription": "Glob patterns (shaped like `search.exclude`) whose matching files are hidden from ClaudeGate review. Ships with sensible defaults (lock files, minified assets, source maps, `node_modules`) — remove or deactivate any with `\"<glob>\": false`. Skipped by the watcher and hidden from panel/counts/badges even if the CLI hook captured them; nothing is deleted. Use `**/`-prefixed globs or a folder name."
}
```

- Add `claudegate.protected` immediately after:

```json
"claudegate.protected": {
  "type": "object",
  "default": {
    "**/.env": true, "**/.env.*": true, "**/*.pem": true, "**/*.key": true,
    "**/*.p12": true, "**/*.pfx": true, "**/id_rsa": true, "**/id_ed25519": true,
    "**/.npmrc": true, "**/credentials": true
  },
  "additionalProperties": { "type": "boolean" },
  "markdownDescription": "Glob patterns for **sensitive** files (secrets, keys, credentials). Matching files are **not hidden** — they are flagged with a warning and sorted to the top of the review so their changes get scrutiny. Ships with defaults; edit or deactivate any with `\"<glob>\": false`."
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:unit && npm run typecheck && node -e "require('./package.json')"`
Expected: all tests pass; typecheck exit 0; package.json parses.

- [ ] **Step 6: Commit**

```bash
git add src/excludeMatcher.ts src/excludeMatcher.test.ts package.json
git commit -m "feat: seed default excludes + protected-file patterns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Protected matcher wiring + `isProtected`

**Files:**
- Modify: `src/workspaceScope.ts` (add `setProtectedMatcher` + `isProtected`)
- Modify: `src/extension.ts` (construct/load `protectedMatcher`; config listener)

**Interfaces:**
- Consumes: `ExcludeMatcher` (existing), `claudegate.protected` config.
- Produces: `workspaceScope.isProtected(filePath): boolean`, `workspaceScope.setProtectedMatcher(m: ExcludeMatcher): void`.

- [ ] **Step 1: Add the protected matcher slot to `src/workspaceScope.ts`**

After the existing exclude-matcher block, add:

```typescript
let _protectedMatcher: ExcludeMatcher | null = null;

export function setProtectedMatcher(m: ExcludeMatcher): void {
  _protectedMatcher = m;
}

/** True if filePath matches an active claudegate.protected glob (sensitive file). */
export function isProtected(filePath: string): boolean {
  return _protectedMatcher?.isExcluded(filePath) ?? false;
}
```

- [ ] **Step 2: Construct + load the protected matcher in `src/extension.ts`**

Update the import from `./workspaceScope` to add the new symbols:

```typescript
import { isInWorkspace, isExcluded, setExcludeMatcher, isProtected, setProtectedMatcher } from "./workspaceScope";
```

Immediately after the existing `loadExclude()` / `setExcludeMatcher(excludeMatcher)` block, add:

```typescript
    const protectedMatcher = new ExcludeMatcher();
    const loadProtected = () =>
      protectedMatcher.reload(
        vscode.workspace.getConfiguration("claudegate").get<Record<string, boolean>>("protected"),
        workspacePath
      );
    loadProtected();
    setProtectedMatcher(protectedMatcher);
```

- [ ] **Step 3: Reload protected on config change**

Find the existing `onDidChangeConfiguration` listener that calls `loadExclude()` (the `claudegate.exclude` refresh listener). Extend its guard + body to also handle `claudegate.protected`:

```typescript
      vscode.workspace.onDidChangeConfiguration((e) => {
        const exclChanged = e.affectsConfiguration("claudegate.exclude");
        const protChanged = e.affectsConfiguration("claudegate.protected");
        if (!exclChanged && !protChanged) return;
        if (exclChanged) loadExclude();
        if (protChanged) loadProtected();
        pendingProvider.refresh();
        acceptedProvider.refresh();
        rejectedProvider.refresh();
        sessionManager.notifyChanged();
      })
```

(Match the existing listener's exact shape — it currently checks only `claudegate.exclude` and refreshes the providers; add the `protected` branch. If the existing listener differs slightly, preserve its refresh calls and just add the `protChanged` handling.)

- [ ] **Step 4: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 5: Manual verification — confirm the VS Code object-default merge (load-bearing)**

In the Extension Development Host:
1. Fresh workspace, no `claudegate.exclude` set → a `package-lock.json` Claude edit does **not** appear in Pending (default seed active).
2. Set `"claudegate.exclude": { "**/*.log": true }` in `.vscode/settings.json` → confirm a `.log` file is hidden **AND** a `package-lock.json` is **still** hidden (proves VS Code merges the registered default with the user value).
3. If step 2 shows lock files reappearing (i.e. VS Code did **not** merge), apply the fallback: change `loadExclude`/`loadProtected` to merge the defaults in-code before `reload`, e.g. `excludeMatcher.reload({ ...Object.fromEntries(DEFAULT_EXCLUDES.map(g=>[g,true])), ...userOwnValue }, workspacePath)` where `userOwnValue` comes from `getConfiguration("claudegate").inspect("exclude")` (global/workspace/folder merged). Document the outcome in the commit.

- [ ] **Step 6: Commit**

```bash
git add src/workspaceScope.ts src/extension.ts
git commit -m "feat: protected-file matcher (isProtected) wired + live reload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Protected visual flag + sort-to-top

**Files:**
- Modify: `src/reviewPanel.ts` (`FileReviewItem` flag; sort protected first)
- Modify: `src/decorationProvider.ts` (protected pending decoration)

**Interfaces:**
- Consumes from Task 2: `isProtected(filePath)`.

- [ ] **Step 1: Flag protected files in `FileReviewItem` (`src/reviewPanel.ts`)**

Add `isProtected` to the workspaceScope import:

```typescript
import { isInWorkspace, isExcluded, isProtected } from "./workspaceScope";
```

In the `FileReviewItem` constructor, after the tooltip is set, add:

```typescript
    if (isProtected(filePath)) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      this.tooltip = new vscode.MarkdownString(
        `⚠ **Protected — sensitive file; review carefully**\n\n**${path.basename(filePath)}**\n\n${filePath}\n\nStatus: *${reviewStatus}*`
      );
    }
```

- [ ] **Step 2: Sort protected files to the top**

In `directChildren`, replace the file sort:

```typescript
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));
```

with a protected-first comparator:

```typescript
    files.sort(
      (a, b) =>
        (Number(isProtected(b.filePath)) - Number(isProtected(a.filePath))) ||
        a.filePath.localeCompare(b.filePath)
    );
```

In the **list-mode** branch of `getChildren` (the `this.viewMode === "list"` path at root and inside a `SessionItem`), sort the file paths protected-first before mapping. Change each `files.map((fp) => new FileReviewItem(...))` to first sort:

```typescript
      const ordered = [...files].sort(
        (a, b) =>
          (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
      );
      return ordered.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager));
```

(Apply to both list-mode return sites — root and `SessionItem`. If a site already maps unsorted `files`, wrap with the `ordered` sort above.)

- [ ] **Step 3: Protected decoration in `src/decorationProvider.ts`**

Add the import:

```typescript
import { isProtected } from "./workspaceScope";
```

In `provideFileDecoration`, after the `if (!entry) return undefined;` guard and before the normal status decoration, add:

```typescript
    if (entry.reviewStatus === "pending" && isProtected(uri.fsPath)) {
      return {
        badge: "⚠",
        color: new vscode.ThemeColor("list.warningForeground"),
        tooltip: "Claude Gate: protected — sensitive file, review carefully",
        propagate: false,
      };
    }
```

- [ ] **Step 4: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 5: Manual verification**

In the Extension Development Host: a Claude edit to `.env` (or `config/app.key`) appears in Pending with a **warning icon + color**, a **"Protected — sensitive file"** tooltip, sorted **above** non-protected files (in both list and tree modes), and a `⚠` badge in the explorer. Accept/reject still work.

- [ ] **Step 6: Commit**

```bash
git add src/reviewPanel.ts src/decorationProvider.ts
git commit -m "feat: flag protected files and sort them to the top of review

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Scope-aware Settings-pane Add/Remove + collapse exclude section

**Files:**
- Modify: `src/extension.ts` (`addExcludePattern` / `removeExcludePattern` write user-scope only)
- Modify: `src/settingsPanel.ts` (collapse the Exclude Patterns section)

**Interfaces:**
- Consumes: `DEFAULT_EXCLUDES` from `./excludeMatcher`; existing `updateClaudegateConfig`.

- [ ] **Step 1: Import `DEFAULT_EXCLUDES` + add a user-scope helper in `src/extension.ts`**

Extend the excludeMatcher import:

```typescript
import { ExcludeMatcher, DEFAULT_EXCLUDES } from "./excludeMatcher";
```

Inside `activate` (near `updateClaudegateConfig`), add a helper that returns the user's OWN exclude map (not merged with defaults) for the active write scope:

```typescript
    const userExcludeMap = (): Record<string, boolean> => {
      const info = vscode.workspace.getConfiguration("claudegate").inspect<Record<string, boolean>>("exclude");
      const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      const own = hasFolder ? info?.workspaceValue : info?.globalValue;
      return { ...(own ?? {}) };
    };
```

- [ ] **Step 2: Rewrite `addExcludePattern` to write user-scope only**

Replace the `claudegate.addExcludePattern` handler body (keep the input-box prompt) so the map it writes comes from `userExcludeMap()`:

```typescript
      vscode.commands.registerCommand("claudegate.addExcludePattern", async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Glob or folder to exclude — e.g. **/dist/**, **/*.min.js, **/*.log, or a folder like .superpowers",
          placeHolder: "**/dist/**",
          validateInput: (v) => (v.trim().length === 0 ? "Enter a non-empty glob" : undefined),
        });
        if (!input) return;
        const glob = input.trim();
        const map = userExcludeMap();
        if (map[glob] === true) {
          vscode.window.showInformationMessage(`Claude Gate: "${glob}" is already excluded.`);
          return;
        }
        map[glob] = true;
        await updateClaudegateConfig("exclude", map);
      }),
```

- [ ] **Step 3: Rewrite `removeExcludePattern` (default → false; user key → delete)**

Replace the `claudegate.removeExcludePattern` handler:

```typescript
      vscode.commands.registerCommand(
        "claudegate.removeExcludePattern",
        async (item: SettingsItem) => {
          const glob = item?.pattern;
          if (!glob) return;
          const map = userExcludeMap();
          if (DEFAULT_EXCLUDES.includes(glob)) {
            map[glob] = false; // can't delete a shipped default — deactivate it
          } else {
            delete map[glob];
          }
          await updateClaudegateConfig("exclude", map);
        }
      ),
```

- [ ] **Step 4: Collapse the Exclude Patterns section in `src/settingsPanel.ts`**

In the `excludeHeader` case of `getTreeItem`, change the collapsible state from `Expanded` to `Collapsed`:

```typescript
        const ti = new vscode.TreeItem("Exclude Patterns", vscode.TreeItemCollapsibleState.Collapsed);
```

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 6: Manual verification**

1. Settings pane → Exclude Patterns is **collapsed** by default; expanding shows the ~15 defaults + any user patterns.
2. **Add** `**/*.log` via the pane → `.vscode/settings.json` contains only `{ "**/*.log": true }` (defaults NOT baked in).
3. **Remove a default** (e.g. `**/go.sum`) via the pane 🗑 → `settings.json` gains `{ "**/go.sum": false }`; a `go.sum` edit now appears in Pending.
4. **Remove a user pattern** (`**/*.log`) → the key is deleted from `settings.json`.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts src/settingsPanel.ts
git commit -m "feat: scope-aware exclude add/remove; collapse exclude pane section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Docs & CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the features from Tasks 1–4.

- [ ] **Step 1: README — settings + protected note**

In `README.md`'s "Extension Settings" table: update the `claudegate.exclude` row's Default to *"sensible defaults (lock files, minified, maps, node_modules)"* and description to note they ship by default and are editable/deactivatable via `false`. Add a new row:

```markdown
| `claudegate.protected` | secrets defaults | Glob patterns for **sensitive** files (`.env`, keys, credentials). Matching files aren't hidden — they're **flagged and sorted to the top** of review so their changes get scrutiny. Edit/deactivate like `claudegate.exclude`. |
```

- [ ] **Step 2: CHANGELOG — extend the 1.3.0 Added section**

In `CHANGELOG.md`, inside the existing `## [1.3.0]` → `### Added` list, append:

```markdown
- **Default exclude patterns** — lock files, minified assets, source maps, and `node_modules` are filtered from review out of the box (shipped as editable defaults in `claudegate.exclude`; deactivate any with `"<glob>": false`).
- **Protected files** — `claudegate.protected` flags sensitive files (`.env`, keys, credentials) with a warning and sorts them to the top of review (never hidden), so their changes get extra scrutiny.
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: default excludes + protected files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** constants + seeds → Task 1; matcher tests (defaults/false/protected) → Task 1; `protectedMatcher` + `isProtected` + config listener → Task 2; VS Code merge verification + fallback → Task 2 Step 5; protected flag + sort-to-top + decoration → Task 3; scope-aware add/remove + collapsed section → Task 4; docs/CHANGELOG (1.3.0, no bump) → Task 5.
- **Placeholder scan:** none — all code/text steps concrete.
- **Type consistency:** `DEFAULT_EXCLUDES`/`DEFAULT_PROTECTED` exported (Task 1), consumed in Task 2 tests / Task 4 import; `isProtected`/`setProtectedMatcher` defined (Task 2) and used in Task 3; `userExcludeMap()` defined + used in Task 4; `SettingsItem` (existing) is the `removeExcludePattern` arg type; command ids unchanged.
