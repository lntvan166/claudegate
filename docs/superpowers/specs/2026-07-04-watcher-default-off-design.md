# File Watcher Off by Default (Hook Covers All Claude Code)

**Date:** 2026-07-04
**Status:** Approved for implementation
**Related:** `package.json`, `src/extension.ts`, `src/hookInstaller.ts`, `README.md`, `CLAUDE.md`

## Background / Spike Result

We empirically confirmed (spike, 2026-07-04) that the **Claude Code in-editor extension fires the `PreToolUse` hook**, exactly like the terminal CLI: a GUI-panel edit was captured by the hook with the correct pre-edit `originalContent` and a distinct `sessionId` (`261c4c8e-…`, different from the terminal session). The hook fires *before* the write, so it already **wins over** the filesystem watcher for Claude edits.

**Implication:** the `PreToolUse` hook is authoritative and attributed for **all** Claude Code usage — terminal *and* in-editor. The GUI `DocumentTracker` filesystem watcher is therefore **redundant for Claude Code**, and its only remaining value is capturing **non-Claude** agents (Cursor Composer, Codex) — which it does noisily, since it cannot attribute edits (manual/formatter/git all look the same to it).

(The originally-researched `PostToolUse` approach was dropped: PostToolUse `tool_output` carries only `{success, message}`, not file content, and PreToolUse already provides before-content + attribution.)

## Problem

The watcher defaults **on**, so Claude-Code users get its false positives (manual edits, formatters, git operations) even though the hook already captures their Claude edits accurately.

## Goal

Default the watcher **off** — the hook fully covers Claude Code — while making the watcher **discoverable** so users of non-Claude agents (or anyone who sees nothing captured) can turn it on easily.

## Non-Goals

- Not removing `DocumentTracker` — it remains the only path for non-Claude agents (kept, just off by default).
- Not adding a `PostToolUse` hook (no added value; carries no content).
- No change to the hook capture logic itself.

## Product Decisions

- **`claudegate.fileWatcher.enabled` default flips `true` → `false`.** Per VS Code semantics, only users who never set it explicitly are affected; anyone who set `true` keeps it.
- **First-run notice is gated on the hook being registered** (so Claude is actually covered). If the hook is *not* registered, the existing "Setup Hook not registered" warning takes priority and the watcher notice is suppressed — we don't stack two notifications.
- **Enabling is idempotent** — a single `claudegate.enableFileWatcher` command sets the setting `true` (never toggles), used by both the notice button and the empty-state welcome link.
- **Version 1.3.0** (behavior change to a default + guidance; 1.2.0 is already released).

## Components

### Modified: `package.json`

- `contributes.configuration` — `claudegate.fileWatcher.enabled` `default`: `true` → `false`. Revise `markdownDescription` to:
  > "Claude Code edits (terminal **and** in-editor) are captured by the `PreToolUse` hook, so this is off by default. Enable this filesystem watcher only if you use a **non-Claude** agent (e.g. Cursor Composer, Codex) that doesn't run Claude's hooks — it cannot attribute edits and may surface manual edits, formatter/codegen output, and git operations as false review items."
- `contributes.commands` — add `{ "command": "claudegate.enableFileWatcher", "title": "Claude Gate: Enable File Watcher" }`.
- `contributes.viewsWelcome` — extend the existing `claudegate.pendingPanel` welcome content to add the fallback hint + action link:
  > `No changes captured yet.\n\nFor Claude Code, make sure the hook is set up.\n[Setup Hook](command:claudegate.setupHook)\n\nUsing a non-Claude agent (Cursor Composer, Codex), or still nothing showing?\n[Enable file watcher](command:claudegate.enableFileWatcher)`

### Modified: `src/extension.ts`

- Register `claudegate.enableFileWatcher` → `updateClaudegateConfig("fileWatcher.enabled", true)` (idempotent; reuses the existing Workspace-scope helper). The existing `onDidChangeConfiguration` listener already starts the tracker live when the flag flips to true.
- **First-run notice:** on activate, once ever (guarded by a `context.globalState` key, e.g. `claudegate.watcherDefaultNoticeShown`), **and only when `hookInstaller.getStatus()` reports `registered === true`**, show an info message:
  > "Claude Gate now captures Claude Code edits (terminal & in-editor) via the hook — the file watcher is off by default. Enable it only for non-Claude agents (Cursor Composer, Codex)."
  - Actions: **Enable file watcher** → run `claudegate.enableFileWatcher`; **Got it** → dismiss.
  - Set the `globalState` flag regardless of which action (show once). Sequence it after `hookInstaller.syncHookIfNeeded()`/`warnIfHookNotRegisteredInSettings()` so the not-registered warning wins when applicable.

### Modified: `src/hookInstaller.ts`

- No change required if `getStatus()` (added earlier) already returns `registered`. Reuse it for the notice gate. (Confirm it exists; it does.)

### Modified: docs

- **README** — correct "How It Works" to state the hook captures **all Claude Code (terminal + in-editor)**; the watcher is a fallback for non-Claude agents. Add a short **"Not seeing changes?"** troubleshooting note: (1) run Setup Hook for Claude Code; (2) enable `claudegate.fileWatcher.enabled` for non-Claude agents. Update the `claudegate.fileWatcher.enabled` settings-table row default to `false` with the revised description.
- **CLAUDE.md** — update the architecture section: the `PreToolUse` hook is authoritative for both terminal and in-editor Claude Code (spike-confirmed); `DocumentTracker` is a non-Claude-agent fallback, off by default.

### Unchanged

`DocumentTracker` logic, `SessionManager`, `reviewPanel`, the hook script — no behavior changes; the watcher simply isn't started unless enabled.

## Error Handling

- First-run notice failures (e.g., `getStatus()` throws) are caught; the notice is skipped rather than blocking activation, and the `globalState` flag is still set to avoid retry loops. (`getStatus()` already fails safe.)
- `enableFileWatcher` write failure surfaces via the existing `updateClaudegateConfig` error path.

## Testing

**Automated:** `npm run typecheck` and `npm run compile` pass; `npm run test:unit` unaffected.

**Manual (Extension Development Host):**
1. Fresh profile, hook registered → on activate the one-time notice appears; **Got it** dismisses it and it never returns; the watcher is off (Output shows "file watcher disabled").
2. Click **Enable file watcher** (notice or empty-state link) → `.vscode/settings.json` gains `claudegate.fileWatcher.enabled: true`; the watcher starts live.
3. Hook **not** registered → the watcher notice is suppressed; only the Setup-Hook warning shows.
4. Terminal *and* in-editor Claude edits are still captured with the watcher off (hook path). A non-Claude agent edit is captured only after enabling the watcher.
5. Empty Pending panel shows the updated welcome with both action links.

## Release

- **1.3.0** (minor — default behavior change + guidance). Update `package.json` version and add a CHANGELOG `## [1.3.0]` entry: **Changed** (watcher off by default; hook now confirmed to cover in-editor Claude too) + **Added** (`enableFileWatcher` command, first-run guidance, empty-state fallback link).
- No hook-script change → no Setup Hook re-run required.
