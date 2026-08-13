# Design — Nested Git Worktree Review

**Date:** 2026-07-10
**Status:** Approved for planning
**Topic:** Make review of a git worktree nested inside a workspace **deterministic** and **visible from both windows** — one canonical record per worktree file, shown (with full accept/reject actions) in both the parent workspace window and the worktree's own window, plus an inline "open worktree in new window" action.

---

## 1. Goal

When a git worktree lives **inside** a workspace root (e.g. `monorepo/ws-alpha` under `monorepo`), Claude's edits to worktree files should:

1. Always be captured to **one canonical session** (the worktree's own), regardless of which windows are open — no more ownership flipping based on window state.
2. Be shown **with full accept/reject/diff actions in the parent (monorepo) window**, identically whether or not the worktree window is open.
3. Be shown in the worktree's own window too, when opened.
4. Have a **single decision**: accepting/rejecting from either window applies to both, because both windows read and write the *same* record.

A secondary convenience: an inline action in the parent's sidebar to **open the detected worktree as a new window**.

## 2. The problem (grounded in real data)

Routing is done by `hook.py`, which writes each edit to the session of the **longest matching registered workspace root** (`hook.py:77-99`, `workspace_root_for_file`). Roots are registered in the shared `~/.claudegate/workspace-roots.json` **only while their window is open** (`workspaceRoots.ts:22-46`).

Consequence — ownership of a nested worktree's edits depends on which windows happen to be open:

- Only `monorepo` open → worktree root not registered → longest match is `monorepo` → edit lands in **monorepo** session.
- `ws-alpha` also open → its root is registered and is the longer match → edit lands in the **worktree** session; the monorepo window goes blank for it.

**Observed on the maintainer's machine** (`~/.claudegate/sessions/`, 2026-07-10):

| Root | Session hash | Accepted entries under `ws-alpha/` |
|---|---|---|
| `monorepo` | `e6c7ce02…` | **19** |
| `monorepo/ws-alpha` | `9d267099…` | **2** |

The feature's review history is split 19-vs-2 across two sessions purely by window open-order. In the worst case, an undecided file can be **pending in both sessions at once with different baselines** (a momentary double-pending) — decidable independently in each window. This is the confusion to eliminate.

## 3. Non-goals

- **No two synced copies / mirroring.** We do *not* keep the record in two sessions and reconcile them. There is exactly **one** canonical record per worktree file; "sync" falls out of that for free.
- **No migration of existing scatter.** The 19 historical `monorepo` accepted entries under `ws-alpha/` are **left as-is**. Only behavior going forward changes.
- **No `git` binary dependency.** Worktree detection is pure filesystem (reading `.git` / `.git/worktrees/*/gitdir`), preserving the project's no-git-dependency design rule.
- **No support for worktrees *outside* every registered workspace root.** We only isolate worktrees nested at/under a root the user has actually opened (keeps the "only capture inside an opened workspace" guarantee).
- **No change to the DocumentTracker** (still opt-in, off by default) or to non-worktree routing.
- **No showing the worktree's accepted/rejected history in the parent.** The parent shows the worktree's **pending** changes with full actions; decided-history stays in the worktree's own window (keeps monorepo's own logs clean).

## 4. Approach & alternatives

**Chosen: One canonical record, two viewers.**

1. Make `hook.py` route a worktree file **deterministically** to the worktree's own session (detect the worktree boundary; ignore window-registration for that decision).
2. Make the parent window **attach to** and watch the session files of worktrees nested under it, aggregate their pending files into its sidebar (with full actions), and **dispatch accept/reject to the owning session**.

Alternatives considered and rejected:

- **B — Show-in-parent by mirroring two sessions.** Keep both sessions and copy/sync entries. Rejected: races, double-accept bugs, and dedup complexity when both windows are open. The single-record design makes all of that impossible by construction.
- **C — Guidance + exclude config only.** No routing change; document "open each worktree as its own window" and add an exclude setting. Rejected as the primary fix: manual per-worktree setup, easy to forget, and the default (unconfigured) behavior stays confusing. (A path-exclude setting may still be added later, independently.)
- **A-strict — isolate but hide from parent.** Deterministic routing but the parent never shows worktree changes (review only by opening the worktree). Rejected: the maintainer explicitly wants the parent to keep showing worktree changes with full actions.

**Accepted trade-offs:**
- The parent window's `SessionManager` gains a genuinely new responsibility: observing *more than one* session and knowing which session owns each displayed file. This is the main added complexity (§6).
- Worktree detection is best-effort filesystem heuristic; if it can't identify a worktree (unusual git layout), behavior degrades to today's longest-match routing (no worse than current).

## 5. Worktree detection (shared contract)

Both `hook.py` and the extension must agree on "is path P a worktree root, and what worktrees are nested under root R" — using filesystem only, no `git`.

- A **worktree working directory** has a `.git` **file** (not a directory) whose contents are `gitdir: <path-to-main-repo>/.git/worktrees/<name>`.
- The **main repository** has a `.git` **directory** containing `worktrees/<name>/` subdirs; each `worktrees/<name>/gitdir` file points back to that worktree's `.git` file, from which the worktree working directory is the parent.

**`hook.py` routing (per edited file):**
1. Resolve the absolute file path (as today).
2. Walk **up** from the file's directory to the nearest ancestor containing a `.git` entry.
   - If that `.git` is a **file** (worktree marker) → that ancestor is the effective worktree root.
   - Only use it when it is **at or below** the best registered root (so we never capture outside an opened workspace). Otherwise fall through.
3. If a worktree root is found and it is **deeper** than the longest matching registered root, route to the worktree root's session. Else route to the longest matching registered root (today's behavior).
4. Must stay **fail-open and fast** — any filesystem error → fall back to today's longest-match logic; never block the edit.

**Extension enumeration (per parent root R):**
- Read `R/.git/worktrees/*/gitdir`; for each, resolve the referenced worktree working directory; keep those whose path is **under R**. That is the set of nested worktrees to attach to. Enumerate **once at activation**, cache, and refresh on a cheap trigger (window focus / manual sidebar refresh) — never in a hot loop.

## 6. Architecture

```
                 ┌─────────────── parent (monorepo) window ───────────────┐
 hook.py ─write─▶│  primary SessionManager  (monorepo session)            │
   routes to     │            +                                      │
 canonical       │  WorktreeSessionRegistry (new)                    │
 worktree        │    attaches to each nested worktree session file, │
 session         │    watches it, exposes its pending files,         │
                 │    dispatches accept/reject to the owning session │
                 │            │                                      │
                 │            ▼  aggregated pending                  │
                 │  reviewPanel tree:                                │
                 │    <monorepo's own pending files>                      │
                 │    ▸ ws-alpha (worktree) — N pending    │
                 │        <worktree pending files, full actions>     │
                 │        [⧉ open worktree window]                   │
                 └───────────────────────────────────────────────────┘

 hook.py ─write─▶  worktree (ws-alpha) session  ◀─read/write─  worktree window (if open)
```

### New / changed units

1. **`hooks/hook.py` (changed)** — add worktree-boundary detection to routing (§5). Isolated in a helper `worktree_root_for_file(file_path, best_root) -> str | None`; `main()` prefers it over the registered-root match when deeper. Fail-open.

2. **`src/worktrees.ts` (new, pure where possible)** — filesystem worktree helpers used by the extension:
   - `isWorktreeRoot(dir): boolean`
   - `nestedWorktreesUnder(root): string[]` — enumerate via `.git/worktrees/*/gitdir`.
   - `worktreeRootForPath(path, boundRoots): string | null` — mirror of the hook logic for the extension side (used when dispatching actions).
   Kept VS-Code-free so it is unit-testable.

3. **`src/worktreeSessionRegistry.ts` (new)** — owns the "attached worktree sessions" for the current window:
   - On activation (and on refresh), compute `nestedWorktreesUnder(primaryRoot)`.
   - For each, open a lightweight read/write handle on its session file and `fs.watch` it (reusing the existing session read/merge/lock helpers from `sessionManager.ts` — do **not** fork the concurrency logic).
   - Expose `getPending(): Map<worktreeRoot, PendingFile[]>` and fire an `onChange` event the sidebar subscribes to.
   - `accept(path, …)` / `reject(path, reason?)` resolve the owning worktree session and delegate to the **same** accept/reject routines the primary session uses (same lock, same `mergeFreshCaptures`, same `ReviewRecord`). No new persistence logic.

4. **`src/sessionManager.ts` (changed)** — factor the per-file accept/reject/persist primitives so they can operate on **any** session file path (primary or an attached worktree), not just the window's own. The registry calls these. Emit a combined change signal so the sidebar refreshes on either primary or attached-session changes.

5. **`src/reviewPanel.ts` (changed)** — render a labeled group node per nested worktree (`▸ <name> (worktree) — N pending`) with its pending files as children, each carrying full accept/reject/open-diff actions that route through the registry. Add an inline group action **"Open Worktree Window."**

6. **`src/extension.ts` / `package.json` (changed)** — register a command `claudegate.openWorktreeWindow` that runs `vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), { forceNewWindow: true })`; wire it into `contributes.commands` + `contributes.menus` (view/item context on the worktree group node).

## 7. Data flow

**Capture:** Claude edits `monorepo/ws-alpha/foo.ts` → `hook.py` detects the worktree boundary → writes one pending entry to the **worktree** session (`9d26…`). No entry is written to the monorepo session.

**Display:** the monorepo window's `WorktreeSessionRegistry` is watching `9d26…`; it sees the new pending file and fires `onChange`; the sidebar shows it under the `ws-alpha (worktree)` group with full actions. If the worktree window is also open, it shows the same file from the same session.

**Decision:** the user clicks Keep on the file in the **monorepo** window → the registry resolves the owning session (`9d26…`) and runs the shared `acceptFile` against it → the entry moves from `files{}` to `accepted[]` in `9d26…`. Both windows watch `9d26…`, so both drop it from pending. One record, one decision.

## 8. Concurrency & performance

- **Concurrency is unchanged.** Writes to a worktree session from the monorepo window use the **same** advisory lock + atomic `os.replace` + `mergeFreshCaptures` path already shared by `hook.py` and the extension. Two windows writing the same session file is the same model as hook↔extension today; both-windows-open is not a new hazard.
- **Watchers:** one `fs.watch` per nested worktree session file (typically 1–5). Negligible; the window already watches its own session file identically.
- **Detection:** filesystem reads at activation + cached; refresh only on window focus / manual refresh. No `git` subprocess, no polling.
- **Rendering:** a group node plus a few children per worktree; the sidebar already rebuilds on session change.
- **Guardrails:** if the nested-worktree count is unexpectedly large, cap the number attached and log which were dropped (never silently truncate).

## 9. Error handling & edge cases

- **Detection fails / unusual git layout:** hook falls back to longest-match routing; extension attaches to nothing. No regression vs. today.
- **Worktree removed on disk (`git worktree remove`):** its session stops resolving; the registry drops it on next refresh; stale watchers are disposed. Existing `workspace-roots.json` pruning already drops non-existent roots.
- **Same file edited before and after the worktree window opened (today's double-pending bug):** cannot occur under deterministic routing — the file is only ever pending in the worktree session.
- **Non-worktree nested git repo (submodule):** `.git` is a *file* for submodules too, but its gitdir points under the superproject's `.git/modules/…`, not `worktrees/…`. Detection keys on the `worktrees/` marker specifically, so submodules are **not** treated as worktrees (they stay with the parent). Documented and tested.
- **Reject of a `newFile` worktree entry:** unchanged semantics (deletes the file); it just targets the worktree session.

## 10. Testing

- **`worktrees.ts` unit tests (VS-Code-free):** temp dirs simulating (a) a real worktree (`.git` file → `worktrees/<name>`), (b) main repo, (c) submodule (must NOT be detected as worktree), (d) nested-under-root vs. outside-root. Assert `isWorktreeRoot`, `nestedWorktreesUnder`, `worktreeRootForPath`.
- **`hook.py` tests:** feed synthetic `.git` layouts; assert routing to the worktree session when nested & deeper, and fallback to longest-match otherwise; assert fail-open on filesystem errors.
- **Registry tests:** given a primary session + one attached worktree session on disk, assert aggregated pending, `onChange` firing on worktree-session change, and that `accept()` writes to the correct (worktree) session file and removes it from the other window's pending view.
- **Concurrency smoke test:** two writers (simulating both windows) accepting different files in the same worktree session under the lock — no lost entries (reuses existing merge/lock tests).

## 11. File manifest

| File | Change |
|---|---|
| `hooks/hook.py` | Add `worktree_root_for_file` + prefer it in `main()` routing (fail-open) |
| `src/worktrees.ts` | **New** — pure filesystem worktree detection/enumeration |
| `src/worktreeSessionRegistry.ts` | **New** — attach/watch/aggregate/dispatch for nested worktree sessions |
| `src/sessionManager.ts` | Factor accept/reject/persist to operate on any session file path; combined change signal |
| `src/reviewPanel.ts` | Worktree group node + full-action children + open-window inline action |
| `src/extension.ts` | Register `claudegate.openWorktreeWindow`; wire registry lifecycle |
| `package.json` | New command + menu contributions |
| `src/worktrees.test.ts`, hook/registry tests | **New** test coverage per §10 |

## 12. Self-review checklist (for the plan)

- Hook stays fail-open and adds no meaningful latency to a Claude write.
- No new persistence/lock logic — worktree writes reuse the primary path.
- Parent behavior identical whether or not the worktree window is open.
- Submodules not misclassified as worktrees.
- No migration of existing accepted/rejected entries.
- Worktree detection cached, not polled.
