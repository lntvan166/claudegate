# Shell-Write Capture + Config Write Safety — Design

**Date:** 2026-08-11
**Status:** Approved — ready for implementation planning
**Bug report:** `docs/2026-08-11-bash-writes-bypass-capture-bug.md`
**Ships as:** two releases (Phase 1 alone, then Phase 2)

---

## Problem

Claude changes files through more than the `Write`/`Edit`/`MultiEdit` tools. It
also runs shell commands that rewrite files — routine behaviour for bulk edits,
codemods, formatters and reverts. ClaudeGate captures the first kind and **nothing
at all** of the second.

A real session across 3 repos / 7 source files produced exactly one capture, and
that one was incidental. Every actual code change was invisible to review, and the
panel showed a clean "nothing pending" state indistinguishable from "nothing
happened".

Three independent layers each drop shell writes on the floor:

1. **The matcher never selects it.** `hookInstaller.ts:80` registers
   `matcher: "^(Write|Edit|MultiEdit)$"`. `Bash` is not in that alternation, so
   Claude Code never invokes the hook.
2. **The hook would bail anyway.** `hook.py:225-227` requires `tool_input.file_path`.
   A `Bash` payload carries `tool_input.command` instead, so it hits `sys.exit(0)`
   *above* the first `log_event` call. Widening the matcher alone therefore changes
   nothing except adding a silent no-op to every shell command.
3. **Existing installs can never upgrade.** `computeSettingsPatch` decides an entry
   is "correct" by comparing only the `command` string (`hookInstaller.ts:58-60`);
   the matcher is never inspected. A user whose wrapper path is already right keeps
   the old matcher forever, through every activation and every hook sync.

Both (1) and (2) were reproduced directly: feeding `hook.py` an `Edit` payload
creates a session file and logs `captured`; feeding it the equivalent `Bash`
payload for the same file produces no session file and no log line at all.

**Why it is the worst kind of failure.** No health check can detect it. The hook
is installed, registered, current, and working — it is simply never invited. This
is strictly quieter than the 2026-07-06 trust bug, where the tool at least stopped
being reached for.

**Secondary cost.** The shell route also loses the correctness check the
first-party tools give for free: `Edit` fails loudly on a non-matching target,
while `str.replace` silently no-ops. In the reported session that shipped dead
code to `main` and `sandbox` under a commit message asserting the fix was in.

---

## Findings that changed the design

Two facts were established during design that invalidate previously documented
assumptions. Both were measured, not inferred.

### 1. `settings.json` changes are hot, not cold

`CLAUDE.md` ("Hot vs Cold Hook Changes") and
`docs/superpowers/specs/2026-08-03-hook-autoheal-design.md` both state that a
`settings.json` write silently disables capture in running Claude sessions until
restart. That is why `patchClaudeSettings()` is gated behind a manual **Setup
Hook** click.

**This is no longer true on Claude Code 2.1.227.** Measured on a live session:

| Observation | Evidence |
|---|---|
| Claude Code watches the settings file | `inotify` watch on `settings.json` inode, mask `c06` (`IN_MODIFY\|IN_ATTRIB\|IN_DELETE_SELF\|IN_MOVE_SELF`), present in **all 7** running sessions including 25-hour-old ones |
| A hook added mid-session fires | probe hook written at `11:13:25`, fired at `11:13:40` and `11:13:52` in a session started long before |
| Existing hooks are **not** revoked | the claudegate hook captured `TEMP-hooktest-delete-me.txt` immediately afterwards (`hook.log`) |

Static reading of the 2.1.227 binary agrees: hook config is snapshotted at startup
(`setup_hooks_captured` telemetry) and served from cache, but a settings-change
path re-stores that snapshot ("Settings changed from …, updating app state").

**Consequence:** the matcher can be auto-healed. No prompt, no new health state,
no restart notice, no user action.

**Open item — CLOSED (verified 2026-08-11, before Phase 2b landed).** The first
live test used the *project* settings file, since that was the low-blast-radius
option, leaving the end-to-end hot reload of the user-global file undemonstrated.
It has now been demonstrated directly: a probe hook was added to
`~/.claude/settings.json` — the file we actually write — and fired on the very
next tool call in a session that had been running for hours, with the existing
claudegate hook continuing to fire throughout. The probe was then removed and the
file restored byte-identically (sha256 unchanged before and after). Nothing about
the auto-heal is now inferred from the project-settings case.

### 2. The config write path can destroy the user's Claude config

Found while auditing Phase 2's safety. All three hazards are **live in the shipped
extension today** and independent of this bug.

| # | Hazard | Consequence |
|---|---|---|
| 1 | `catch { raw = "" }` (`hookInstaller.ts:457-462`) conflates *unreadable* with *absent* | `computeSettingsPatch("")` returns a fresh-install stub, which is then written over the user's entire config — `model`, `permissions`, `enabledPlugins`, `extraKnownMarketplaces`, `theme`, and **other tools' hooks**. The backup is skipped, because it is gated on `raw.trim()`. |
| 2 | Backup is a single fixed path, overwritten every write | a second bad write destroys the only good copy |
| 3 | `writeFileAtomic`'s `renameSync` replaces a symlink with a regular file | a dotfiles-managed config is silently detached; the real file stops being read |

Hazard 1 needs only a transient read failure on a perfectly good file — `EACCES`,
`EMFILE` under a busy VS Code, or `EBUSY`/`EPERM` on Windows while Claude Code
writes the file concurrently (which it does often, for model/theme/plugin state).

Today this requires a **Setup Hook** click. Auto-healing would run it at every
activation and every window focus, for every user. **The hardening is therefore a
prerequisite for the auto-write, not a companion to it.**

---

## Phase 1 — Config write safety

Ships as its own patch release, before anything writes to `settings.json`
automatically.

### Write protocol

1. **Only `ENOENT` means fresh install.** Read with explicit errno handling.
   `ENOENT` → the file is genuinely absent → safe to create. **Any other errno →
   abort, write nothing**, log once. Closes hazard 1.
2. **Always back up before any write,** including the create case. Timestamped —
   `settings.json.claudegate-<ISO>.bak` — retaining the newest 5. Closes hazard 2.
3. **Resolve `realpath` before writing.** Write the temp file beside the *resolved*
   target and rename onto the resolved path. Preserves symlinked configs and keeps
   the rename within one filesystem. Closes hazard 3.
4. **Verify after write; auto-restore on failure.** Re-read, `JSON.parse`, and
   assert that every top-level key present beforehand is still present *and* our
   entry landed. Any failure → restore the backup immediately and latch off.
5. **Touch only what we own.** Append or repair solely the claudegate `PreToolUse`
   entry. Never reorder keys, never drop unknown ones, never touch another tool's
   hooks. (`computeSettingsPatch` already behaves this way; Phase 1 adds the
   regression test that pins it.)
6. **Refuse on malformed JSON.** Already implemented; retained and tested.
7. **Bounded attempts.** At most one write attempt per extension activation —
   never per focus event — latching off permanently after any failure.

### Tests (these gate the release)

- A settings blob carrying foreign top-level keys **and** a foreign tool's
  `PreToolUse` hook round-trips intact apart from our added entry.
- A present-but-unreadable settings file produces **no write at all** and no backup
  churn.
- A symlinked settings file is still a symlink afterwards, with the dotfiles target
  updated.
- A post-write verification failure restores the backup.
- Malformed JSON is refused (existing behaviour, retained).

---

## Phase 2 — Shell-write capture

### Architecture

```
Claude Code (any session)
   │
   ├── PreToolUse ^(Write|Edit|MultiEdit)$ ──► hook.sh ──► hook.py ──┐  tool_input.file_path
   │                                                                 │
   └── PreToolUse ^Bash$ ─────────────────────► hook.sh ──► hook.py ──┤  tool_input.command
                                                                      │        │
                                                          paths_from_command()  │
                                                                      ▼        ▼
                                                    ...existing capture pipeline, unchanged...
                                       (cwd resolve → workspace_root_for_file → worktree routing
                                        → binary/unreadable skip → advisory lock → pending check
                                        → save_session)
```

Three deliberate properties:

- **The session schema does not change.** A shell-originated capture is an ordinary
  pending `FileEntry` with a real `originalContent` baseline. `reviewPanel`,
  `diffProvider`, accept/reject, revert/reapply, worktree routing and the explorer
  badge all work unmodified. `migrateSession` is untouched.
- **Both legs share one pipeline.** `main()` gains a dispatch at the top —
  `file_path` present → today's flow; otherwise `command` present → extract
  candidates, then run each through the *same* code. No parallel implementation to
  drift.
- **Half the fix reaches existing users for free.** `hook.py` is hot: `syncHookIfNeeded()`
  already ships it on the next activation or window focus. Only the matcher needs
  the settings write.

### `hook.py` — three tiers

**Tier 1 — write detection (fast path).** Does the command plausibly write? If not,
exit immediately, before any filesystem work. This keeps the measured ~23 ms
per-invocation cost off every `ls` / `go build` / `git status`, and keeps
`hook.log` free of spam.

Indicators: shell redirection; `sed -i`/`--in-place`; `tee`; `cp`/`mv`/`install`;
`patch`; `git apply`, `git checkout --`, `git restore`, `git stash pop|apply`,
`git reset --hard`; `dd of=`; `truncate`; `touch`; in-place formatters (`gofmt -w`,
`goimports -w`, `prettier --write`, `black`, `rustfmt`, `ruff format`,
`clang-format -i`); `perl -pi`; and `open(…, 'w')`.

**Tier 2 — target extraction.** Harvest candidates from the command string:

- explicit redirection targets, excluding `/dev/null`, `/dev/std*`, `/dev/tty` and
  fd-duplication forms (`2>&1`, `>&2`);
- non-flag arguments of the known in-place tools above;
- **all path-shaped string literals** in the command.

The third rule is what catches the reported failure, where the path is bound to a
variable before being written:

```python
p='manager/biz/monitor_filter.go'   # literal harvested here
s=open(p).read()
open(p,'w').write(...)              # write indicator fires Tier 1
```

Candidates then flow through the existing pipeline unchanged.

**Tier 3 — unattributable writes: explicitly out of scope.** Commands that write
without naming a file (`make generate`, `go generate`, `prettier --write src/`,
`git checkout .`) produce no capture and no warning. Rationale: these
overwhelmingly regenerate build output that Claude did not author, so a notice
would be noise. Accepted residual gap: a directory-wide revert or reformat of real
source goes unrecorded. Named forms (`git checkout -- some/file.go`) are still
caught by Tier 2. This is the only part that would have touched the session schema;
dropping it means Phase 2 needs no data-format change at all.

### Why liberal harvesting is safe

Under-capture is the bug; over-capture is nearly free. A wrongly harvested path
lands in one of two states, and both self-clean via existing logic:

| Case | Outcome |
|---|---|
| Path exists, command didn't touch it | baseline equals disk → hidden immediately by `hasRealPendingChange`, pruned after `NOOP_SETTLE_MS` (15 s) |
| Path doesn't exist | entry with `originalContent: null`, pruned after `NEW_FILE_ABSENT_MS` (45 s); a reject inside that window deletes an already-absent file — a no-op |

So a false positive costs a transient, invisible entry — never a wrong diff, never
data loss. Generated files that *are* named still route through the user's existing
`claudegate.exclude` filtering at display time.

### `hookInstaller.ts` — matcher auto-heal

- Extract the matcher to a single exported constant, widened to
  `^(Write|Edit|MultiEdit|Bash)$`.
- `computeSettingsPatch` must compare the **matcher** as well as the command, and
  repair in place when it differs — reusing the existing stale-registration repair
  branch, which already sets `changed = true`.
- A new `syncSettingsIfNeeded()` runs at activation alongside `syncHookIfNeeded()`
  and performs the write itself when `changed` is true, under the Phase 1 write
  protocol (including the once-per-activation latch).

### Adjacent correction

`watchSettingsForTrustInvalidation()` and the `trust-invalidated` health state exist
solely to warn "your running sessions have stopped tracking, restart them." On
2.1.227 that is false — sessions reload and keep working. Our own writes will not
trigger it (`lastKnownSettingsRaw` covers that), but a user hand-editing settings
would still be told to restart for no reason. **Scope for Phase 2: correct the
message.** Removing the mechanism is deliberately not proposed — older Claude Code
versions may still behave the documented way.

`CLAUDE.md`'s "Hot vs Cold Hook Changes" section must be updated in the same change,
since it is the source of the now-false rule.

### Error handling

Unchanged philosophy: **fail open, always.** The hook runs synchronously before
every Claude write and must never block or slow an edit. Extraction is wrapped so
any exception logs and exits 0. Work is bounded — scanned command text is capped,
candidates capped (~25) — so a pathological heredoc cannot stall a write. No
subprocess, no glob expansion, no `git` invocation on this path.

### Tests

- Table-driven Python test over ~30 commands covering every form in the bug report,
  plus negative controls (`ls`, `go build`, `git status`, `cat f`,
  `echo x > /dev/null`) asserting **zero** extraction.
- End-to-end: a real `Bash` payload produces the expected session entry.
- `computeSettingsPatch`: an old-matcher entry with a correct command is detected as
  stale and repaired; an already-correct entry is still a no-op (idempotency, which
  the 2026-07-06 fix depends on).
- Per `CLAUDE.md`, every new `src/*.test.ts` must be appended to the `test:unit`
  script in `package.json`.

---

## Acceptance

From the bug report, unchanged:

1. In a registered workspace, modify a tracked file via `Bash` — one case each for
   a `python3` heredoc, `sed -i`, and `cat > f <<EOF`.
2. Each produces a visible captured diff in the review panel.
3. `~/.claudegate/hook.log` contains an entry for each — silence is the bug.
4. Control: an ordinary `Edit` still captures exactly as before, and a non-write
   shell command (`go build`, `ls`) produces no capture and no log spam.

Plus, for Phase 1:

5. A present-but-unreadable `~/.claude/settings.json` results in no write.
6. A symlinked `~/.claude/settings.json` remains a symlink, with the dotfiles target
   updated.

---

## References

- Bug report: `docs/2026-08-11-bash-writes-bypass-capture-bug.md`
- Prior bug this design corrects the premise of:
  `docs/2026-07-06-hook-not-firing-in-running-session-bug.md`
- Superseded hot/cold claim: `docs/superpowers/specs/2026-08-03-hook-autoheal-design.md`
  and `CLAUDE.md` § "Hot vs Cold Hook Changes"
- Matcher registration: `src/hookInstaller.ts:80`
- Config write path: `src/hookInstaller.ts:453-503`
- Hook entrypoint / `file_path` contract: `hooks/hook.py:218-289`
- No-op pruning that makes over-capture safe: `src/reviewModel.ts:98-135`
