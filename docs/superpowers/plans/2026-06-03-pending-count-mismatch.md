# Pending Count Mismatch Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pending counts, review tree, bulk actions, and session JSON consistent by scoping all extension logic to open workspace folders and skipping hook capture when no registered root matches.

**Architecture:** Extract `isInWorkspace` into `workspaceScope.ts`, apply it to counts and bulk mutations, prune stale entries on session load, and change `hook.py` to return early instead of cwd-fallback routing.

**Tech Stack:** TypeScript (VS Code extension API), Python 3 (`hooks/hook.py`)

**Spec:** `docs/superpowers/specs/2026-06-03-pending-count-mismatch-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/workspaceScope.ts` | Shared `isInWorkspace(filePath)` |
| Modify | `src/reviewPanel.ts` | Import shared helper; remove duplicate |
| Modify | `src/sessionManager.ts` | Filter counts/actions; prune on load |
| Modify | `src/extension.ts` | Filter session-change counts and command file lists |
| Modify | `hooks/hook.py` | Skip capture when no workspace root matches |
| Modify | `package.json` | Patch version `1.1.11` |
| Modify | `CHANGELOG.md` | Fixed entry for this bug |

---

## Task 1: Shared workspace scope helper

**Files:**
- Create: `src/workspaceScope.ts`
- Modify: `src/reviewPanel.ts`

- [ ] **Step 1: Create `src/workspaceScope.ts`**

```typescript
import * as path from "path";
import * as vscode from "vscode";

/** True if filePath is under any open VS Code workspace folder. */
export function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
}
```

- [ ] **Step 2: Update `src/reviewPanel.ts`**

Remove the local `function isInWorkspace` (lines ~35–39). Add:

```typescript
import { isInWorkspace } from "./workspaceScope";
```

- [ ] **Step 3: Verify compile**

Run: `npm run compile && npm run typecheck`  
Expected: exit 0, no errors.

---

## Task 2: SessionManager — counts, bulk actions, prune

**Files:**
- Modify: `src/sessionManager.ts`

- [ ] **Step 1: Import helper**

```typescript
import { isInWorkspace } from "./workspaceScope";
```

- [ ] **Step 2: Update `getPendingCount()`**

Replace the method body with:

```typescript
getPendingCount(): number {
  if (!this.session) return 0;
  return Object.entries(this.session.files).filter(
    ([fp, f]) => f.reviewStatus === "pending" && isInWorkspace(fp)
  ).length;
}
```

- [ ] **Step 3: Scope `acceptAll()`**

Change the loop to iterate entries with workspace filter:

```typescript
for (const [filePath, entry] of Object.entries(this.session.files)) {
  if (entry.reviewStatus === "pending" && isInWorkspace(filePath)) {
    entry.reviewStatus = "accepted";
    count++;
  }
}
```

- [ ] **Step 4: Scope `rejectAll()`**

At the start of the loop body, add guard:

```typescript
if (entry.reviewStatus !== "pending" || !isInWorkspace(filePath)) continue;
```

(remove the separate `if (entry.reviewStatus !== "pending") continue` if redundant)

- [ ] **Step 5: Add prune helper and call from `loadSession()`**

Add private method:

```typescript
private pruneOutOfWorkspaceEntries(): void {
  if (!this.session) return;
  let removed = 0;
  for (const filePath of Object.keys(this.session.files)) {
    if (!isInWorkspace(filePath)) {
      delete this.session.files[filePath];
      removed++;
      this.log.appendLine(`[INFO] Pruned out-of-workspace entry: ${filePath}`);
    }
  }
  if (removed > 0) this.persist();
}
```

In `loadSession()`, after `this.session = JSON.parse(...)` succeeds and before `this._onSessionChange.fire`, call:

```typescript
this.pruneOutOfWorkspaceEntries();
```

- [ ] **Step 6: Verify compile**

Run: `npm run compile && npm run typecheck`  
Expected: exit 0.

---

## Task 3: Extension — session change counts and commands

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Import helper**

```typescript
import { isInWorkspace } from "./workspaceScope";
```

- [ ] **Step 2: Filter counts in `onSessionChange`**

Replace the count loop (~lines 269–272) with:

```typescript
for (const [filePath, { reviewStatus }] of Object.entries(session.files)) {
  if (!isInWorkspace(filePath)) continue;
  counts[reviewStatus]++;
}
```

- [ ] **Step 3: Filter `acceptAll` pending list**

Change filter to:

```typescript
Object.entries(session.files).filter(
  ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp)
)
```

- [ ] **Step 4: Filter `rejectAll` pending list**

Same filter as Step 3 for the `files` array used after confirmation.

- [ ] **Step 5: Verify compile**

Run: `npm run compile && npm run typecheck`  
Expected: exit 0.

---

## Task 4: Hook — skip unmatched paths

**Files:**
- Modify: `hooks/hook.py`

- [ ] **Step 1: Change return type of `workspace_root_for_file`**

Update signature and fallback:

```python
def workspace_root_for_file(file_path: str, cwd: str) -> str | None:
```

Replace the final line:

```python
return os.path.normcase(os.path.abspath(cwd))
```

with:

```python
return None
```

(`cwd` remains in the signature for call-site stability; unused after this change.)

- [ ] **Step 2: Guard in `main()`**

After resolving `file_path`, before `workspace_session_file`:

```python
workspace_root = workspace_root_for_file(file_path, cwd)
if workspace_root is None:
    sys.exit(0)
session_file = workspace_session_file(workspace_root)
```

- [ ] **Step 3: Manual hook smoke test**

From repo root:

```bash
echo '{"tool_name":"Write","cwd":"/tmp","tool_input":{"file_path":"/etc/hosts"}}' | python3 hooks/hook.py
ls ~/.claudegate/sessions/ | wc -l
```

Expected: no new session file for `/tmp` or `/etc/hosts` when `/tmp` is not in `workspace-roots.json`.

Test in-workspace path only if you have a root in `workspace-roots.json` that contains a temp file under it.

---

## Task 5: Version and changelog

**Files:**
- Modify: `package.json` — `"version": "1.1.11"`
- Modify: `CHANGELOG.md` — new `## [1.1.11]` section

- [ ] **Step 1: Bump version** in `package.json`.

- [ ] **Step 2: Add CHANGELOG entry**

Under `## [1.1.11] — 2026-06-03` / `### Fixed`:

- Pending badge/status-bar count could exceed visible Pending tree files when the session contained paths outside the workspace (e.g. `~/.claude/...` edits filed via hook cwd fallback). Counts and bulk actions now use the same workspace filter as the tree; stale entries are pruned on load.
- Hook no longer captures files that match no registered VS Code workspace root (re-run **Setup Hook** after upgrade).

- [ ] **Step 3: Commit**

```bash
git add src/workspaceScope.ts src/reviewPanel.ts src/sessionManager.ts src/extension.ts hooks/hook.py package.json CHANGELOG.md docs/superpowers/specs/2026-06-03-pending-count-mismatch-design.md docs/superpowers/plans/2026-06-03-pending-count-mismatch.md
git commit -m "$(cat <<'EOF'
fix: align pending counts with workspace-scoped review

Skip hook capture when no VS Code root matches, prune ghost session
entries on load, and filter counts and bulk actions with isInWorkspace.
EOF
)"
```

---

## Task 6: Manual verification (Extension Development Host)

- [ ] Open a workspace that previously had a ghost entry (or inject one in session JSON).
- [ ] Reload window → ghost pruned; pending count equals tree length.
- [ ] Run **Claude Gate: Setup Hook** so `~/.claudegate/hook.py` updates.
- [ ] From terminal Claude with project `cwd`, edit a `~/.claude/projects/.../memory/*.md` file → session entry count unchanged for that workspace.
- [ ] Edit a normal project file → appears in Pending tree; count increments.

---

## Plan self-review (spec coverage)

| Spec requirement | Task |
|------------------|------|
| Shared `isInWorkspace` | Task 1 |
| reviewPanel uses shared helper | Task 1 |
| extension counts filtered | Task 3 |
| getPendingCount / acceptAll / rejectAll filtered | Task 2 |
| prune on load | Task 2 |
| hook skip (no cwd fallback) | Task 4 |
| DocumentTracker unchanged | — (no task) |
| compile/typecheck + manual tests | Tasks 1–6 |
| version + CHANGELOG + Setup Hook note | Task 5 |
