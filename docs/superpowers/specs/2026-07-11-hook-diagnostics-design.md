# Hook health & diagnostics

**Date:** 2026-07-11
**Status:** approved

## Problem

The hook's health signals are all **one-shot toasts** that vanish once dismissed:
`warnIfHookNotRegisteredInSettings` (guarded by `HOOK_SETTINGS_WARNED_KEY`) and
`watchSettingsForTrustInvalidation` (guarded by `trustWarningShown`) each fire at
most once per activation. A user who dismisses one has no lingering signal that
capture is broken. And when the hook silently skips a file (binary, no workspace
root, an exception it swallows to stay fail-open), there is no way to see why.
`verify()` prints a flat "All checks passed!" / issue list with no per-check
breakdown.

## Scope

Three parts, all additive, hook stays fail-open:

- **A. Persistent hook-health indicator** — a status-bar chip that stays visible
  while the hook is unhealthy, replacing the dismiss-once behavior as the durable
  signal.
- **B. Opt-in hook log** — `claudegate.hookLog.enabled` → `hook.py` appends
  decision lines to `~/.claudegate/hook.log`, so silent skips are diagnosable.
- **C. Structured Verify Setup** — a per-check ✓/✗ breakdown instead of a flat
  pass/fail.

## Design

### A. Persistent hook-health indicator
- A `HookHealth` value computed from existing state:
  `"ok" | "not-installed" | "not-registered" | "stale" | "trust-invalidated"`.
  - `not-installed` / `not-registered` / `stale` come from `getStatus()`
    (`scriptInstalled`/`registered`/`upToDate`).
  - `trust-invalidated` is a **runtime** flag set by the settings.json
    `watchFile` handler when `shouldWarnTrustInvalidation` fires, and cleared
    when a subsequent settings read is healthy again (registered + not changed)
    or after Setup Hook runs.
- A dedicated **status-bar item** (separate from the pending-count badge), shown
  only when health ≠ `ok`: text `$(warning) Claude Gate` + a state-specific
  tooltip, `backgroundColor = statusBarItem.warningBackground`, command → Verify
  Setup (for trust-invalidated/stale) or Setup Hook (for not-installed/
  not-registered). Hidden when `ok`.
- Re-evaluated: at activation, on every settings.json `watchFile` change, and
  after `setup()`/`verify()`. On each change also refresh the Settings tree (its
  Hook row reads settings.json directly, so external edits don't fire a config
  event today).
- **Toast behavior:** keep exactly ONE toast on the *transition* into a broken
  state (so it's noticed) — reuse the existing one-shot toasts, but they are no
  longer the only signal. The chip persists regardless of dismissal. The
  `trust-invalidated` flag re-arms if settings.json goes healthy→broken again
  (so a second real breakage re-warns), rather than never re-firing.
- `HookInstaller` exposes `getHealth(): HookHealth` and an
  `onHealthChange: vscode.Event<HookHealth>` the status bar + settings panel
  subscribe to.

### B. Opt-in hook log
- Setting `claudegate.hookLog.enabled` (boolean, default **false**).
- `hook.py` stays config-free: the extension writes a sentinel file
  `~/.claudegate/hooklog.enabled` when the setting is on and removes it when off
  (on activation and on config change). `hook.py` logs only if that file exists.
- `hook.py` `log(event, detail)` helper appends
  `<ISO ts> <event> <detail>` to `~/.claudegate/hook.log`, called at each
  decision point: `captured` (path), `skip-binary`, `skip-unreadable`,
  `skip-no-root`, `skip-already-pending`, and the top-level fail-open handler
  logs `error <exc>`. Logging is itself wrapped so a logging failure never
  breaks the hook (fail-open is sacred). Self-truncation: if the log exceeds
  ~1 MB, it's reset (keep it bounded; this is a rolling debug aid, not an audit
  trail).
- New command `claudegate.openHookLog` ("Claude Gate: Open Hook Log") — opens
  `~/.claudegate/hook.log` in an editor; if missing/empty, an info message
  ("No hook log yet — enable Hook Log in Settings and make a Claude edit").
- Settings panel **Hook Log** row (On/Off), toggled by
  `claudegate.toggleHookLog` (mirrors the Auto-advance/History rows).

### C. Structured Verify Setup
- `verify()` returns nothing to the UI change, but its checks are extracted into
  a pure builder over injected probe results so it's unit-testable:
  `buildVerifyReport(checks: VerifyCheck[]): { ok: boolean; lines: string[] }`
  where `VerifyCheck = { label: string; ok: boolean; detail?: string }`.
- `verify()` gathers the five checks (script installed · wrapper installed ·
  hook runs [exec smoke test, unchanged] · registered in settings.json ·
  capture — the smoke test already exercises capture), then shows a multi-line
  message: `✓ <label>` / `✗ <label> — <detail>` per line, headed "All checks
  passed" or "N issue(s) found", with a **Setup Hook** action when any check
  fails and an **Open Hook Log** action when the log is enabled.

## Testing

- **Python (`hooks/tests/`):** with the sentinel present, a capture writes a
  `captured` line to hook.log and a binary file writes `skip-binary`; with the
  sentinel absent, no log file is created; a malformed workspace-roots.json
  still fails open AND (sentinel on) logs an `error`/skip line without throwing;
  log self-truncates past the cap.
- **TS unit:** `buildVerifyReport` (ok/lines for all-pass and mixed); a pure
  `hookHealthFrom(status, trustInvalidated)` mapping to the five states.
- **Manual:** toggle Hook Log on → make a Claude edit → Open Hook Log shows
  lines; break registration (edit settings.json) → status-bar chip appears and
  persists after dismissing the toast, clears after Setup Hook; Verify Setup
  shows the per-check breakdown.

## Non-goals
- No structured/rotating log framework (single self-truncating file).
- No telemetry or network. Log stays local.
- The hook log is a debug aid, not a tamper-proof audit trail.
