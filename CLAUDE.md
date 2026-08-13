# CLAUDE.md — ClaudeGate Developer Guide

## What This Project Does

ClaudeGate is a VS Code/Cursor extension that captures file changes made by Claude Code and presents them in a structured review panel. The user can accept or reject each change using VS Code's native diff editor.

Two detection paths are supported:
- **PreToolUse hook (authoritative for all Claude Code).** The `~/.claude/settings.json` `PreToolUse` hook fires before every Claude write — for **both** the terminal CLI **and** the in-editor Claude Code extension (confirmed: both run the same hook, so a GUI edit is captured with correct original content and the in-editor session's `session_id`). This is the primary, attributed capture path. The registered matcher is `PRE_TOOL_MATCHER` in `src/hookInstaller.ts` — `^(Write|Edit|MultiEdit|Bash)$`. `Bash` is in it because Claude also rewrites files through the shell (`sed -i`, `cat > f <<EOF`, a `python3` heredoc); `hook.py` extracts the target paths from `tool_input.command` and runs them through the same capture pipeline.
- **DocumentTracker (non-Claude fallback, off by default).** The filesystem watcher exists only to capture **non-Claude** agents (Cursor Composer, Codex) that don't run Claude's hooks; it cannot attribute edits, so it is disabled unless `claudegate.fileWatcher.enabled` is set.

---

## Architecture

```
Claude Code (terminal CLI)   Claude Code (in-editor ext)      Non-Claude agents
         │                            │                       (Cursor, Codex)
         └──────── PreToolUse hook ───┘                             │
              hook.py snapshots the original            DocumentTracker (opt-in,
                          │                              off by default) FS watch
                          │                                         │
                          └──────────────────┬──────────────────────┘
                                             ▼
                          ~/.claudegate/sessions/<workspace>.json
                                             │
                                    Claude Gate review panels
```

---

## Key Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, status bar |
| `src/sessionManager.ts` | Read/write session JSON, file watcher, accept/reject/clear logic |
| `src/documentTracker.ts` | GUI extension support — snapshots docs, detects FS changes |
| `src/reviewPanel.ts` | `vscode.TreeDataProvider` for the three sidebar panels |
| `src/diffProvider.ts` | `TextDocumentContentProvider` for `claudegate:` URIs; `openDiff` helper |
| `src/decorationProvider.ts` | File explorer badge (`!`) for pending files |
| `src/hookInstaller.ts` | Installs `hook.py` + `hook.sh`, patches `~/.claude/settings.json` |
| `hooks/hook.py` | Python hook script — copied to `~/.claudegate/hook.py` at setup |

---

## Session State Schema

Per-workspace session file at `~/.claudegate/sessions/<md5(workspacePath)>.json`:

```json
{
  "sessionId": "2026-05-31T10:00:00.000000+00:00",
  "status": "active | reviewed",
  "files": {
    "/absolute/path/to/file.ts": {
      "originalContent": "string | null",
      "reviewStatus": "pending",
      "sessionId": "string",
      "capturedAt": "ISO 8601 timestamp"
    }
  },
  "accepted": [
    {
      "id": "<decidedAt>::<path>",
      "path": "/absolute/path/to/file.ts",
      "before": "string | null",
      "after": "string | null",
      "decidedAt": "ISO 8601 timestamp",
      "sessionId": "string"
    }
  ],
  "rejected": {
    "/absolute/path/to/file.ts": {
      "id": "<decidedAt>::<path>",
      "path": "/absolute/path/to/file.ts",
      "before": "string | null",
      "after": "string | null",
      "decidedAt": "ISO 8601 timestamp",
      "sessionId": "string"
    }
  }
}
```

**Files (pending-only):**
- `files` contains only entries with `reviewStatus: "pending"` — unreviewed changes awaiting user decision.
- `originalContent: null` — Claude created this file (didn't exist before). Rejecting deletes the file.
- `originalContent` is the frozen "before" baseline. It is **not** advanced on accept; the next edit (via `hook.py`) re-snapshots the current on-disk content, so re-editing an accepted file appends a new pending entry with the new baseline.
- The entry is removed from `files` when it is accepted (appended to `accepted[]`) or rejected (stored in `rejected{}`).

**Accepted (persistent log):**
- `accepted` is an append-only array of every file the user has approved, with the before/after diffs that were accepted.
- Reversible: `revertAccepted(id)` removes the entry from `accepted[]` and re-adds it to `files` as pending (the frozen `before` becomes the new baseline).

**Rejected (latest per file):**
- `rejected` is a map of `path → ReviewRecord`, storing only the latest rejected change per file.
- Reapplicable: `reapplyRejected(path)` copies the `rejected[path]` entry back to `files` as pending with its frozen `before` baseline.

**Session lifecycle:**
- `status: active` — session has pending files.
- `status: reviewed` — set automatically when `files` is empty.
- The workspace hash is `MD5(path.resolve(workspacePath))` (lowercased on Windows). Both `hook.py` and `SessionManager` use the same algorithm so they always agree on the filename.

---

## Claude Code Hook Input Schema

`hook.py` receives this JSON on stdin for each `PreToolUse` event:

```json
{
  "session_id": "string",
  "transcript_path": "/path/to/transcript",
  "cwd": "/absolute/working/directory",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write | Edit | MultiEdit | Bash",
  "tool_input": {
    "file_path": "relative or absolute path to target file (Write/Edit/MultiEdit)",
    "command": "the shell command string (Bash)"
  }
}
```

**Hook behavior:**
- A `Bash` payload carries `command` instead of `file_path`. The hook first asks whether the command can plausibly write at all (redirection, `sed -i`, `tee`, `cp`/`mv`, `patch`, `git apply|checkout --|restore`, in-place formatters, …) and exits immediately if not — no filesystem work, no log spam for `ls` or `go build`. Otherwise it harvests candidate target paths from the command and runs **each one through the same pipeline** as a `file_path`. Harvesting leans liberal — a missed path is an uncaptured edit — but **not unboundedly so**, because a bogus capture is not free: it costs a session-file write, a full reload (multi-MB on a busy workspace), a reconcile, the prune, and a second write + reload. Two guards keep the false-positive rate down, both of which apply *only* to speculative candidates and never to an explicit redirection or in-place-tool target (`cat > Makefile` still captures `Makefile`):
  - **Speculative candidates must plausibly name a file** (`_names_a_file`): an extension on the basename, or an existing file on disk. This is what stops a Go module path (`github.com/acme/schema-lib`) becoming a pending entry. `paths_from_command(command, cwd)` takes the tool call's `cwd` for the existence probe; without it, extensionless speculative candidates are dropped rather than resolved against the *process* cwd, which is not the session's directory.
  - **`git` arguments must be pathspecs, not treeish** (`_pathspec_shaped`): with no explicit `--`, `git checkout origin/main` / `git reset --hard origin/release-1.4` name refs. Everything after a `--` is still taken verbatim as a path.
- `file_path` may be relative to `cwd`. The hook resolves it to an absolute path before storing.
- If the file is **already pending**, the hook leaves it untouched (preserves the frozen baseline).
- Otherwise (no entry yet, or — for legacy/pre-migration sessions — a non-pending entry) the hook creates a fresh pending entry with the current on-disk `originalContent`. The hook only ever writes `files`; the extension owns `accepted`/`rejected`, and accept/reject remove the entry from `files`, so on a current-model session a re-edit simply finds no entry and creates a new pending one.

---

## DocumentTracker (GUI path)

`src/documentTracker.ts` provides GUI extension support without hooks:

1. On `start()`: snapshots all currently open documents (`vscode.workspace.textDocuments`).
2. On `onDidOpenTextDocument`: snapshots newly opened documents — this is the "before Claude edits" capture point.
3. On `FileSystemWatcher` `onDidChange` / `onDidCreate`: if the changed file has a snapshot and is not already in the session, calls `sessionManager.trackFileChange(filePath, originalContent)`.

**Ignored paths**: `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `__pycache__`, and other generated directories are skipped to avoid thousands of spurious events when Claude installs dependencies.

**Coexistence with hook**: whichever path fires first for a file owns it. The other path skips any file already present in the session.

---

## Development Setup

```bash
# Install dependencies
npm install

# Compile TypeScript (with source maps)
npm run compile

# Watch mode (auto-recompile on save)
npm run watch

# Type-check without emitting
npm run typecheck
```

Press **F5** in VS Code to launch the Extension Development Host.

To test the hook manually:

```bash
echo '{"tool_name":"Write","cwd":"/tmp","tool_input":{"file_path":"test.txt"}}' \
  | python3 hooks/hook.py
ls ~/.claudegate/sessions/
```

### Testing

- `npm test` runs `test:unit` (TS) + `test:hook` (Python `unittest` in `hooks/tests/`).
- Unit tests are plain `assert` + `console.log("ok - …")`, bundled per-file by esbuild and run with node. **Each new `src/*.test.ts` must be appended to the `test:unit` script in `package.json`** or it won't run.
- Tests that import VS Code-dependent modules bundle with `--alias:vscode=./src/test-stubs/vscode.ts`; isolate `~/.claudegate` via `process.env.HOME = fs.mkdtempSync(...)`.

## Subagent / Background-Task Git Safety

Subagents run in the **same working directory** (no worktree isolation by default), so a stray `git checkout`/`reset` — or a race — can land a commit as a **dangling commit on the wrong base**, leaving the branch HEAD unmoved with a clean tree (work recoverable only via `git cherry-pick <sha>`).

- When dispatching a subagent that commits: instruct it to run ONLY `git add <files>` + `git commit` on the current branch, NEVER `checkout/switch/reset/rebase/stash/branch`, and to confirm `git branch --show-current` before committing.
- After each subagent returns, verify HEAD actually advanced on the expected branch (`git log --oneline -1`, clean status, files present) before trusting the work. If not, find the dangling commit (`git log --oneline <sha>`) and `cherry-pick` it.
- Prefer worktree isolation for parallel or file-mutating agents.

---

## Publishing to the Marketplace

**Do NOT cut a release, bump the version, tag, or run `vsce publish` on your own.** Releasing is gated behind the `release` skill and must only happen when the maintainer explicitly invokes it (`/release` or "make a release"). Until then, leave `package.json` version, `CHANGELOG.md`, tags, and publishing untouched — even after landing a fix. Just land the change; the maintainer decides when to release.

When the maintainer does invoke the `release` skill, it owns the whole flow (semver bump → CHANGELOG → tests → bundle → auth → commit → tag → `vsce publish`) and pauses for confirmation before the irreversible publish.

```bash
npm install -g @vscode/vsce   # one-time
vsce login <publisher-id>      # requires Azure DevOps PAT with Marketplace → Manage scope
vsce publish                   # publishes the current package.json version
```

The release also publishes to **Open VSX** (`ovsx publish`) so Cursor/VSCodium/Windsurf auto-update. The Open VSX token is stored as the **`OVSX_PAT`** environment variable (set in `~/.zshrc`); `ovsx` reads it automatically, so no need to pass `-p`. Never commit the token value — only reference the `OVSX_PAT` name.

The `.vscodeignore` file controls what gets packaged. vsce reads `.vscodeignore` (not `.vsixignore`). Keep dev-only directories (`.superpowers/`, `docs/`, `.claude/`, `.qodo/`) listed there.

---

## How Hook Changes Reach a Running Session

`~/.claude/settings.json` does not invoke `hook.py` directly. It invokes a stable
wrapper (`~/.claudegate/hook.sh`, or `hook.bat` on Windows) whose path never
changes and which re-execs `hook.py` **fresh on every tool call**:

```bash
#!/usr/bin/env bash
python3 "$HOME/.claudegate/hook.py"
```

| Change | Effect on a **running** Claude session |
|---|---|
| `hooks/hook.py` content | Picked up on the session's next tool call. No restart. |
| `~/.claude/settings.json` hooks block | Picked up on the session's next tool call **on Claude Code 2.1.227+**. Older versions snapshotted hook config at session start and needed a restart. |

**This corrects an earlier rule in this file** that called the settings.json case
"cold" — that a write silently stopped capture in every running session until it
restarted. Measured on 2.1.227:

- every running session (including 25-hour-old ones) holds an `inotify` watch on
  the settings file, mask `c06`;
- a hook added mid-session to the **project** `settings.local.json` fired on the
  very next tool call;
- the same was then verified for the **user-global** `~/.claude/settings.json` —
  the file we actually write — in a session hours old;
- in both cases the pre-existing claudegate hook kept firing throughout: adding
  or repairing a hook does **not** revoke the others.

Consequences:

- `HookInstaller.syncHookIfNeeded()` rewrites `~/.claudegate/*` **silently and
  automatically** (activation + window focus). It must fire `onHealthChange`
  afterwards or the status chip keeps reporting the pre-heal state.
- `HookInstaller.syncSettingsIfNeeded()` may likewise write `settings.json`
  **silently**, at activation, because the change takes effect immediately. It is
  deliberately bounded: at most one attempt per activation, latching off on
  failure, and **repair only** — it never performs a first-time install, which
  stays the explicit **Setup Hook** action. This is how a widened
  `PRE_TOOL_MATCHER` (e.g. adding `Bash`) reaches users who installed earlier;
  nothing else could, since `computeSettingsPatch` is the only code that inspects
  the matcher.
- Every settings.json write still runs the full guarded protocol (ENOENT-only
  fresh install, timestamped backup, realpath write, post-write verify with
  rollback) — that file holds the user's entire Claude config.
- `watchSettingsForTrustInvalidation()` is retained for the older versions, but
  its message is a heads-up, **not** an outage report: do not reintroduce
  "your sessions have stopped tracking, restart them".

When diagnosing "capture stopped", check `~/.claudegate/hook.log` first — daily
entry counts show immediately whether the hook stopped firing or whether the
records are landing somewhere the panel isn't displaying (the far more common
cause historically: worktree sessions, see v1.10.1 / v1.12.0 / v1.12.1).

---

## Adding Features

- **New commands**: Register in `src/extension.ts` and add to `contributes.commands` + `contributes.menus` in `package.json`.
- **Hook changes**: Edit `hooks/hook.py` — the extension auto-syncs it to `~/.claudegate/hook.py` at activation and on window focus, and running Claude sessions pick it up immediately (see **How Hook Changes Reach a Running Session**). Re-running **Setup Hook** is only needed when the `settings.json` registration is missing entirely — a *stale* one (wrong wrapper path, outdated matcher) is repaired automatically at the next activation.
- **Captured tools**: change `PRE_TOOL_MATCHER` in `src/hookInstaller.ts` and teach `hooks/hook.py` to read that tool's `tool_input`. The constant is compared by `computeSettingsPatch`, so existing installs migrate themselves; a matcher hardcoded anywhere else would strand every user who installed before the change.
- **Session behavior**: `src/sessionManager.ts` owns all session read/write logic; keep side effects there.
- **GUI detection changes**: `src/documentTracker.ts` owns all VS Code document/FS watching logic.

---

## Design Decisions

- **File snapshot over git**: No git dependency — works in any directory, including non-git projects.
- **Per-workspace session files** (`~/.claudegate/sessions/<hash>.json`): Multiple simultaneous Claude sessions in different projects stay fully isolated. The hash is `MD5(resolvedWorkspacePath)`, computed identically by `hook.py` and `SessionManager`.
- **Two detection paths**: The `PreToolUse` hook is authoritative for all Claude Code — terminal CLI and in-editor extension both run the same hook, firing synchronously before writes, for `Write`/`Edit`/`MultiEdit` **and** `Bash`. The `DocumentTracker` is a non-Claude fallback for agents like Cursor Composer or Codex that don't run Claude's hooks; it cannot attribute edits, so it's disabled by default.
- **Shell writes captured by extraction, not by watching**: a `Bash` payload is parsed for write intent and target paths rather than resolved by observing the filesystem, so the baseline is still snapshotted *before* the write and stays attributable to the session. Commands that write without naming a file (`make generate`, `prettier --write src/`) are out of scope by design.
- **Only pending files get a badge**: Accepted and rejected files are undecorated in the file explorer to avoid clashing with git's own `A`/`R` status indicators.
- **Python for the hook**: Python 3 is pre-installed on macOS/Linux and handles JSON and file I/O without extra dependencies.
- **Nothing expensive runs synchronously on a coarse trigger** — see the section below.

---

## Extension-Host Responsiveness

Every trigger this extension listens to fires far more often than the work behind
it is worth doing. Two of them are load-bearing, and both are rate-limited. Treat
this as a standing constraint, not an optimization: the extension host is a single
thread shared with every other extension, and a synchronous stall there freezes
the editor's UI.

**Window focus** fires on every alt-tab. The sweep behind it (worktree rescan,
reconcile of every attached session, hook health check) is real filesystem work.

- `createThrottle(FOCUS_SWEEP_MIN_INTERVAL_MS)` in `src/extension.ts` drops
  sub-interval focus events outright.
- `WorktreeSessionRegistry.refresh()` applies its own, longer
  `RESCAN_MIN_INTERVAL_MS` on top, coalesces concurrent callers onto one in-flight
  walk, and takes `{ force: true }` for activation and user-driven refreshes so
  nothing a user explicitly asks for is ever delayed.
- `nestedWorktreesUnder()` is **async and must stay async**. It is the single most
  expensive routine here — measured at ~2,500 `readdir` + ~2,700 `lstat` on a real
  `go.work` monorepo. Synchronously that blocked the host for ~42 ms warm (far
  worse with a cold page cache); the bounded-concurrency BFS keeps the worst
  event-loop stall at ~2 ms for the same tree. `worktrees.test.ts` asserts the loop
  keeps turning during a scan.

**Session change** fires at least twice per user decision: once from `persist()`
and once from the `fs.watch` reload that write triggers. Both consumers coalesce
via `createCoalescer` (`src/scheduling.ts`):

- `FilteredTreeProvider` collapses the burst into one `onDidChangeTreeData` fire.
  Firing each change separately raced inside VS Code's async tree and threw
  `TreeError [claudegate.acceptedPanel] Data tree node not found` /
  `Tree element not found` during multi-file accepts. `setViewMode()` deliberately
  fires directly — a button press must repaint at once and cannot storm.
- The badge/context fan-out and the "Review All Pending" multi-diff rebuild in
  `extension.ts` likewise. The multi-diff one matters most: `pendingReviewPaths()`
  reads **every** pending file off disk to test it for a real change.

Note the coalescer is not a debounce — it does not extend its deadline on each
call, so a continuous stream still runs at a steady cadence instead of starving.

**Logging must never throw.** VS Code closes the host's IPC channel *before*
running `dispose()` on subscriptions, so `appendLine` from a teardown path raises
`Error: Channel has been closed`. That escaped `WorktreeSessionRegistry.detach()`
and aborted `dispose()` mid-loop, leaking an `fs.watch` handle and a reconcile
timer per un-detached worktree on every window reload. `activate()` wraps the
channel in `failSoftLog()` (`src/safeLog.ts`) and passes only the wrapper
downstream; `dispose()` additionally guards each detach.

When diagnosing "the editor feels slow with ClaudeGate installed", check in this
order: the Claude Gate output channel for a `Session file is large` warning (a
multi-MB session re-parses on every watch event), then `~/.claudegate/hook.log`
for bogus captures driving that churn, then whether a new synchronous filesystem
walk has crept onto a focus or session-change path.
