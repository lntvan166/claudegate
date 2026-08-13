# Bug: Pending count disagrees with pending tree (shows 2, only 1 visible)

**Date:** 2026-06-03
**Status:** Fixed in v1.1.11 — see `docs/superpowers/specs/2026-06-03-pending-count-mismatch-design.md`
**Severity:** Medium — a "ghost" pending file inflates the count and can never be cleared from the UI.

---

## Symptom

The pending **badge / status-bar count shows `2`**, but the **Pending review tree only lists `1` file**. The extra count can't be reconciled from the panel, because the second file is never rendered.

## How to reproduce

1. Open a workspace (e.g. `~/projects/my-monorepo`).
2. From a Claude Code session whose `cwd` is that workspace, edit a file that lives **outside** the workspace folder — e.g. a memory file under `~/.claude/projects/<...>/memory/<file>.md`.
3. The `PreToolUse` hook captures the edit and files it into **this workspace's** session.
4. Observe: status-bar/badge count increments, but the tree does not show the file.

## Evidence

Session file for the monorepo workspace
(`~/.claudegate/sessions/e6c7ce029d23a96e09ca9c8906a451f1.json`) contained
**two** pending entries:

| reviewStatus | path | inside workspace? |
|---|---|---|
| `pending` | `…/repo/docs/superpowers/specs/2026-06-03-…-design.md` | ✅ yes |
| `pending` | `~/.claude/projects/<workspace-hash>/memory/notes.md` | ❌ no — lives under `~/.claude` |

The second entry is a file edited in a prior session that physically lives
outside the workspace directory.

---

## Root cause

Two distinct layers contribute. The visible 2-vs-1 is Layer 1; Layer 2 explains
why the offending entry exists at all.

### Layer 1 — count and display use different inclusion rules

The **tree** filters entries by workspace membership
(`src/reviewPanel.ts:129`):

```ts
.filter(([fp, e]) => e.reviewStatus === this.status && isInWorkspace(fp))
```

so the out-of-workspace file is excluded → **1 rendered**.

The **count** (`pendingView.badge`, status-bar `badgeBar`) iterates *all*
session files with **no** workspace filter (`src/extension.ts:269-272`):

```ts
for (const { reviewStatus } of Object.values(session.files)) {
  counts[reviewStatus]++;
}
```

→ **2 counted**. `SessionManager.getPendingCount()`
(`src/sessionManager.ts:86-90`) has the same missing filter, so any other
caller relying on it is affected too.

Net effect: the count can include a file the panel can never display or let the
user act on — a permanent "ghost" pending.

### Layer 2 — the hook routes out-of-workspace files into the cwd's session

`hooks/hook.py` → `workspace_root_for_file(file_path, cwd)`
(`hooks/hook.py:23-45`) matches the edited file against the registered
workspace roots; when **none match**, it falls back to `cwd`
(`hooks/hook.py:45`):

```python
# no registered root matched the file → fall back to the Claude cwd
return os.path.normcase(os.path.abspath(cwd))
```

So editing a `~/.claude/...` file while `cwd` is the monorepo workspace files that
path under the monorepo session bucket, even though the file lives outside it.

---

## Data flow summary

```
Claude edits  ~/.claude/.../memory/foo.md   (cwd = /…/repo)
        │
        ▼
hook.py: file matches no registered workspace root
        │  → falls back to cwd  (hook.py:45)
        ▼
entry written into monorepo session JSON  (path is OUTSIDE the workspace)
        │
        ├─► count loop (extension.ts:269)  → no isInWorkspace filter → counts it  ⇒ 2
        └─► tree (reviewPanel.ts:129)       → isInWorkspace filter     → hides it  ⇒ 1
```

---

## Fix options

1. **Align count to display (fixes the 2-vs-1).**
   Apply the same `isInWorkspace` filter in the count loop
   (`extension.ts:269`) and in `SessionManager.getPendingCount()`
   (`sessionManager.ts:86-90`). Ghosts stop being counted. The stale entry
   still lingers in the JSON.

2. **Stop capturing out-of-workspace files at the source (true root cause).**
   In `hook.py`, when a file matches no registered root, **skip it** rather
   than falling back to `cwd` (or only capture when the file is under `cwd`).
   Optionally have `DocumentTracker` also ignore paths outside the workspace.
   Prevents future ghosts.

**Recommendation:** do both — #2 prevents recurrence; #1 keeps count and display
consistent. Remove the existing ghost entry from the current session JSON in the
same pass.

---

## Affected files

- `src/extension.ts:269-272` — count loop, missing workspace filter
- `src/sessionManager.ts:86-90` — `getPendingCount()`, missing workspace filter
- `src/reviewPanel.ts:129` — tree filter (the correct reference behavior)
- `hooks/hook.py:23-45` — `workspace_root_for_file` cwd fallback (source of ghost)
