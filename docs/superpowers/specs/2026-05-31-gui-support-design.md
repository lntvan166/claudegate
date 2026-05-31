# GUI Support Design — ClaudeGate

**Date:** 2026-05-31
**Status:** Approved for implementation

## Problem

ClaudeGate's hook mechanism relies on Claude Code's `PreToolUse` hook system, which only fires for the terminal CLI (`claude` command). The Claude Code VS Code/Cursor GUI extension uses a different internal code path that does not trigger hooks in `~/.claude/settings.json`. File changes made via the GUI panel are invisible to ClaudeGate.

## Goal

Add a second detection layer that captures file changes made by the Claude Code VS Code GUI extension, without affecting or changing the existing terminal CLI hook flow in any way.

## Scope

- **In scope:** Detecting and reviewing file changes made by the Claude Code VS Code GUI extension
- **Out of scope:** Distinguishing Claude GUI edits from user edits (documented limitation for non-pure-session workflows); changes to the hook mechanism; changes to the review UI

## Architecture

Two independent detection mechanisms feed the same session file and the same review panel:

```
Claude Code terminal CLI          Claude Code VS Code GUI extension
        │                                     │
  PreToolUse hook                   edits document via VS Code APIs
  hook.py writes original                     │
        │                            DocumentTracker detects change
        └──────────────┬─────────────────────┘
                       ▼
          ~/.claudegate/sessions/<hash>.json
                       │
             ClaudeGate extension
             (review panels, unchanged)
```

**Coexistence rule:** Whichever mechanism fires first for a given file owns it. If `hook.py` already recorded the file, `DocumentTracker` skips it (checks `session.files[filePath]`). If `DocumentTracker` recorded it first, `hook.py` also skips it (already checks `if existing is None`). No conflict, no duplicates.

## Components

### New: `src/documentTracker.ts`

Owns all VS Code document lifecycle logic. Injected with `SessionManager` as its only dependency.

**Responsibilities:**
- On activation: read and cache content of all currently open documents (`vscode.workspace.textDocuments`)
- On `onDidOpenTextDocument`: cache content of newly opened documents — the "snapshot before Claude edits" moment
- On `createFileSystemWatcher` change event: if the changed file has a cached original and is not already in the session → call `sessionManager.trackFileChange(filePath, cachedOriginal)`
- Ignore files outside the current workspace

**Snapshot cache:** `Map<filePath, string | null>` — `null` means file didn't exist when first seen (new file case).

### Modified: `src/sessionManager.ts`

Add one public method:

```typescript
trackFileChange(filePath: string, originalContent: string | null): void
```

Logic mirrors `hook.py`:
- If file not in session → add with `reviewStatus: "pending"`
- If file in session with `reviewStatus: "accepted" | "rejected"` → reset to `"pending"`, update `originalContent`
- If file already `"pending"` → no-op

### Modified: `src/extension.ts`

Initialize `DocumentTracker` after `SessionManager`, pass workspace path, call `tracker.start()` and dispose on deactivation. Three additions.

### Unchanged

`hook.py`, `hookInstaller.ts`, `reviewPanel.ts`, `diffProvider.ts`, `decorationProvider.ts`, session JSON schema, all review UI.

## Data Flow

**File open before Claude edits it (already open in editor):**
Snapshotted from `vscode.workspace.textDocuments` at activation → covered.

**File opened during Claude's task:**
Claude Code extension calls `openTextDocument()` internally → `onDidOpenTextDocument` fires → snapshot cached → Claude applies edit → FS watcher fires → `trackFileChange()` called → review panel updates.

**New file Claude creates:**
Never opened before → no snapshot → `originalContent: null` → shown as "new file", consistent with hook behavior.

**CLI and GUI simultaneously in same workspace:**
Hook fires first → file in session → `DocumentTracker` FS watcher fires → file already in session → skipped.

## Error Handling

| Scenario | Behavior |
|---|---|
| Cannot read document content | Store `null` — treated as new file |
| File outside workspace | Ignored by `DocumentTracker` |
| Same file changed multiple times | Idempotent — first snapshot wins, subsequent FS events no-op |
| Snapshot race (file changes before `onDidOpenTextDocument` handler runs) | Snapshot reflects pre-edit content because VS Code loads the document before the extension applies its edit |

## Known Limitation

`DocumentTracker` watches all file changes in the workspace. In workflows where the user edits files themselves while Claude is not running, those edits will appear as pending review items. This is documented in the README. The existing "Clear Session" command handles cleanup. This limitation only affects users who mix their own edits with Claude's in the same workspace without clearing between sessions.

## File Size Estimate

`src/documentTracker.ts`: ~100 lines
`src/sessionManager.ts`: +15 lines (one method)
`src/extension.ts`: +3 lines

## Testing

`DocumentTracker` takes `SessionManager` as a constructor dependency — can be unit tested by injecting a mock and simulating `onDidOpenTextDocument` and FS watcher events. Existing session manager and hook flow tests are unaffected.
