# Changelog

All notable changes to ClaudeGate are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
