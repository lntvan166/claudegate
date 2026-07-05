# Changelog

All notable changes to ClaudeGate are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] — 2026-07-05

### Changed

- **File watcher is now off by default.** The `PreToolUse` hook captures **all** Claude Code edits — terminal **and** in-editor (confirmed: the in-editor extension runs the same hook) — so the filesystem watcher, which can't attribute edits and surfaced manual/formatter/git noise, is no longer needed for Claude Code. Enable `claudegate.fileWatcher.enabled` only for non-Claude agents (Cursor Composer, Codex).

### Added

- **`Claude Gate: Enable File Watcher`** command, plus a one-time first-run notice and an empty-panel link, so non-Claude-agent users can turn the watcher on easily.
- **Default exclude patterns** — lock files, minified assets, source maps, and `node_modules` are filtered from review out of the box (shipped as editable defaults in `claudegate.exclude`; deactivate any with `"<glob>": false`).
- **Protected files** — `claudegate.protected` flags sensitive files (`.env`, keys, credentials) with a warning and sorts them to the top of review (never hidden), so their changes get extra scrutiny.
- **Review All Pending** — a Pending-panel action (and `Claude Gate: Review All Pending` command) opens every pending change in VS Code's multi-file diff editor for one-pass review of multi-file refactors; clicking it again reuses and focuses the existing view instead of stacking a new tab.

---

## [1.2.0] — 2026-07-04

### Added

- **`claudegate.fileWatcher.enabled` setting** (default `true`) — turn off the GUI file watcher so terminal-CLI users rely only on the more-accurate `PreToolUse` hook. Applies live (no reload).
- **`claudegate.exclude` setting** — `search.exclude`-style glob map to hide files (e.g. generated `**/*.pb.go`) from the review panel, counts, badges, and the watcher. Non-destructive and applies live.
- **Settings pane** in the Claude Gate sidebar — toggle the file watcher, view/add/remove exclude patterns, and see hook status / run Setup Hook, all in one place.
- **Keyboard review** — `Cmd+Enter` accept / `Cmd+Backspace` reject the focused diff, with auto-advance to the next pending file (`claudegate.autoAdvance`, default on).
- **Change counts** — the diff tab title and pending-row tooltip show `+A -B` line counts.
- **Row file actions** — right-click a file in the panel for Open File, Open to the Side, Reveal in Explorer, Copy Path / Relative Path, and Add to Claude Chat (when the Claude Context extension is installed).
- **Group by session** — an optional `claudegate.groupBySession` setting (and Settings-pane toggle) groups the review panels by the Claude Code session that made each change, for when several sessions run in one workspace. The hook now records each change's `session_id`; files captured before this update or by the GUI watcher show under "Unknown session". Re-run **Setup Hook** to start recording session ids.

### Changed
- **Accept now checkpoints the baseline.** Approving a file makes its current content the new diff baseline, so the next Claude edit is compared against the approved version instead of the original.

### Fixed
- `closeDiffEditor` matched the wrong tab-title prefix, so open diff tabs were never closed on accept/reject; the diff tab now closes correctly.
- The review baseline is now frozen while a file is pending — a diff can no longer silently drop the original and show only the latest edit-to-edit change.
- `git pull` / `merge` / `checkout` no longer create phantom "pending" entries: changes made while a git operation is detected are ignored regardless of file count.

### Notes
- Re-run **Setup Hook** (or let activate auto-sync run) to deploy the updated `hook.py`.

---

## [1.1.12] — 2026-06-03

### Added

- **Hook auto-sync on activate** — when installed `~/.claudegate/hook.py` differs from the extension bundle (SHA-256), the extension copies the new script and refreshes the wrapper, then shows a one-time notification per bundled version with optional **Verify Setup**. Registering the hook in `~/.claude/settings.json` still requires **Setup Hook** if not yet registered; a separate warning is shown when the script exists but settings lack the claudegate entry.

---

## [1.1.11] — 2026-06-03

### Fixed

- **Pending badge/status-bar count could exceed the Pending tree** — when the session contained paths outside the workspace (e.g. `~/.claude/...` memory files filed via hook `cwd` fallback), counts and bulk actions included them but the tree did not. Counts, `acceptAll` / `rejectAll`, and `getPendingCount` now use the same workspace filter as the tree; stale out-of-workspace entries are pruned on session load.
- **Hook captured files with no matching VS Code workspace root** — `workspace_root_for_file` no longer falls back to Claude's `cwd`; those edits are skipped. Re-run **Setup Hook** after upgrading to deploy the updated `hook.py`.

---

## [1.1.10] — 2026-06-01

### Fixed

- **Temp files Claude created then deleted stayed in the panel** — the hook fires only on `Write`/`Edit`/`MultiEdit`, so a temp file Claude created (recorded as a pending "new file") and later removed was never cleaned up on the terminal path, and the GUI delete handler only fires when a live window is watching that workspace. The session now reconciles on load: a pending new-file entry whose path no longer exists is pruned. A short grace delay protects genuinely new files, which the hook records just before the write lands.

---

## [1.1.9] — 2026-06-01

### Fixed

- **Hook crash on macOS system Python 3.9** — `hook.py` used `dict | None` type annotations (Python 3.10+). On macOS, `python3` is often 3.9.x, so the hook crashed at import time and never captured `originalContent`. Added `from __future__ import annotations` for 3.9 compatibility. Setup verification now smoke-tests `hook.py` with the detected Python executable.
- **Existing files shown as "new file" in monorepos / multiple windows** — the hook keyed session files off Claude's terminal `cwd` (often a subproject), while the VS Code extension keyed off the workspace root, so the hook captured `originalContent` into a different session file than the sidebar reads. The extension now writes `~/.claudegate/workspace-roots.json`; the hook resolves the workspace folder that contains the target file and backfills pending entries with missing originals. The roots file is now **merged across every open window** (instead of each window overwriting it) and the hook matches the **most specific** root, so files edited in one project no longer get routed to another window's session.
- **Setup verification no longer pollutes the sessions directory** — the `hook.py` smoke-test now runs against a throwaway temp directory and removes the session file it creates.

---

## [1.1.8] — 2026-06-01

### Fixed

- **Claude GUI edits not captured (v1.1.7 regression)** — v1.1.7 required a recent in-editor text change before tracking, but the Claude Code GUI often writes directly to disk without firing `onDidChangeTextDocument`. Single-file edits (e.g. one `.tsx` file) were silently ignored. Tracking no longer depends on editor change events.
- **Bulk external detection retuned** — git pull, checkout, and codegen are still filtered out, now by batch size (8+ files in one debounced window, or 2+ brand-new files with no prior snapshot) instead of the unreliable editor-activity signal. Small Claude GUI edits (1–few files with a cached snapshot) are captured again.

---

## [1.1.7] — 2026-06-01

### Fixed

- **False captures from git and codegen** — `DocumentTracker` treated every file system change in the workspace as a Claude edit. Operations like `git checkout`, `git pull` (or any bulk codegen) could flood the review panel with unrelated files. Changes are now tracked only when they follow a recent in-editor edit; bulk external writes refresh snapshots instead of entering the session. Modifications to files that were never opened in the editor are skipped, matching the original GUI detection design.

---

## [1.1.6] — 2026-06-01

### Changed

- **Extension renamed to "Claude Gate"** — display name, activity bar title, command palette category, all user-facing notifications, diff editor titles, and README updated. Internal command IDs (`claudegate.*`) and TypeScript class names are unchanged.

---

## [1.1.5] — 2026-06-01

### Fixed

- **Duplicate folder name in review panel** — when Claude created a new directory, VS Code's file system watcher (`**/*`) fired an `onDidCreate` event for the directory path itself. `DocumentTracker` had no guard against directories, so the folder path was added to the session as a phantom file entry. In tree view this rendered as both a collapsible `FolderItem` (correct) and an unclickable leaf with the same name (wrong). Directory paths are now skipped before entering the session.

---

## [1.1.4] — 2026-05-31

### Fixed

- **Spurious `.git` temp files in review panel** — VS Code's git extension creates temporary files like `package.json.git` on disk during diff/comparison operations and then deletes them. These were being captured as pending review items and stuck there permanently. Files ending in `.git`, `.orig`, `.tmp`, or `~` are now filtered out before entering the session.
- **Deleted pending files lingering in review panel** — if a pending file is deleted from disk while in the session (e.g. a temp file VS Code removed), it is now automatically removed from the review panel via an `onDidDelete` watcher handler.

---

## [1.1.3] — 2026-05-31

### Added

- **Clear All buttons** — "Clear All Accepted" (`$(clear-all)`) and "Clear All Rejected" (`$(clear-all)`) toolbar buttons on their respective sidebar panels. Removes entries from the review view without touching files on disk — useful for cleaning up after a review is complete.

---

## [1.1.2] — 2026-05-31

### Fixed

- **Accepted files re-appearing as pending** — after accepting a file in ClaudeGate, git operations (e.g. `git add`) or VS Code reloading the file would trigger the file system watcher and mistakenly re-queue the file back to pending. Accepted and rejected files are now skipped entirely by the document tracker.
- **Confusing "A" badge in file explorer** — accepted files showed an `A` badge in the VS Code file explorer, clashing visually with git's own `A` (Added) status indicator. Only pending files now show a badge (`!`); accepted and rejected files are undecorated.

---

## [1.1.1] — 2026-05-31

### Fixed

- **GUI mode lag** — the file system watcher no longer fires on `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `vendor/`, `__pycache__/`, and other generated directories. Previously, Claude installing npm packages would trigger thousands of spurious change events and freeze the extension.

---

## [1.1.0] — 2026-05-31

### Added

- **Claude Code VS Code/Cursor GUI extension support** — ClaudeGate now captures file changes made by the Claude Code GUI extension (not just the terminal CLI). A new `DocumentTracker` snapshots files as they are opened in the editor and detects changes via a file system watcher. Both detection paths feed the same review panel with no configuration required.
  - Works best in "pure sessions" where Claude makes changes and you review before editing further.
  - Coexists cleanly with the hook path — whichever fires first for a given file owns it; the other skips it.
  - Re-edits of previously accepted or rejected files are correctly re-queued for review.

### Fixed

- **Packaging** — development-only files (`.superpowers/`, `.claude/`, `.qodo/`, `docs/`) were incorrectly bundled in previous releases. The correct ignore file (`.vscodeignore`) is now used; the published package is ~95% smaller.

### Changed

- **Extension icon** — updated to a torii gate icon.

---

## [1.0.1] — 2026-05-31

### Changed

- **README** — added a note clarifying that the Claude Code VS Code/Cursor GUI extension is not yet supported (terminal CLI only). Superseded by v1.1.0.

---

## [1.0.0] — 2026-05-30

First public release. ClaudeGate gives you the same accept/reject review workflow for Claude Code (terminal) that Cursor provides for its own AI agent.

### Review workflow

- **Automatic file snapshots** — a `PreToolUse` hook fires before every `Write`, `Edit`, and `MultiEdit` call. The original file content is captured once per file per session; subsequent Claude writes to the same file never overwrite that snapshot.
- **Native diff editor** — click any pending file to open VS Code's built-in diff view: original on the left, Claude's version on the right.
- **Accept** keeps Claude's change and marks the file reviewed. **Reject** writes the original content back to disk; files that didn't exist before Claude are deleted on reject.
- **Accept/Reject buttons** appear in the editor title bar whenever a pending file is open, and as inline actions on each file row in the sidebar.
- **Undo decisions** — re-apply Claude's changes from the Rejected panel; move Accepted files back to Pending.

### Sidebar panels

- **Three independent panels** — Pending, Accepted, and Rejected — each with its own collapse and view-mode toggle.
- **Tree and List view** — switch between a flat file list and a folder tree per panel.
- **Folder-level actions** — Accept or Reject an entire directory at once in tree view.
- **Pending count badge** on the sidebar panel header.
- **Workspace-aware filtering** — files modified outside the current workspace (e.g. `~/.claude/settings.json`) are hidden.

### Status bar

- **`$(shield) N` badge** on the left status bar shows the pending file count and highlights orange when files are waiting for review. Clicking it opens the review panel.

### Session management

- **Per-workspace session files** — each project gets its own `~/.claudegate/sessions/<hash>.json`. Two VS Code windows with two Claude sessions running simultaneously stay fully isolated with no shared state.
- **Session history** — completed sessions are automatically archived to `~/.claudegate/history/`.
- **Clear Session** — archive and reset the current session at any time.

### Setup

- **One-command setup** — `ClaudeGate: Setup Hook` installs the hook script and patches `~/.claude/settings.json` automatically.
- **Verify Setup** — confirms the hook script and settings registration are in place.
- **Windows native support** — generates a `hook.bat` wrapper on Windows; detects `python` or `python3` automatically. WSL is not required.
