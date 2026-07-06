# Bug: unconditional `settings.json` rewrite silently disables capture in already-running Claude sessions

**Date:** 2026-07-06
**Severity:** High — silent data loss (edits go untracked; user believes ClaudeGate is watching when it isn't)
**Component:** `src/hookInstaller.ts` (the `~/.claude/settings.json` registration write)
**Status:** FIXED (2026-07-06) — `computeSettingsPatch` made the registration write idempotent; see `src/hookInstaller.ts` + `src/hookInstaller.test.ts`.

---

## Symptom

A whole Claude Code session's worth of `Write`/`Edit` edits were **not captured** — the workspace session file (`~/.claudegate/sessions/<hash>.json`) stayed at `status: "reviewed"` with `files: {}` empty, so nothing showed up for review. It was noticed on one file (`.claude/commits/ErrorCode.commits.yaml`) but affected **every** edit in that session, not just that file.

## What was ruled out (NOT the cause)

- **Not an exclude-glob issue.** `src/excludeMatcher.ts` `DEFAULT_EXCLUDES` does not cover `.claude/**` or `*.yaml`. The file is not excluded.
- **Not a `hook.py` bug.** Invoking the hook manually captured the file correctly:
  ```bash
  echo '{"tool_input":{"file_path":"/abs/path/to/file.yaml"},"cwd":"/workspace/root","session_id":"debug"}' \
    | bash ~/.claudegate/hook.sh
  # → session file flips status:"active" and adds the file to files{}. Works.
  ```
- **Not workspace-root routing.** The workspace root was correctly registered in `~/.claudegate/workspace-roots.json`, and `workspace_root_for_file` resolves it (the session file for that hash exists and is non-trivial).

## Reproduction (confirmed)

1. In a Claude Code session that has been running since before the extension last activated:
2. Reset the workspace session file to `{ "status": "reviewed", "files": {} }`.
3. Make a real `Edit`/`Write` via Claude Code to any file under the workspace root.
4. **Observed:** session file unchanged — `files: {}`, `status: "reviewed"`. The PreToolUse hook did **not** run.
5. **Control:** the *project*-level hook in that repo (a different tool, registered in the repo's `.claude/settings.json` which had NOT been modified) **did** fire in the same session.

So: the running session executes hooks from an unmodified settings file, but NOT the claudegate hook from `~/.claude/settings.json`.

## Root cause

Two facts combine:

1. **Claude Code trusts hook config as captured at session start.** If `settings.json` is modified out from under a running session, Claude Code treats the changed hooks as untrusted and stops running them until the user restarts the session or re-approves via `/hooks`. (This is an anti-tampering safeguard — a background process must not be able to inject/silently swap hooks into a live session.)

2. **`hookInstaller.ts` rewrote `~/.claude/settings.json` unconditionally whenever `setup()` ran, even when nothing changed.** (Correction to the original note: this is *not* on every activation — plain activation runs only `syncHookIfNeeded()`, which touches `~/.claudegate/hook.py`, and the read-only `warnIfHookNotRegisteredInSettings()`. The settings write happens from `setup()`, i.e. the **Setup Hook** command or the "Setup Hook" button in the not-registered warning.) That still produced the incident, and made it worse: a user who noticed capture had gone quiet and clicked **Setup Hook** to fix it triggered another unconditional rewrite, re-invalidating the very session they were trying to rescue. The registration method guarded only against *duplicating* the PreToolUse entry, but called `writeFileSync` unconditionally:

   ```ts
   // src/hookInstaller.ts  (~lines 244-254)
   if (!hooks.PreToolUse) hooks.PreToolUse = [];
   const alreadyInstalled = JSON.stringify(hooks.PreToolUse).includes("claudegate");
   if (!alreadyInstalled) {
     hooks.PreToolUse.push({ /* matcher ^(Write|Edit|MultiEdit)$ -> hook.sh */ });
   }
   fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8"); // ← runs even when alreadyInstalled === true
   ```

   When VS Code launches / the extension activates / upgrades, this write re-touches `~/.claude/settings.json` (content + mtime) even though the claudegate entry is already present and identical. That rewrite is what invalidates the hook's trust for any Claude Code session that was already open.

**Timeline that produced the report:**
- `~/.claude/settings.json` and `~/.claudegate/hook.py` were both written at `09:40:10` (extension activation / upgrade to 1.3.3).
- The affected Claude session was already running across that moment → its global-settings hooks were invalidated → claudegate capture went silent for the rest of the session.
- The repo's project `.claude/settings.json` (untouched since 2026-06-05) kept its hooks trusted → the project hook kept firing. This is the exact asymmetry observed.
- An earlier Claude session (started right around/after 09:40) captured fine — its trust snapshot included the hook.

## Fix

Make the registration write **idempotent** — do not touch `settings.json` when the claudegate entry is already present and correct:

```ts
const alreadyInstalled = JSON.stringify(hooks.PreToolUse).includes("claudegate");
if (alreadyInstalled) return "none";   // already registered → do NOT rewrite (preserves trust of running sessions)

hooks.PreToolUse.push({ /* ... */ });
fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
return "installed";
```

Notes / considerations for the fix:
- The `alreadyInstalled` check is currently a substring match on `"claudegate"`. When making the write conditional, make sure the "already installed" test also holds when the entry needs *updating* (e.g. matcher or command path changed across versions) — in that case you DO want to rewrite (and then the running-session invalidation is unavoidable and correct). So the precise rule is: **write only if the desired PreToolUse entry differs from what's on disk**; skip the write when it's byte-identical.
- There is already a first-install notice ("Restart any Claude Code sessions that were already running", ~line 51). Keep showing that notice **whenever a write actually happens** (install or genuine update), not only on the very first install — because any real write invalidates running sessions by design.
- Consider a lightweight health signal: if the hook is registered but a Claude session appears active with zero captures arriving, surface a "restart Claude Code / run `/hooks` to activate" hint. This turns the silent failure into a visible one.

## Acceptance check

After the fix:
1. With a Claude session already running, trigger extension activation (reload window). `~/.claude/settings.json` mtime must be **unchanged** (no rewrite).
2. The running session's claudegate hook must keep firing (edits still captured).
3. On a genuine hook-entry change (version bump that alters matcher/command), the file is rewritten once and the restart notice is shown.

## Reference paths

- Installer / registration: `src/hookInstaller.ts`
- Hook script: `~/.claudegate/hook.sh` → `~/.claudegate/hook.py` (source: `hooks/hook.py`)
- Global registration target: `~/.claude/settings.json` (`hooks.PreToolUse`, matcher `^(Write|Edit|MultiEdit)$`)
- Per-workspace session store: `~/.claudegate/sessions/<md5(workspace root)>.json`
- Exclude logic (confirmed not involved): `src/excludeMatcher.ts`
