# GUI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture file changes made by the Claude Code VS Code GUI extension in ClaudeGate's review panel, without affecting the existing terminal CLI hook flow.

**Architecture:** A new `DocumentTracker` class watches VS Code document lifecycle events to snapshot file contents before Claude edits them, then detects changes via a file system watcher. It calls a new `SessionManager.trackFileChange()` method that mirrors the logic in `hook.py`. Both detection paths (hook + tracker) are additive — whichever fires first for a given file owns it; the other skips it.

**Tech Stack:** TypeScript, VS Code Extension API (`workspace.onDidOpenTextDocument`, `workspace.createFileSystemWatcher`, `workspace.textDocuments`)

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/sessionManager.ts` | Add `trackFileChange(filePath, originalContent)` public method |
| Create | `src/documentTracker.ts` | Snapshot files on open; detect FS changes; call `trackFileChange` |
| Modify | `src/extension.ts` | Initialize and wire up `DocumentTracker` |
| Modify | `README.md` | Update to note GUI support |

---

## Task 1: Add `trackFileChange` to `SessionManager`

**Files:**
- Modify: `src/sessionManager.ts` — add after the `getPendingCount` method (around line 79)

- [ ] **Step 1: Add the method**

Open `src/sessionManager.ts`. After the `getPendingCount(): number` method (line 79), insert:

```typescript
trackFileChange(filePath: string, originalContent: string | null): void {
  if (!this.session) {
    this.session = {
      sessionId: new Date().toISOString(),
      status: "active",
      files: {},
    };
  }

  const existing = this.session.files[filePath];

  if (!existing) {
    this.session.files[filePath] = { originalContent, reviewStatus: "pending" };
    if (this.session.status === "reviewed") {
      this.session.status = "active";
    }
    this.persist();
    return;
  }

  if (existing.reviewStatus === "accepted" || existing.reviewStatus === "rejected") {
    existing.originalContent = originalContent;
    existing.reviewStatus = "pending";
    existing.claudeContent = undefined;
    this.session.status = "active";
    this.persist();
  }
  // already pending → no-op
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sessionManager.ts
git commit -m "feat: add trackFileChange to SessionManager for GUI detection"
```

---

## Task 2: Create `DocumentTracker`

**Files:**
- Create: `src/documentTracker.ts`

- [ ] **Step 1: Create the file**

Create `src/documentTracker.ts` with this content:

```typescript
import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";

export class DocumentTracker {
  private readonly snapshots = new Map<string, string | null>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly workspacePath: string | undefined,
    private readonly log: vscode.OutputChannel
  ) {}

  start(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.snapshotDocument(doc);
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.snapshotDocument(doc))
    );

    if (!this.workspacePath) return;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspacePath, "**/*")
    );

    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => this.handleFileChange(uri)),
      watcher.onDidCreate((uri) => this.handleFileChange(uri))
    );
  }

  stop(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private snapshotDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file") return;
    const filePath = doc.uri.fsPath;
    if (!this.isInWorkspace(filePath)) return;
    if (!this.snapshots.has(filePath)) {
      this.snapshots.set(filePath, doc.getText());
    }
  }

  private handleFileChange(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    if (!this.isInWorkspace(filePath)) return;

    const session = this.sessionManager.getSession();
    if (session?.files[filePath]) return;

    const originalContent = this.snapshots.has(filePath)
      ? (this.snapshots.get(filePath) ?? null)
      : null;

    this.sessionManager.trackFileChange(filePath, originalContent);
    this.log.appendLine(`[INFO] DocumentTracker: captured ${path.basename(filePath)}`);
  }

  private isInWorkspace(filePath: string): boolean {
    if (!this.workspacePath) return false;
    return filePath.startsWith(this.workspacePath + path.sep);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/documentTracker.ts
git commit -m "feat: add DocumentTracker for VS Code GUI file change detection"
```

---

## Task 3: Wire `DocumentTracker` into `extension.ts`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Add import**

At the top of `src/extension.ts`, add alongside the existing imports:

```typescript
import { DocumentTracker } from "./documentTracker";
```

- [ ] **Step 2: Initialize and wire up**

In `src/extension.ts`, inside the `activate` function, after the line:

```typescript
const hookInstaller  = new HookInstaller(context, log);
```

Add:

```typescript
const documentTracker = new DocumentTracker(sessionManager, workspacePath, log);
```

Then after `sessionManager.startWatching();` (near the bottom of `activate`), add:

```typescript
documentTracker.start();
context.subscriptions.push({ dispose: () => documentTracker.stop() });
```

- [ ] **Step 3: Typecheck and compile**

```bash
npm run typecheck && npm run compile
```

Expected: no errors, `out/extension.js` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire DocumentTracker into extension activation"
```

---

## Task 4: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the existing GUI note**

The README already has this note (added in v1.0.1):

```
> **Note:** ClaudeGate works with the **Claude Code terminal CLI** (`claude` command). The Claude Code VS Code/Cursor GUI extension is **not yet supported**...
```

Replace it with:

```markdown
> **Note:** ClaudeGate supports two modes: the **Claude Code terminal CLI** (`claude` command) via pre-install hooks, and the **Claude Code VS Code/Cursor GUI extension** via automatic file change detection. GUI mode works best in "pure sessions" where Claude makes changes and you review before editing further — all file changes during a GUI session are captured for review.
```

- [ ] **Step 2: Update the Requirements table**

The current Requirements table has:

```markdown
| [Claude Code](https://claude.ai/claude-code) | Anthropic's CLI |
```

Change the Notes column to:

```markdown
| [Claude Code](https://claude.ai/claude-code) | Terminal CLI or VS Code/Cursor GUI extension |
```

- [ ] **Step 3: Update "How It Works" section**

Replace the existing diagram:

```
Claude Code (terminal)
       │
  PreToolUse hook fires before each Write / Edit / MultiEdit
  ~/.claudegate/hook.py snapshots the current file content
       │
  ~/.claudegate/session.json  ←  shared state file
       │
  ClaudeGate extension watches for changes
       └── Updates review panels in real time
```

With:

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

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README to document GUI extension support"
```

---

## Task 5: Smoke Test & Publish

- [ ] **Step 1: Launch extension development host**

Press **F5** in VS Code (or run `code --extensionDevelopmentPath=.` from the project root). This opens a new VS Code window with ClaudeGate loaded from source.

- [ ] **Step 2: Verify CLI path still works**

In the Extension Development Host window, open a terminal and run:

```bash
echo '{"tool_name":"Write","cwd":"'$(pwd)'","tool_input":{"file_path":"test.txt"}}' \
  | python3 ~/.claudegate/hook.py
```

Expected: ClaudeGate sidebar shows `test.txt` as pending. If it does, the hook path is unaffected. ✓

Clean up: run `ClaudeGate: Clear Session` from the command palette.

- [ ] **Step 3: Verify GUI path**

In the Extension Development Host window:
1. Open any existing file in the workspace via the Explorer
2. From the terminal, directly overwrite it to simulate what the Claude Code GUI extension does:

```bash
echo "// modified by gui test" >> <path-to-the-file-you-just-opened>
```

Expected: ClaudeGate sidebar shows the file as pending with the correct original content in the diff. ✓

- [ ] **Step 4: Verify no double-tracking**

With a file already in the session from the hook (Step 2), simulate the FS watcher also firing for the same file:

```bash
touch test.txt
```

Expected: `test.txt` stays in the session exactly once — not duplicated. ✓

- [ ] **Step 5: Bump version and publish**

In `package.json`, change:

```json
"version": "1.0.1"
```
to:
```json
"version": "1.1.0"
```

Then:

```bash
git add package.json
git commit -m "chore: bump to v1.1.0 for GUI support"
vsce publish
```

Expected: extension published to VS Code Marketplace as v1.1.0.
