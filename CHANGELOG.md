# Changelog

All notable changes to ClaudeGate are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.13.1] — 2026-08-13

### Fixed

- **The editor no longer stalls every time you switch back to the window.** Focusing the window triggered a filesystem scan for nested git worktrees, and that scan ran synchronously on the extension host — the single thread VS Code shares between every installed extension, so nothing else could run until it finished. On a real `go.work` monorepo the pass costs about 2,500 directory reads and 2,700 stat calls, measured at ~42 ms with a warm page cache and far worse with a cold one, which is why it was most painful on a machine already low on memory. The scan is now asynchronous and walks the tree in bounded batches: the same work now blocks the host for at most ~2 ms at a stretch instead of 42 ms in one block. Total scan time is unchanged — the point is that the editor stays responsive while it happens.
- **That scan no longer repeats on every alt-tab.** Window focus fires whenever you come back to the editor, from anywhere, and each one re-derived a worktree set that changes maybe a few times a day. It is now rate-limited on two levels — the focus sweep as a whole, and the scan itself on a longer interval — while activation and any refresh you explicitly ask for still bypass both, so nothing you request is ever delayed. A burst of triggers now shares one walk rather than starting several.
- **Accepting several files at once no longer raises `Data tree node not found` in the Accepted panel.** Every decision fired two session-change events — one from the write, one from the file-watch reload that write triggers — and each rebuilt all three sidebar trees. VS Code's tree resolves children asynchronously, so a refresh could still be reading rows that a later refresh had already thrown away, and it surfaced that as an error notification mid-review. Rapid changes are now collected and repainted once. Switching between list and tree view still repaints immediately, because a button press should never feel deferred.
- **Reloading a window no longer leaks a file watcher and a timer for every attached worktree.** VS Code closes the extension host's message channel *before* running an extension's cleanup, so writing a routine log line during shutdown threw `Channel has been closed`. That escaped the middle of the loop that detaches worktree sessions, so every worktree after the first never got shut down — one orphaned watcher and one live timer each, accumulating with every reload, on top of the error notification it showed. Logging can no longer throw, and each detach is isolated so one failure cannot abort the rest.
- **Git branch names and Go module paths are no longer captured as if they were files.** Shell-write capture harvests candidate paths out of a command, and its "anything containing a slash" rule was too loose: `git checkout origin/main` recorded `origin/main`, `git reset --hard origin/release-1.4` recorded `origin/release-1.4`, and a `go mod edit` recorded the Go module path it referenced. None of them exist, so each became a pending row that hung around until the settle window pruned it — and on a busy workspace that is not free, since every one costs a session write, a full re-read of a file that can run to megabytes, a reconcile, the prune, then a second write and re-read. Git arguments must now look like a pathspec rather than a branch (everything after an explicit `--` is still taken as written), and a speculatively-harvested path must either carry a file extension or already exist on disk. Explicitly named targets are untouched: `cat > Makefile` still captures `Makefile`.

### Internal

- Two small modules carry the rate limiting so it is testable and used consistently: `src/scheduling.ts` (a throttle for coarse triggers, and a collector that folds a burst of events into one run — deliberately not a debounce, so a continuous stream still runs at a steady cadence instead of being starved) and `src/safeLog.ts` (an output channel wrapper that cannot throw).
- `CLAUDE.md` gains an **Extension-Host Responsiveness** section recording why the worktree scan must stay asynchronous, which triggers are rate-limited and why, and the order to check things in when the editor feels slow. The measured syscall and stall figures are written down so a future change can tell whether it made things worse.
- Test coverage goes from 191 to 213 (156 unit assertions, 57 hook tests), including a check that the event loop keeps turning during a worktree scan and one that shutdown detaches every worktree even when logging is already dead.

### Notes

- **No need to re-run Setup Hook.** The hook script is synced automatically and running Claude sessions pick it up on their next tool call.

## [1.13.0] — 2026-08-11

### Added

- **Files that Claude rewrites through a shell command are now captured for review.** Claude does not only edit through its `Write`/`Edit`/`MultiEdit` tools — it also runs shell commands that rewrite files, which is routine for bulk edits, codemods, formatters and reverts. None of that was captured: the registered hook matched only the three edit tools, so a whole session's work could pass through unreviewed while the panel showed a clean "nothing pending" state — indistinguishable from "nothing happened". In one reported case a session spanning 3 repositories and 7 source files produced a single capture, and that one was incidental. No health check could catch it either, because nothing was broken: the hook was installed, registered, current, and simply never invoked. `Bash` is now part of the matcher, and the hook extracts the target paths from the command — redirection targets, the arguments of in-place tools (`sed -i`, `tee`, `cp`/`mv`, `patch`, `git apply`/`checkout --`/`restore`, `gofmt -w`, `prettier --write`, and others), and path-shaped string literals, which is what catches a `python3` heredoc that binds the path to a variable before writing it. Each target goes through exactly the same pipeline as a direct edit, so a shell-written file gets a real baseline and a normal accept/reject diff.
- **Commands that cannot write are rejected before any work happens.** The hook now runs on every shell command, so it first asks whether the command could write at all and exits immediately if not. `ls`, `go build` and `git status` cost a few microseconds and produce no log entry. Commands that write without naming a file (`make generate`, `prettier --write src/`) are deliberately left alone — they regenerate output Claude did not author, so flagging them would be noise.

### Fixed

- **A momentary read failure on `~/.claude/settings.json` could replace your entire Claude configuration with a hook-only stub.** Registration read the file inside a `try` whose `catch` set the contents to the empty string, which the patch logic then read as "no config yet" and answered with a fresh-install blob containing nothing but the ClaudeGate hook. `model`, `permissions`, `enabledPlugins`, `extraKnownMarketplaces`, `theme` and every other tool's hooks were overwritten — and the backup was skipped in exactly that case, because backing up was conditional on having read something. No user error was required: a passing `EACCES`, an `EMFILE` under a busy editor, or an `EBUSY`/`EPERM` on Windows while Claude Code wrote the file concurrently was enough. Only a genuine `ENOENT` is now treated as a first install; every other error aborts the write and leaves the file untouched. Verifying after the write cannot help here — with no baseline to compare against, a stub verifies as correct — so refusing to write is the only defence.
- **A second bad write can no longer destroy the only good backup.** The backup went to one fixed path and was overwritten every time. Backups are now timestamped and the five most recent are kept, and a write is abandoned rather than attempted if the backup itself fails.
- **A `settings.json` kept as a symlink into a dotfiles repository is no longer silently detached.** The atomic write renamed a temporary file over the path, which replaces the symlink with a regular file: the real config stayed in the repository while Claude Code began reading a copy that nothing was managing. The write now resolves the link first, so the dotfiles file is what gets updated. File permissions survive the write too, rather than being reset to a fresh default.
- **Writes are now verified and rolled back.** After writing, the file is re-read and checked — every top-level key that was there before must still be there, and the hook entry must have landed. Anything unexpected restores the backup immediately.
- **ClaudeGate no longer claims your Claude sessions have stopped tracking when they have not.** Changing `settings.json` produced a warning saying every running session had gone silent and had to be restarted. On current Claude Code that is false, and the warning was pure alarm: sessions notice the change and carry on. The message is now a factual note, and the status bar reads "hook config changed" rather than "restart Claude sessions".

### Changed

- **An out-of-date hook registration now repairs itself, with no Setup Hook click.** Deciding whether the registration was current compared only the wrapper path and never the matcher, so anyone whose path was already correct kept their old matcher permanently — through every activation and every hook sync. That made the change above impossible to deliver: widening the matcher in a release could never have reached an existing install. Both halves are now compared, and a stale registration is repaired at activation. The repair is bounded to one attempt, stops after any failure, and only ever repairs — with no ClaudeGate entry present it does nothing, because a first install stays a deliberate **Setup Hook** action rather than something done to a configuration you never opted into.

### Internal

- Corrected the rule recorded in `CLAUDE.md` in 1.12.2, which held that a `settings.json` change was "cold" — silently invalidating hooks in every running Claude session until it restarted. Measured against Claude Code 2.1.227, that is no longer so: every running session holds an inotify watch on the settings file, a hook added mid-session fires on the very next tool call (verified for both project and user-global settings, in sessions hours old), and existing hooks keep firing throughout. This is what makes the self-repair above safe, and the old rule is why the shell-capture gap went undiagnosed for as long as it did. The genuinely useful part of that section — check `~/.claudegate/hook.log` first when capture appears to have stopped — is kept.
- The session file format is unchanged. A shell-originated capture is an ordinary pending entry, so the review panel, diff viewer, accept/reject, revert/re-apply and worktree routing all work without modification.
- Path extraction is deliberately liberal, because a wrong guess is nearly free while a miss is the bug being fixed: a path that was not written has a baseline equal to what is on disk and is hidden then pruned by the existing settle-window logic, and a path that never appears is pruned as an absent new file. Extraction is pure string work with no subprocess, glob expansion or `git` call, and is bounded in both input size and target count so a pathological command cannot delay an edit.

### Notes

- **No need to re-run Setup Hook.** Both halves of this release reach an existing install on their own: the hook script is already synced automatically, and the widened matcher is repaired at the next activation.

## [1.12.2] — 2026-08-04

### Fixed

- **A capture hook that breaks mid-session is now noticed and repaired, instead of failing silently.** The extension keeps `~/.claudegate/hook.py` in sync with the bundled version, but it only ever did so at activation — so a hook deleted, downgraded, or replaced while the window stayed open went unnoticed until the next reload. Capture stopped while the status bar still reported everything as fine, which is the worst combination: no changes captured and no signal that anything is wrong. The hook is now re-checked and re-synced on window focus as well. It costs nothing when nothing has changed (two file hashes, then an early return — no subprocess, no writes), and a healthy setup shows and logs nothing.
- **The status bar no longer keeps warning about a hook it has already repaired.** Syncing the hook moves its health state, but that path never notified the status chip, unlike every other transition. The warning was therefore a snapshot from activation rather than the current truth. Today the sync happens to run before the first render so the stale warning was not visible in practice, but the bug was one `await` away from surfacing as "the extension stopped working" after an update, when in fact it had fixed itself.
- **A read-only home directory can no longer destabilise the extension.** Writing the hook reaches an unguarded `mkdir`, so an unwritable `~/.claudegate` throws out of the sync routine. Neither caller handled that, and the newly added focus check would have turned a single failure at activation into an unhandled rejection on *every* window focus for the whole session. Both call sites now log and continue — an unwritable hook is already reported through the health chip and must not take anything else down with it.

### Internal

- Documented in `CLAUDE.md` the mechanism that makes silent self-repair safe: `~/.claude/settings.json` invokes a stable wrapper that re-executes `hook.py` on every tool call, so **hook script changes are hot** (a running Claude session picks them up on its next edit) while **`settings.json` changes are cold** (they invalidate every running session until it restarts). Conflating the two is what makes a hook problem look like a broken extension. Also records that `~/.claudegate/hook.log` is the fastest way to tell a genuine capture failure apart from records landing where the panel is not looking.

## [1.12.1] — 2026-07-31

### Fixed

- **Accepting or rejecting a file inside a git worktree no longer makes it disappear with no trace.** The decision was recorded correctly — into that worktree's own session — but the parent window surfaced it nowhere: the **Accepted** and **Rejected** views are gated on counts that only ever looked at the primary session, so the view stayed hidden; and even when shown, the panels only ever read the primary session, so they would have rendered empty. In a workspace where every change lives in a worktree (a `go.work` layout, or any window opened above several checked-out modules), the file simply vanished from **Pending** and appeared in neither log. Both counts and panel contents now aggregate across attached worktrees, and worktree records render under their own worktree group — mirroring how **Pending** has grouped them since 1.10.1. Records already written by an earlier version are picked up automatically; nothing was lost, only hidden.
- **Reverting an accepted file, or re-applying a rejected one, now targets the session that actually owns it.** Both commands were hard-wired to the primary session manager, so once a worktree's records became visible the actions would have written the change back into the wrong session. They now resolve the owning worktree from the file path.

### Internal

- The extension bundle no longer ships the README screenshots or demo media. Both registries render the README by fetching its images from GitHub over HTTPS — the packaged copies were never read — so excluding them cuts the published VSIX from **1.41 MB to 81 KB**. `media/icon.png` and `media/icon-activity.png` still ship; `package.json` points at them.
- `SessionManager` gains `getAcceptedCount()` / `getRejectedCount()` alongside the existing `getPendingCount()`, and `WorktreeSessionRegistry` gains the matching `totalAccepted()` / `totalRejected()` — the asymmetry between them was the root cause of the bug above.

## [1.12.0] — 2026-07-29

### Fixed

- **Pending changes in a large multi-module workspace no longer go missing from the panel.** The window attached at most **10** nested git worktrees, and it picked which 10 by sorting the discovered roots alphabetically and slicing — so in a workspace with more than ten, every worktree late in the alphabet was silently skipped and its captured edits appeared in **no** window at all. This bites `go.work` / multi-module layouts hardest, because they check out *one worktree per module*: a single feature directory is 5–10 worktrees on its own, so two of them plus a few agent worktrees clears eighteen and the second feature directory vanishes wholesale. The cap is now **256** (see below), well above any realistic layout. This is the same class of gap as the 1.10.1 discovery fix — there the worktrees were never found; here they were found and then dropped.

### Added

- **New `claudegate.worktrees.maxAttached` setting** (default `256`) caps how many nested worktrees a window will attach. Lower it only to deliberately narrow the review scope — there's no resource reason to. Any worktrees past the limit are now **listed by full path** in the *Claude Gate* output channel instead of only being counted, so a cap hit is diagnosable rather than invisible.

### Changed

- **Worktrees that hold captured work are attached first.** If the cap is ever reached, the slots that get dropped are now guaranteed to be idle worktrees rather than ones sitting on unreviewed changes. Previously the ordering was purely alphabetical, so throwaway agent worktrees under `.claude/worktrees/` could take slots away from worktrees with real pending edits. The check is existence-only on the worktree's session file — deliberately cheap, since parsing every session on each refresh would cost more than the attach it protects.

### Internal

- The old cap of 10 was documented as being "well past any realistic count"; measurement showed the assumption behind it was wrong. Attaching a worktree costs one `fs.watch` on the sessions directory that *every* manager already shares, plus a JSON parse of that worktree's own file when it changes — there is no polling loop, no per-worktree filesystem crawl, and no `git` subprocess. Capping the result of the scan saved nothing, since the directory walk runs regardless. The constant is now documented as a runaway-scan backstop with the real costs written down.
- `SessionManager`'s inline workspace-hash logic is extracted into an exported `sessionFilePathFor()`, so a caller can locate a worktree's session file without constructing a manager (which would install a watcher). One source of truth with `hook.py` for the MD5 path scheme.

## [1.11.1] — 2026-07-23

### Internal

- **Documentation and test fixtures now use generic example names.** The CHANGELOG examples, worktree test fixtures, and a repro note previously referenced company-internal module/workspace names (and one personal filesystem path); these are replaced with neutral placeholders (`ws-alpha`, `ws-beta`, `service-*`). No code or behavior change — this only affects docs and tests.

## [1.11.0] — 2026-07-23

### Added

- **Accept or reject a whole git worktree in one click.** Worktree group rows in the **Pending** panel now carry inline **Accept ✓** and **Reject ✗** actions, next to the existing **Open Worktree in New Window** button — the same one-click bulk review folder rows already had. Accepting takes every pending file in that worktree's session at once; rejecting prompts for confirmation and restores each file's original content. Both operate on the worktree's own review session, so the decision syncs to the worktree's own window too.

### Changed

- **Worktree changes now nest under the folder they live in, instead of floating at the top of the panel.** In a `go.work` / multi-module layout where worktrees are checked out under per-feature directories (e.g. `ws-alpha/service-core`, `ws-alpha/service-worker`), the Pending tree used to append every worktree as a bare top-level row labelled by its base name only — disconnected from the `ws-*` folder it belonged to, and ambiguous when two worktrees shared a name (`shared-proto` under two different parents). Worktree groups are now placed inside the tree at the folder they physically sit under; intermediate folders (like a `ws-*` directory whose only change is a checked-out worktree) are created even when no primary-session file lives directly under them. Ordering within a folder is subfolders, then worktree groups, then files.
- **A worktree group's own files now honour the View as Tree / View as List toggle.** The files inside a worktree group used to render as a flat, path-labelled list regardless of the panel's view mode. In tree view they now group into folders rooted at the worktree — matching the primary panel — while list view keeps the flat layout. Folder rows inside a worktree resolve back to that worktree's session, so accept/reject/open still target the correct one.

## [1.10.3] — 2026-07-20

### Fixed

- **Clicking a file in a review panel right after accepting another one no longer throws "Actual command not found, wanted to execute claudegate.openDiff".** Accepting a file removes its row and refreshes the tree; if you clicked the next file while that refresh was still in flight (a fast reviewer, not a slow one), VS Code dispatched the row's open command against a stale internal tree node and mangled the command id into `claudegate.openDiff/<node-handle>` — an id that isn't registered, so it errored and the diff didn't open until you clicked again. This is a known VS Code tree-view timing bug ([microsoft/vscode#173233](https://github.com/microsoft/vscode/issues/173233)); the reliable fix is to stop routing the open through a `TreeItem.command` at all. All three panels — Pending, Accepted, Rejected — now open their diff from the tree's **selection** event, calling the open handler directly with the live row, so there is no command-dispatch step left to mangle. Two minor consequences of opening on selection: navigating the list with the arrow keys now opens each highlighted row's diff (as clicking does), and re-selecting the row that's already selected won't reopen a diff you closed — move to another row and back.

## [1.10.2] — 2026-07-17

### Fixed

- **Files Claude edits under `.claude/` (commit trackers, skill files, pipeline state) no longer flash into the Pending panel and vanish before you can review them.** The capture hook records a file's baseline *before* the write lands, but the write can arrive several seconds later (measured up to ~6 s under a busy hook chain or a slow editor save). The reconcile pass — which cleans up settled no-op captures and temp files Claude created-then-deleted — ran on a 1.5-second grace, so it kept classifying a legitimate pending entry as "unchanged" (existing file) or "vanished" (new file) and pruning it *before its content ever reached disk*; the next tool call then re-captured it, producing an endless flash-and-disappear. The reconcile now waits long enough for the write to land — 15 s for an existing file that still looks unchanged, 45 s for a promised new file not yet on disk — so a slow write is no longer mistaken for a no-op. Cleanup of genuine no-ops and temp files still happens, just slightly later; the panel already hides no-ops, so nothing spurious is shown in the meantime.
- **A file reverted back to its baseline no longer lingers in the Pending panel as an un-openable "phantom" row.** When a captured file is set back to exactly its baseline outside the hook's view — a `git reset`, an editor undo — the extension couldn't notice (it reconciles only on a session-file change and runs no workspace file-watcher), so the now-empty entry stayed in the panel and opened a blank diff. Opening such a row now **removes it** (rather than just reporting "no changes to review"), and **refocusing the window runs a reconcile** that prunes settled no-op rows in the main session and every attached worktree session — so a stale entry clears on its own instead of sitting there until the next capture.
- **The "settings.json changed — sessions stopped tracking" warning no longer fires on unrelated edits.** Claude Code rewrites `~/.claude/settings.json` constantly for reasons that have nothing to do with hooks — switching your model, changing the theme, toggling plugins — and *every* such rewrite tripped the trust-invalidation warning, because the check keyed off any byte-change to a file that always contains the string `claudegate` (the hook's own command path). It now compares only the **hooks** block, so the warning fires when your hook configuration actually changes mid-session (which genuinely does silence capture) and stays quiet for the model/theme/plugin edits that don't. A companion fix stops a benign non-hook edit from clearing a still-active invalidation.

### Changed

- **Orphaned session files are now cleaned up automatically.** On activation, ClaudeGate removes per-workspace session files whose referenced files *all* live in directories that no longer exist on disk — deleted projects, removed git worktrees, leftover fixtures. The rule is deliberately conservative: a session is kept if even one of its files still has a living directory (so live and partially-live workspaces are never touched), and the sweep is fail-soft — an unreadable file is skipped, not deleted. This reclaims space that previously accumulated forever under `~/.claudegate/sessions/`.
- **The large-session self-heal triggers earlier and can no longer over-trim.** The threshold that warns about and trims a bloated session dropped from 5 MB to 2 MB, so the panel self-heals before it starts to feel slow. Trimming still only ever touches the accepted-history log — pending entries, which are your unreviewed baselines, are never dropped automatically — and the trimmer now always keeps at least the newest accepted record, so a single large-file accept can't wipe your entire History. When the bloat lives in pending or rejected entries instead, the warning now points you to review those changes rather than unhelpfully suggesting you clear accepted history.

## [1.10.1] — 2026-07-14

### Fixed

- **Claude's edits inside a nested sub-repo worktree now show up in the Pending panel.** In a `go.work`-style layout where a module is checked out as a git *worktree* into a sub-folder of the workspace you opened (e.g. `ws-alpha/service-geo`, a worktree of the nested `service-geo` repo — not of the workspace's own repo), the capture hook correctly recorded the change into that worktree's own review session, but the sidebar never surfaced it: worktree discovery only looked at the *top-level* repo's `.git/worktrees`, so worktrees owned by nested sub-repos were invisible and their pending edits appeared in no window at all. Discovery now scans the workspace tree for worktree working directories the same way the hook detects them, so those changes appear as a worktree group in the parent window — matching what already worked for the workspace repo's own worktrees.

## [1.10.0] — 2026-07-13

### Added

- **Open any pending folder in a new window — right-click it.** Folder rows in the **Pending** panel (tree view) now have an **Open in New Window** action that opens that folder as its own editor window. This is aimed at multi-repo / `go.work` layouts, where the directory you actually want to review (e.g. a `ws-…` folder holding several service worktrees) isn't a git worktree of the workspace you opened, so it never got the existing **Open Worktree in New Window** button. Now you can jump straight into it and review it there as its own session. The action is right-click only (no hover icon) and, like folder rows themselves, appears in tree view.

## [1.9.0] — 2026-07-12

### Added

- **Edit Claude's change before you accept it.** The right-hand side of a review diff has always been the live file, but Accept captured the version on disk — so if you tweaked a line in the diff and hadn't saved, your edit was silently dropped. Now every Accept (single file, **Accept Folder**, or **Accept All**) flushes any unsaved edits in those diffs to disk first, so the version you see is exactly the version that gets kept and logged. Reject is unchanged — it still discards the change, edits and all.
- **Step through pending files from the keyboard.** Two new commands — **Next Pending File** (`Alt+]`) and **Previous Pending File** (`Alt+[`) — move between pending diffs *without* deciding, so you can skip ahead and come back. They stop at the ends with a hint instead of wrapping, and they're gated to pending diffs — and use `Alt+[`/`Alt+]` rather than `Cmd/Ctrl+[`/`]` on purpose, so they don't clobber the diff's own indent/outdent now that the right pane is editable. The diff title also shows where you are in the queue — **`· N of M pending`** — and the count shrinks as you accept or reject.

## [1.8.0] — 2026-07-12

### Added

- **A Session History panel — your cleared reviews are no longer gone for good.** *Clear Session* already archived the session to `~/.claudegate/history/`; now there's a dedicated **History** panel in the Claude Gate sidebar that shows those archives, each grouped by session and rendered as a **folder tree** of the files you accepted and rejected. It's **view-only** — click any record to open its diff — with **Clear History** (all) and per-session **delete** controls. The panel is workspace-scoped, so you only see the history for the project you're in, and it stays hidden until you have at least one archived session.
- **Turn history off entirely.** A new **`claudegate.history.enabled`** setting (default on) — mirrored as a toggle row in the Settings panel — stops *Clear Session* from writing archives, for anyone who'd rather keep nothing on disk.
- **A persistent hook-health indicator in the status bar.** When capture is broken — hook not installed, not registered in `settings.json`, out of date, or its trust invalidated by a mid-session settings edit — a `⚠ Claude Gate` chip now appears and *stays* until the problem is fixed, instead of a single dismissable toast you might miss. Clicking it jumps to Setup Hook or Verify Setup as appropriate; it clears the moment the hook is healthy again.
- **An opt-in Hook Log for diagnosing "why wasn't this captured?".** A new **`claudegate.hookLog.enabled`** setting (default off, with a Settings row and **Toggle Hook Log** command) makes the capture hook append its per-edit decisions — `captured`, `skip-binary`, `skip-no-root`, `skip-unreadable`, `skip-already-pending`, `error` — to `~/.claudegate/hook.log`. **Open Hook Log** opens the file. It's a local, bounded (self-truncating ~1 MB) rolling debug aid — no network, no telemetry — and the hook stays fail-open even if logging itself fails.

### Changed

- **Verify Setup now shows a per-check breakdown.** Instead of a flat "all passed" / issue list, it reports each probe on its own line — `✓ hook.py installed`, `✗ registered — not in settings.json`, and so on — with a **Setup Hook** action when anything fails and an **Open Hook Log** action when the log is enabled.

### Fixed

- **A cosmetic re-save of `~/.claude/settings.json` no longer drops the hook-health warning.** A byte-identical rewrite (e.g. a formatter bumping the file's mtime) used to look like a settings change and could clear an active trust-invalidation signal while running sessions were still untrusted. The watcher now ignores a no-op rewrite and keeps the warning up until the hook is genuinely healthy again.

### Notes

- **Re-run `Claude Gate: Setup Hook` after updating.** This release changes `hooks/hook.py` (opt-in diagnostic logging); the updated hook is only picked up when you re-run Setup Hook.

---

## [1.7.0] — 2026-07-11

### Added

- **"Copy Feedback to AI" — export your review decisions in one click.** A new command (and 💬 button on the Pending panel title bar) copies a paste-ready summary of everything you kept, everything you rejected (with the reasons you attached), and what's still pending — across the main workspace and any nested git worktrees. Paste it back to Claude so your agent knows exactly what to keep and what to redo differently.
- **A "Get Started" walkthrough.** New installs get a proper three-step walkthrough (Setup Hook → Verify → Review) in VS Code's Welcome area instead of a chain of one-shot notification toasts.
- **The Settings panel now covers more of the extension.** Three new rows: an **Auto-advance** toggle (whether the next pending diff opens automatically after a keyboard accept/reject), a **Protected Files** row showing your sensitive-file globs with one-click access to edit them, and a persistent **Verify Setup** health check (previously reachable only from a transient toast).
- **A one-time tip in Review All Pending.** The multi-file diff's per-file actions are focus-based — click into a file's pane, then use the ✓/✗ title-bar buttons or `Ctrl/Cmd+Enter` / `Ctrl/Cmd+Backspace` — and nothing on screen said so. The first time you open the view, a notice now explains it.

### Fixed

- **Windows: accept/reject buttons can no longer vanish on a drive-letter case mismatch.** File paths coming from the editor (e.g. `c:\…`) can differ in case from the session's stored key (`C:\…`); lookups along the active-editor and diff paths are now case-tolerant on Windows, so the diff always shows its original side and the title-bar ✓/✗ always appear for a pending file.
- **Clear Session can no longer destroy your review history if its backup fails.** Clearing first archives the session to `~/.claudegate/history/`; if that copy cannot be written, the clear now aborts with an explanation instead of deleting the only copy.
- **"Reject" is called Reject everywhere.** The reject flow's prompts used to say "Revert", colliding with the Accepted panel's separate "Revert to Pending" (un-accept) action. One name per action now.

### Changed

- **The experimental all-in-one "Review Changes" panel is gone — the native multi-file diff is the answer.** We built a full webview-based review panel this cycle (Preact + a dedicated diff renderer) and retired it after evaluation: VS Code's native multi-diff already gives 100% editor fidelity — real syntax highlighting, word-level diffs, go-to-definition — that no webview can match, and per-file decisions work in it today via the focus-based actions above. Nothing webview-based ships in this release, and the README no longer describes features that don't exist (the "CodeLens" wording now correctly says title-bar buttons).

### Internal

- Dead `.vsixignore` file removed from the package (vsce reads `.vscodeignore`); dependency tree back to a single runtime dependency (`diff`).

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
