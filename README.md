# ClaudeGate

**Review every file Claude Code touches — accept or revert with one click.**

Stop flying blind when Claude modifies your codebase. ClaudeGate captures every file change before it happens and surfaces each one as a structured diff — the same accept/reject workflow as Cursor's native AI review, but for Claude Code running in any terminal.

> **Note:** ClaudeGate supports two modes: the **Claude Code terminal CLI** (`claude` command) via pre-installed hooks, and the **Claude Code VS Code/Cursor GUI extension** via automatic file change detection. GUI mode works best in "pure sessions" where Claude makes changes and you review before editing further — all file changes during a GUI session are captured for review.

---

## Screenshot

![ClaudeGate in action](media/ClaudeGateDemo.png)

---

## Quick Start

Three steps, no manual config:

**1. Install**
Install **ClaudeGate** from the VS Code / Cursor Extensions panel.

**2. Setup the hook**
Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
ClaudeGate: Setup Hook
```

This installs a `PreToolUse` hook into Claude Code that automatically snapshots files before Claude writes them.

**3. Run Claude Code normally**
Use `claude` in your terminal as usual. When Claude modifies files, ClaudeGate shows a pending count badge in the sidebar — click any file to review the diff.

---

## The Review Flow

1. The **ClaudeGate** icon in the Activity Bar shows three panels: **Pending**, **Accepted**, and **Rejected**
2. Click any pending file to open VS Code's native diff editor — original on the left, Claude's version on the right
3. **✓ Accept** and **✕ Reject** inline links appear at the top of the diff — one click, done
4. Accepted files move to the Accepted panel; rejected files are restored to their original content

---

## Features

- **Automatic session tracking** — hooks fire before every Claude file write; no manual start/stop
- **Three independent panels** — Pending, Accepted, and Rejected with per-panel collapse and view toggle
- **Accept/Reject CodeLens** — inline action links at the top of any pending file, in the diff view and the regular editor
- **Folder-level actions** — accept or reject an entire directory at once (tree view mode)
- **Undo your decisions** — re-apply Claude's changes from the Rejected panel; un-accept files back to Pending
- **Workspace-aware filtering** — files modified outside the current workspace (e.g. `~/.claude/settings.json`) are hidden from the review panel
- **Pending count badge** on the sidebar panel header
- **Session history** archived to `~/.claudegate/history/`

---

## How It Works

```
Claude Code (terminal CLI)          Claude Code (VS Code GUI extension)
        │                                        │
  PreToolUse hook fires                 DocumentTracker watches
  hook.py snapshots original          file system for changes
        │                                        │
        └──────────────┬─────────────────────────┘
                       ▼
        ~/.claudegate/sessions/<workspace>.json
                       │
             ClaudeGate review panels
```

The hook captures a file's original content **once per session** — subsequent Claude writes to the same file don't overwrite the snapshot, so you always diff against the true before-state.

---

## Requirements

| Requirement                                  | Notes                                         |
| -------------------------------------------- | --------------------------------------------- |
| VS Code 1.85+ or Cursor                      |                                               |
| [Claude Code](https://claude.ai/claude-code) | Terminal CLI or VS Code/Cursor GUI extension  |
| Python 3.7+                                  | Pre-installed on macOS and most Linux distros |

> **Windows:** Native Windows is supported. Python must be on your `PATH` (`python` or `python3`). WSL is not required.

---

## Updating the Hook

After updating the extension, re-run **`ClaudeGate: Setup Hook`** to install the latest hook script.

---

## Contributing & Issues

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/lntvan166/claudegate/issues).

---

## License

MIT — see [LICENSE](LICENSE)
