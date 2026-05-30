# ClaudeGate — Review Workflow Improvements: Design Spec

**Date:** 2026-05-30  
**Status:** Approved for implementation  
**Author:** Brainstorming session

---

## 1. Overview and Motivation

ClaudeGate currently lets users accept or reject entire files modified by Claude Code. This is simple but coarse: a single file often contains one large refactor and several small formatting tweaks — and the user must decide all or nothing.

This spec describes three improvements to make the review workflow faster and more precise:

| ID | Feature | Value |
|----|---------|-------|
| D1 | **Hunk-level review** | Accept or reject individual changed sections within a file |
| D2 | **Diff stats in sidebar** | `+N −M` line counts in the Pending panel for quick triage |
| D3 | **Auto-advance** | After each file decision, automatically open the next pending file |

These three features share a common theme: reducing friction in the review loop. A user reviewing 10 changed files should be able to work through them in a single fluid session without navigating manually or making all-or-nothing calls.

---

## 2. Session Schema Changes

### 2.1 New interface: `HunkEntry`

A hunk represents one contiguous block of changed lines within a file.

```ts
interface HunkEntry {
  id: string;               // stable identifier: "<originalStart>:<originalEnd>"
  startLine: number;        // first changed line in Claude's version of the file (0-indexed)
  reviewStatus: "pending" | "accepted" | "rejected";
}
```

**Hunk ID stability:** The ID is derived from the original file's line range (`originalStart:originalEnd`). Because the original content never changes during a session, this ID is stable across multiple opens of the diff view.

**`startLine`:** The 0-indexed line in Claude's (modified) file where this hunk begins. This is the line at which the CodeLens button is positioned. It must be recomputed each time hunks are (re)computed from the diff, because accepting or rejecting an earlier hunk changes line offsets.

### 2.2 Extended interface: `FileEntry`

Add an optional `hunks` field to the existing `FileEntry` interface in `src/sessionManager.ts`:

```ts
export interface FileEntry {
  originalContent: string | null;
  claudeContent?: string | null;
  reviewStatus: ReviewStatus;
  hunks?: HunkEntry[];      // present when file has been opened in diff view
}
```

`hunks` is absent until the diff view is opened for that file for the first time. It is computed lazily in `openDiff()` and written to the session.

**Session file example after partial hunk review:**

```json
{
  "sessionId": "2026-05-30T10:00:00.000000+00:00",
  "status": "active",
  "files": {
    "/project/src/sessionManager.ts": {
      "originalContent": "...",
      "reviewStatus": "pending",
      "hunks": [
        { "id": "81:85", "startLine": 80, "reviewStatus": "accepted" },
        { "id": "89:91", "startLine": 93, "reviewStatus": "pending" },
        { "id": "120:122", "startLine": 128, "reviewStatus": "pending" }
      ]
    }
  }
}
```

---

## 3. Feature D1: Hunk-Level Review

### 3.1 Overview

When a user opens a diff for a file that has `originalContent`, the extension computes hunks (if not already in session) and shows Accept/Reject CodeLens buttons above the first changed line of each hunk in the right (Claude's) pane.

### 3.2 New file: `src/hunkReviewProvider.ts`

This file implements `vscode.CodeLensProvider` and is registered for `{ scheme: "file" }` documents.

**Responsibilities:**
1. On `provideCodeLenses(document)`: check if the document's `fsPath` has a session entry with `hunks`. If the entry is absent, has no hunks array, or the file's `reviewStatus` is not `"pending"` (i.e., the file as a whole has been accepted/rejected), return `[]`.
2. For each hunk in `entry.hunks`, produce `CodeLens` items at `new vscode.Range(hunk.startLine, 0, hunk.startLine, 0)`. Note: even when the overall file is `"pending"`, individual hunks may already be decided — show different buttons per hunk status:
   - **Pending hunk:** two CodeLenses — `claudegate.acceptHunk` ("✓ Accept hunk") and `claudegate.rejectHunk` ("✕ Reject hunk")
   - **Accepted hunk:** one CodeLens — "✓ Accepted · Undo" (calls `claudegate.rejectHunk`)
   - **Rejected hunk:** one CodeLens — "✕ Rejected · Undo" (calls `claudegate.acceptHunk`)
3. Return an `onDidChangeCodeLenses` event that fires on `sessionManager.onSessionChange`.

**Constructor signature:**

```ts
export class HunkReviewProvider implements vscode.CodeLensProvider {
  constructor(private readonly sessionManager: SessionManager) {}
}
```

**Registration in `src/extension.ts`:**

```ts
context.subscriptions.push(
  vscode.languages.registerCodeLensProvider(
    { scheme: "file" },
    new HunkReviewProvider(sessionManager)
  )
);
```

### 3.3 Hunk computation

Hunks are computed in `openDiff()` inside `src/diffProvider.ts`, immediately after the diff editor is opened, using the `diff` npm package (already a dependency).

**Algorithm:**

`diffLines` from the `diff` package emits changes in one of three forms: `{ removed: true }`, `{ added: true }`, or context (neither). A logical "hunk" is either a lone insertion, a lone deletion, or a replace (a `removed` immediately followed by an `added`). The algorithm collects changes in a lookahead pass to merge remove+add pairs:

```ts
import { diffLines, Change } from "diff";

function computeHunks(originalContent: string, claudeContent: string): HunkEntry[] {
  const changes = diffLines(originalContent, claudeContent);
  const hunks: HunkEntry[] = [];
  let origLine = 0;   // cursor in original file
  let modLine  = 0;   // cursor in Claude's file
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    const count  = change.count ?? 0;

    if (change.removed) {
      const origStart = origLine;
      const origEnd   = origLine + count - 1;
      const hunkModLine = modLine;
      origLine += count;

      // Peek: is the next change an addition? → replace hunk (merge into one entry)
      if (i + 1 < changes.length && changes[i + 1].added) {
        i++;
        const addCount = changes[i].count ?? 0;
        hunks.push({
          id: `${origStart}:${origEnd}`,
          startLine: hunkModLine,
          reviewStatus: "pending",
        });
        modLine += addCount;
      } else {
        // Pure deletion hunk
        hunks.push({
          id: `${origStart}:${origEnd}`,
          startLine: hunkModLine,
          reviewStatus: "pending",
        });
      }
    } else if (change.added) {
      // Pure insertion hunk (no preceding removed)
      // ID encodes the original insertion point: "ins:<origLine>"
      hunks.push({
        id: `ins:${origLine}`,
        startLine: modLine,
        reviewStatus: "pending",
      });
      modLine += count;
    } else {
      // Context
      origLine += count;
      modLine  += count;
    }
    i++;
  }
  return hunks;
}
```

**Hunk ID scheme:**
- Deletion or replace: `"<origStart>:<origEnd>"` — stable because `originalContent` never changes.
- Pure insertion: `"ins:<origLine>"` — the insertion point in the original file is stable.
- IDs are unique within a file because no two hunks can start at the same original line.

**When to (re)compute:** If `entry.hunks` is already present in the session when `openDiff()` is called, keep the existing hunk statuses — do not recompute. `startLine` values in the stored hunks are based on Claude's original content (captured in `claudeContent`), which is frozen at first-open time, so they remain valid for subsequent CodeLens renders against that same content.

### 3.4 New commands

Register in `src/extension.ts`:

```
claudegate.acceptHunk  — args: { filePath: string, hunkId: string }
claudegate.rejectHunk  — args: { filePath: string, hunkId: string }
```

Both are internal commands invoked only from CodeLens. They are excluded from the Command Palette via `"when": "false"` in `contributes.menus["commandPalette"]` — see section 8.1 for the exact JSON.

### 3.5 Accept/Reject hunk logic (`src/sessionManager.ts`)

**`acceptHunk(filePath: string, hunkId: string): void`**

1. Find the hunk by `id` in `entry.hunks`.
2. Set `hunk.reviewStatus = "accepted"`.
3. Call `writeMergedFile(filePath)`.
4. Call `updateFileStatus(filePath)`.
5. Call `persist()`.

**`rejectHunk(filePath: string, hunkId: string): void`**

1. Find the hunk by `id` in `entry.hunks`.
2. Set `hunk.reviewStatus = "rejected"`.
3. Call `writeMergedFile(filePath)`.
4. Call `updateFileStatus(filePath)`.
5. Call `persist()`.

### 3.6 Merged file write (`writeMergedFile`)

After every hunk decision, the file on disk is rewritten to reflect the current state of all hunk decisions:

```
For each hunk in the diff:
  - accepted → use Claude's lines (from claudeContent or current disk)
  - rejected → use original lines (from originalContent)
  - pending  → use Claude's lines (tentative, until decided)
```

This means the file on disk is always a valid merge of decided + pending state. A pending hunk shows Claude's version as the tentative default.

**Source of Claude's lines:** Claude's complete file content is stored in `entry.claudeContent` at the point when hunks are first computed (captured when `openDiff()` is called). This is essential because after a rejection, the on-disk content changes and the original Claude content would be lost.

**Capture `claudeContent` on first hunk computation:**

```ts
// In openDiff(), before computeHunks:
if (!entry.hunks) {
  entry.claudeContent = fs.readFileSync(filePath, "utf-8");
  entry.hunks = computeHunks(entry.originalContent!, entry.claudeContent);
  sessionManager.updateFileEntry(filePath, entry);
}
```

**`writeMergedFile` algorithm:**

The merge algorithm mirrors `computeHunks` — it must use the same lookahead logic to correlate `removed`/`added` diff pairs with the correct hunk entry:

```ts
function writeMergedFile(filePath: string): void {
  const entry = this.session!.files[filePath];
  const originalLines = (entry.originalContent ?? "").split("\n");
  const claudeLines   = (entry.claudeContent   ?? "").split("\n");
  const changes = diffLines(entry.originalContent ?? "", entry.claudeContent ?? "");

  const output: string[] = [];
  let origIdx = 0;
  let modIdx  = 0;
  let hunkIdx = 0;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    const count  = change.count ?? 0;

    if (change.removed) {
      const hunk = entry.hunks![hunkIdx];
      const isReplace = i + 1 < changes.length && changes[i + 1].added;

      if (hunk.reviewStatus === "rejected") {
        // Keep original lines; skip Claude's added lines (handled below)
        output.push(...originalLines.slice(origIdx, origIdx + count));
      }
      origIdx += count;

      if (isReplace) {
        i++;
        const addCount = changes[i].count ?? 0;
        if (hunk.reviewStatus !== "rejected") {
          // accepted or pending: use Claude's lines
          output.push(...claudeLines.slice(modIdx, modIdx + addCount));
        }
        modIdx += addCount;
      }
      hunkIdx++;

    } else if (change.added) {
      // Pure insertion hunk
      const hunk = entry.hunks![hunkIdx];
      if (hunk.reviewStatus !== "rejected") {
        output.push(...claudeLines.slice(modIdx, modIdx + count));
      }
      modIdx += count;
      hunkIdx++;

    } else {
      // Context lines — always keep
      output.push(...originalLines.slice(origIdx, origIdx + count));
      origIdx += count;
      modIdx  += count;
    }
    i++;
  }

  this.atomicWrite(filePath, output.join("\n"));
}
```

**Key invariant:** `hunkIdx` advances exactly once per logical hunk, and `computeHunks` / `writeMergedFile` both use the same lookahead rule (removed followed by added = one hunk). This keeps `hunkIdx` in sync with `entry.hunks[]`.

### 3.7 File status rules with hunks

Implemented in `updateFileStatus(filePath)`:

```ts
private updateFileStatus(filePath: string): void {
  const entry = this.session!.files[filePath];
  if (!entry.hunks || entry.hunks.length === 0) return;

  const anyPending  = entry.hunks.some(h => h.reviewStatus === "pending");
  const anyAccepted = entry.hunks.some(h => h.reviewStatus === "accepted");
  const allRejected = entry.hunks.every(h => h.reviewStatus === "rejected");

  if (anyPending) {
    entry.reviewStatus = "pending";
  } else if (allRejected) {
    entry.reviewStatus = "rejected";
  } else {
    // all decided, at least one accepted
    entry.reviewStatus = "accepted";
  }
}
```

### 3.8 Interaction with file-level Accept/Reject

When a user uses file-level Accept/Reject on a file that has hunks:

- **File-level Accept:** Set all hunks to `"accepted"`, set file `reviewStatus = "accepted"`, write Claude's full content to disk (no merge needed — all accepted). Clear `claudeContent` (no longer needed for undo).
- **File-level Reject:** Set all hunks to `"rejected"`, set file `reviewStatus = "rejected"`, restore `originalContent` to disk. Behaves identically to the existing `rejectFile()`.
- **Hunk buttons are hidden** once file-level status is decided (non-pending).

---

## 4. Feature D2: Diff Stats in Sidebar

### 4.1 Overview

Pending files in the TreeView sidebar show a compact `+N −M` line count computed from the diff between `originalContent` and the current file on disk. This appears as the `description` property of `FileReviewItem`.

### 4.2 Computation

In `src/reviewPanel.ts`, the `FileReviewItem` constructor currently sets `description` to the relative directory path when `showPath = true`.

**New behavior for Pending items:**

Replace the existing `this.description = showPath ? relativeDir(filePath) : undefined` assignment in `FileReviewItem` with:

```ts
if (reviewStatus === "pending") {
  const stats = sessionManager.getDiffStats(filePath);
  const entry = sessionManager.getSession()?.files[filePath];
  if (stats) {
    this.description = entry?.originalContent === null
      ? `+${stats.added}`                            // new file — no removals
      : `+${stats.added} −${stats.removed}`;
  } else {
    this.description = showPath ? relativeDir(filePath) : undefined;
  }
} else {
  // Accepted and Rejected items: keep existing path hint
  this.description = showPath ? relativeDir(filePath) : undefined;
}
```

`getDiffStats()` returns `null` when the file cannot be read from disk or is not pending; in that case, fall back to the existing path description.

### 4.3 `getDiffStats` method on `SessionManager`

```ts
private diffStatsCache = new Map<string, { added: number; removed: number }>();

getDiffStats(filePath: string): { added: number; removed: number } | null {
  if (this.diffStatsCache.has(filePath)) {
    return this.diffStatsCache.get(filePath)!;
  }

  const entry = this.session?.files[filePath];
  if (!entry || entry.reviewStatus !== "pending") return null;

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const original = entry.originalContent ?? "";
  const changes  = diffLines(original, currentContent);

  let added = 0, removed = 0;
  for (const change of changes) {
    if (change.added)   added   += change.count ?? 0;
    if (change.removed) removed += change.count ?? 0;
  }

  const stats = { added, removed };
  this.diffStatsCache.set(filePath, stats);
  return stats;
}
```

**Cache invalidation:** Clear `diffStatsCache` at the start of `persist()`, before writing. This ensures stats are recomputed after any accept/reject action.

```ts
private persist(): void {
  this.diffStatsCache.clear();   // ← add this line
  // ... existing logic ...
}
```

### 4.4 `diff` import in `sessionManager.ts`

Add at the top of `src/sessionManager.ts`:

```ts
import { diffLines } from "diff";
```

The `diff` package is already listed in `package.json` dependencies (used by `diffProvider.ts`).

---

## 5. Feature D3: Auto-Advance

### 5.1 Overview

After a file's `reviewStatus` transitions from `"pending"` to `"accepted"` or `"rejected"` (via file-level or hunk-level action), the extension automatically closes the current diff editor and opens the diff for the next pending file.

### 5.2 VS Code Setting

Add to `package.json` `contributes.configuration`:

```json
{
  "claudegate.autoAdvance": {
    "type": "boolean",
    "default": true,
    "description": "Automatically open the next pending file after accepting or rejecting a change."
  }
}
```

Read with:

```ts
vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)
```

### 5.3 Trigger points

Auto-advance fires from two places:

1. **File-level decisions:** Inside the `claudegate.acceptFile` and `claudegate.rejectFile` command handlers in `extension.ts`, after calling `sessionManager.acceptFile()` / `sessionManager.rejectFile()`.

2. **Hunk decisions that complete a file:** Inside `claudegate.acceptHunk` and `claudegate.rejectHunk` command handlers. Check: after the hunk decision, does `entry.reviewStatus` become `"accepted"` or `"rejected"`? If yes, trigger auto-advance.

### 5.4 Auto-advance implementation

Extract into a helper in `extension.ts`:

```ts
async function autoAdvance(
  sessionManager: SessionManager,
  justDecidedPath: string
): Promise<void> {
  const enabled = vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true);
  if (!enabled) return;

  const session = sessionManager.getSession();
  if (!session) return;

  const nextPath = Object.entries(session.files).find(
    ([fp, e]) => fp !== justDecidedPath && e.reviewStatus === "pending"
  )?.[0];

  if (!nextPath) return; // no more pending files

  await closeDiffEditor(justDecidedPath);
  await openDiff(nextPath, sessionManager);
}
```

**File ordering:** `Object.entries()` preserves insertion order, which matches the order files were added to the session (hook execution order). This is stable and deterministic.

### 5.5 Bulk action exclusion

`claudegate.acceptAll` and `claudegate.rejectAll` do NOT trigger auto-advance — they already handle all pending files in one shot and close all diff editors. Adding auto-advance on top would be redundant and confusing.

Folder-level `acceptFolder` / `rejectFolder` similarly do not trigger auto-advance for the same reason.

### 5.6 Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Last pending file decided | `nextPath` is undefined; auto-advance skips. Session transitions to `reviewed`. |
| User has `autoAdvance = false` | Guard check at top of `autoAdvance()` returns early. |
| Hunk decided but file still has pending hunks | `entry.reviewStatus` is still `"pending"` after `updateFileStatus()`. Auto-advance is not triggered. |
| New file added by hook.py during review | `Object.entries()` at advance time picks up the freshly added file. No crash; stable ordering. |
| `closeDiffEditor` fails (tab already closed) | `closeDiffEditor` already silently handles tabs not found. `openDiff` still fires. |

---

## 6. Component Interaction Diagram

```
User Action (CodeLens / TreeView button)
         │
         ▼
  extension.ts (command handler)
  ┌─────────────────────────────────────────┐
  │  claudegate.acceptHunk / rejectHunk     │
  │  claudegate.acceptFile / rejectFile     │
  └────────────────┬────────────────────────┘
                   │ calls
                   ▼
  sessionManager.ts
  ┌─────────────────────────────────────────┐
  │  acceptHunk / rejectHunk                │
  │    → writeMergedFile(filePath)          │
  │    → updateFileStatus(filePath)         │
  │  acceptFile / rejectFile                │
  │    → fs.writeFileSync / unlinkSync      │
  │  getDiffStats(filePath)                 │
  │    → diffLines(original, current)       │
  │    → diffStatsCache                     │
  │  persist()                              │
  │    → diffStatsCache.clear()             │
  │    → atomicWrite(session.json)          │
  │    → _onSessionChange.fire()            │
  └────────────────┬────────────────────────┘
                   │ event
         ┌─────────┼─────────┐
         ▼         ▼         ▼
  reviewPanel.ts  hunkReviewProvider.ts  extension.ts
  ┌──────────────┐ ┌──────────────────┐  ┌────────────────────────┐
  │ refresh tree │ │ refresh CodeLens │  │ update badge / context │
  │ FileReview   │ │ (hide decided    │  │ autoAdvance()          │
  │ Item gets    │ │  hunks)          │  │  → closeDiffEditor()   │
  │ getDiffStats │ └──────────────────┘  │  → openDiff(next)      │
  └──────────────┘                       └────────────────────────┘

Virtual document (claudegate: URI scheme):
  diffProvider.ts
  ┌──────────────────────────────────────────┐
  │  openDiff()                              │
  │    → computeHunks() if entry.hunks null  │
  │    → capture entry.claudeContent         │
  │    → sessionManager.updateFileEntry()    │
  │    → vscode.diff(claudegate:, file:)     │
  └──────────────────────────────────────────┘

  hunkReviewProvider.ts
  ┌──────────────────────────────────────────┐
  │  provideCodeLenses(document)             │
  │    → check session for file.hunks        │
  │    → emit CodeLens at hunk.startLine     │
  └──────────────────────────────────────────┘
```

---

## 7. Edge Cases and Error Handling

### 7.1 File deleted externally during review

If a file is deleted outside the extension while a hunk review is in progress, `writeMergedFile()` will throw. Wrap in try/catch:

```ts
try {
  this.writeMergedFile(filePath);
} catch (err) {
  this.log.appendLine(`[ERROR] writeMergedFile failed: ${(err as Error).message}`);
  vscode.window.showErrorMessage(`ClaudeGate: Could not write merged file — ${(err as Error).message}`);
}
```

### 7.2 `originalContent === null` (new file) and hunk review

A new file has `originalContent === null`. Hunk-level review is not meaningful for purely-added files. Behaviour:

- Do NOT compute hunks for new files. `entry.hunks` remains absent.
- The diff view shows the new file in full (existing behaviour).
- File-level Accept/Reject is the only option.

Guard in `openDiff()`:

```ts
if (entry.originalContent !== null && !entry.hunks) {
  // compute and store hunks
}
```

### 7.3 Empty diff (no changes detected)

If `diffLines` returns no added/removed changes (file is identical to original), hunks will be empty (`[]`). In this case:

- `updateFileStatus()` sees `anyPending = false`, `anyAccepted = false`, `allRejected = true` (vacuously). This would incorrectly set `reviewStatus = "rejected"`.
- Guard: if `entry.hunks.length === 0`, do not call `updateFileStatus()`. Leave the file as `"pending"` (unusual but safe).

### 7.4 Session written by hook.py during hunk review

There is a known race condition (documented in `sessionManager.ts`) where `hook.py` and the extension may both write `session.json` simultaneously. The `atomicWrite` (rename-based) prevents torn reads but not lost writes.

For hunk review specifically: if hook.py adds a new file entry while the user is mid-hunk-review of another file, the extension's next `persist()` will overwrite hook.py's write. Mitigation: read-merge-write (load fresh session before mutating) is the correct long-term fix, but is out of scope for this iteration.

### 7.5 `claudeContent` unavailable for `writeMergedFile`

If `entry.claudeContent` is absent or null when `writeMergedFile` is called, there is nothing to merge from. This should not happen in normal flow (it is captured before hunk computation). Guard:

```ts
if (!entry.claudeContent || !entry.originalContent) {
  this.log.appendLine(`[WARN] writeMergedFile: missing content for ${filePath}`);
  return;
}
```

### 7.6 `diffStatsCache` memory

The cache is a plain `Map` on `SessionManager`. It is cleared on every `persist()` call, so it never grows unboundedly. Maximum size is bounded by the number of files in the session (typically < 50).

### 7.7 CodeLens on non-pending files

`HunkReviewProvider.provideCodeLenses()` must return `[]` when:
- The document's `fsPath` is not in the current session.
- The file entry has no `hunks`.
- The file's `reviewStatus` is not `"pending"` (hunk buttons are hidden for decided files).

This prevents stale CodeLens buttons appearing after a file is accepted/rejected at the file level.

---

## 8. `package.json` Changes Required

### 8.1 New commands

In `contributes.commands`:

```json
{ "command": "claudegate.acceptHunk", "title": "ClaudeGate: Accept Hunk" },
{ "command": "claudegate.rejectHunk", "title": "ClaudeGate: Reject Hunk" }
```

In `contributes.menus["commandPalette"]`, exclude both from the palette with a `"when": "false"` condition:

```json
"commandPalette": [
  { "command": "claudegate.acceptHunk", "when": "false" },
  { "command": "claudegate.rejectHunk", "when": "false" }
]
```

This is the correct VS Code pattern for commands that exist only as CodeLens targets: they must be registered (so the runtime can invoke them) but should not appear in the Command Palette.

### 8.2 New configuration

```json
"contributes": {
  "configuration": {
    "title": "ClaudeGate",
    "properties": {
      "claudegate.autoAdvance": {
        "type": "boolean",
        "default": true,
        "description": "Automatically open the next pending file after accepting or rejecting a change."
      }
    }
  }
}
```

---

## 9. New and Modified Files Summary

| File | Change |
|------|--------|
| `src/sessionManager.ts` | Add `HunkEntry` interface; add `hunks?` to `FileEntry`; add `acceptHunk()`, `rejectHunk()`, `writeMergedFile()`, `updateFileStatus()`, `getDiffStats()`, `updateFileEntry()`; add `diffStatsCache`; clear cache in `persist()` |
| `src/diffProvider.ts` | Add hunk computation in `openDiff()`; capture `claudeContent` before computing hunks |
| `src/hunkReviewProvider.ts` | **New file.** `CodeLensProvider` for `{ scheme: "file" }` documents with session hunks |
| `src/reviewPanel.ts` | `FileReviewItem` shows diff stats as `description` for pending files |
| `src/extension.ts` | Register `HunkReviewProvider`; add `claudegate.acceptHunk` and `claudegate.rejectHunk` commands; add `autoAdvance()` helper; call it from accept/reject handlers |
| `package.json` | Add two new commands; add `claudegate.autoAdvance` configuration |

---

## 10. Implementation Order

The features have some dependency ordering:

1. **Session schema** — `HunkEntry` interface and `hunks?` on `FileEntry` must be added first (other features depend on it).
2. **Hunk computation** — `computeHunks()` in `diffProvider.ts` and `claudeContent` capture.
3. **`writeMergedFile` + hunk state methods** in `sessionManager.ts`.
4. **`HunkReviewProvider`** — depends on session schema and hunk commands.
5. **Hunk commands** in `extension.ts`.
6. **Diff stats** — `getDiffStats()` and `FileReviewItem` description update (independent of D1 aside from the schema).
7. **Auto-advance** — depends on hunk commands existing (trigger point), otherwise independent.

D2 (diff stats) and D3 (auto-advance) can be implemented in parallel with D1 steps 4–5 once the schema and session methods are in place.
