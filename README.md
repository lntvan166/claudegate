# ClaudeGate

**Review every file Claude Code touches — accept or revert with one click.**

ClaudeGate bridges the gap between Claude Code (terminal) and Cursor/VS Code's visual diff workflow. When Claude modifies your files, ClaudeGate captures the before-state automatically and surfaces each change in a structured sidebar panel — the same red/green accept/reject experience you get with Cursor's native AI agent.

---

## Quick Start

Three steps, no manual config:

**1. Install**
Search for `ClaudeGate` in the VS Code / Cursor Extensions panel, or install via the Marketplace.

**2. Setup the hook**
Open the Command Palette (`Cmd+Shift+P`) and run:
```
ClaudeGate: Setup Hook
```
This installs a Claude Code `PreToolUse` hook that captures file changes automatically.

**3. Use Claude Code normally**
Run `claude` in your terminal as usual. When Claude writes files, ClaudeGate will catch them and show a pending count in the status bar.

---

## The Review Flow

1. The **ClaudeGate** icon in the Activity Bar shows a panel with all modified files
2. Click any file to open VS Code's native diff editor (original on the left, Claude's version on the right)
3. Use the inline buttons to **Accept** (keep Claude's change) or **Reject** (revert to original)
4. The status bar shows how many files are still pending

---

## Features

- Automatic session tracking via Claude Code hooks — no manual start/stop
- File-by-file diff review using VS Code's built-in diff editor
- Accept keeps the change as-is; Reject writes the original content back
- New files created by Claude are deleted on Reject
- Session history archived to `~/.claudegate/history/`
- Status bar indicator with pending file count
- Clear Session button to archive and reset

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ or Cursor | |
| [Claude Code](https://claude.ai/claude-code) | Anthropic's CLI |
| Python 3.7+ | Pre-installed on macOS and most Linux distros |

> **Windows:** Requires WSL (Windows Subsystem for Linux). Native Windows support is planned for a future release.

---

## How It Works

```
Claude Code (terminal)
       │
  PreToolUse hook fires before each Write / Edit / MultiEdit
  ~/.claudegate/hook.py reads the file's current content
       │
  ~/.claudegate/session.json  ← shared state file
       │
  ClaudeGate extension watches for changes
       └── Updates sidebar panel in real time
```

The hook only stores a file's original content **once per session** — subsequent Claude writes to the same file don't overwrite the snapshot, so you always compare against the true before-state.

---

## File Locations

| Path | Purpose |
|---|---|
| `~/.claudegate/hook.py` | Hook script (managed by Setup Hook command) |
| `~/.claudegate/hook.sh` | Shell entry point called by Claude Code |
| `~/.claudegate/session.json` | Active session state |
| `~/.claudegate/history/` | Archived past sessions |
| `~/.claude/settings.json` | Claude Code configuration (hook registration added here) |

---

## Updating the Hook

If you update ClaudeGate, re-run **`ClaudeGate: Setup Hook`** to install the latest hook script.

---

## Contributing

See [CLAUDE.md](CLAUDE.md) for the architecture guide and development setup.

---

## License

MIT — see [LICENSE](LICENSE)
