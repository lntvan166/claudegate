# Capture Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every Bash call, record which files under a registered root really changed and how that compares with what the hook captured (A). In ClaudeGate Desktop, show the files Claude changed that were not captured (B).

**Architecture:**
- The existing PreToolUse hook (`hook.py`) writes a small in-flight record per Bash call.
- A new PostToolUse/PostToolUseFailure hook (`audit.py`, stdlib only, separate process) runs an mtime scan of the touched roots, classifies the changed files, and appends one JSON line per (call, innermost root) to `~/.claudegate/audit/<md5(root)>.jsonl`.
- Both the extension installer and the app installer register the new hook.
- The app reads the audit files and shows the misses.

**Tech Stack:**
- Extension: Python 3 stdlib (hooks), TypeScript.
- App: Rust (Tauri 2, `claudegate-core`), Svelte 5 + vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-capture-audit-design.md`

**Repos:**
- Extension: `/home/tuvan/Documents/src/personal/claudegate`. Branch `feat/capture-audit`, cut from `fix/hook-env-vars` once the N1 fix lands. Tasks 1–4.
- App: `/home/tuvan/Documents/src/personal/claudegate-desktop`, `main`. Tasks 5–7.

## Global Constraints

- **Names:** neutral names only in code, tests, docs and commits. Before every commit, run the internal-name scrub grep the controller gives you; it must print nothing. Never write the scrub list itself into the repo.
- **Hooks:**
  - Stdlib only, synchronous, fail open (any exception → exit 0, never print to stdout/stderr on success).
  - `audit.py` never imports `hook.py`.
- **Latency:** the audit adds ≤ 30 ms of scan on a warm cache. Hard scan budget 150 ms, then `truncated: true`. The whole audit process target is ≤ 35 ms on a ~1.5k-file tree.
- **Prune list (always):** `.git`, `node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`, plus the capture exclude matcher. Never follow symlinks; never cross `st_dev`.
- **Change window:** `mtime >= startedAt - 1000` ms. `uncertain` when the call took longer than 10 000 ms. Only the last 7 days are shown in the app. Rotate the audit file at 5 MB, keeping one old file (`<hash>.jsonl.1`). In-flight records expire after 1 h.
- **Classes** (exact strings):
  - `missed`: changed, not captured, not covered, not implicit, not out of scope.
  - `uncertain`: a `missed` file whose call ran longer than 10 s, or which another session captured inside the window.
  - `phantom`: captured but unchanged.
  - `covered`: pending in any session at scan time, with `capturedAt` before the call.
  - `implicit`: changed in a call whose record has `implicit: true`.
  - `outOfScope`: git-ignored (`git check-ignore`) or binary.
  - `background`: the call was `run_in_background`. The whole line is flagged; the app never shows it.
- **`~/.claude/settings.json`:** written only through the existing guarded protocols. That is `computeSettingsPatch` + backup/verify/rollback in the extension, and the ported `install_capture` in the app. xcheck byte parity must hold.
- **Session files:** unchanged schema. The audit lives only in `~/.claudegate/audit/`.
- **No version bump, CHANGELOG entry, tag, push or publish.** Releasing stays a maintainer decision.

## Review Focus

1. **A huge or deep root** (70 nested repos, 100k files): the scan stops at 150 ms and writes `truncated: true`. It never blocks longer. Pinned in Task 2 (`test_scan_stops_at_budget`).
2. **A PostToolUse with no in-flight record, no `tool_use_id`, or malformed stdin:** exit 0 with no output and no file written. Pinned in Task 2 (`test_missing_inflight_is_silent`).
3. **Two sessions, or two parallel calls, touching the same file:** the file is `covered`, not `missed`, when it is pending anywhere. Pinned in Task 2 (`test_pending_elsewhere_is_covered`).
4. **A half-written or garbage audit line** (concurrent appends, a crash mid-write): the app's reader skips the bad line and keeps the rest. Pinned in Task 6 (`skips_corrupt_lines`).
5. **A root outside any git repo, or git missing:** `outOfScope` falls back to the prune list and the binary test, with no error. Pinned in Task 2 (`test_no_git_uses_prune_list`).

---

### Task 1: In-flight record from the PreToolUse hook

**Files:**
- Modify: `hooks/hook.py` (`main`, after the Bash capture work)
- Test: `hooks/tests/test_audit_inflight.py`

**Interfaces:**
- Produces: `~/.claudegate/audit/inflight/<tool_use_id>.json`, with shape
  `{"startedAt": int ms, "cwd": str, "sessionId": str|null, "captured": [abs str], "implicit": bool, "background": bool}`.
  - `captured` lists the paths this call captured, plus candidates that were `skip-already-pending`.
  - `background` is `tool_input.run_in_background is True`.
- Produces: `hook.py` removes in-flight files older than 3 600 000 ms on each run, capped at 50 removals per run.

- [ ] **Step 1: Write failing tests** with a temp HOME:
  - `test_bash_writes_inflight`: payload `{tool_name:"Bash", tool_use_id:"t1", cwd:<root>, tool_input:{command:"sed -i s/a/b/ f.go"}}` → `inflight/t1.json` exists, with `captured == [<root>/f.go]` and `implicit is False`.
  - `test_implicit_flag`: the command `git pull` → `implicit is True`, `captured == []`.
  - `test_no_tool_use_id_no_record`.
  - `test_write_tool_no_record`: `tool_name:"Write"` → no in-flight record.
  - `test_stale_inflight_removed`: a record with mtime now − 2 h is deleted.
  - `test_inflight_failure_is_silent`: an unwritable audit dir → exit 0, and the capture still happens.
- [ ] **Step 2:** Run `python3 -m unittest hooks.tests.test_audit_inflight -v`. Expected: FAIL.
- [ ] **Step 3: Implement.** Record `startedAt` at entry, before the capture work, with `int(time.time()*1000)`. Write the record atomically (tmp + `os.replace`). Wrap everything so that a failure here never affects capture.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(hook): record an in-flight audit entry per Bash call`.

### Task 2: `audit.py` scans, classifies and appends

**Files:**
- Create: `hooks/audit.py`
- Test: `hooks/tests/test_audit.py`

**Interfaces:**
- Consumes: the Task 1 in-flight record, `~/.claudegate/workspace-roots.json`, `~/.claudegate/excludes.json`, and `~/.claudegate/sessions/*.json` (read only).
- Produces: `main()`, which reads the hook payload from stdin. `hook_event_name` is `PostToolUse` or `PostToolUseFailure`. It reads and deletes `inflight/<tool_use_id>.json`.
- Produces: one line per innermost root that has a change or a phantom, appended to `~/.claudegate/audit/<md5(resolved root)>.jsonl`. Use the same hash as the session files: `hashlib.md5(os.path.abspath(root))`, lowercased on Windows. The line, in exactly this shape:

  `{"at": ISO8601, "sessionId", "toolUseId", "event", "durationMs", "cwd", "root", "commandHead": first 120 chars, "background": bool, "truncated": bool, "missed": [abs], "uncertain": [abs], "phantom": [abs], "covered": int, "implicit": int, "outOfScope": int, "captured": int}`

  - A call with no change and no phantom writes nothing.
  - `durationMs` = now − `startedAt`.
- Produces: `scan_changed(roots, since_ms, budget_ms) -> (list[str], truncated: bool)`, `classify(...)`, and `rotate(path, max_bytes=5_000_000)`, all importable for tests.

- [ ] **Step 1: Write failing tests**, using a temp HOME and temp roots. Set file mtimes with `os.utime`.
  - `test_missed_file`: the record captured nothing; `<root>/a.go` mtime = start + 100 → `missed == [a.go]`.
  - `test_captured_not_missed`: `captured` has `a.go`, and `a.go` changed → `missed == []`, `captured == 1`.
  - `test_phantom`: `captured` has `b.go`, and `b.go` is unchanged → `phantom == [b.go]`.
  - `test_implicit_never_missed`: `implicit: true` → `missed == []`, `implicit == 1`.
  - `test_gitignored_out_of_scope`: init a git repo with `.gitignore` = `bin/`; `bin/x` changed → `outOfScope == 1`.
  - `test_binary_out_of_scope`.
  - `test_pending_elsewhere_is_covered`: another session has `files[a.go]` with `capturedAt` before start → `covered == 1`.
  - `test_long_call_uncertain`: `startedAt` = now − 11 000 → that file is in `uncertain`, not `missed`.
  - `test_innermost_root_attribution`: `<root>/sub` is also registered, and `sub/c.go` changed → the line goes to `md5(sub).jsonl` only.
  - `test_prune_and_symlink`: changes under `node_modules/` and behind a symlinked dir are not seen.
  - `test_scan_stops_at_budget`: `budget_ms=1` on a 5k-file tree → `truncated is True`, and it returns in under 50 ms.
  - `test_missing_inflight_is_silent`: no record, no `tool_use_id`, or garbage stdin → exit 0, nothing written, empty stdout.
  - `test_no_git_uses_prune_list`: PATH without git → no crash.
  - `test_rotate_at_5mb`.
  - `test_background_flag_kept`.
  - `test_post_failure_event_also_audited`.
- [ ] **Step 2:** Run `python3 -m unittest hooks.tests.test_audit -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Walk with `os.scandir`, iteratively. Check the deadline every 256 entries.
  - Pick the roots: those that contain `cwd` or a captured path, plus the registered roots nested inside them.
  - Batch `git check-ignore --stdin -z` per repo toplevel, over the changed files only.
  - Use the same binary test as `hook.py` (the first 8 KiB contains a NUL), duplicated here, not imported.
  - Append with `O_APPEND` and one `write()` per line.
- [ ] **Step 4: Measure.** Add `hooks/tests/test_audit_perf.py`:
  - It builds a 1 500-file tree with 70 nested dirs and asserts the warm `scan_changed` takes under 30 ms.
  - It asserts a subprocess run of `audit.py` with a record takes under 60 ms in total. Mark it `skipUnless` when not on CI if the runner is slow.

  Then run `npm test`.
- [ ] **Step 5:** Commit: `feat(hook): audit.py classifies what really changed per Bash call`.

### Task 3: Register the audit hook (extension)

**Files:**
- Modify: `src/hookInstaller.ts`, which covers the constants, `computeSettingsPatch`, the file copy and `syncHookIfNeeded`
- Create: `hooks/audit.sh` and `hooks/audit.bat`, mirroring `hook.sh` and `hook.bat` but pointing at `audit.py`
- Test: `src/hookInstaller.test.ts`

**Interfaces:**
- Produces: `POST_TOOL_MATCHER = "^Bash$"`. The settings entries go under `hooks.PostToolUse` and `hooks.PostToolUseFailure`, each `{ matcher: POST_TOOL_MATCHER, hooks: [{ type: "command", command: <~/.claudegate/audit.sh path> }] }`.
- Produces: `audit.py` and `audit.sh` are copied next to `hook.py` by `installHook`/`syncHookIfNeeded`, using the same hash compare.

- [ ] **Step 1: Verify `PostToolUseFailure` exists.**
  - Check the Claude Code hooks docs (https://docs.claude.com/en/docs/claude-code/hooks) and the input field name for the tool-use id (`tool_use_id`).
  - Record the result in CLAUDE.md.
  - If the event does not exist, drop it from this task. Then add a "failed calls are not audited" line to the report output in Task 4.
- [ ] **Step 2: Write failing tests:**
  - A fresh install adds both entries.
  - An install that has only PreToolUse is repaired, adding the post entries.
  - A wrong audit path is repaired.
  - Other tools' PostToolUse entries are untouched.
  - The idempotent patch is byte-identical on a second run.
  - The silent activation repair includes the new entries.
- [ ] **Step 3:** Implement it in the same style as the PreToolUse handling. Keep the guarded write protocol unchanged.
- [ ] **Step 4:** Run `npm test` and `xvfb-run -a npm run test:integration`. Expected: green.
- [ ] **Step 5:** Commit: `feat: register the capture audit hook (PostToolUse, PostToolUseFailure)`.

### Task 4: Report script and docs (extension)

**Files:**
- Create: `hooks/tools/audit_report.py`
- Modify: `CLAUDE.md`, adding a "Capture audit" section and a hook behavior bullet
- Modify: `.vscodeignore`, so that `hooks/tools/**` is not packaged
- Test: `hooks/tests/test_audit_report.py`

**Interfaces:**
- Produces: `python3 hooks/tools/audit_report.py [--days N] [--root PATH]`. It prints one row per day and a total:
  - calls, captured, missed, uncertain, phantom, covered, implicit, outOfScope, truncated;
  - `recall = captured / (captured + missed)` and `precision = captured / (captured + phantom)`;
  - the top 20 `commandHead` prefixes (first 2 words) with misses;
  - the blind-spot line: "mtime scan cannot see deletions, or moves/copies that keep mtime".

- [ ] **Step 1: Write the failing test.** Feed it fixture jsonl, including a corrupt line, and assert the numbers and that the corrupt line is skipped.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Run `npm test` and confirm the package by checking that `vsce ls` shows `hooks/audit.py` and `hooks/audit.sh` but not `hooks/tools/`.
- [ ] **Step 5:** Commit: `feat: audit report script; document the capture audit`.

### Task 5: App registers and bundles the audit hook

**Files** (in `claudegate-desktop`):
- Modify: `scripts/bump-hook.sh`, which now also copies `hooks/audit.py`, `audit.sh` → `src-tauri/resources/`
- Modify: `core/src/store.rs`, covering `install_capture` (both post entries, `audit.py`/`audit.sh`), `replace_hook` and `update_app_hook` (refresh `audit.py` alongside `hook.py`, under the same guards)
- Modify: `core/src/capture.rs`, `compute_settings_patch`, mirroring Task 3's entries
- Modify: `xcheck/` capture fixtures
- Test: `core/tests/install_capture.rs`, `core/tests/capture.rs`

**Interfaces:**
- Consumes: Task 3's exact entry shape and `POST_TOOL_MATCHER`.
- Produces: the same settings bytes as the extension for every fixture. Checked by xcheck.

- [ ] **Step 1: Write failing tests:**
  - A fresh install writes `audit.py` and `audit.sh` (mode 0755) and registers both post entries.
  - The rollback removes them under the existing rules.
  - `update_app_hook` refreshes `audit.py` when it refreshes `hook.py`.
  - The status detection is unchanged by the presence of post entries.
- [ ] **Step 2:** FAIL. **Step 3:** Implement, then run `scripts/bump-hook.sh <tag-or-branch-ref>` against the extension branch for the bundled copies. **Step 4:** `cargo test --workspace` (`CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4`), `bash scripts/capture-e2e.sh`, and xcheck all green.
- [ ] **Step 5:** Commit: `feat: install and update the capture audit hook`.

### Task 6: App reads the audit (core + command)

**Files:**
- Create: `core/src/audit.rs`
- Modify: `src-tauri/src/commands.rs`, adding `get_audit` and `dismiss_audit`
- Modify: `src-tauri/src/config.rs`, adding `auditDismissed`
- Test: `core/tests/audit.rs`, `src-tauri/tests/audit_cmd.rs`

**Interfaces:**
- Produces: `pub fn read_audit(home: &Path, roots: &[PathBuf], since_ms: i64) -> AuditView`.
  - `AuditView { missed: Vec<AuditItem>, uncertain: Vec<AuditItem>, stats: AuditStats }`
  - `AuditItem { path, at_ms, command_head, root }`, deduplicated by path, keeping the latest.
  - `AuditStats { calls, captured, missed, uncertain, phantom, covered, implicit, out_of_scope, truncated }`
  - It reads both `<hash>.jsonl` and `.jsonl.1`, skips lines flagged `background`, and skips lines that fail to parse.
- Produces: the Tauri command `get_audit(root) -> AuditView`.
  - It covers the project's scopes: the primary root, the worktrees and the nested roots.
  - The window is the last 7 days.
  - It removes dismissed items, meaning `auditDismissed[path] >= item.at_ms`.
  - It also removes items whose file is pending now.
- Produces: `dismiss_audit(paths: Vec<String>)`, which writes `auditDismissed` through `update_config` (add-only, under the lock). Entries older than 7 days are pruned on write.

- [ ] **Step 1: Write failing tests:**
  - `reads_both_files`
  - `skips_corrupt_lines`
  - `skips_background`
  - `dedups_latest`
  - `window_7_days`
  - `dismissed_hidden_until_newer_miss`
  - `pending_now_hidden`
  - `nested_scope_included`
  - `no_writes` stays green: the only new write is config.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `cargo test --workspace`.
- [ ] **Step 5:** Commit: `feat: read the capture audit per project`.

### Task 7: App UI for misses and stats

**Files:**
- Create: `ui/src/lib/audit.ts`, `ui/src/components/NotCaptured.svelte`
- Modify: `ui/src/App.svelte`, the project header line
- Modify: `ui/src/components/Settings.svelte`, the Capture stats line
- Modify: `ui/src/lib/api.ts`, `ui/src/lib/mock.ts`, `README.md`
- Test: `ui/src/lib/audit.test.ts`

**Interfaces:**
- Consumes: `get_audit` and `dismiss_audit` from Task 6.
- Produces (copy pinned by the spec):
  - **Header line**, shown when `missed.length > 0`: `N files Claude changed weren't captured` (singular: `1 file Claude changed wasn't captured`).
  - **List.** Each row shows the path relative to its scope, a relative time and the command head, with the actions **Open in editor** and **Dismiss**. There is also a **Dismiss all**.
  - **Uncertain section**, collapsed by default: `Changed while Claude was running (may be yours)`.
  - **Settings → Capture:** `Last 7 days: X captured · Y missed · Z phantom · W implicit` (omit any zero term except captured).

- [ ] **Step 1: Write the failing test** in `audit.test.ts`. It covers the header text (singular and plural), the stats line, relative paths per scope, and that dismiss removes the rows optimistically.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
  - Refresh on the existing session-change events, and on the audit file changing. Add the audit dir to the watcher's map.
  - Keyboard: the list rows are focusable, Enter opens, Delete dismisses.
- [ ] **Step 4:** `npm --prefix ui test` and `npm --prefix ui run check`. Then check the preview (`?audit=some` mock state) at narrow and wide widths, in dark and light themes. Stop the dev server by PID, never with `pkill -f`.
- [ ] **Step 5:** Commit: `feat(ui): show files Claude changed that weren't captured`.
