# Hook Health & Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hook's health observable — a persistent status-bar indicator (not dismiss-once toasts), an opt-in `~/.claudegate/hook.log` for diagnosing silent capture-skips, and a per-check Verify Setup breakdown.

**Architecture:** `hook.py` gains sentinel-gated logging (config-free; the extension writes `~/.claudegate/hooklog.enabled` when the setting is on). `HookInstaller` computes a `HookHealth` state and fires `onHealthChange`; `extension.ts` reflects it in a status-bar chip and wires the setting/commands; `verify()` renders a structured report from a pure, tested builder.

**Tech Stack:** Python 3 (hook), TypeScript, VS Code status bar / commands / configuration. No new deps.

## Global Constraints

- `hook.py` MUST remain fail-open: logging is best-effort and wrapped so a logging failure never throws or blocks a Claude edit. Never add a non-zero exit.
- `hook.py` stays config-free — it reads only the sentinel file `~/.claudegate/hooklog.enabled`, never VS Code config.
- New setting `claudegate.hookLog.enabled` default **false**. Setting `claudegate.history.enabled` (existing) is unrelated — don't touch it.
- Every contributed command is registered and vice versa (internal-only commands registered-only, matching existing patterns).
- The hook log is a bounded rolling debug aid (self-truncate ~1 MB), not an audit trail; stays local (no network).
- Every new `src/*.test.ts` appended to the `test:unit` chain in package.json; Python tests auto-discovered in `hooks/tests/`.
- `hooks/hook.py` changes → the release CHANGELOG needs a "re-run Setup Hook" note (release skill handles it; do not bump the version here).
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: hook.py sentinel-gated logging

**Files:**
- Modify: `hooks/hook.py`
- Test: `hooks/tests/test_hook_log.py` (new; auto-discovered by `python3 -m unittest discover`)

**Interfaces:**
- Produces: a `~/.claudegate/hook.log` file (only when `~/.claudegate/hooklog.enabled` exists), with lines `<iso-ts> <event> <detail>`. Events: `captured`, `skip-no-root`, `skip-unreadable`, `skip-binary`, `skip-already-pending`, `error`.

- [ ] **Step 1: Write the failing test**

`hooks/tests/test_hook_log.py`:
```python
import json
import os
import subprocess
import sys
import unittest
import tempfile
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook.py")


class HookLogTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.logfile = os.path.join(self.cg, "hook.log")
        self.sentinel = os.path.join(self.cg, "hooklog.enabled")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, rel, tool="Edit"):
        payload = json.dumps({
            "tool_name": tool, "cwd": self.root,
            "tool_input": {"file_path": rel}, "session_id": "s",
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)

    def enable_log(self):
        open(self.sentinel, "w").close()

    def test_no_log_without_sentinel(self):
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertFalse(os.path.exists(self.logfile), "no log file when sentinel absent")

    def test_captured_logged_with_sentinel(self):
        self.enable_log()
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertTrue(os.path.exists(self.logfile))
        body = open(self.logfile).read()
        self.assertIn("captured", body)
        self.assertIn(p, body)

    def test_binary_skip_logged(self):
        self.enable_log()
        p = os.path.join(self.root, "img.bin")
        with open(p, "wb") as f:
            f.write(bytes([0x89, 0xff, 0xfe, 0x00]))
        self.run_hook(p)
        self.assertIn("skip-binary", open(self.logfile).read())

    def test_no_root_skip_logged(self):
        self.enable_log()
        outside = os.path.join(self.home, "outside", "x.txt")
        os.makedirs(os.path.dirname(outside))
        open(outside, "w").write("v")
        self.run_hook(outside)
        self.assertIn("skip-no-root", open(self.logfile).read())

    def test_log_self_truncates(self):
        self.enable_log()
        # Pre-fill the log beyond the cap; the next write should reset it small.
        with open(self.logfile, "w") as f:
            f.write("x" * 1_200_000)
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)
        self.assertLess(os.path.getsize(self.logfile), 1_000_000, "log truncated past the cap")
        self.assertIn("captured", open(self.logfile).read())

    def test_logging_failure_never_breaks_hook(self):
        # Sentinel present but the log path is unwritable (a directory) — the
        # hook must still exit 0 and capture normally.
        os.mkdir(self.logfile)  # occupy hook.log path with a directory
        self.enable_log()
        p = os.path.join(self.root, "a.txt")
        open(p, "w").write("v0")
        self.run_hook(p)  # check=True asserts exit 0
        sf = os.listdir(os.path.join(self.cg, "sessions"))
        self.assertEqual(len(sf), 1, "capture still happened despite unwritable log")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest discover -s hooks/tests -p 'test_hook_log.py' -v`
Expected: FAIL — `test_captured_logged_with_sentinel` etc. fail (no logging yet); `test_no_log_without_sentinel` passes trivially.

- [ ] **Step 3: Implement in `hooks/hook.py`**

Add constants after `WORKSPACE_ROOTS_FILE` (near line 21):
```python
HOOKLOG_SENTINEL = os.path.join(CLAUDEGATE_DIR, "hooklog.enabled")
HOOKLOG_FILE     = os.path.join(CLAUDEGATE_DIR, "hook.log")
HOOKLOG_MAX_BYTES = 1_000_000  # rolling debug aid; reset past this
```

Add a helper (place it above `def main()`):
```python
def log_event(event: str, detail: str = "") -> None:
    """Append a diagnostic line to ~/.claudegate/hook.log, but ONLY when the
    extension has created the sentinel (claudegate.hookLog.enabled=true).
    Best-effort and fully guarded: the hook must never break because logging
    failed. Self-truncates once the file passes the size cap."""
    try:
        if not os.path.exists(HOOKLOG_SENTINEL):
            return
        try:
            if os.path.getsize(HOOKLOG_FILE) > HOOKLOG_MAX_BYTES:
                os.remove(HOOKLOG_FILE)
        except OSError:
            pass
        ts = datetime.now(timezone.utc).isoformat()
        line = f"{ts} {event}{(' ' + detail) if detail else ''}\n"
        with open(HOOKLOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass  # logging must never break the fail-open hook
```

Wire calls into `main()` at each decision point (edit the existing branches):
- After `if workspace_root is None:` → before `sys.exit(0)`, add `log_event("skip-no-root", file_path)`.
- In the `except (OSError, UnicodeDecodeError)` block: distinguish by catching separately, or log the class. Replace that `except` with:
  ```python
  except UnicodeDecodeError:
      log_event("skip-binary", file_path)
      sys.exit(0)
  except OSError:
      log_event("skip-unreadable", file_path)
      sys.exit(0)
  ```
- In the lock block, in the `if existing is None or existing.get("reviewStatus") != "pending":` branch, after `save_session(...)` add `log_event("captured", file_path)`; add an `else:` logging `log_event("skip-already-pending", file_path)` (the existing comment `# else: …` becomes that else body).
- In the top-level `except Exception:` handler (in `__main__`), before `sys.exit(0)` add `log_event("error", repr(sys.exc_info()[1]))`.

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m unittest discover -s hooks/tests -p 'test_hook*.py' -v`
Expected: the new log tests PASS **and** all existing `test_hook.py` / `test_worktree_routing.py` tests still PASS (fail-open behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add hooks/hook.py hooks/tests/test_hook_log.py
git commit -m "feat: sentinel-gated diagnostic logging in hook.py (fail-open, self-truncating)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure TS helpers — hook health + verify report

**Files:**
- Modify: `src/hookInstaller.ts` (add two exported pure functions + the `HookHealth` type)
- Test: `src/hookInstaller.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export type HookHealth = "ok" | "not-installed" | "not-registered" | "stale" | "trust-invalidated";
  export interface VerifyCheck { label: string; ok: boolean; detail?: string; }
  // trust-invalidated (a runtime signal) outranks the static status flags.
  export function hookHealthFrom(status: HookStatus, trustInvalidated: boolean): HookHealth;
  export function buildVerifyReport(checks: VerifyCheck[]): { ok: boolean; lines: string[] };
  ```
  where `HookStatus` is the existing `{ scriptInstalled: boolean; registered: boolean; upToDate: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/hookInstaller.test.ts`:
```ts
import { hookHealthFrom, buildVerifyReport } from "./hookInstaller";

// hookHealthFrom precedence: not-installed → not-registered → trust-invalidated → stale → ok
{
  const S = (o: Partial<{scriptInstalled:boolean;registered:boolean;upToDate:boolean}>) =>
    ({ scriptInstalled: true, registered: true, upToDate: true, ...o });
  assert.equal(hookHealthFrom(S({ scriptInstalled: false }), false), "not-installed");
  assert.equal(hookHealthFrom(S({ registered: false }), false), "not-registered");
  assert.equal(hookHealthFrom(S({}), true), "trust-invalidated", "runtime trust flag outranks a healthy status");
  assert.equal(hookHealthFrom(S({ upToDate: false }), false), "stale");
  assert.equal(hookHealthFrom(S({}), false), "ok");
  // a not-installed hook can't be trust-invalidated — install state wins
  assert.equal(hookHealthFrom(S({ scriptInstalled: false }), true), "not-installed");
  console.log("ok - hookHealthFrom maps status + trust flag to health state");
}

// buildVerifyReport
{
  const pass = buildVerifyReport([
    { label: "hook.py installed", ok: true },
    { label: "registered", ok: true },
  ]);
  assert.equal(pass.ok, true);
  assert.ok(pass.lines.every((l) => l.startsWith("✓ ")), "all-pass lines are checkmarks");

  const mixed = buildVerifyReport([
    { label: "hook.py installed", ok: true },
    { label: "registered", ok: false, detail: "not in settings.json" },
  ]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.lines.some((l) => l === "✗ registered — not in settings.json"), "failing line shows detail");
  assert.ok(mixed.lines.some((l) => l === "✓ hook.py installed"));
  console.log("ok - buildVerifyReport formats per-check lines + overall ok");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit` — Expected: FAIL (`hookHealthFrom`/`buildVerifyReport` not exported).

- [ ] **Step 3: Implement in `src/hookInstaller.ts`**

Add near the top-level exports (e.g. after `shouldWarnTrustInvalidation`), using the existing `HookStatus` interface:
```ts
export type HookHealth = "ok" | "not-installed" | "not-registered" | "stale" | "trust-invalidated";

export interface VerifyCheck { label: string; ok: boolean; detail?: string; }

// Map install status + the runtime trust-invalidation signal to one health
// state. Install problems win (a missing hook can't be "trust-invalidated");
// then registration; then a mid-session settings.json change; then staleness.
export function hookHealthFrom(status: HookStatus, trustInvalidated: boolean): HookHealth {
  if (!status.scriptInstalled) return "not-installed";
  if (!status.registered) return "not-registered";
  if (trustInvalidated) return "trust-invalidated";
  if (!status.upToDate) return "stale";
  return "ok";
}

export function buildVerifyReport(checks: VerifyCheck[]): { ok: boolean; lines: string[] } {
  const lines = checks.map((c) => (c.ok ? `✓ ${c.label}` : `✗ ${c.label}${c.detail ? ` — ${c.detail}` : ""}`));
  return { ok: checks.every((c) => c.ok), lines };
}
```
If `HookStatus` is not already exported, add `export` to its `interface HookStatus` declaration.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit` — Expected: PASS incl. the two new blocks.

- [ ] **Step 5: Commit**

```bash
git add src/hookInstaller.ts src/hookInstaller.test.ts
git commit -m "feat: pure hookHealthFrom + buildVerifyReport helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: HookInstaller — health state/event, sentinel toggle, structured verify

**Files:**
- Modify: `src/hookInstaller.ts`

**Interfaces:**
- Produces:
  ```ts
  // on HookInstaller:
  getHealth(): HookHealth;
  readonly onHealthChange: vscode.Event<HookHealth>;
  setHookLogEnabled(enabled: boolean): void;   // writes/removes ~/.claudegate/hooklog.enabled
  hookLogPath(): string;                        // ~/.claudegate/hook.log
  // verify() now renders the structured buildVerifyReport output.
  ```
- Consumes: `hookHealthFrom`, `buildVerifyReport`, `VerifyCheck` (Task 2).

- [ ] **Step 1: Add health state + event + sentinel toggle**

In `HookInstaller` add fields + an emitter (near `trustWarningShown`):
```ts
  private readonly hookLogSentinel = path.join(this.claudegateDir, "hooklog.enabled");
  private trustInvalidated = false;
  private readonly _onHealthChange = new vscode.EventEmitter<HookHealth>();
  readonly onHealthChange = this._onHealthChange.event;
```
Add methods:
```ts
  getHealth(): HookHealth {
    return hookHealthFrom(this.getStatus(), this.trustInvalidated);
  }

  private fireHealth(): void {
    this._onHealthChange.fire(this.getHealth());
  }

  hookLogPath(): string {
    return path.join(this.claudegateDir, "hook.log");
  }

  // The hook reads this sentinel (not VS Code config) to decide whether to log.
  setHookLogEnabled(enabled: boolean): void {
    try {
      if (enabled) {
        fs.mkdirSync(this.claudegateDir, { recursive: true });
        fs.writeFileSync(this.hookLogSentinel, "", "utf-8");
      } else {
        fs.rmSync(this.hookLogSentinel, { force: true });
      }
    } catch (err) {
      this.log.appendLine(`[WARN] could not toggle hook log: ${(err as Error).message}`);
    }
  }
```

- [ ] **Step 2: Make health changes fire**

- In `watchSettingsForTrustInvalidation`'s `onChange`: replace the `if (this.trustWarningShown) return;` early-return-forever with a re-armable flag. When `shouldWarnTrustInvalidation` is true, set `this.trustInvalidated = true; this.fireHealth();` and show the toast only if not already shown this episode (`if (!this.trustWarningShown) { this.trustWarningShown = true; <toast> }`). When `shouldWarnTrustInvalidation` is false on a change (settings back to a healthy registered state), clear: `this.trustInvalidated = false; this.trustWarningShown = false; this.fireHealth();`. Keep updating `lastKnownSettingsRaw` as before.
- At the end of a successful `setup()` (after `patchClaudeSettings`), add `this.trustInvalidated = false; this.trustWarningShown = false; this.fireHealth();` so re-running Setup clears the broken state.

- [ ] **Step 3: Structured `verify()`**

Refactor `verify()` to build `VerifyCheck[]` from the existing probes, then render via `buildVerifyReport`:
```ts
  verify(): void {
    const checks: VerifyCheck[] = [];
    const scriptOk = fs.existsSync(this.hookPyDest);
    checks.push({ label: "hook.py installed", ok: scriptOk,
      detail: scriptOk ? undefined : "run Setup Hook" });
    const wrapperOk = fs.existsSync(this.hookWrapperDest);
    checks.push({ label: `hook.${this.isWindows ? "bat" : "sh"} installed`, ok: wrapperOk,
      detail: wrapperOk ? undefined : "run Setup Hook" });

    if (scriptOk) {
      let runOk = true; let runDetail: string | undefined;
      const probeDir = path.join(os.tmpdir(), `claudegate-verify-${crypto.randomBytes(4).toString("hex")}`);
      try {
        child_process.execSync(`${this.pythonCmd} "${this.hookPyDest}"`, {
          input: JSON.stringify({ tool_name: "Write", cwd: probeDir, tool_input: { file_path: "test.txt" } }),
          stdio: ["pipe", "ignore", "pipe"],
        });
      } catch (err) {
        runOk = false;
        const d = (err as { stderr?: Buffer }).stderr?.toString().trim();
        runDetail = `crashes under ${this.pythonCmd}${d ? `: ${d.split("\n").pop()}` : ""}`;
      } finally {
        const resolved = path.resolve(probeDir);
        const normalized = this.isWindows ? resolved.toLowerCase() : resolved;
        const hash = crypto.createHash("md5").update(normalized).digest("hex");
        try { fs.unlinkSync(path.join(this.claudegateDir, "sessions", `${hash}.json`)); } catch { /* nothing */ }
      }
      checks.push({ label: "hook runs", ok: runOk, detail: runDetail });
    }

    let registered = false;
    try { registered = JSON.stringify(JSON.parse(fs.readFileSync(this.claudeSettingsPath, "utf-8"))).includes("claudegate"); }
    catch { /* unreadable/missing → not registered */ }
    checks.push({ label: "registered in ~/.claude/settings.json", ok: registered,
      detail: registered ? undefined : "run Setup Hook" });

    const report = buildVerifyReport(checks);
    this.fireHealth();
    const body = report.lines.join("\n");
    const actions = report.ok ? [] : ["Setup Hook"];
    if (fs.existsSync(this.hookLogSentinel)) actions.push("Open Hook Log");
    const show = report.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(`Claude Gate — hook check:\n${body}`, { modal: false }, ...actions).then((a) => {
      if (a === "Setup Hook") void this.setup();
      else if (a === "Open Hook Log") void vscode.commands.executeCommand("claudegate.openHookLog");
    });
  }
```
(Remove the old flat-list `verify()` body it replaces. `crypto`/`child_process`/`os` are already imported.)

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean / all PASS (Task 2's tests exercise the pure helpers this task consumes).

- [ ] **Step 5: Commit**

```bash
git add src/hookInstaller.ts
git commit -m "feat: hook health state + onHealthChange, sentinel toggle, structured verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wiring — status-bar chip, commands, setting, Settings row

**Files:**
- Modify: `package.json` (commands, configuration)
- Modify: `src/extension.ts`
- Modify: `src/settingsPanel.ts`

**Interfaces:**
- Consumes: `hookInstaller.getHealth()` / `onHealthChange` / `setHookLogEnabled` / `hookLogPath()` (Task 3).
- Produces: commands `claudegate.openHookLog`, `claudegate.toggleHookLog`; setting `claudegate.hookLog.enabled`; a hook-health status-bar item.

- [ ] **Step 1: package.json**

`contributes.commands` — add:
```json
{ "command": "claudegate.openHookLog", "title": "Claude Gate: Open Hook Log", "icon": "$(output)" },
{ "command": "claudegate.toggleHookLog", "title": "Claude Gate: Toggle Hook Log" },
```
`contributes.configuration.properties` — add:
```json
"claudegate.hookLog.enabled": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "Write a diagnostic log of the capture hook's decisions to `~/.claudegate/hook.log` (captured / skipped / errors). Useful when Claude's edits aren't being captured. Off by default; the log is a bounded rolling file, kept local."
}
```

- [ ] **Step 2: extension.ts — sentinel sync, status chip, commands**

After the hookInstaller is created and `syncHookIfNeeded` is called, sync the sentinel to the current setting and on change:
```ts
    const syncHookLogSentinel = () =>
      hookInstaller.setHookLogEnabled(
        vscode.workspace.getConfiguration("claudegate").get<boolean>("hookLog.enabled", false)
      );
    syncHookLogSentinel();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudegate.hookLog.enabled")) syncHookLogSentinel();
      })
    );
```

Add the hook-health status-bar item (near the existing `badgeBar`):
```ts
    const hookHealthBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    context.subscriptions.push(hookHealthBar);
    const HEALTH_TEXT: Record<string, string> = {
      "not-installed": "hook not installed",
      "not-registered": "hook not registered",
      "stale": "hook update available",
      "trust-invalidated": "restart Claude sessions",
    };
    const renderHookHealth = (health: string) => {
      if (health === "ok") { hookHealthBar.hide(); return; }
      hookHealthBar.text = `$(warning) Claude Gate`;
      hookHealthBar.tooltip = `Claude Gate: ${HEALTH_TEXT[health] ?? health} — click for details`;
      hookHealthBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      hookHealthBar.command = health === "not-installed" || health === "not-registered"
        ? "claudegate.setupHook" : "claudegate.verifyHook";
      hookHealthBar.show();
    };
    context.subscriptions.push(hookInstaller.onHealthChange(renderHookHealth));
    renderHookHealth(hookInstaller.getHealth());
```
Register the two commands (near `verifyHook`):
```ts
      vscode.commands.registerCommand("claudegate.openHookLog", async () => {
        const p = hookInstaller.hookLogPath();
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
          vscode.window.showInformationMessage(
            "Claude Gate: no hook log yet — enable Hook Log in Settings, then make a Claude edit."
          );
          return;
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(p)));
      }),

      vscode.commands.registerCommand("claudegate.toggleHookLog", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("hookLog.enabled", false);
        await updateClaudegateConfig("hookLog.enabled", !cur);
      }),
```
(`fs` is already imported in extension.ts.)

- [ ] **Step 3: settingsPanel.ts — Hook Log row**

Add `"hookLog"` to `SettingsKind`; add `{ kind: "hookLog" }` to the root list right after `{ kind: "history" }`; add `e.affectsConfiguration("claudegate.hookLog.enabled")` to the config-change refresh condition; add the case:
```ts
      case "hookLog": {
        const on = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("hookLog.enabled", false);
        const ti = new vscode.TreeItem("Hook Log");
        ti.description = on ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(on ? "output" : "circle-slash");
        ti.tooltip = on
          ? "Writing hook decisions to ~/.claudegate/hook.log. Click to turn off."
          : "Turn on to diagnose why edits aren't captured (writes ~/.claudegate/hook.log).";
        ti.command = { command: "claudegate.toggleHookLog", title: "Toggle Hook Log" };
        return ti;
      }
```

- [ ] **Step 4: Verify**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && npm run typecheck && npm test`
Expected: valid JSON, clean typecheck, all tests pass. Confirm command parity: `openHookLog` + `toggleHookLog` are both contributed and registered.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts src/settingsPanel.ts
git commit -m "feat: hook-health status chip, Hook Log setting/command/row, sentinel sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end verification + install

**Files:** none (verification only)

- [ ] **Step 1: Full suite + package**

Run: `npm test && npm run typecheck && rm -f claudegate-*.vsix; npx vsce package`
Expected: all green; `.vsix` packages; file list still ships `hooks/hook.py` and includes no new stray files (sentinel/log live in `~/.claudegate`, not the package).

- [ ] **Step 2: Install for the maintainer's manual pass**

Run: `cursor --install-extension "$(pwd)/claudegate-<version>.vsix" --force && rm -f claudegate-*.vsix`

Manual checklist (after Reload Window; the hook.py change needs **Setup Hook** re-run):
- Settings panel → **Hook Log: Off** → click → On; `~/.claudegate/hooklog.enabled` appears. Make a Claude (or seeded) edit → **Open Hook Log** shows `captured …` lines. Toggle Off → sentinel removed.
- Edit `~/.claude/settings.json` to break the claudegate registration → within a few seconds a **status-bar chip** `$(warning) Claude Gate` appears and *stays* after dismissing the toast; the Settings Hook row shows "Not registered". Run **Setup Hook** → chip clears.
- **Verify Setup** shows a per-check ✓/✗ breakdown; when the log is on it offers "Open Hook Log".

- [ ] **Step 3: Report** results; leave the release to the maintainer (note the CHANGELOG will need a "re-run Setup Hook" line because `hook.py` changed).
