# Hook Auto-Heal — Design

**Date:** 2026-08-03
**Status:** ❌ **REJECTED — the feature already existed.** Superseded by the
Findings section below. Kept because the mechanism analysis and the forensic
method are still correct and still useful; the premise is not.

> ## Why this was rejected
>
> `HookInstaller.syncHookIfNeeded()` already hash-compares the bundled and
> installed `hook.py`, rewrites it plus the wrapper, and notifies once per hash —
> and `extension.ts` already calls it on activation. The "Problem" section below
> is simply false. It was written without grepping for an existing implementation.
>
> **Forensic findings (2026-08-03, read-only, no reproduction needed):**
>
> | Evidence | Result |
> |---|---|
> | installed vs bundled `hook.py` hash | identical → health was never `stale` |
> | `claudegate` in `~/.claude/settings.json` | present → never `not-registered` |
> | `~/.claudegate/hook.log` daily counts | 354 (Jul 30) → 175 (Jul 31) → 88 (Aug 3) |
> | captures after the Jul 30 `settings.json` write | uninterrupted, no gap |
>
> Capture never stopped. The reported "pending tab stops capturing" is fully
> explained by two bugs **already fixed**: the nested-worktree attach cap (v1.12.0
> — `monorepo` had 18 worktrees against a cap of 10, so whole feature directories were
> silently dropped) and worktree decision records not surfacing (v1.12.1).
>
> **What survived from this design:** the hot/cold distinction under "The
> mechanism that makes this safe" — `hook.py` changes take effect immediately for
> running Claude sessions, `settings.json` changes require a restart. That is
> accurate, load-bearing, and was undocumented. It moved into `CLAUDE.md`.
>
> **Also implemented separately:** `syncHookIfNeeded()` never fired
> `onHealthChange`, and healing ran only at activation. Both fixed — see the
> commit that follows this one.
>
> **Lesson:** grep for the implementation before specifying it, and diagnose from
> artifacts already on disk before designing. `hook.log`, file hashes and mtimes
> answered this in minutes without touching a running Claude session.

## Problem

**(Superseded — this premise is false; see above.)**

Nothing updates the capture hook. When a release changes `hooks/hook.py`, the copy
at `~/.claudegate/hook.py` stays on the old version until the user notices a
`$(warning) Claude Gate` chip in the status bar and manually runs **Setup Hook**.

That makes new-extension + old-hook the *normal* state after any such release, not
an edge case. Users read the warning as "capture is broken" and, in at least one
report, as the extension having stopped working after an update.

The chip is also indiscriminate: it looks identical whether the extension could
have silently fixed the problem itself or whether the user genuinely has to act.

## The mechanism that makes this safe

`~/.claude/settings.json` does not invoke `hook.py` directly. It invokes a stable
two-line wrapper:

```bash
#!/usr/bin/env bash
python3 "$HOME/.claudegate/hook.py"
```

The wrapper path never changes, and it re-execs `hook.py` **fresh on every tool
call**. Therefore:

- **`hook.py` changes are hot.** A running Claude session picks up a rewritten
  hook on its very next edit. No restart.
- **`settings.json` changes are cold.** Claude reads it once at session start, so
  changing the registration silently stops capture for every already-running
  session until it restarts.

The extension currently treats both identically. This design separates them.

## Approach

One new method on `HookInstaller`, called once during `activate()` before health is
first computed:

```
activate()
  → hookInstaller.healStaleHook()   // silent, atomic, idempotent
  → hookInstaller.getHealth()       // now accurate
  → renderHookHealth(...)           // chip only when the user must act
```

No new module. `HookHealth`, the status chip, and `onHealthChange` are unchanged.
`stale` simply stops being reachable on the normal path.

## Scope boundary

**May auto-heal:** files under `~/.claudegate/` — `hook.py` and `hook.sh`. We own
that directory, and the wrapper indirection means the change takes effect
immediately for running sessions.

**May never auto-heal:** `~/.claude/settings.json`. Writing it invalidates running
Claude sessions and requires a restart, so it stays a deliberate user action
(**Setup Hook**). This boundary is the entire safety argument and must be stated as
a comment at the call site, not only here.

**Updates only, never installs.** Auto-heal rewrites a hook file that already
exists and differs from the bundled copy. It never creates one that is absent —
that is `not-installed`, and installing also requires registering the hook in
`settings.json`, which is out of bounds. A missing `hook.py` or `hook.sh` therefore
leaves health at `not-installed` and the chip pointing at **Setup Hook**.

`healStaleHook()` returns whether it wrote anything, so the caller can log a single
line and callers in tests can assert the no-op path.

## Safety rules

1. **Hash first, write only on mismatch.** Runs on every activation, so the common
   path must be one read plus a sha256 — no write, no I/O beyond that.
2. **Atomic write** (temp file + rename, the existing `atomicWrite` pattern). A
   half-written `hook.py` breaks capture for *every* session, which is strictly
   worse than being one version behind.
3. **Preserve the executable bit** on `hook.sh`.
4. **Fail soft.** On any error leave the installed hook untouched — it still
   captures, just at an older version — log the reason, and surface `stale`.
5. **Silent on success**, logged to the Output channel. A notification announcing
   that a file the user has never heard of was updated is noise.

## Health states after the change

| State | Meaning | Chip action |
|---|---|---|
| `ok` | working | hidden |
| `not-installed` | hook files absent | Setup Hook |
| `not-registered` | `settings.json` lacks our entry | Setup Hook, then restart Claude sessions |
| `trust-invalidated` | hooks block changed mid-session | restart Claude sessions |
| `stale` | auto-heal **failed** | retry, showing the real reason |

`stale` changes meaning. Today it means "you have work to do"; afterwards it means
"we tried to fix this and could not". The three states that remain user-actionable
are exactly the ones that require a Claude session restart, so their messages
should say so.

## Compatibility contract

The extension already tolerates sessions written by an older hook
(`migrateSession` defaults every missing field and moves legacy
`reviewStatus: accepted|rejected` entries out of `files{}`), and `hook.py` already
tolerates sessions written by a newer extension (it reads with `.get()` defaults
and only ever writes `files`, preserving `accepted`/`rejected`).

Both properties hold by accident — nothing tests them. Since auto-heal makes
version skew routine rather than exceptional, they get locked down:

- A session in the **old hook's shape** loads through `migrateSession` with no
  data loss.
- `hook.py` reads a session containing `accepted[]` / `rejected{}` written by a
  **newer extension** and preserves both.

## Error handling

| Failure | Behaviour |
|---|---|
| Write fails (permissions, disk full) | Log, keep existing hook, health = `stale`, chip offers retry |
| Bundled hook missing (packaging bug) | Log an error, write nothing, health unchanged |
| Hash of installed hook unreadable | Treat as mismatched and attempt the heal |

Every path leaves a working — if older — hook in place. Auto-heal must never be
able to make capture worse than it already was.

## Testing

- **`healStaleHook`**: writes when hashes differ; no-ops when equal; does **not**
  create an absent hook; fails soft on a write error; preserves the exec bit on
  `hook.sh`.
- **Compat (TS)**: old-hook-shaped session loads without data loss.
- **Compat (Python)**: `hook.py` preserves `accepted`/`rejected` written by a newer
  extension.

Per `CLAUDE.md`, any new `src/*.test.ts` must be appended to the `test:unit` script
in `package.json` or it will not run.

## Documentation

Add to `CLAUDE.md`: **`hook.py` changes are hot (no restart required);
`settings.json` changes are cold (restart required).** This is the fact that makes
auto-heal safe, and it is currently written down nowhere — a future contributor
would reasonably assume both need a restart, or that neither does.

## Out of scope

- **`hook.py --self-test`** (an active end-to-end probe of the capture chain).
  Auto-heal removes the common failure without it, and shipping a hook change now
  would push every user into the skew state this design exists to eliminate. It is
  a clean follow-up if silent runtime breakage proves to still be a problem.
- **Auto-registering the hook in `settings.json`.** Out by the scope boundary above.
- **First-run onboarding** for users who never set the hook up at all. Related, but
  a different failure mode and a different design.
