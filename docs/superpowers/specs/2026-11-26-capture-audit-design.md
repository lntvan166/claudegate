# Capture audit: measure what Claude really changed, and surface what we missed

Status: approved direction (A + B) — design for review.

## Why

ClaudeGate's job is a review list that matches exactly what Claude changed: nothing Claude changed is missing, and nothing Claude didn't change (a `git pull`, codegen, another person) is in it.

For Write/Edit/MultiEdit the file is named, so capture is exact. For `Bash`, `hooks/hook.py` *guesses* the target files from the command text before the command runs. Several releases (1.16.x → 1.18.0, in progress) improved that guess. Each improvement was measured by replaying real commands and counting "candidates that exist on disk" against "candidates with nothing on disk".

That proxy is weak:
- A file existing doesn't mean the command changed it.
- A missing file may be one the command created and then deleted.

No number today says what fraction of Claude's real edits are captured, or how many captures are phantoms. The maintainer wants decisions driven by real data, and wants to never be silently unaware of an edit Claude made.

## Goals

1. **Measure (A).** For every Bash call, record ground truth: which files under a registered root actually changed while the command ran. Compare it with what the hook captured:
   - `missed`: changed, not captured;
   - `phantom`: captured, not changed;
   - `implicit`: changed by a command containing a git history op, codegen or extraction.

   Aggregate per day so precision and recall can be read off after a few days of real work.
2. **Surface (B).** In ClaudeGate Desktop, show files Claude changed that were not captured, so the user can check them by hand. There is no baseline, so there is no Reject.

## Non-goals

- Capturing missed files with a reconstructed baseline. Using git HEAD as the baseline is unsafe: Reject would wipe the user's own uncommitted edits. Full observation-based capture (approach C) is deferred until A's data shows where the misses are.
- Changing what the PreToolUse capture captures. A and B observe; they do not add entries to `files`.
- The VS Code extension's panels. B is desktop-app only for now. The extension only has to install the new hook.

## Anti-goals (would make this a failure even if it works)

- **Showing a `git pull`'s, codegen's or extraction's changes as Claude's misses.** The maintainer's rule: those never count as Claude's edits. They are classified `implicit`, never `missed`, and B never shows them.
- **Noticeably slowing every Bash call.** Budget: the post-scan adds ≤ 30 ms on a warm cache for the maintainer's largest root, which has ~1.5k tracked files and 70 nested repos. Hard stop at 150 ms; if the budget runs out, log `audit-truncated`.
- **Blaming Claude for the user's own saves.** Changes that cannot be attributed confidently are marked `uncertain`, not `missed`.
- **Breaking Claude Code if the hook fails.** Fail open, exactly as the PreToolUse hook does.

## Constraints

- **Measured on this machine.**
  - `git status` at the umbrella root does not see the 70 nested repos (gitignored by a `/<prefix>-*` pattern). Running it per repo would cost ~0.7 s, so git-based detection is out.
  - An mtime scan of the whole umbrella tree, pruning `.git`, `node_modules`, `vendor` and `target`, takes ~12 ms warm. It also covers non-git directories.
- `hook.py` ships in the VSIX and the desktop app bundles it by tag. Keep it to the Python stdlib, keep it synchronous and fast, and use only neutral names in code and docs.
- `~/.claude/settings.json` holds the user's whole Claude Code config. Any registration change goes through the existing guarded install protocol:
  - the extension: `computeSettingsPatch`, backup, verify, rollback;
  - the app: the ported `install_capture` and the xcheck byte parity.
- The extension and the app both read and write `~/.claudegate/`. A new file there is a new shared contract. The app's `no_writes` allow-list governs app-side writes.
- Shared-session schema: unchanged. Audit data lives outside session files.

## Approaches considered

- **A only.** Measure, change nothing visible. Cheapest, but the maintainer would still not see a miss when one happens.
- **A + B (chosen).** Measure, and show misses in the app. Gives the data, and ends the "silently unaware" problem for the user.
- **C, observation-based full capture.** Snapshot every likely file before each command, so every real change has a true baseline. Knowing "likely" files is the same guessing problem A measures. Deferred until A's numbers say where the misses are.
- **Rejected detection methods:**
  - `git status` before and after: blind to nested repos and non-git directories, and 0.7 s per call here.
  - Pre-scan everything: every Bash call would pay the cost, and it still gives no content baseline.

## Design (decided parts)

### Hook: PreToolUse (existing) records the command's start

For `Bash` only, after its existing capture work, `hook.py` writes a small in-flight record:

```
~/.claudegate/audit/inflight/<tool_use_id>.json
{ "startedAt": <epoch ms>, "cwd": ..., "sessionId": ...,
  "captured": [abs paths this call captured or found already-pending],
  "implicit": true|false }
```

- `implicit` means the command contains an implicit op, as defined by `_implicit_op` in the 1.18 work.
- The id is the hook input's tool-use id. If the input has none, skip the audit for that call.

### Hook: PostToolUse (new) scans and classifies

1. Read and delete the in-flight record. If it is missing, exit 0.
2. Pick the roots to scan:
   - every registered root (from `workspace-roots.json`) that contains `cwd` or a captured path;
   - each root's nested registered roots are covered by the same walk.
3. Walk each root with the excludes applied: the same matcher as capture, plus `.git`, `node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`. Collect regular files whose `mtime >= startedAt - 1000 ms`.
   - Do not follow symlinks.
   - Do not cross `st_dev`.
   - Stop at 150 ms.
4. Classify each changed file:
   - `captured`: in `captured`, or pending in its session with `capturedAt >= startedAt`.
   - `implicit`: the record's `implicit` is true. These are never shown.
   - `missed`: neither of the above.
   - `uncertain`: a `missed` file is downgraded to this when the command ran longer than 10 s (the user or another session may have saved meanwhile), or when another Claude session captured the same file inside the window.
5. A captured path that did not change is a `phantom`.
6. Append one line per Bash call to `~/.claudegate/audit/<md5(root)>.jsonl`:

   ```
   { "at", "sessionId", "durationMs", "cwd", "commandHead": first 120 chars,
     "missed": [...], "uncertain": [...], "phantom": [...], "implicitCount": n,
     "capturedCount": n, "truncated": bool }
   ```

   Rotate at 5 MB, keeping one old file.
7. The in-flight directory self-cleans: on every run, PreToolUse removes in-flight records older than 1 h.

### Registration

`PostToolUse` with matcher `^Bash$` runs the same wrapper as PreToolUse. The wrapper passes the event through; `hook.py` dispatches on `hook_event_name`. A one-line `hook.sh` wrapper is acceptable if it is needed.

- **Extension:** `computeSettingsPatch` adds and repairs the PostToolUse entry the same way it repairs the PreToolUse one. That includes the silent repair at activation, which is how existing installs migrate.
- **App:** `install_capture` adds both entries. The xcheck fixtures prove the bytes still match the extension's.

### B: the desktop app

- A new reader for `audit/<hash>.jsonl`, the files of the selected project and of its nested and worktree scopes. Only the last 7 days are shown.
- **Project header:** a quiet line when there are misses: "3 files Claude changed weren't captured".
- **The "Not captured" list:** clicking the line opens it, showing each file with its time, the command head, Open in editor, and Dismiss. A Dismiss is app-local, stored in config, never in the shared file.
- **Uncertain entries:** listed separately as "Changed while Claude was running (may be yours)", collapsed by default.
- **Settings → Capture:** a stats line for the last 7 days: captured, missed, phantom, implicit.

### Measurement report

A small script, `hooks/tools/audit_report.py`, run by hand, prints per-day and per-category precision and recall from the audit files. This is what the next round of hook work is decided on.

## Decisions after the builder check

**The maintainer decided: what counts as Claude's change that needs review.**

| Changed file | Class | Shown in B |
|---|---|---|
| Ignored by git (`git check-ignore`, run only on the few changed files; outside git, the fixed prune list): build output, caches, `.venv`, `dist` | `out-of-scope`, counted in stats only | no |
| Binary, by the same test capture uses | `out-of-scope` | no |
| Tracked or untracked-not-ignored source rewritten by a whole-tree formatter (`gofmt -w ./...`, `prettier --write src/`) | `missed` | yes |
| Lockfile or manifest not caught by the 1.18 manifest capture | `missed` | yes |
| Any change in a command with an implicit op (git history, codegen, extraction) | `implicit` | no |

**Calls made by Claude** (the maintainer may override):

1. **Latency.** PostToolUse runs a separate small stdlib script, `hooks/audit.py`, copied next to `hook.py`. It does not import `hook.py`, so process start plus scan stays around 25–35 ms. The registration is synchronous, not async.
2. **Several roots.** A changed file is attributed to the innermost registered root that contains it. One line is appended per (Bash call, innermost root) to that root's `audit/<md5(root)>.jsonl`, so nested projects see their own misses and nothing is double-counted.
3. **Overlapping windows.**
   - A changed file that is pending in *any* session at scan time is `covered`, not `missed`. This covers the session's own parallel calls and Write/Edit landing mid-command.
   - A `run_in_background` Bash call is marked `background` and excluded from the stats and from B, because its PostToolUse fires before its writes.
4. **Failed calls are audited too.** Register `PostToolUseFailure` with the same script, provided Claude Code supports that event; verify against its hook docs first. If the event doesn't exist, note the bias in the report.
   - An interrupted call leaves an in-flight record, which expires after 1 h.
   - Registering it goes through the same guarded settings protocol, in both repos, with xcheck fixtures.
5. **Blind spot accepted.** An mtime scan can't see deletions, or moves and copies that keep mtimes (`mv`, `cp -p`, `rsync -a`). Write this in the report output. `rm` is captured directly since 1.18.
6. **Already-pending file changed again by an unnamed write.** In A this is `covered-pending`: a guess miss counted for measurement. It is not in B, because the review panel already shows it against the earlier baseline.

## Left to the builder

- Exact field names and casing (camelCase, matching session files).
- The in-flight file format details and the rotation implementation.
- How to share the exclude matcher between capture and audit inside hook.py.
- UI layout details of B, following the app's existing chip, popover and list patterns.
- Where in the extension's tests the PostToolUse registration and repair are covered.
