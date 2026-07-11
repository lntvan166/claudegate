# Changelog

All notable changes to ClaudeGate are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.6.1] — 2026-07-11

### Changed

- **"Review All Pending" is back to VS Code's native multi-file diff editor.** The 1.6.0 "Review Changes" webview reimplemented the diff view in HTML and had layout bugs — long lines overflowing the pane, misaligned columns, aggressive folding that hid real changes, and no syntax highlighting. This release reverts the feature to VS Code's built-in multi-diff editor (real syntax highlighting, correct scrolling and alignment), reached from the **Review All Pending** icon on the Pending panel. It still rebuilds live as you accept/reject and closes once nothing's left, and it now also includes pending files from **nested git worktrees** — each diffed against its own baseline — which the native view previously omitted. The webview code stays in the repo for future work but is no longer wired into the UI; the webview-only `claudegate.review.diffMode` setting has been removed.
- **A very large review history now self-heals instead of only warning.** When the per-workspace session file crosses the size threshold, the oldest accepted records are now trimmed automatically by byte budget (recent history is always kept) rather than relying on you to clear the list by hand.
- **Bulk history actions now confirm and report.** *Clear All Accepted*, *Clear All Rejected*, *Clear Session*, *Revert All*, and *Re-apply All* now ask for confirmation and show a summary notice (and *Accept All* confirms what it did), so a mis-click on a title-bar icon can't silently wipe history.

### Fixed

- **Setup Hook can no longer wipe your `~/.claude/settings.json`.** If that file failed to parse — a JSONC comment, a trailing comma, a stray hand-edit — the old logic reset it to `{}` and overwrote it, destroying your model config, permissions, other hooks, and MCP entries with no backup. It now refuses to write on a parse error (leaving the file untouched and telling you to fix the JSON), writes a `.bak` before its first change, writes atomically, repairs a stale or mis-pathed claudegate entry in place, and rewrites only when the registration actually changes — never for cosmetic formatting differences, which used to silently invalidate hook trust in running sessions.
- **Review decisions are no longer lost when a nested worktree and its parent window are open at once.** Both windows own the same session file; the previous merge treated each window's accepted/rejected log as authoritative and could overwrite the other's decisions. The merge now reconciles the decision log from disk (union by record id, latest reject per path) and drops a pending entry the other window has already decided — so no accept/reject record is clobbered.
- **Binary / non-UTF-8 files are no longer corrupted.** Reading file content decoded invalid bytes to `U+FFFD` and could write that mojibake back on reject. Content is now decoded strictly as UTF-8 and treated as unreadable (skipped) when it isn't valid — matching the hook — so a binary file is never mangled.
- **A corrupt session file no longer silently empties the panels.** A parse failure used to be swallowed, nulling the session with no signal. It is now logged and surfaced once, the last-known state is kept (a normally absent or cleared file is still handled quietly), and the next decision rewrites the file atomically.
- **The review hook can't crash a Claude edit.** `hooks/hook.py` now wraps its whole body in a fail-open guard, so an unwritable `~/.claudegate`, a full disk, or a malformed `workspace-roots.json` degrades to "no capture" instead of printing a Python traceback on every Write/Edit.

### Notes

- **Re-run `Claude Gate: Setup Hook` after updating.** This release changes `hooks/hook.py` (fail-open guard); the updated hook is only picked up when you re-run Setup Hook.

---

## [1.6.0] — 2026-07-10

### Added

- **A new "Review Changes" panel that shows every pending file in one scrollable surface.** Run **Claude Gate: Review Changes** to open a single editor tab that renders all pending changes stacked, each with its own **Keep / Undo** buttons, a **split ↔ unified** diff toggle (your choice is remembered), and an **Open in native diff** shortcut for close inspection. It updates live as you decide files — no reopening, and none of the flicker of the old multi-diff. It also keeps a copyable **Feedback to AI** log of your keep/undo decisions (and any undo reasons) that you can paste back to your agent yourself — ClaudeGate never calls a model; the log is just formatted text.
- **A git worktree nested inside your workspace now gets its own review scope, shown in the parent window.** Previously, whether an edit inside a nested worktree (e.g. `repo/ws-feature`) landed in the parent's review or the worktree's own depended on which editor windows happened to be open — the same change could scatter across two sessions. Now Claude's edits to a worktree are always captured to that worktree's own session (detected purely from git's on-disk layout, no `git` binary), and the parent window's **Pending** panel shows them under a labeled `… (worktree)` group with full accept/reject/diff actions plus an **Open Worktree in New Window** button. Accept or reject from either window and the decision applies in both, because it's one shared record.
- **You can attach an optional reason when you reject a change.** Rejecting now offers an inline prompt for a short "why" (across the sidebar, keyboard, and the Review Changes panel), and the reason is shown with the record in the **Rejected** list and included in the Feedback to AI log — so you can tell your agent what to do differently. Leaving it blank behaves exactly as before.

### Notes

- **Re-run `Claude Gate: Setup Hook` after updating.** This release changes `hooks/hook.py` (nested-worktree routing); the updated hook is only picked up when you re-run Setup Hook.

---

## [1.5.0] — 2026-07-09

### Fixed

- **The extension's changelog now shows up on the Marketplace and Open VSX.** `CHANGELOG.md` was listed in `.vscodeignore`, so it was stripped from the packaged `.vsix` and both registries rendered an empty "Changes" tab. It now ships with the extension, so the version history is visible where you install from. (Applies from this release forward — already-published versions can't be back-filled.)

### Changed

- **Reloading the review panels is cheaper and flickers less.** Every time the session file changed on disk, the extension re-serialized the entire session twice just to check whether a migration had altered it — work that scaled with the size of your accepted/rejected history and ran on every filesystem event. It now gets that answer directly from the migration step, and no longer rewrites the session file for cosmetic (key-order) differences — removing a class of spurious rewrites that each triggered another panel reload.
- **The Accepted history is now bounded (most recent 500).** The accepted log grew without limit, and every entry stores the file's full before/after content, so a long-lived workspace could accumulate a multi-megabyte session file that was re-read on every reload. The log now keeps the 500 most recent records, dropping the oldest first; recent entries — the ones you'd actually revert — are always retained.

### Added

- **A warning when a workspace's review history gets very large.** If the per-workspace session file exceeds 5 MB (usually a big accepted/rejected backlog, or stray oversized captures), ClaudeGate logs it to its Output channel on each load and shows a one-time notice suggesting you clear the Accepted or Rejected list to shrink it. The file still loads normally — your pending changes are never withheld — and the popup fires at most once per session so it never spams.

---

## [1.4.1] — 2026-07-07

### Fixed

- **The review panels no longer reload nonstop when a no-op change is pending.** If a captured file ended up identical to its baseline (e.g. Claude edited it and the edit was undone by hand), the extension could get stuck rewriting its session file several times a second — flickering the Pending/Accepted/Rejected panels and the explorer badges without end. The cause was an interaction between two safeguards: the reconcile pass pruned the settled no-op entry, but the dual-writer merge that guards against concurrent hook writes then re-read the (not-yet-rewritten) session file and *resurrected* the entry it had just pruned — so the prune never stuck and every cycle wrote the file again. The merge now skips re-adding an entry the same persist cycle just deliberately pruned (matched by capture timestamp, so a genuinely fresh re-capture still merges and no hook write is lost). Both the no-op reconcile and the out-of-workspace prune share the guard.

---

## [1.4.0] — 2026-07-06

### Fixed

- **Re-running Setup Hook no longer silently kills tracking in running Claude sessions.** Claude Code snapshots its hook configuration at session start and stops trusting hooks whose config changes underneath it — so ClaudeGate's habit of rewriting `~/.claude/settings.json` on *every* Setup Hook run quietly disabled capture for every Claude Code session that was already open, all at once. (The nastiest form: noticing capture had gone quiet and clicking **Setup Hook** to fix it re-triggered the exact rewrite that broke it.) The registration write is now idempotent — it only touches `settings.json` when the hook entry actually differs from what's on disk — so re-running Setup Hook on an already-configured machine leaves the file untouched and running sessions keep tracking. The "restart your running sessions" notice now appears only when a real write happened.

### Added

- **A heads-up when a settings change silently stops capture.** ClaudeGate now watches `~/.claude/settings.json` and, if it changes while the hook is still registered, warns once that any already-running Claude Code sessions have stopped tracking edits and should be restarted (or `/hooks` re-run). It flags the *cause* (the settings file changed) rather than guessing from missing captures, turning a previously invisible failure into an actionable prompt.

---

## [1.3.3] — 2026-07-06

### Fixed

- **Captured changes could silently vanish from the Pending panel.** When Claude created or edited a file and you then accepted or rejected an *unrelated* file, the just-captured change could disappear without ever being reviewed. The dual-writer reconcile (`mergeFreshCaptures`) used a wall-clock heuristic to decide whether a change was "already handled"; an unrelated action could advance that clock past a genuine, unseen capture and drop it. It now keys on the actual accept/reject **decision record** instead of a timestamp, so an unseen capture is never mistaken for a handled one.
- **The extension no longer relies on file mtime to detect concurrent hook writes.** It now always reconciles with the on-disk session before writing, so a coarse-granularity filesystem (which can stamp two writes with the same mtime) can no longer cause a capture to be clobbered.
- **The hook can no longer overwrite your accept/reject history.** The hook and the extension now coordinate through a fail-open advisory lock around each read-modify-write, so a capture landing at the same moment as an accept/reject can’t erase the decision log. The hook never blocks a Claude edit — if the lock is contended it proceeds anyway, and the extension’s always-reconcile backstops it.
- **A Claude-created file reopened via Revert/Re-apply is again deleted on reject.** The `newFile` marker was lost when a change was reopened, so rejecting a reopened new file left it on disk instead of removing it. The marker is now carried through the accepted/rejected record.
- **Windows: in-repo pending changes could be wrongly pruned.** Workspace-containment checks are now case-insensitive on Windows, so a drive-letter/path-case mismatch no longer makes a real pending file look "out of workspace" and get dropped.

### Notes

- This release changes `hooks/hook.py` (the coordination lock). Re-run **Claude Gate: Setup Hook** (or let the activate auto-sync deploy it) to pick up the new hook.

---

## [1.3.2] — 2026-07-06

### Fixed

- **Setup Hook now warns to restart in-progress Claude sessions.** Claude Code loads its hooks once at startup, so a session that was already running when you install the hook will never be tracked until it restarts — its edits silently bypass capture and never reach the Pending panel. The post-setup message now says so explicitly. (Script *updates* still take effect immediately in running sessions — only the initial hook registration requires a restart.)

---

## [1.3.1] — 2026-07-05

### Fixed

- **Rejecting an unreadable file could delete it.** The hook recorded a file it couldn't read (a permissions error, or a non-text/binary file) as a new (null-baseline) file, so rejecting it deleted the real file. On the hook path such files are now skipped instead of captured, so a `null` baseline means "the file did not exist" and reject can't delete a real file. (Watcher-captured files are covered separately — see the reject-safety fix below.)
- **Working-file restores are now atomic.** Rejecting (restore to baseline) and re-applying write your files via a temp-file + rename, so an interrupted write can no longer leave a half-written file.
- **Concurrent writes no longer drop changes.** The hook and the extension both write the session file; the extension now re-reads and merges any changes the hook made since it loaded (guarded by a cheap modification-time check), so a hook capture or an accept/reject decision isn't lost during a race.
- **The file watcher can no longer delete a real file on reject.** A file the watcher captured as "new" without a prior snapshot (e.g. an atomic save over an existing file) is no longer deleted when rejected — only files confidently known to be new (created via Claude's hook) are removed; uncertain ones are left on disk with a note.
- **No more blank diffs.** Clicking a pending file that has no real change (a transient no-op) now shows a short note instead of an empty diff.
- **Review All Pending stays in sync.** Accepting or rejecting a file now refreshes the open multi-file diff to the remaining pending files (and closes it once none remain), instead of leaving a stale view with the resolved file still shown.

### Internal

- Added a GitHub Actions CI workflow (typecheck, compile, unit + hook tests) and a dependency-free integration-test harness for `SessionManager`.

### Notes

- Re-run **Claude Gate: Setup Hook** (or let activate auto-sync run) to deploy the updated `hook.py`.

---

## [1.3.0] — 2026-07-05

### Changed

- **File watcher is now off by default.** The `PreToolUse` hook captures **all** Claude Code edits — terminal **and** in-editor (confirmed: the in-editor extension runs the same hook) — so the filesystem watcher, which can't attribute edits and surfaced manual/formatter/git noise, is no longer needed for Claude Code. Enable `claudegate.fileWatcher.enabled` only for non-Claude agents (Cursor Composer, Codex).

### Added

- **`Claude Gate: Enable File Watcher`** command, plus a one-time first-run notice and an empty-panel link, so non-Claude-agent users can turn the watcher on easily.
- **Default exclude patterns** — lock files, minified assets, source maps, and `node_modules` are filtered from review out of the box (shipped as editable defaults in `claudegate.exclude`; deactivate any with `"<glob>": false`).
- **Protected files** — `claudegate.protected` flags sensitive files (`.env`, keys, credentials) with a warning and sorts them to the top of review (never hidden), so their changes get extra scrutiny.
- **Review All Pending** — a Pending-panel action (and `Claude Gate: Review All Pending` command) opens every pending change in VS Code's multi-file diff editor for one-pass review of multi-file refactors; clicking it again reuses and focuses the existing view instead of stacking a new tab.

### Fixed

- **Accepted and Rejected panels now show meaningful, persistent diffs.** The Accepted panel is a persistent per-accept log — each approval is recorded with its own diff (baseline → accepted content), so re-editing an already-accepted file no longer erases history: the new change appears in Pending while the Accepted log keeps every prior approval. The Rejected panel keeps the latest discarded change per file (baseline → discarded version). Clicking any Accepted/Rejected row opens exactly that change's diff (previously both opened an empty diff). Pending now shows only files with a real change, so no-op or failed edits no longer leave empty Pending rows or wipe an accepted decision. The Pending review flow is otherwise unchanged.

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
