# CLAUDE.md — ClaudeGate Developer Guide

## What This Project Does

ClaudeGate is a VS Code/Cursor extension that captures file changes made by Claude Code and presents them in a structured review panel. The user can accept or reject each change using VS Code's native diff editor.

Two detection paths are supported:
- **PreToolUse hook (authoritative for all Claude Code).** The `~/.claude/settings.json` `PreToolUse` hook fires before every Claude write — for **both** the terminal CLI **and** the in-editor Claude Code extension (confirmed: both run the same hook, so a GUI edit is captured with correct original content and the in-editor session's `session_id`). This is the primary, attributed capture path.
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
  "tool_name": "Write | Edit | MultiEdit",
  "tool_input": {
    "file_path": "relative or absolute path to target file"
  }
}
```

**Hook behavior:**
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

The `.vscodeignore` file controls what gets packaged. vsce reads `.vscodeignore` (not `.vsixignore`). Keep dev-only directories (`.superpowers/`, `docs/`, `.claude/`, `.qodo/`) listed there.

---

## Adding Features

- **New commands**: Register in `src/extension.ts` and add to `contributes.commands` + `contributes.menus` in `package.json`.
- **Hook changes**: Edit `hooks/hook.py` — users must re-run **Setup Hook** to pick up the new version.
- **Session behavior**: `src/sessionManager.ts` owns all session read/write logic; keep side effects there.
- **GUI detection changes**: `src/documentTracker.ts` owns all VS Code document/FS watching logic.

---

## Design Decisions

- **File snapshot over git**: No git dependency — works in any directory, including non-git projects.
- **Per-workspace session files** (`~/.claudegate/sessions/<hash>.json`): Multiple simultaneous Claude sessions in different projects stay fully isolated. The hash is `MD5(resolvedWorkspacePath)`, computed identically by `hook.py` and `SessionManager`.
- **Two detection paths**: The `PreToolUse` hook is authoritative for all Claude Code — terminal CLI and in-editor extension both run the same hook, firing synchronously before writes. The `DocumentTracker` is a non-Claude fallback for agents like Cursor Composer or Codex that don't run Claude's hooks; it cannot attribute edits, so it's disabled by default.
- **Only pending files get a badge**: Accepted and rejected files are undecorated in the file explorer to avoid clashing with git's own `A`/`R` status indicators.
- **Python for the hook**: Python 3 is pre-installed on macOS/Linux and handles JSON and file I/O without extra dependencies.
