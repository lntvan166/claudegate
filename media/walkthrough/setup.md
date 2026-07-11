# Set up the capture hook

Claude Gate captures every file change Claude Code makes — both the **terminal CLI** and the **in-editor extension** — through a `PreToolUse` hook it installs into `~/.claude/settings.json`.

Running **Setup Hook** is a one-time step. It:

- copies the hook script into `~/.claudegate/`
- registers it in your Claude settings (preserving anything already there)
- takes a `.bak` of your settings first, and never overwrites a file it can't parse

After setup, **restart any running Claude Code sessions** so they pick up the hook.
