# Bug: file edits performed through `Bash` bypass capture entirely

**Date:** 2026-08-11
**Severity:** High — silent, total review bypass. Not a subset of edits: an agent that writes files via shell does *100%* of its work unreviewed, while the UI shows a clean "nothing pending" state indistinguishable from "nothing happened".
**Component:** `src/hookInstaller.ts:80` (the PreToolUse matcher) + `hooks/hook.py:224-227` (the `file_path` contract)
**Status:** FIXED in v1.13.0 (2026-08-11). Design:
`docs/superpowers/specs/2026-08-11-bash-writes-capture-design.md`.

> Fix options (1) and (3) below were both partly overtaken by what the design
> turned up. Option 1's "detect and warn" became "detect and capture a real
> diff", because the extension already prunes baselines that turn out to match
> disk — so guessing a path wrongly costs a transient invisible entry, which
> makes liberal extraction affordable rather than reckless. Option 3's premise —
> that per-tool interception cannot be trusted — is right, and Claude Code now
> offers a `FileChanged` hook that delivers it natively; it is not used here
> because it fires after the write and so carries no baseline.
>
> Two things had to be fixed that this report does not mention. Widening the
> matcher could never have reached an existing install, because the registration
> check compared only the wrapper path and never the matcher. And the reason
> that check was manual at all — the belief that writing `settings.json`
> invalidates hooks in running sessions — no longer holds on Claude Code
> 2.1.227, which is what allows the repair to happen automatically.

---

## Symptom

A full working session of code changes across 3 repos / 7 source files produced **exactly one** ClaudeGate capture — and that one file was incidental (a doc created with `Write`). Every actual code change was invisible to review.

`~/.claudegate/hook.log`, filtered to that day:

```
$ grep "^2026-08-11" ~/.claudegate/hook.log
2026-08-11T02:31:43.650612+00:00 captured /home/…/repo/features/example-feature/deploy/sql/prod.sql
```

The same source files had been captured normally on previous days — 19 hits for `es_reader.go`, 14 for `monitor_filter.go` / `shipment_monitor_completed.go` across the log's history. So the plumbing was healthy; nothing was misconfigured, excluded, or stale.

The user noticed only because they went looking: *"why I dont see anything in /claudegate review for this?"* Nothing in the extension surfaced the gap.

## Root cause

The agent applied its edits with Python heredocs run through the `Bash` tool:

```bash
python3 - <<'PY'
p='manager/biz/monitor_filter.go'
s=open(p).read()
s=s.replace(old, new, 1)
open(p,'w').write(s)
PY
```

Two independent layers each drop this on the floor:

1. **The matcher never selects it.** `src/hookInstaller.ts:80` registers

   ```ts
   matcher: "^(Write|Edit|MultiEdit)$",
   ```

   `Bash` is not in that alternation, so Claude Code never invokes `hook.sh` at all.

2. **Even if it were, the hook would bail.** `hooks/hook.py:224-227` is built entirely around a `file_path` key:

   ```py
   tool_input = hook_input.get("tool_input") or {}
   file_path = tool_input.get("file_path", "")
   if not file_path:
       sys.exit(0)
   ```

   A `Bash` invocation carries `tool_input.command` — a shell string — and no `file_path`. It would exit 0 silently, without even reaching `log_event`. So widening the matcher alone changes nothing; it just adds an invisible no-op on every shell command.

Note the failure is *quieter* than the 2026-07-06 hook-trust bug. There, the hook stopped firing but the tool was at least still the one Claude reached for. Here the tool works perfectly and simply is never asked, so no probe, health check, or "is the hook registered?" warning can detect it — everything is genuinely fine.

## Why this matters more than it looks

Writing files through the shell is not exotic agent behaviour. It is reached for routinely:

- bulk/mechanical sweeps across many files (rename, import reorder, codemod)
- `sed -i`, `python3 -c`, `perl -pi -e`, heredoc `cat > file <<EOF`
- `git checkout --`, `git apply`, `patch`, `git stash pop` — which *revert or rewrite* tracked files
- code generators and formatters (`make generate`, `gofmt -w`, `prettier --write`)

In the session that produced this report, the shell route also caused a **real shipped bug**, which is worth recording because it argues the gate has value beyond review:

> The replace targeted `Size:       totalMonitors,` (wide alignment) while the file contained `Size:  totalMonitors,`. Python's `str.replace` silently no-ops on a miss. The result was dead code, plus a commit message asserting the fix was in — shipped to `main` and `sandbox`. The `Edit` tool **fails loudly** on a non-match and would have caught it at the moment of the edit.

So the shell path loses the review gate *and* the correctness check that the first-party tools give for free.

## Fix options

Roughly ascending cost. (1) is cheap and strictly better than today; (3) is the only complete answer.

**1. Detect and warn (recommended first step).**
Add `Bash` to the matcher and, in `hook.py`, when `file_path` is absent but `tool_input.command` is present, scan the command for write-ish patterns — shell redirection into a path, `sed -i`, `tee`, `python3 … open(…,'w')`, `cp`/`mv` into the workspace, `git checkout --`, `git apply`. On a hit, don't try to reconstruct the diff; record a **flag** on the workspace session ("N unreviewed shell writes this session") and surface it in the UI. Turns a silent bypass into a visible one. Accept false positives — the cost is a dismissible notice.

**2. Snapshot-and-diff.**
On a suspected shell write, `git stash create` / snapshot the workspace before and after and capture the resulting file diffs. Accurate, no command parsing, but PreToolUse fires only *before* the tool runs, so this needs a PostToolUse companion hook and a snapshot store. Cost is real; correctness is high.

**3. Reconcile against git working-tree state.**
Stop trusting per-tool interception as the source of truth. Periodically (or on VS Code focus) diff the working tree against the last-reviewed snapshot and treat *any* unexplained modification as pending review, regardless of which tool made it. This is the only approach immune to new tool names and to edits made entirely outside Claude Code. Largest change; also the one that makes the guarantee actually hold.

An additional guard, orthogonal to the above and cheap: because Claude Code re-reads hook config, a `PreToolUse` on `Bash` could **deny** (exit 2) commands matching a high-confidence write pattern, with a message steering the agent to `Edit`/`Write`. Blunt, and it would fight legitimate build/codegen steps, so it likely belongs behind an opt-in setting rather than on by default.

## Acceptance check

1. In a workspace with ClaudeGate registered, modify a tracked file via `Bash` (`python3` heredoc, `sed -i`, and `cat > f <<EOF` — one case each).
2. Each must produce a visible signal: a captured diff (option 2/3) or an explicit unreviewed-shell-write warning (option 1).
3. `~/.claudegate/hook.log` must contain an entry for each — silence is the bug.
4. Control: an ordinary `Edit` still captures exactly as before, and a non-write shell command (`go build`, `ls`) produces no notice and no log spam.

## Reference paths

- Matcher registration: `src/hookInstaller.ts:80` (`^(Write|Edit|MultiEdit)$`)
- Hook entrypoint / `file_path` contract: `hooks/hook.py:220-240` (deployed at `~/.claudegate/hook.py`)
- Event log used as evidence: `~/.claudegate/hook.log` (`hooklog.enabled` present)
- Per-workspace session store: `~/.claudegate/sessions/<md5(workspace root)>.json`
- Related prior bug (different cause, same class of silent miss): `docs/2026-07-06-hook-not-firing-in-running-session-bug.md`
