# Changelog

All notable changes to ClaudeGate are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-05-28

### Added

- **Automatic session tracking** via Claude Code `PreToolUse` hooks — captures original file content before every `Write`, `Edit`, and `MultiEdit` tool call
- **One-command setup** (`ClaudeGate: Setup Hook`) installs the hook script and patches `~/.claude/settings.json` automatically
- **Sidebar review panel** listing all files modified in the current Claude session, sorted by review status (pending first)
- **Native VS Code diff editor** — clicking a file opens the built-in red/green diff view (original left, Claude's version right)
- **Inline Accept / Reject buttons** per file in the sidebar
  - Accept: keeps Claude's version, marks file as reviewed
  - Reject: writes original content back to disk; new files created by Claude are deleted
- **Status bar indicator** showing pending file count with warning highlight
- **Clear Session** button to archive the current session and reset the panel
- **Session history** automatically archived to `~/.claudegate/history/`
- **Setup verification** — "Verify Setup" action confirms hook script and settings are in place
