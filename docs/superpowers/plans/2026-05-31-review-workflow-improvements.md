# Review Workflow Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hunk-level Accept/Reject within the diff view, `+N −M` diff stat badges in the Pending sidebar panel, and auto-advance to the next pending file after each decision.

**Architecture:** Extends the session schema with `HunkEntry[]` per file, computed lazily when a diff is first opened. Hunk decisions rewrite the on-disk file as a merge of accepted/rejected/pending hunks. Diff stats and auto-advance are independent features that share the same session event bus.

**Tech Stack:** TypeScript, VS Code Extension API (`CodeLensProvider`), `diff` npm package (already installed), `fs`/`path`/`crypto` (already used).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sessionManager.ts` | Modify | Add `HunkEntry`, extend `FileEntry`, add hunk/stats methods |
| `src/diffProvider.ts` | Modify | Add `computeHunks`, capture `claudeContent`, trigger hunk init on `openDiff` |
| `src/hunkReviewProvider.ts` | **Create** | `CodeLensProvider` showing Accept/Reject buttons at each hunk |
| `src/reviewPanel.ts` | Modify | `FileReviewItem` shows `+N −M` stats for pending files |
| `src/extension.ts` | Modify | Register provider, add hunk commands, auto-advance helper |
| `package.json` | Modify | New commands, commandPalette exclusions, `claudegate.autoAdvance` config |

---

## Task 1: Session schema — HunkEntry type, FileEntry.hunks, updateFileEntry

**Files:**
- Modify: `src/sessionManager.ts:7-20`

- [ ] **Add `HunkEntry` interface and `hunks?` field to `FileEntry`**

In `src/sessionManager.ts`, replace the existing interfaces block (lines 7–20):

```typescript
export type ReviewStatus = "pending" | "accepted" | "rejected";
export type SessionStatus = "active" | "reviewed";

export interface HunkEntry {
  id: string;         // "<origStart>:<origEnd>" for edits/deletions; "ins:<origLine>" for pure insertions
  startLine: number;  // 0-indexed line in Claude's version of the file (for CodeLens placement)
  reviewStatus: "pending" | "accepted" | "rejected";
}

export interface FileEntry {
  originalContent: string | null;
  claudeContent?: string | null;
  reviewStatus: ReviewStatus;
  hunks?: HunkEntry[];
}
```

- [ ] **Add `updateFileEntry` method to `SessionManager`**

Add after the `getSession()` method (after line ~60):

```typescript
updateFileEntry(filePath: string, entry: FileEntry): void {
  if (!this.session) return;
  this.session.files[filePath] = entry;
  this.persist();
}
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/sessionManager.ts
git commit -m "feat: add HunkEntry type, FileEntry.hunks, updateFileEntry"
```

---

## Task 2: computeHunks helper + hunk init in openDiff

**Files:**
- Modify: `src/diffProvider.ts`

- [ ] **Add `fs` import and `HunkEntry` import to `diffProvider.ts`**

Replace the top of `src/diffProvider.ts` (lines 1–4):

```typescript
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { diffLines } from "diff";
import { SessionManager, HunkEntry } from "./sessionManager";
```

- [ ] **Add `computeHunks` helper function**

Add after the `claudeUri` export (after line 43), before the `openDiff` function:

```typescript
// ─── Hunk computation ─────────────────────────────────────────────────────────

export function computeHunks(originalContent: string, claudeContent: string): HunkEntry[] {
  const changes = diffLines(originalContent, claudeContent);
  const hunks: HunkEntry[] = [];
  let origLine = 0;
  let modLine  = 0;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    const count  = change.count ?? 0;

    if (change.removed) {
      const origStart   = origLine;
      const origEnd     = origLine + count - 1;
      const hunkModLine = modLine;
      origLine += count;

      if (i + 1 < changes.length && changes[i + 1].added) {
        // replace hunk: removed immediately followed by added → one logical hunk
        i++;
        const addCount = changes[i].count ?? 0;
        hunks.push({ id: `${origStart}:${origEnd}`, startLine: hunkModLine, reviewStatus: "pending" });
        modLine += addCount;
      } else {
        // pure deletion hunk
        hunks.push({ id: `${origStart}:${origEnd}`, startLine: hunkModLine, reviewStatus: "pending" });
      }
    } else if (change.added) {
      // pure insertion — ID encodes insertion point in original
      hunks.push({ id: `ins:${origLine}`, startLine: modLine, reviewStatus: "pending" });
      modLine += count;
    } else {
      origLine += count;
      modLine  += count;
    }
    i++;
  }
  return hunks;
}
```

- [ ] **Initialise hunks on first diff open**

In `openDiff`, insert the hunk-init block immediately after the `const entry = session.files[filePath];` line (currently line 55) and before the rejected-new-file early return:

```typescript
  // Capture Claude's content and compute hunks on first open (skip new files)
  if (entry.originalContent !== null && !entry.hunks) {
    try {
      entry.claudeContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      entry.claudeContent = "";
    }
    entry.hunks = computeHunks(entry.originalContent, entry.claudeContent);
    sessionManager.updateFileEntry(filePath, entry);
  }
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/diffProvider.ts
git commit -m "feat: computeHunks helper, capture claudeContent on first diff open"
```

---

## Task 3: writeMergedFile, updateFileStatus, acceptHunk, rejectHunk

**Files:**
- Modify: `src/sessionManager.ts`

- [ ] **Add `diffLines` import to `sessionManager.ts`**

Add to the imports block at the top of `src/sessionManager.ts`:

```typescript
import { diffLines } from "diff";
```

- [ ] **Add `updateFileStatus` private method**

Add before the `persist()` method:

```typescript
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
  } else if (anyAccepted) {
    entry.reviewStatus = "accepted";
  }
  // empty hunks array: leave reviewStatus unchanged
}
```

- [ ] **Add `writeMergedFile` private method**

Add after `updateFileStatus`:

```typescript
private writeMergedFile(filePath: string): void {
  const entry = this.session!.files[filePath];
  if (!entry.originalContent || !entry.claudeContent || !entry.hunks) {
    this.log.appendLine(`[WARN] writeMergedFile: missing content for ${filePath}`);
    return;
  }

  const originalLines = entry.originalContent.split("\n");
  const claudeLines   = entry.claudeContent.split("\n");
  const changes       = diffLines(entry.originalContent, entry.claudeContent);
  const output: string[] = [];
  let origIdx = 0;
  let modIdx  = 0;
  let hunkIdx = 0;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    const count  = change.count ?? 0;

    if (change.removed) {
      const hunk      = entry.hunks[hunkIdx];
      const isReplace = i + 1 < changes.length && changes[i + 1].added;

      if (hunk.reviewStatus === "rejected") {
        output.push(...originalLines.slice(origIdx, origIdx + count));
      }
      origIdx += count;

      if (isReplace) {
        i++;
        const addCount = changes[i].count ?? 0;
        if (hunk.reviewStatus !== "rejected") {
          output.push(...claudeLines.slice(modIdx, modIdx + addCount));
        }
        modIdx += addCount;
      }
      hunkIdx++;

    } else if (change.added) {
      const hunk = entry.hunks[hunkIdx];
      if (hunk.reviewStatus !== "rejected") {
        output.push(...claudeLines.slice(modIdx, modIdx + count));
      }
      modIdx += count;
      hunkIdx++;

    } else {
      output.push(...originalLines.slice(origIdx, origIdx + count));
      origIdx += count;
      modIdx  += count;
    }
    i++;
  }

  try {
    this.atomicWrite(filePath, output.join("\n"));
  } catch (err) {
    this.log.appendLine(`[ERROR] writeMergedFile failed for ${filePath}: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`ClaudeGate: Could not write merged file — ${(err as Error).message}`);
  }
}
```

- [ ] **Modify `acceptFile` to restore Claude's content when hunks exist**

Find the existing `acceptFile` method and replace it:

```typescript
acceptFile(filePath: string): void {
  const entry = this.session?.files[filePath];
  if (!entry || entry.reviewStatus !== "pending") return;

  // If any hunk was rejected, the on-disk file has original lines for that hunk.
  // File-level Accept means "keep all of Claude's changes", so restore the full
  // Claude content before marking accepted.
  if (entry.claudeContent && entry.hunks?.some(h => h.reviewStatus === "rejected")) {
    try {
      this.atomicWrite(filePath, entry.claudeContent);
    } catch (err) {
      this.log.appendLine(`[ERROR] acceptFile restore failed for ${filePath}: ${(err as Error).message}`);
    }
  }

  entry.reviewStatus = "accepted";
  this.log.appendLine(`[INFO] Accepted: ${filePath}`);
  this.persist();
}
```

- [ ] **Add `acceptHunk` and `rejectHunk` public methods**

Add after the updated `acceptFile`:

```typescript
acceptHunk(filePath: string, hunkId: string): void {
  const entry = this.session?.files[filePath];
  if (!entry?.hunks) return;
  const hunk = entry.hunks.find(h => h.id === hunkId);
  if (!hunk) return;
  hunk.reviewStatus = "accepted";
  this.writeMergedFile(filePath);
  this.updateFileStatus(filePath);
  this.persist();
}

rejectHunk(filePath: string, hunkId: string): void {
  const entry = this.session?.files[filePath];
  if (!entry?.hunks) return;
  const hunk = entry.hunks.find(h => h.id === hunkId);
  if (!hunk) return;
  hunk.reviewStatus = "rejected";
  this.writeMergedFile(filePath);
  this.updateFileStatus(filePath);
  this.persist();
}
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/sessionManager.ts
git commit -m "feat: writeMergedFile, updateFileStatus, acceptHunk, rejectHunk"
```

---

## Task 4: HunkReviewProvider

**Files:**
- Create: `src/hunkReviewProvider.ts`

- [ ] **Create `src/hunkReviewProvider.ts`**

```typescript
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

export class HunkReviewProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") return [];

    const filePath = document.uri.fsPath;
    const entry    = this.sessionManager.getSession()?.files[filePath];

    // Only show hunk buttons for pending files that have computed hunks
    if (!entry || entry.reviewStatus !== "pending" || !entry.hunks?.length) return [];

    const lenses: vscode.CodeLens[] = [];

    for (const hunk of entry.hunks) {
      const line  = Math.min(hunk.startLine, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);

      if (hunk.reviewStatus === "pending") {
        lenses.push(
          new vscode.CodeLens(range, {
            title:     "✓ Accept hunk",
            command:   "claudegate.acceptHunk",
            arguments: [{ filePath, hunkId: hunk.id }],
          }),
          new vscode.CodeLens(range, {
            title:     "✕ Reject hunk",
            command:   "claudegate.rejectHunk",
            arguments: [{ filePath, hunkId: hunk.id }],
          })
        );
      } else if (hunk.reviewStatus === "accepted") {
        lenses.push(
          new vscode.CodeLens(range, {
            title:     "✓ Accepted · Undo",
            command:   "claudegate.rejectHunk",
            arguments: [{ filePath, hunkId: hunk.id }],
          })
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title:     "✕ Rejected · Undo",
            command:   "claudegate.acceptHunk",
            arguments: [{ filePath, hunkId: hunk.id }],
          })
        );
      }
    }

    return lenses;
  }
}
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/hunkReviewProvider.ts
git commit -m "feat: HunkReviewProvider — CodeLens Accept/Reject per hunk"
```

---

## Task 5: Hunk commands in extension.ts + package.json

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Add `HunkReviewProvider` import and `openDiff` to `extension.ts`**

In `src/extension.ts`, make two import changes:

Add a new import line:
```typescript
import { HunkReviewProvider } from "./hunkReviewProvider";
```

And extend the existing `diffProvider` import to include `openDiff`:
```typescript
import { ClaudeGateContentProvider, SCHEME, openDiff } from "./diffProvider";
```

- [ ] **Register `HunkReviewProvider` in `activate()`**

Add after the `ClaudeGateDecorationProvider` registration block (after the `context.subscriptions.push(vscode.window.registerFileDecorationProvider(...))` call):

```typescript
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        new HunkReviewProvider(sessionManager)
      )
    );
```

- [ ] **Add `claudegate.acceptHunk` and `claudegate.rejectHunk` command handlers**

Add after the `claudegate.rejectFile` command handler, before the folder actions block:

```typescript
      vscode.commands.registerCommand(
        "claudegate.acceptHunk",
        (item: { filePath: string; hunkId: string }) => {
          sessionManager.acceptHunk(item.filePath, item.hunkId);
        }
      ),

      vscode.commands.registerCommand(
        "claudegate.rejectHunk",
        (item: { filePath: string; hunkId: string }) => {
          sessionManager.rejectHunk(item.filePath, item.hunkId);
        }
      ),
```

- [ ] **Add new commands to `package.json` `contributes.commands`**

In `package.json`, add to the `contributes.commands` array (after the existing `claudegate.rejectFile` entry):

```json
      {
        "command": "claudegate.acceptHunk",
        "title": "ClaudeGate: Accept Hunk"
      },
      {
        "command": "claudegate.rejectHunk",
        "title": "ClaudeGate: Reject Hunk"
      },
```

- [ ] **Exclude hunk commands from Command Palette in `package.json`**

In `package.json`, add to the `contributes.menus.commandPalette` array:

```json
        { "command": "claudegate.acceptHunk", "when": "false" },
        { "command": "claudegate.rejectHunk", "when": "false" },
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Compile and smoke-test**

```bash
npm run compile
```

Press F5 to launch Extension Development Host. Open a pending file's diff — hunk Accept/Reject CodeLens should appear above each changed section.

- [ ] **Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: register HunkReviewProvider, acceptHunk/rejectHunk commands"
```

---

## Task 6: Diff stats (D2)

**Files:**
- Modify: `src/sessionManager.ts`
- Modify: `src/reviewPanel.ts`

- [ ] **Add `diffStatsCache` and `getDiffStats` to `SessionManager`**

In `src/sessionManager.ts`, add the cache as a private field after the `watcher` field declaration (around line 30):

```typescript
  private diffStatsCache = new Map<string, { added: number; removed: number }>();
```

Add `getDiffStats` as a public method after `updateFileEntry`:

```typescript
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

- [ ] **Clear `diffStatsCache` at the start of `persist()`**

In `src/sessionManager.ts`, find the `private persist(): void` method and add one line at the top of the method body:

```typescript
  private persist(): void {
    this.diffStatsCache.clear();   // invalidate stats after any session change
    if (!this.session) return;
    // ... rest of existing method unchanged ...
```

- [ ] **Show diff stats in `FileReviewItem`**

In `src/reviewPanel.ts`, update the `FileReviewItem` constructor. Replace the line:

```typescript
    this.description  = showPath ? relativeDir(filePath) : undefined;
```

with:

```typescript
    if (reviewStatus === "pending") {
      const stats = sessionManager.getDiffStats(filePath);
      if (stats) {
        this.description = entry?.originalContent === null
          ? `+${stats.added}`
          : `+${stats.added} −${stats.removed}`;
      } else {
        this.description = showPath ? relativeDir(filePath) : undefined;
      }
    } else {
      this.description = showPath ? relativeDir(filePath) : undefined;
    }
```

Also add `entry` lookup before the description block (it is needed for the `originalContent === null` check). Add after `super(...)` and before `this.resourceUri`:

```typescript
    const entry = sessionManager.getSession()?.files[filePath];
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/sessionManager.ts src/reviewPanel.ts
git commit -m "feat: diff stats (+N −M) in Pending sidebar panel"
```

---

## Task 7: Auto-advance (D3)

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Add `claudegate.autoAdvance` configuration to `package.json`**

In `package.json`, add a `contributes.configuration` section (if none exists) or add to the existing `properties` block:

```json
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
```

- [ ] **Add `autoAdvance` helper to `extension.ts`**

Add after the `refreshActiveFilePendingContext` function (before the `activate` function):

```typescript
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

  if (!nextPath) return;

  await closeDiffEditor(justDecidedPath);
  await openDiff(nextPath, sessionManager);
}
```

- [ ] **Wire auto-advance into `claudegate.acceptFile`**

In `src/extension.ts`, update the `claudegate.acceptFile` handler to call `autoAdvance` after accepting:

```typescript
      vscode.commands.registerCommand(
        "claudegate.acceptFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(sessionManager);
          if (!filePath) return;
          sessionManager.acceptFile(filePath);
          await autoAdvance(sessionManager, filePath);
        }
      ),
```

- [ ] **Wire auto-advance into `claudegate.rejectFile`**

Update the `claudegate.rejectFile` handler:

```typescript
      vscode.commands.registerCommand(
        "claudegate.rejectFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(sessionManager);
          if (!filePath) return;
          const answer = await vscode.window.showWarningMessage(
            `Revert "${path.basename(filePath)}" to its original content?`,
            { modal: false },
            "Revert"
          );
          if (answer === "Revert") {
            sessionManager.rejectFile(filePath);
            await autoAdvance(sessionManager, filePath);
          }
        }
      ),
```

- [ ] **Wire auto-advance into hunk commands**

Update the hunk command handlers to trigger auto-advance when a hunk decision completes the file:

```typescript
      vscode.commands.registerCommand(
        "claudegate.acceptHunk",
        async (item: { filePath: string; hunkId: string }) => {
          sessionManager.acceptHunk(item.filePath, item.hunkId);
          const entry = sessionManager.getSession()?.files[item.filePath];
          if (entry && entry.reviewStatus !== "pending") {
            await autoAdvance(sessionManager, item.filePath);
          }
        }
      ),

      vscode.commands.registerCommand(
        "claudegate.rejectHunk",
        async (item: { filePath: string; hunkId: string }) => {
          sessionManager.rejectHunk(item.filePath, item.hunkId);
          const entry = sessionManager.getSession()?.files[item.filePath];
          if (entry && entry.reviewStatus !== "pending") {
            await autoAdvance(sessionManager, item.filePath);
          }
        }
      ),
```

- [ ] **Remove the old `closeDiffEditor` call from `acceptFile` (now handled by autoAdvance)**

`autoAdvance` calls `closeDiffEditor` before opening the next file. The old explicit `closeDiffEditor` in `acceptFile`/`rejectFile` is no longer needed since `autoAdvance` closes the diff. However, if auto-advance is disabled, the diff should still be closed. Update `autoAdvance` to always close the diff:

```typescript
async function autoAdvance(
  sessionManager: SessionManager,
  justDecidedPath: string
): Promise<void> {
  await closeDiffEditor(justDecidedPath);  // always close, regardless of setting

  const enabled = vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true);
  if (!enabled) return;

  const session = sessionManager.getSession();
  if (!session) return;

  const nextPath = Object.entries(session.files).find(
    ([fp, e]) => fp !== justDecidedPath && e.reviewStatus === "pending"
  )?.[0];

  if (!nextPath) return;

  await openDiff(nextPath, sessionManager);
}
```

- [ ] **Verify**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Final compile**

```bash
npm run compile
```

Expected: bundle output, no errors.

- [ ] **Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: auto-advance to next pending file after accept/reject (claudegate.autoAdvance)"
```

---

## Task 8: Final push

- [ ] **Push all commits**

```bash
git push
```

- [ ] **Smoke test checklist**

Press F5 to open Extension Development Host. Verify:
1. Open a pending file's diff → hunk CodeLens ("✓ Accept hunk" / "✕ Reject hunk") appears above each changed block
2. Click "✓ Accept hunk" on one hunk → CodeLens changes to "✓ Accepted · Undo"; file is still pending
3. Click "✕ Reject hunk" on remaining hunks → file moves to Rejected panel; diff closes; next pending file opens
4. Pending panel shows "+N −M" line counts next to each file name
5. After accepting the last file, no auto-advance fires (no more pending files)
6. Set `claudegate.autoAdvance: false` in settings → after accept, diff closes but next file does NOT auto-open
