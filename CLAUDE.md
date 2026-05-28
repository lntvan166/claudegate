# CLAUDE.md — ClaudeGate Developer Guide

## What This Project Does

ClaudeGate is a VS Code/Cursor extension that captures file changes made by Claude Code (terminal CLI) and presents them in a structured review panel. The user can accept or reject each change using VS Code's native diff editor.

---

## Architecture

Three components share state through a single JSON file:

```
hooks/hook.py          ← copied to ~/.claudegate/hook.py at setup
       │  writes original content before Claude modifies files
       ▼
~/.claudegate/session.json   ← shared state (watched by extension)
       │
src/sessionManager.ts  ← watches session.json, exposes session state
src/reviewPanel.ts     ← TreeView sidebar listing modified files
src/diffProvider.ts    ← serves original content via claudegate: URI scheme
src/hookInstaller.ts   ← Setup Hook command: installs scripts, patches settings
src/extension.ts       ← entry point, wires everything together
```

---

## Key Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, status bar |
| `src/sessionManager.ts` | Read/write `session.json`, file watcher, accept/reject logic |
| `src/reviewPanel.ts` | `vscode.TreeDataProvider` for the sidebar panel |
| `src/diffProvider.ts` | `TextDocumentContentProvider` for `claudegate:` URIs; `openDiff` helper |
| `src/hookInstaller.ts` | Installs `hook.py` + `hook.sh`, patches `~/.claude/settings.json` |
| `hooks/hook.py` | Python hook script — source file copied to `~/.claudegate/hook.py` |

---

## Session State Schema

`~/.claudegate/session.json`:

```json
{
  "sessionId": "2026-05-28T19:44:00.000000+00:00",
  "status": "active | reviewed",
  "files": {
    "/absolute/path/to/file.ts": {
      "originalContent": "string | null",
      "reviewStatus": "pending | accepted | rejected"
    }
  }
}
```

- `originalContent: null` means Claude created this file (it did not exist before). Rejecting it deletes the file.
- `status: reviewed` is set automatically when all files have a non-pending status.
- A new session is started automatically when `hook.py` runs and finds `status: reviewed`.

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

`file_path` may be relative to `cwd`. The hook resolves it to an absolute path before storing.

---

## Development Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-recompile)
npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

To test the hook manually:

```bash
echo '{"tool_name":"Write","cwd":"/tmp","tool_input":{"file_path":"test.txt"}}' \
  | python3 hooks/hook.py
cat ~/.claudegate/session.json
```

---

## Publishing to the Marketplace

1. Install `vsce`: `npm install -g @vscode/vsce`
2. Update `publisher` in `package.json` to your VS Code Marketplace publisher ID
3. Replace `media/icon.svg` with a 128×128 PNG named `media/icon.png` and update `package.json`
4. Run: `vsce package` to generate a `.vsix` for local testing
5. Run: `vsce publish` to publish

---

## Adding Features

- **New commands**: Register in `src/extension.ts` and add to `contributes.commands` + `contributes.menus` in `package.json`
- **Hook changes**: Edit `hooks/hook.py` — users must re-run **Setup Hook** to pick up the new version
- **Session behavior**: `src/sessionManager.ts` owns all session read/write logic; keep side effects there

---

## Design Decisions

- **File snapshot over git**: No git dependency — works in any directory, including non-git projects.
- **Home directory for state** (`~/.claudegate/`): Session state is shared across all projects and survives workspace changes.
- **One session at a time**: Keeps the review flow linear. A new Claude session automatically starts when the previous one is marked `reviewed`.
- **Python for the hook**: Python 3 is pre-installed on macOS/Linux and handles JSON and file I/O without extra dependencies. The alternative (a Node.js script) would require installing Node in the shell environment where Claude runs.
