# ClaudeGate Improvement Ideas — Research Summary

**Date:** 2026-07-04
**Method:** `deep-research` workflow (5 search angles → ~38 sources fetched → 139 claims extracted → 3-vote adversarial verification on haiku, scope/synthesis on sonnet). The automated synthesis step failed on structured output; the 133 substantive claims were recovered from the run journal and synthesized manually. **Caveat:** claim-level adversarial verdicts were not fully recoverable, so treat individual claims as *research leads*, not verified fact — the "⚠️ verify" notes below flag the ones to confirm before building.

## Prioritized improvement ideas (for ClaudeGate specifically)

### 1. `PostToolUse` hook — the real fix for edit attribution ⭐ (recommended next)
- **Value: very high · Effort: medium.**
- `PostToolUse` hooks fire *after* a successful Write/Edit and receive the tool result/written content plus `tool_use_id`, `session_id`, `transcript_path`. The IDE extension runs the same bundled CLI + shared `~/.claude/settings.json`, so hooks fire for **both terminal and GUI** Claude Code. A PostToolUse hook could therefore capture **exactly what Claude wrote, with attribution**, for both paths — retiring the flaky `DocumentTracker` filesystem watcher for all Claude Code usage.
- **Maps onto:** existing `hookInstaller` + session schema. PreToolUse already gives the "before"; PostToolUse gives the authoritative "after + who".
- ⚠️ **Verify:** the confirmed parts are PostToolUse + written content + `session_id`. The `agent_id` / `agent_type` / `parent_tool_use_id` subagent-attribution fields appear in Agent-SDK docs but must be confirmed against the actual CLI hook stdin before designing around them.

### 2. Native SCM / QuickDiff gutter integration
- **Value: high · Effort: medium-high.**
- `QuickDiffProvider.provideOriginalResource()` + the **existing `claudegate:` content provider** would make VS Code render gutter diff decorations inline in the editor for pending changes, automatically. The SCM API can also render the review groups as a native Source Control view (multi-select batch commands, 6 menu points).

### 3. Per-hunk (line-level) accept/reject
- **Value: high (most-requested) · Effort: high.**
- The #1 cross-source pain: only whole-file accept/reject today; Copilot Edits and VS Code's Changes panel offer inline per-edit accept/discard. Big capability gap, but complex (partial-diff application).

### 4. Ship sensible default exclude patterns
- **Value: medium · Effort: low (easy win).**
- Auto-filter noise (lock files, `*.min.*`, source maps, generated). The exclude engine exists; add a curated, user-overridable default set.

### 5. "Protected files" flag for secrets/config
- **Value: medium (security) · Effort: low-medium.**
- VS Code guards `.env`/config edits behind explicit approval; sources cite real secrets-exfiltration/destructive-edit incidents. Reuse the glob infra for a `claudegate.protected` set that visually flags (not hides) sensitive files atop Pending.

### 6. Multi-file diff view ("review all pending at once")
- **Value: medium · Effort: medium.**
- VS Code's multi-diff editor scrolls all changed files in one editor — speeds multi-file refactor review (a cited friction point).

## Validated (already in ClaudeGate)
- **Auto-advance on resolve** — matches VS Code's `chat.editing.revealNextChangeOnResolve` best practice.
- **Session grouping, exclude patterns, keyboard review** — align with cited best practices.

## Not recommended (scope creep)
- Turning ClaudeGate into a **bug-finding reviewer** (specialized security/perf agents, severity triage) — different product; ClaudeGate is a change *gate*, not a linter.
- **Aider-style git auto-commit attribution** — reliable but contradicts the deliberate no-git design.
- **Inline PR-style comments (Comments API)** — high effort, expands beyond accept/reject.

## Source themes (for reference)
- Comparable tools: GitHub Copilot Edits (Working Set, inline accept/discard, Secondary Side Bar review), VS Code "Changes" panel + multi-diff editor, aider (git auto-commit + `(aider)` attribution + `/undo`), GitLens (47M installs, git-history not review).
- VS Code APIs: SCM API (SourceControl/ResourceGroup/ResourceState, `when`-clause menus, multi-select), QuickDiffProvider + `registerTextDocumentContentProvider` + custom URI scheme, gutter decorations, multi-diff editor.
- Claude Code ecosystem: PostToolUse / SessionStart / SessionEnd / UserPromptSubmit hooks; `transcript_path`, `session_id`, `prompt_id`; subagent `parent_tool_use_id`; MCP; worktree isolation for parallel subagents.
- Pain points: file-level-only accept/reject, no inline feedback, multi-file refactor friction, AI velocity outpacing review, distrust of AI accuracy, secrets/destructive-action incidents.
