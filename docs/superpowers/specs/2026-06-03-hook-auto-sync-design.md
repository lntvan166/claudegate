# Hook Auto-Sync on Extension Upgrade — ClaudeGate

**Date:** 2026-06-03  
**Status:** Approved for implementation

## Problem

`hooks/hook.py` in the VSIX updates on every extension release, but `~/.claudegate/hook.py` is only refreshed when the user runs **Claude Gate: Setup Hook**. Users who upgrade (e.g. v1.1.11 cwd-fallback fix) keep running stale hook logic until they manually re-run setup. VS Code cannot force a command; we need automatic detection and a low-friction update path.

## Goal

On extension activation, detect when the installed hook script differs from the bundled copy, **auto-copy** the new script (and refresh the shell/batch wrapper), and show **one informational notification per bundled version** with optional **Verify Setup**. Do not re-prompt on every window reload.

## Product Decision

**Option B (hash detect + auto-copy + toast):**

- Compare SHA-256 of bundled vs installed `hook.py`.
- On mismatch: copy bundled file, refresh `hook.sh` / `hook.bat`, show info toast with **Verify Setup**.
- Dedupe notifications via `globalState` keyed by bundled file hash.
- Do **not** auto-patch `~/.claude/settings.json` on sync (only explicit Setup Hook registers PreToolUse). If hook file exists but settings lack claudegate, show a separate one-time warning with **Setup Hook**.

**Out of scope:** Blocking UI until Setup, auto-patch settings on every upgrade, `HOOK_VERSION` constant in Python (file hash is sufficient), preserving user-edited `~/.claudegate/hook.py` when hash differs.

## Architecture

```
extension activate()
        │
        ▼
HookInstaller.syncHookIfNeeded()   [async, non-blocking]
        │
        ├─ bundledHash === installedHash → none
        │
        ├─ hook.py missing → install copy + wrapper → installed (log only)
        │
        └─ hash differs → copy + wrapper → updated
                │
                ├─ if updated && !notifiedForHash → info toast + Verify Setup
                └─ set globalState hookSyncNotifiedForHash = bundledHash

(separate check)
settings.json lacks "claudegate" && hook.py exists
        → one-time warning + Setup Hook (globalState hookSettingsWarned)
```

## Components

### Modified: `src/hookInstaller.ts`

**New helpers:**

- `private hashFile(filePath: string): string` — SHA-256 hex of file contents; throws if unreadable.
- `private bundledHookPath(): string` — `path.join(extensionPath, "hooks", "hook.py")`.
- `private bundledHookHash(): string` — hash of bundled file.
- `private installedHookHash(): string | null` — hash of `~/.claudegate/hook.py` or `null` if missing.

**Refactor (no behavior change for Setup):**

- Keep `installHookPy()` / `installHookWrapper()` as the copy/write implementation used by both `setup()` and sync.

**New public method:**

```typescript
type HookSyncAction = "none" | "installed" | "updated";

async syncHookIfNeeded(): Promise<HookSyncAction>
```

Logic:

1. If bundled `hook.py` missing → log error, return `"none"`.
2. Compute `bundledHash`, `installedHash`.
3. If equal → `"none"`.
4. `ensurePythonAvailable()` before wrapper write; on failure → log + `showErrorMessage` suggesting Setup Hook, return `"none"` (do not copy if Python required for wrapper — still copy `hook.py` if only wrapper needs Python; **copy hook.py first**, then wrapper; if Python missing, copy hook.py only and warn).
5. If `installedHash === null` → `installHookPy()` + `installHookWrapper()` → `"installed"`.
6. Else → `installHookPy()` + `installHookWrapper()` → `"updated"`.
7. If `"updated"` and `globalState.get("claudegate.hookSyncNotifiedForHash") !== bundledHash`:
   - `showInformationMessage` with extension version from `package.json`, actions **Verify Setup**.
   - On **Verify Setup** → `verify()`.
   - `globalState.update("claudegate.hookSyncNotifiedForHash", bundledHash)`.
8. If `"installed"` → log only at INFO (no toast).

**New check (same class or called from sync):**

```typescript
warnIfHookNotRegisteredInSettings(): void
```

- Read `~/.claude/settings.json`; if file exists and JSON does not include substring `"claudegate"` and `hook.py` exists:
  - If `!globalState.get("claudegate.hookSettingsWarned")`:
    - Set `hookSettingsWarned` true.
    - `showWarningMessage` with **Setup Hook** action → `setup()`.

### Modified: `src/extension.ts`

After `HookInstaller` construction and command registration, call:

```typescript
void hookInstaller.syncHookIfNeeded().then(() => hookInstaller.warnIfHookNotRegisteredInSettings());
```

Do not await on activation critical path; errors logged to output channel.

### Unchanged

- `hooks/hook.py` content (no embedded version stamp).
- `setup()` still runs full flow: roots, hook.py, wrapper, `patchClaudeSettings`, success toast.
- Legacy `session.json` migration notice in `extension.ts`.

## Error Handling

| Case | Behavior |
|------|----------|
| Bundled hook missing | Log ERROR, skip sync |
| Python not found during sync | Copy `hook.py` if possible; skip wrapper refresh; error toast → Setup Hook |
| Copy fails (permissions) | Log ERROR, error toast |
| `settings.json` unreadable | Skip registration warning |
| User dismisses update toast | Hash key still set after toast shown (no repeat for same bundle) |

## Testing

**Automated:** `npm run compile`, `npm run typecheck`.

**Manual:**

1. Place an old `hook.py` in `~/.claudegate` → reload window → file matches bundle, one info toast, reload again → no second toast.
2. Delete `~/.claudegate/hook.py` → reload → file created, no update toast (installed path).
3. Remove claudegate from `settings.json` but keep `hook.py` → one warning with Setup Hook.
4. **Verify Setup** from update toast → passes smoke test.
5. Explicit **Setup Hook** still patches settings and shows install success message.

## Release

- Patch version (e.g. `1.1.12`).
- CHANGELOG **Added**: hook script auto-syncs from extension on activate when `hook.py` hash differs; notification once per bundled version.
