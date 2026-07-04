# File Watcher Off by Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default the GUI file watcher off (the PreToolUse hook covers all Claude Code — terminal & in-editor, spike-confirmed), and make the watcher discoverable for non-Claude agents.

**Architecture:** Flip the `claudegate.fileWatcher.enabled` default to `false`; add an idempotent `claudegate.enableFileWatcher` command wired to a one-time first-run notice and the empty-panel welcome link; correct the docs. `DocumentTracker` is unchanged (just not started unless enabled).

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc). No new dependencies. Typecheck/compile + manual verification (no TS test runner for `vscode`-coupled code).

## Global Constraints

- **No new dependencies.**
- **Default flip only affects users who never set the setting** (VS Code config semantics) — anyone who set `true` keeps it.
- **First-run notice is gated on `hookInstaller.getStatus().registered === true`** — if the hook isn't registered, suppress it (the existing "not registered" warning wins); do NOT set the shown-flag until it actually shows.
- **`enableFileWatcher` is idempotent** — always sets `true`, never toggles.
- **`DocumentTracker` kept** — off by default; the only path for non-Claude agents.
- **No hook-script change** → no Setup Hook re-run required.
- **Version 1.3.0**; CHANGELOG date `2026-07-05`.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass after every task.

---

## File Structure

- `package.json` — MODIFY: `fileWatcher.enabled` default→false + description; add `enableFileWatcher` command; update `viewsWelcome`; version bump (Task 2).
- `src/extension.ts` — MODIFY: register `enableFileWatcher`; one-time first-run notice.
- `README.md`, `CLAUDE.md`, `CHANGELOG.md` — MODIFY: docs (Task 2).

---

## Task 1: Watcher off by default + enable command + first-run notice

**Files:**
- Modify: `package.json` (`fileWatcher.enabled` default+description; add `enableFileWatcher` command; `viewsWelcome`)
- Modify: `src/extension.ts` (register `enableFileWatcher`; first-run notice)

**Interfaces:**
- Consumes: existing `updateClaudegateConfig(key, value)` helper, `hookInstaller.getStatus()` (returns `{ scriptInstalled, registered, upToDate }`), `context.globalState`.
- Produces: command `claudegate.enableFileWatcher`; a one-time notice.

- [ ] **Step 1: Flip the default + revise the description in `package.json`**

In `contributes.configuration.properties`, replace the `claudegate.fileWatcher.enabled` entry with:

```json
"claudegate.fileWatcher.enabled": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "Claude Code edits (terminal **and** in-editor) are captured by the `PreToolUse` hook, so this is off by default. Enable this filesystem watcher only if you use a **non-Claude** agent (e.g. Cursor Composer, Codex) that doesn't run Claude's hooks — it cannot attribute edits and may surface manual edits, formatter/codegen output, and git operations as false review items."
}
```

- [ ] **Step 2: Declare the `enableFileWatcher` command in `package.json`**

Add to `contributes.commands`:

```json
{ "command": "claudegate.enableFileWatcher", "title": "Claude Gate: Enable File Watcher" }
```

- [ ] **Step 3: Update the empty-state welcome in `package.json`**

Replace the `contributes.viewsWelcome` entry's `contents` for `claudegate.pendingPanel` with:

```json
"contents": "No changes captured yet.\n\nFor Claude Code, make sure the hook is set up.\n[Setup Hook](command:claudegate.setupHook)\n\nUsing a non-Claude agent (Cursor Composer, Codex), or still nothing showing?\n[Enable file watcher](command:claudegate.enableFileWatcher)"
```

- [ ] **Step 4: Register the `enableFileWatcher` command in `src/extension.ts`**

Inside the existing `context.subscriptions.push( ... )` command block, add:

```typescript
      vscode.commands.registerCommand("claudegate.enableFileWatcher", async () => {
        await updateClaudegateConfig("fileWatcher.enabled", true);
      }),
```

(The existing `onDidChangeConfiguration` listener already starts the tracker live when the flag flips to `true`.)

- [ ] **Step 5: Add the one-time first-run notice in `src/extension.ts`**

Immediately after the existing one-time migration-notice block (the `claudegate.shownMigrationNotice` block near the end of `activate`, before `refreshActiveFilePendingContext(sessionManager);`), add:

```typescript
    // One-time notice: the file watcher is now off by default because the hook
    // covers all Claude Code (terminal + in-editor). Only surface it once the
    // hook is registered — otherwise the "not registered" warning takes priority.
    const watcherNoticeKey = "claudegate.watcherDefaultNoticeShown";
    if (!context.globalState.get(watcherNoticeKey)) {
      let hookRegistered = false;
      try {
        hookRegistered = hookInstaller.getStatus().registered;
      } catch {
        hookRegistered = false;
      }
      if (hookRegistered) {
        void context.globalState.update(watcherNoticeKey, true);
        void vscode.window
          .showInformationMessage(
            "Claude Gate captures Claude Code edits (terminal & in-editor) via the hook — the file watcher is off by default. Enable it only for non-Claude agents (Cursor Composer, Codex).",
            "Enable file watcher"
          )
          .then((choice) => {
            if (choice === "Enable file watcher") {
              void vscode.commands.executeCommand("claudegate.enableFileWatcher");
            }
          });
      }
    }
```

- [ ] **Step 6: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0. Also confirm `node -e "require('./package.json')"` parses.

- [ ] **Step 7: Manual verification (Extension Development Host)**

1. With no explicit setting, the watcher does **not** start (Output: "File watcher disabled…"); terminal and in-editor Claude edits are still captured (hook path).
2. First activate with the hook registered → the one-time notice appears; dismissing it (X) → it never returns on later activates; **Enable file watcher** → `.vscode/settings.json` gains `claudegate.fileWatcher.enabled: true` and the watcher starts live.
3. Hook NOT registered → the watcher notice does not appear (and the flag stays unset so it can show later once registered).
4. Empty Pending panel shows both `[Setup Hook]` and `[Enable file watcher]` links; the latter enables the watcher.

- [ ] **Step 8: Commit**

```bash
git add package.json src/extension.ts
git commit -m "feat: default file watcher off (hook covers all Claude Code) + enable command/notice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Docs, CHANGELOG & version bump

**Files:**
- Modify: `package.json` (`version`)
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the behavior from Task 1.
- Produces: nothing consumed by code.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.2.0"` to `"version": "1.3.0"`.

- [ ] **Step 2: Update the README settings row + How-It-Works + troubleshooting**

In `README.md`:

(a) In the "Extension Settings" table, replace the `claudegate.fileWatcher.enabled` row with:

```markdown
| `claudegate.fileWatcher.enabled` | `false` | Claude Code edits (terminal **and** in-editor) are captured by the `PreToolUse` hook, so this is **off by default**. Enable it only if you use a **non-Claude** agent (Cursor Composer, Codex) — the watcher can't attribute edits and may surface manual/formatter/git changes as false items. |
```

(b) In the "How It Works" section, replace the note that follows the ASCII diagram (the line beginning "The hook captures a file's original content…") by prepending this sentence to it:

```markdown
The `PreToolUse` hook is the authoritative capture path for **all Claude Code — both the terminal CLI and the in-editor extension** (both run the same hook). The filesystem watcher is an optional fallback for **non-Claude** agents (Cursor Composer, Codex) and is off by default.
```

(c) Add a new subsection just after "The Review Flow" (or near the settings section):

```markdown
### Not seeing changes captured?

1. **Using Claude Code** (terminal or in-editor)? Make sure the hook is installed — run **`Claude Gate: Setup Hook`**. That covers all Claude Code edits.
2. **Using a non-Claude agent** (Cursor Composer, Codex) or still nothing showing? Enable the filesystem watcher: set `claudegate.fileWatcher.enabled` to `true` (or click **Enable file watcher** in the empty panel / the Settings pane).
```

- [ ] **Step 3: Correct the architecture note in `CLAUDE.md`**

In `CLAUDE.md`, in the "Two detection paths" / architecture description, update the wording so it reads (adjust to match the surrounding prose):

```markdown
- **PreToolUse hook (authoritative for all Claude Code).** The `~/.claude/settings.json` `PreToolUse` hook fires before every Claude write — for **both** the terminal CLI **and** the in-editor Claude Code extension (confirmed: both run the same hook, so a GUI edit is captured with correct original content and the in-editor session's `session_id`). This is the primary, attributed capture path.
- **DocumentTracker (non-Claude fallback, off by default).** The filesystem watcher exists only to capture **non-Claude** agents (Cursor Composer, Codex) that don't run Claude's hooks; it cannot attribute edits, so it is disabled unless `claudegate.fileWatcher.enabled` is set.
```

- [ ] **Step 4: Add the CHANGELOG 1.3.0 entry**

In `CHANGELOG.md`, add a new section above `## [1.2.0]` (match the file's `## [version] — YYYY-MM-DD` heading style + `---` separators):

```markdown
## [1.3.0] — 2026-07-05

### Changed

- **File watcher is now off by default.** The `PreToolUse` hook captures **all** Claude Code edits — terminal **and** in-editor (confirmed: the in-editor extension runs the same hook) — so the filesystem watcher, which can't attribute edits and surfaced manual/formatter/git noise, is no longer needed for Claude Code. Enable `claudegate.fileWatcher.enabled` only for non-Claude agents (Cursor Composer, Codex).

### Added

- **`Claude Gate: Enable File Watcher`** command, plus a one-time first-run notice and an empty-panel link, so non-Claude-agent users can turn the watcher on easily.

---
```

- [ ] **Step 5: Verify build**

Run: `npm run typecheck && npm run compile && node -e "require('./package.json').version"`
Expected: typecheck/compile exit 0; prints `1.3.0`.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md CLAUDE.md CHANGELOG.md
git commit -m "docs: watcher off by default (hook covers GUI); release 1.3.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** default flip + description → Task 1 Step 1; `enableFileWatcher` command → Task 1 Steps 2/4; welcome link → Task 1 Step 3; first-run notice gated on `getStatus().registered`, flag set only when shown → Task 1 Step 5; docs correction (hook covers GUI) → Task 2 Steps 2–3; keep DocumentTracker → unchanged (no code touches it); version 1.3.0 + CHANGELOG → Task 2 Steps 1/4.
- **Placeholder scan:** none — all code/text steps are concrete.
- **Type consistency:** command id `claudegate.enableFileWatcher` identical across package.json (command + welcome link) and `registerCommand`; `updateClaudegateConfig` and `hookInstaller.getStatus()` are existing symbols used as-is; `globalState` key `claudegate.watcherDefaultNoticeShown` is new and self-contained.
