# Group Pending Review by Claude Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optionally group the review panels by the Claude session that produced each change, driven by a new `claudegate.groupBySession` setting.

**Architecture:** `hook.py` records `session_id` + `capturedAt` per file entry (it already receives `session_id`). `FilteredTreeProvider` gains a session-grouping layer: when the setting is on, root returns `SessionItem` nodes whose children use the existing folder/flat arrangement scoped to that session. A setting + toggle command + Settings-pane row control it.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc), Python 3 (hook). No new dependencies. Python `unittest` for the hook; typecheck/compile + manual for the TS UI.

## Global Constraints

- **No new dependencies.**
- **No version bump** — folds into unreleased `1.2.0`; extend the `## [1.2.0] — 2026-07-04` CHANGELOG entry, no new heading.
- **Default off** — `claudegate.groupBySession` defaults to `false`; when off, panels behave exactly as today (existing code path untouched).
- **Backward compatible** — `sessionId`/`capturedAt` are optional; existing and GUI-watcher entries lack them and collect under an "Unknown session" node.
- **Composes** with View-as-Tree/List: session grouping is the outer layer; the current arrangement applies within each session.
- **Most-recent session on top**; ordinal `N` = first-seen birth order (by earliest `capturedAt`).
- **Applies to all three panels** (they share `FilteredTreeProvider`).
- **TypeScript verification** — `npm run typecheck` and `npm run compile` pass after every TS task; `npm run test:unit` stays green.
- **Hook redeploy** — `hook.py` change needs Setup Hook re-run / activate auto-sync (note in docs).

---

## File Structure

- `hooks/hook.py` — MODIFY: record `session_id` + `capturedAt` on new + re-pending entries.
- `hooks/tests/test_hook.py` — MODIFY: `run_hook` accepts `session_id`; new capture test.
- `src/sessionManager.ts` — MODIFY: `FileEntry` gains optional `sessionId`/`capturedAt`.
- `src/reviewPanel.ts` — MODIFY: `SessionItem`, `FolderItem.sessionId`, `matchesSession`, `directChildren` param, `getChildren` grouping.
- `package.json` — MODIFY: `groupBySession` setting + `toggleGroupBySession` command.
- `src/extension.ts` — MODIFY: `toggleGroupBySession` command + config-change refresh listener.
- `src/settingsPanel.ts` — MODIFY: "Group by Session" row + config listener key.
- `CHANGELOG.md`, `readme.md` — MODIFY: docs.

---

## Task 1: Hook records `session_id` + `capturedAt`

**Files:**
- Modify: `hooks/hook.py` (`main()` — new-entry and accepted/rejected→re-pending branches)
- Test: `hooks/tests/test_hook.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: file entries written by the hook now carry `"sessionId"` (from `hook_input["session_id"]`, may be `null`) and `"capturedAt"` (ISO string).

- [ ] **Step 1: Make `run_hook` able to send a session_id + add the failing test**

In `hooks/tests/test_hook.py`, replace the `run_hook` method with:

```python
    def run_hook(self, session_id=None):
        payload_obj = {
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": self.file},
        }
        if session_id is not None:
            payload_obj["session_id"] = session_id
        payload = json.dumps(payload_obj)
        env = dict(os.environ, HOME=self.home)
        subprocess.run(
            [sys.executable, HOOK],
            input=payload, text=True, env=env, check=True,
        )
```

Add this test method to `HookBaselineTest`:

```python
    def test_captures_session_id_and_timestamp(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook(session_id="s-123")
        entry = self.read_entry()
        self.assertEqual(entry["sessionId"], "s-123")
        self.assertTrue(entry.get("capturedAt"))
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `python3 -m unittest discover -s hooks/tests -v`
Expected: `test_captures_session_id_and_timestamp` FAILS (KeyError `sessionId` — the hook doesn't write it yet); the other tests still pass.

- [ ] **Step 3: Record the fields in `hook.py`**

In `hooks/hook.py` `main()`, after computing `cwd` (near `cwd = hook_input.get("cwd", os.getcwd())`), add:

```python
    session_id = hook_input.get("session_id")
    captured_at = datetime.now(timezone.utc).isoformat()
```

In the new-entry branch, change the dict written for a brand-new file to include the two fields:

```python
        session["files"][file_path] = {
            "originalContent": original_content,
            "reviewStatus": "pending",
            "sessionId": session_id,
            "capturedAt": captured_at,
        }
```

In the `elif existing["reviewStatus"] in ("accepted", "rejected"):` branch, add the two fields alongside the existing updates:

```python
    elif existing["reviewStatus"] in ("accepted", "rejected"):
        existing["originalContent"] = original_content
        existing["reviewStatus"] = "pending"
        existing["sessionId"] = session_id
        existing["capturedAt"] = captured_at
        session["status"] = "active"
        save_session(session, session_file)
```

(`datetime`/`timezone` are already imported at the top of the file.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `python3 -m unittest discover -s hooks/tests -v`
Expected: all tests PASS (including `test_captures_session_id_and_timestamp`).

- [ ] **Step 5: Commit**

```bash
git add hooks/hook.py hooks/tests/test_hook.py
git commit -m "feat: hook records session_id and capturedAt per change

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Session grouping in `reviewPanel`

**Files:**
- Modify: `src/sessionManager.ts` (`FileEntry` fields)
- Modify: `src/reviewPanel.ts` (`SessionItem`, `FolderItem`, `matchesSession`, `directChildren`, `getChildren`)

**Interfaces:**
- Consumes: the `sessionId`/`capturedAt` fields written by Task 1.
- Produces: `export class SessionItem extends vscode.TreeItem { sessionId: string | null }`; `FolderItem` now takes an optional `sessionId?: string | null`; `getChildren` returns `SessionItem`s at root when `claudegate.groupBySession` is on.

- [ ] **Step 1: Add the schema fields**

In `src/sessionManager.ts`, extend `FileEntry`:

```typescript
export interface FileEntry {
  originalContent: string | null;
  claudeContent?: string | null; // saved at reject time so the action can be undone
  reviewStatus: ReviewStatus;
  sessionId?: string;  // Claude session_id that produced this change (hook path only)
  capturedAt?: string; // ISO timestamp of first capture
}
```

- [ ] **Step 2: Import `Session`/`FileEntry` and add `matchesSession` in `reviewPanel.ts`**

Change the sessionManager import at the top of `src/reviewPanel.ts` to include the types:

```typescript
import { SessionManager, ReviewStatus, Session, FileEntry } from "./sessionManager";
```

Add this module-level helper (e.g. just above `export class FolderItem`):

```typescript
// A file belongs to a session bucket: null = the "unknown" bucket (no session id).
function matchesSession(entry: FileEntry, sessionId: string | null): boolean {
  return sessionId === null ? !entry.sessionId : entry.sessionId === sessionId;
}
```

- [ ] **Step 3: Give `FolderItem` an optional session scope**

Replace the `FolderItem` constructor signature/body:

```typescript
export class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderPath: string,
    public readonly groupStatus: ReviewStatus,
    public readonly sessionId?: string | null
  ) {
    super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri  = vscode.Uri.file(folderPath);
    this.tooltip      = folderPath;
    this.contextValue = `claudegate.folder.${groupStatus}`;
  }
}
```

- [ ] **Step 4: Add the `SessionItem` class**

Add after `FolderItem` (before `FileReviewItem` or after it — anywhere at module top level):

```typescript
// ─── Session group item (group-by-session mode) ───────────────────────────────

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string | null,
    label: string,
    fileCount: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description  = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
    this.contextValue = "claudegate.session";
    this.iconPath     = new vscode.ThemeIcon(sessionId ? "history" : "question");
  }
}
```

- [ ] **Step 5: Extract `filteredFiles` and add `sessionGroups` to `FilteredTreeProvider`**

Add these private methods to `FilteredTreeProvider` (e.g. above `directChildren`):

```typescript
  private filteredFiles(session: Session): string[] {
    return Object.entries(session.files)
      .filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp) && !isExcluded(fp))
      .map(([fp]) => fp);
  }

  // Build one SessionItem per distinct session (known sessions ordered by
  // earliest capturedAt → ordinal N; displayed most-recent-first; unknown last).
  private sessionGroups(session: Session): vscode.TreeItem[] {
    const UNKNOWN = " unknown";
    const buckets = new Map<string, { key: string | null; files: string[]; earliest: string }>();
    for (const fp of this.filteredFiles(session)) {
      const e = session.files[fp];
      const key = e.sessionId ?? null;
      const mapKey = key ?? UNKNOWN;
      const cap = e.capturedAt ?? "";
      const b = buckets.get(mapKey);
      if (b) {
        b.files.push(fp);
        if (cap && (b.earliest === "" || cap < b.earliest)) b.earliest = cap;
      } else {
        buckets.set(mapKey, { key, files: [fp], earliest: cap });
      }
    }

    const known = [...buckets.values()]
      .filter((b) => b.key !== null)
      .sort((a, b) => (a.earliest || "~").localeCompare(b.earliest || "~"));

    const items: SessionItem[] = [];
    known.forEach((b, i) => {
      const n = i + 1;
      const time = b.earliest
        ? new Date(b.earliest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      b.label = time ? `Session ${n} · ${time}` : `Session ${n}`;
    });
    // most-recent (largest ordinal) on top
    for (const b of [...known].reverse()) {
      items.push(new SessionItem(b.key, b.label, b.files.length));
    }
    const unknown = buckets.get(UNKNOWN);
    if (unknown) items.push(new SessionItem(null, "Unknown session", unknown.files.length));
    return items;
  }
```

Note: the `b.label` assignment above requires the bucket type to carry a `label`. Use this exact bucket type instead — declare the map as:

```typescript
    const buckets = new Map<
      string,
      { key: string | null; files: string[]; earliest: string; label: string }
    >();
```

and initialize new buckets with `label: ""`:

```typescript
        buckets.set(mapKey, { key, files: [fp], earliest: cap, label: "" });
```

- [ ] **Step 6: Wire grouping into `getChildren`**

Replace the whole `getChildren` method with:

```typescript
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const session = this.sessionManager.getSession();
    if (!session) return [];

    const grouped = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("groupBySession", false);

    // Root
    if (!element) {
      if (grouped) return this.sessionGroups(session);
      const files = this.filteredFiles(session);
      if (this.viewMode === "list") {
        return files.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager));
      }
      return this.directChildren(files, getWorkspaceRoot(files), this.status, false);
    }

    // Session group children
    if (element instanceof SessionItem) {
      const files = this.filteredFiles(session).filter((fp) =>
        matchesSession(session.files[fp], element.sessionId)
      );
      if (this.viewMode === "list") {
        return files.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager));
      }
      return this.directChildren(files, getWorkspaceRoot(files), this.status, false, element.sessionId);
    }

    // Folder children (tree mode)
    if (element instanceof FolderItem) {
      const filesUnder = this.filteredFiles(session).filter(
        (fp) =>
          fp.startsWith(element.folderPath + path.sep) &&
          (element.sessionId === undefined || matchesSession(session.files[fp], element.sessionId))
      );
      return this.directChildren(filesUnder, element.folderPath, this.status, false, element.sessionId);
    }

    return [];
  }
```

- [ ] **Step 7: Add the `sessionId` param to `directChildren`**

Update `directChildren` to accept and propagate the session scope to folders:

```typescript
  private directChildren(
    filePaths: string[],
    parentPath: string,
    status: ReviewStatus,
    showFilePath: boolean,
    sessionId?: string | null
  ): vscode.TreeItem[] {
    const seenFolders = new Set<string>();
    const folders: FolderItem[]     = [];
    const files:   FileReviewItem[] = [];

    for (const fp of filePaths) {
      const rel   = path.relative(parentPath, fp);
      const parts = rel.split(path.sep);
      if (parts.length === 1) {
        files.push(new FileReviewItem(fp, status, this.sessionManager, showFilePath));
      } else {
        const folderPath = path.join(parentPath, parts[0]);
        if (!seenFolders.has(folderPath)) {
          seenFolders.add(folderPath);
          folders.push(new FolderItem(folderPath, status, sessionId));
        }
      }
    }

    folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return [...folders, ...files];
  }
```

- [ ] **Step 8: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: both exit 0.

- [ ] **Step 9: Manual verification**

In the Extension Development Host, temporarily add `"claudegate.groupBySession": true` to your workspace `settings.json` (the setting isn't declared until Task 3, but VS Code still reads it):
1. With pending files that have `sessionId`s, the Pending panel shows `Session N · time` nodes, newest on top, with file counts; expanding shows that session's files.
2. Files without a `sessionId` appear under "Unknown session".
3. Toggle View-as-List / Tree → arrangement changes within each session node.
4. Set the setting back to `false` → flat/folder view returns.

- [ ] **Step 10: Commit**

```bash
git add src/sessionManager.ts src/reviewPanel.ts
git commit -m "feat: group review panels by Claude session (behind setting)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Setting, toggle command & Settings-pane row

**Files:**
- Modify: `package.json` (`groupBySession` setting, `toggleGroupBySession` command)
- Modify: `src/extension.ts` (`toggleGroupBySession` command + refresh-on-change listener)
- Modify: `src/settingsPanel.ts` ("Group by Session" row + config listener key)

**Interfaces:**
- Consumes from Task 2: the grouping honored by `FilteredTreeProvider` reading `claudegate.groupBySession`.
- Produces: command `claudegate.toggleGroupBySession`; setting `claudegate.groupBySession`.

- [ ] **Step 1: Declare the setting + command in `package.json`**

Add to `contributes.configuration.properties`:

```json
"claudegate.groupBySession": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "Group the review panels by the Claude Code session that produced each change (useful when several sessions run in one workspace). Requires re-running **Setup Hook** so the hook records session ids. Files captured before the update, or by the GUI file watcher, appear under \"Unknown session\"."
}
```

Add to `contributes.commands`:

```json
{ "command": "claudegate.toggleGroupBySession", "title": "Claude Gate: Toggle Group by Session" }
```

- [ ] **Step 2: Register the toggle command + refresh listener in `extension.ts`**

Register the command inside the existing `context.subscriptions.push( ... )` command block:

```typescript
      vscode.commands.registerCommand("claudegate.toggleGroupBySession", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("groupBySession", false);
        await updateClaudegateConfig("groupBySession", !cur);
      }),
```

Add a dedicated config-change listener (near the other `onDidChangeConfiguration` registrations; `pendingProvider`/`acceptedProvider`/`rejectedProvider`/`settingsProvider` are all in scope in `activate`):

```typescript
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("claudegate.groupBySession")) return;
        pendingProvider.refresh();
        acceptedProvider.refresh();
        rejectedProvider.refresh();
        settingsProvider.refresh();
      })
    );
```

- [ ] **Step 3: Add the "Group by Session" row in `settingsPanel.ts`**

Add `"groupBySession"` to the `SettingsKind` union:

```typescript
type SettingsKind =
  | "watcher"
  | "groupBySession"
  | "excludeHeader"
  | "excludePattern"
  | "excludeAdd"
  | "hook";
```

In `getChildren`, add the row to the root list (right after `watcher`):

```typescript
    if (!element) {
      return [{ kind: "watcher" }, { kind: "groupBySession" }, { kind: "excludeHeader" }, { kind: "hook" }];
    }
```

In `getTreeItem`, add the case (next to the `watcher` case):

```typescript
      case "groupBySession": {
        const on = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("groupBySession", false);
        const ti = new vscode.TreeItem("Group by Session");
        ti.description = on ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(on ? "list-tree" : "list-flat");
        ti.tooltip = `Click to turn session grouping ${on ? "off" : "on"}`;
        ti.command = { command: "claudegate.toggleGroupBySession", title: "Toggle Group by Session" };
        return ti;
      }
```

Extend the provider's own `onDidChangeConfiguration` guard (in its constructor) to also refresh on this key. Change the condition to include it:

```typescript
        if (
          e.affectsConfiguration("claudegate.exclude") ||
          e.affectsConfiguration("claudegate.fileWatcher.enabled") ||
          e.affectsConfiguration("claudegate.groupBySession")
        ) {
          this.refresh();
        }
```

- [ ] **Step 4: Typecheck, compile, and confirm package.json parses**

Run: `npm run typecheck && npm run compile && node -e "require('./package.json')"`
Expected: all exit 0 / prints nothing-then-clean.

- [ ] **Step 5: Manual verification**

1. Settings pane shows a **Group by Session** row (Off). Click it → flips to On; `.vscode/settings.json` gains `claudegate.groupBySession: true`; the Pending panel regroups by session live.
2. Toggle off from the row → panels return to flat/folder; row shows Off.
3. Setting also appears in VS Code Settings UI under Claude Gate.

- [ ] **Step 6: Commit**

```bash
git add package.json src/extension.ts src/settingsPanel.ts
git commit -m "feat: groupBySession setting, toggle command, and Settings row

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs & CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (extend the existing `## [1.2.0] — 2026-07-04` entry)
- Modify: `readme.md`

**Interfaces:**
- Consumes: the feature from Tasks 1–3.
- Produces: nothing consumed by code.

- [ ] **Step 1: Extend the CHANGELOG 1.2.0 Added section**

In `CHANGELOG.md`, in the existing `## [1.2.0] — 2026-07-04` → `### Added` list, append:

```markdown
- **Group by session** — an optional `claudegate.groupBySession` setting (and Settings-pane toggle) groups the review panels by the Claude Code session that made each change, for when several sessions run in one workspace. The hook now records each change's `session_id`; files captured before this update or by the GUI watcher show under "Unknown session". Re-run **Setup Hook** to start recording session ids.
```

- [ ] **Step 2: Add a note to `readme.md`**

In `readme.md`, in the "Extension Settings" table, add a row (below the `claudegate.exclude` row):

```markdown
| `claudegate.groupBySession` | `false` | Group the review panels by the Claude Code **session** that produced each change — helpful when several sessions run in one workspace. Toggle it from the Settings pane too. Re-run **Setup Hook** so the hook records session ids. |
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md readme.md
git commit -m "docs: document group-by-session mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** capture (`session_id`+`capturedAt`) → Task 1; schema → Task 2 Step 1; `SessionItem`/`FolderItem.sessionId`/`matchesSession`/`sessionGroups`/`directChildren` param/`getChildren` grouping → Task 2; ordinal-by-first-seen + most-recent-first + time label → Task 2 Step 5; Unknown bucket → Task 2 (null key); setting + default off → Task 3 Step 1; toggle command + live refresh → Task 3 Step 2; Settings-pane row → Task 3 Step 3; applies to all three panels (shared provider) → inherent; docs/no-bump/Setup-Hook note → Task 4.
- **Placeholder scan:** none — all steps carry full code.
- **Type consistency:** `SessionItem(sessionId, label, fileCount)`, `FolderItem(folderPath, status, sessionId?)`, `matchesSession(entry, sessionId)`, `directChildren(..., sessionId?)`, `filteredFiles(session)`, `sessionGroups(session)` used consistently across Task 2. Setting key `claudegate.groupBySession` and command `claudegate.toggleGroupBySession` identical across package.json / extension.ts / settingsPanel.ts. Bucket type includes `label` (Task 2 Step 5 note).
- **Ordering:** Task 2 reads the setting (works with it undefined → false); Task 3 declares it + adds the toggle/refresh; Task 2's manual test sets the key by hand. Task 1 (capture) precedes Task 2 (reads the fields) logically but they're independent files — either order compiles; keep 1→2 so the fields exist end-to-end.
