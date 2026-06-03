# Hook Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On extension activate, SHA-256-compare bundled vs installed `hook.py`, auto-copy when different, refresh wrapper, and show one info toast per bundled hash with optional Verify Setup.

**Architecture:** Add `syncHookIfNeeded()` and `warnIfHookNotRegisteredInSettings()` to `HookInstaller`; call both asynchronously from `extension.ts` after activation. Reuse existing `installHookPy` / `installHookWrapper` for copies.

**Tech Stack:** TypeScript, VS Code Extension API, Node `crypto`, existing `HookInstaller`

**Spec:** `docs/superpowers/specs/2026-06-03-hook-auto-sync-design.md`

---

## File Map

| Action | Path |
|--------|------|
| Modify | `src/hookInstaller.ts` — hash helpers, sync, settings warning |
| Modify | `src/extension.ts` — call sync on activate |
| Modify | `package.json` — version `1.1.12` |
| Modify | `CHANGELOG.md` — Added entry |

---

## Task 1: Hash helpers and sync method

**Files:** `src/hookInstaller.ts`

- [ ] **Step 1: Add imports and constants**

`HookSyncAction` type and globalState keys as private static strings on the class or module-level:

```typescript
type HookSyncAction = "none" | "installed" | "updated";

const HOOK_SYNC_NOTIFIED_KEY = "claudegate.hookSyncNotifiedForHash";
const HOOK_SETTINGS_WARNED_KEY = "claudegate.hookSettingsWarned";
```

- [ ] **Step 2: Add `hashFile` and hash accessors**

```typescript
private hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

private bundledHookSourcePath(): string {
  return path.join(this.context.extensionPath, "hooks", "hook.py");
}

private bundledHookHash(): string {
  return this.hashFile(this.bundledHookSourcePath());
}

private installedHookHash(): string | null {
  if (!fs.existsSync(this.hookPyDest)) return null;
  return this.hashFile(this.hookPyDest);
}
```

- [ ] **Step 3: Add `syncHookIfNeeded`**

```typescript
async syncHookIfNeeded(): Promise<HookSyncAction> {
  const source = this.bundledHookSourcePath();
  if (!fs.existsSync(source)) {
    this.log.appendLine("[ERROR] Bundled hook.py not found; cannot sync.");
    return "none";
  }

  let bundledHash: string;
  try {
    bundledHash = this.bundledHookHash();
  } catch (err) {
    this.log.appendLine(`[ERROR] Cannot hash bundled hook: ${(err as Error).message}`);
    return "none";
  }

  const installedHash = this.installedHookHash();
  if (installedHash === bundledHash) return "none";

  try {
    this.ensurePythonAvailable();
  } catch (err) {
    // Still update hook.py; wrapper may be stale until Setup
    this.installHookPy();
    this.log.appendLine(`[WARN] Hook sync: ${(err as Error).message}`);
    vscode.window.showErrorMessage(
      `Claude Gate: Hook script updated but wrapper needs Python. Run 'Setup Hook'.`
    );
    return installedHash === null ? "installed" : "updated";
  }

  this.installHookPy();
  this.installHookWrapper();

  const action: HookSyncAction = installedHash === null ? "installed" : "updated";
  this.log.appendLine(`[INFO] Hook sync: ${action} (hash ${bundledHash.slice(0, 12)}…)`);

  if (action === "updated") {
    const notified = this.context.globalState.get<string>(HOOK_SYNC_NOTIFIED_KEY);
    if (notified !== bundledHash) {
      const version = this.context.extension.packageJSON.version as string;
      const choice = await vscode.window.showInformationMessage(
        `Claude Gate: Hook script updated to match extension v${version}.`,
        "Verify Setup"
      );
      await this.context.globalState.update(HOOK_SYNC_NOTIFIED_KEY, bundledHash);
      if (choice === "Verify Setup") this.verify();
    }
  }

  return action;
}
```

- [ ] **Step 4: Run compile**

```bash
npm run compile && npm run typecheck
```

---

## Task 2: Settings registration warning

**Files:** `src/hookInstaller.ts`

- [ ] **Step 1: Add `warnIfHookNotRegisteredInSettings`**

```typescript
warnIfHookNotRegisteredInSettings(): void {
  if (!fs.existsSync(this.hookPyDest)) return;
  if (this.context.globalState.get(HOOK_SETTINGS_WARNED_KEY)) return;

  let raw = "";
  try {
    raw = fs.readFileSync(this.claudeSettingsPath, "utf-8");
  } catch {
    return;
  }

  if (raw.includes("claudegate")) return;

  void this.context.globalState.update(HOOK_SETTINGS_WARNED_KEY, true);
  void vscode.window
    .showWarningMessage(
      "Claude Gate: Hook script is installed but not registered in ~/.claude/settings.json. Terminal Claude won't be tracked until you run Setup Hook.",
      "Setup Hook"
    )
    .then((action) => {
      if (action === "Setup Hook") void this.setup();
    });
}
```

- [ ] **Step 2: Compile check**

```bash
npm run compile && npm run typecheck
```

---

## Task 3: Wire activation

**Files:** `src/extension.ts`

- [ ] **Step 1: After `hookInstaller` is created and `setupHook` command registered**, add:

```typescript
void hookInstaller.syncHookIfNeeded().then(() => {
  hookInstaller.warnIfHookNotRegisteredInSettings();
});
```

Place before or after legacy migration block — order does not matter.

- [ ] **Step 2: Compile check**

```bash
npm run compile && npm run typecheck
```

---

## Task 4: Version and changelog

**Files:** `package.json`, `CHANGELOG.md`

- [ ] Bump to `1.1.12`.

- [ ] Add under `## [1.1.12] — 2026-06-03` / `### Added`:

- **Hook auto-sync on activate** — when the installed `~/.claudegate/hook.py` differs from the extension bundle (SHA-256), the extension copies the new script and refreshes the wrapper, then shows a one-time notification per bundled version with optional **Verify Setup**. Terminal hook registration in `settings.json` still requires **Setup Hook** if not yet registered.

- [ ] **Commit**

```bash
git add src/hookInstaller.ts src/extension.ts package.json CHANGELOG.md \
  docs/superpowers/specs/2026-06-03-hook-auto-sync-design.md \
  docs/superpowers/plans/2026-06-03-hook-auto-sync.md
git commit -m "$(cat <<'EOF'
feat: auto-sync hook.py on activate when hash differs

Compare bundled vs installed hook SHA-256, copy on mismatch,
notify once per bundle with Verify Setup, warn if settings lack hook.
EOF
)"
```

---

## Task 5: Manual verification

- [ ] Copy an older `hook.py` into `~/.claudegate`, reload Extension Development Host → file updated, one toast, reload again → no toast.
- [ ] Delete `~/.claudegate/hook.py`, reload → file created, no update toast.
- [ ] Remove `claudegate` from `~/.claude/settings.json`, reload → one warning with Setup Hook.
- [ ] Run **Verify Setup** from update toast → all checks passed.

---

## Plan self-review (spec coverage)

| Spec requirement | Task |
|------------------|------|
| SHA-256 compare | Task 1 |
| Auto-copy + wrapper | Task 1 |
| Toast once per bundled hash (B) | Task 1 |
| No toast on `installed` | Task 1 |
| No auto-patch settings | Tasks 1–2 (warn only) |
| `warnIfHookNotRegisteredInSettings` | Task 2 |
| Async activate call | Task 3 |
| CHANGELOG + version | Task 4 |
