# Default Exclude Patterns & Protected Files

**Date:** 2026-07-05
**Status:** Approved for implementation
**Related:** `package.json`, `src/excludeMatcher.ts`, `src/workspaceScope.ts`, `src/extension.ts`, `src/reviewPanel.ts`, `src/decorationProvider.ts`, `src/settingsPanel.ts`; research items #4/#5 in `docs/superpowers/research/2026-07-04-improvement-ideas-research.md`

## Goal

Two low-effort quality-of-life wins that reuse the existing glob engine (`ExcludeMatcher`):

- **#4 Default excludes** — noise files (lock files, minified assets, source maps, `node_modules`) are filtered from review **out of the box**, shipped as the *default value* of `claudegate.exclude` so users can **see and edit** them.
- **#5 Protected files** — sensitive files (`.env`, private keys, credentials) are **visually flagged and sorted to the top** of the review (never hidden), so a change to them draws scrutiny. The research cited real secrets-exfiltration / destructive-edit incidents.

## Product Decisions

- **Seed the setting defaults** (VS Code `files.exclude`-style): the default patterns are the registered `default` value of `claudegate.exclude` (and `claudegate.protected`). No separate toggle. Users see the defaults in Settings, edit freely, and deactivate any default by setting it `false`.
- **Relies on VS Code merging the registered default object with the user's value** (shallow, per-key, user wins) — the standard object-setting behavior behind `files.exclude`. This is load-bearing and **verified as the first implementation step**.
- **Protected is visual-only, non-blocking** — flag + sort to top; accept/reject behave normally.
- **Folds into the unreleased `1.3.0`** (main already carries the 1.3.0 CHANGELOG entry) — extend it, no new version.

## Default lists

`DEFAULT_EXCLUDES` (seed for `claudegate.exclude`):
```
**/package-lock.json, **/yarn.lock, **/pnpm-lock.yaml, **/npm-shrinkwrap.json,
**/bun.lockb, **/Cargo.lock, **/poetry.lock, **/Pipfile.lock, **/Gemfile.lock,
**/composer.lock, **/go.sum, **/*.min.js, **/*.min.css, **/*.map, **/node_modules/**
```
(Build-output dirs like `dist/`/`build/` intentionally excluded from defaults — some projects legitimately review them; users add via the setting.)

`DEFAULT_PROTECTED` (seed for `claudegate.protected`):
```
**/.env, **/.env.*, **/*.pem, **/*.key, **/*.p12, **/*.pfx,
**/id_rsa, **/id_ed25519, **/.npmrc, **/credentials
```

Each seed is an object map of `"<glob>": true` (matching the existing `claudegate.exclude` shape).

## Components

### Modified: `package.json`

- `claudegate.exclude` — set its `default` to the `DEFAULT_EXCLUDES` object map (was `{}`). Update `markdownDescription` to explain these ship by default and can be removed/deactivated (`"<glob>": false`).
- Add `claudegate.protected` (type `object`, `additionalProperties: boolean`, `default` = `DEFAULT_PROTECTED` map). Description: files matching these globs are **flagged and sorted to the top** of the review (not hidden) so sensitive-file changes get scrutiny; edit/deactivate like `claudegate.exclude`.

### Modified: `src/excludeMatcher.ts`

No engine change needed for #4 — the merged config value (defaults + user) flows through the existing `reload(map, workspaceRoot)`. Export the two constants for reuse/tests:
```typescript
export const DEFAULT_EXCLUDES: string[];   // for reference/tests; the seed lives in package.json
export const DEFAULT_PROTECTED: string[];
```
(The seeds live in `package.json` as the source of truth; the exported arrays are for unit tests and any in-code reference. Keep them in sync — a test asserts package.json defaults match the constants.)

### Modified: `src/workspaceScope.ts`

Add a second matcher instance + accessor, mirroring the exclude one:
```typescript
export function setProtectedMatcher(m: ExcludeMatcher): void;
export function isProtected(filePath: string): boolean;   // delegates to the protected matcher; false until set
```

### Modified: `src/extension.ts`

- Construct `protectedMatcher = new ExcludeMatcher()`; a `loadProtected()` that reloads it from `getConfiguration("claudegate").get("protected")` + `workspacePath`; call it at activate and wire via `setProtectedMatcher`.
- Extend the existing `onDidChangeConfiguration` listener: on `claudegate.protected` change → `loadProtected()` + refresh the review providers (same as the exclude reload path). On `claudegate.exclude` change → existing `loadExclude()` already runs.

### Modified: `src/reviewPanel.ts`

- `FileReviewItem`: if `isProtected(filePath)`, set a warning `iconPath` (`ThemeIcon("warning")` with `charts.red`/`errorForeground` color), and prepend a protected line to the tooltip: *"⚠ Protected — sensitive file; review carefully."* (Non-protected rows unchanged.)
- **Sort protected first:** in the file sort (both `directChildren` and list-mode root), order protected files before others, then by path. Add an `isProtected`-aware comparator.

### Modified: `src/decorationProvider.ts`

For a **pending, protected** file, use a distinct decoration (warning color + a `⚠` badge) instead of the default pending badge, so the explorer also flags it. (Accepted/rejected unchanged.)

### Modified: `src/settingsPanel.ts`

- The Exclude Patterns section now lists the effective set (defaults + user) since `activePatterns()` reads the merged config — **collapse this section by default** (`TreeItemCollapsibleState.Collapsed`) so the ~15 rows aren't noisy.
- **Scope-aware Add/Remove** (so pane edits never bake the whole default set into `settings.json`): use `getConfiguration("claudegate").inspect("exclude")` to read the user's *own* value (workspace/global scope), and write back only user keys:
  - **Add** → set `"<glob>": true` in the user scope.
  - **Remove a *default* pattern** (present in `DEFAULT_EXCLUDES`) → set `"<glob>": false` in the user scope (deactivate; can't delete a registered default).
  - **Remove a *user* pattern** → delete the key from the user scope.

### Unchanged

`sessionManager`, `documentTracker`, `hook.py` — no changes.

## Error Handling

- Verify-merge step: if VS Code does **not** merge the object default with user values (contrary to expectation), fall back to merging `DEFAULT_EXCLUDES`/`DEFAULT_PROTECTED` with the user map inside `loadExclude`/`loadProtected` before `reload`. (The spec assumes merge works; this is the documented fallback.)
- A protected glob that fails to compile is skipped (existing `ExcludeMatcher` fail-open).
- Settings-pane `inspect()` returning `undefined` scope value → treat as `{}`.

## Testing

**Automated (`test:unit`):**
1. `DEFAULT_EXCLUDES`/`DEFAULT_PROTECTED` constants match the `package.json` seed values (guards drift).
2. `ExcludeMatcher` seeded with `DEFAULT_EXCLUDES` matches `pkg/package-lock.json`, `a/b.min.js`, `x.map`, `node_modules/foo/y.js`; does not match `src/main.ts`.
3. A user `false` entry for a default deactivates it (merged map with `"**/go.sum": false` → `go.sum` not excluded).
4. `protectedMatcher` seeded with `DEFAULT_PROTECTED` matches `.env`, `config/.env.local`, `keys/server.pem`; not `README.md`.

**Manual (Extension Development Host):**
5. Fresh workspace: a `package-lock.json` / `*.min.js` Claude edit does **not** appear in Pending (default excludes).
6. Add `"**/*.log": true` via the Settings pane → `.log` files hidden; `settings.json` contains only `{"**/*.log": true}` (defaults NOT baked in).
7. Remove a default (e.g. `go.sum`) via the pane → `settings.json` gets `{"**/go.sum": false}`; a `go.sum` edit now appears.
8. A `.env` Claude edit appears **flagged (warning icon/color, tooltip) and sorted to the top** of Pending; accept/reject still work.
9. `npm run typecheck && npm run compile` pass.

## Release

- **No version bump** — folds into unreleased `1.3.0`; extend the existing `## [1.3.0]` CHANGELOG **Added** entry: default exclude patterns (lock files/minified/maps/node_modules, shipped as editable defaults) + protected-files flagging (`claudegate.protected`, sorted to top).
- No hook change.
