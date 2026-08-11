import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";
import * as crypto from "crypto";
import { persistWorkspaceRoots } from "./workspaceRoots";

type HookSyncAction = "none" | "installed" | "updated";

/**
 * The `PreToolUse` matcher claudegate registers in ~/.claude/settings.json.
 *
 * `Bash` is in the alternation because Claude rewrites files through shell
 * commands too (`sed -i`, `cat > f <<EOF`, a python heredoc); those writes were
 * invisible to review until the matcher selected them. Defined once and
 * compared by `computeSettingsPatch`, so an install carrying an older matcher is
 * detected as stale and repaired — a widened list reaches existing users on its
 * own instead of needing a manual re-install.
 */
export const PRE_TOOL_MATCHER = "^(Write|Edit|MultiEdit|Bash)$";

/**
 * Pure decision logic for the ~/.claude/settings.json registration write.
 *
 * Given the current file contents and the hook wrapper command, returns the
 * settings JSON that *should* be on disk and whether it differs from what is.
 *
 * Idempotency is load-bearing. This file is the user's entire Claude config, and
 * every write costs a backup, a rewrite of bytes we do not own, and (on older
 * Claude Code versions, which snapshot hook config at session start) the hook
 * trust of every running session. So we must NOT rewrite the file for a cosmetic
 * (formatting-only) difference when the claudegate entry is already correct.
 * `changed` therefore reflects a SEMANTIC change (entry added or repaired),
 * never a reformat. See docs/2026-07-06-hook-not-firing-in-running-session-bug.md.
 *
 * Data safety: a non-empty file that does not parse as a JSON object is NOT
 * reset to `{}` (that silently destroyed the user's whole Claude config —
 * model, permissions, other hooks, MCP servers). Instead `parseError` is set
 * and `content` echoes the original bytes so the caller refuses to write.
 */
export function computeSettingsPatch(
  raw: string,
  hookCommand: string
): { content: string; changed: boolean; parseError?: boolean } {
  const trimmed = raw.trim();
  let settings: Record<string, unknown>;
  if (!trimmed) {
    settings = {}; // absent/empty file → fresh install (not corruption)
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { content: raw, changed: false, parseError: true }; // not an object → refuse
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      return { content: raw, changed: false, parseError: true }; // malformed → refuse (never wipe)
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.PreToolUse) hooks.PreToolUse = [];
  const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: unknown }> }>;

  // "Ours" = any PreToolUse entry that references a claudegate wrapper path.
  // Never the matcher: a foreign tool may legitimately register `^Bash$`, and
  // rewriting that would hijack another tool's hook.
  const isOurs = (h: unknown) => JSON.stringify(h).includes("claudegate");
  const ours = preToolUse.filter(isOurs);
  // Correct means BOTH halves are current. Comparing only the command is what
  // made an existing install un-upgradable: the wrapper path is already right,
  // so a widened matcher could never reach anyone who had installed before.
  const correct = ours.some(
    (h) =>
      h.matcher === PRE_TOOL_MATCHER &&
      Array.isArray(h.hooks) &&
      h.hooks.some((x) => x.command === hookCommand)
  );

  let changed = false;
  if (correct) {
    // Already registered with the exact command AND matcher → no semantic
    // change. Return the reformatted content but leave `changed` false so the
    // caller preserves the on-disk bytes.
  } else if (ours.length > 0) {
    // Stale claudegate registration → repair in place rather than leave capture
    // silently broken. Either half can be stale:
    //   - the wrapper COMMAND (an old/wrong path after the home dir moved, a
    //     .sh/.bat mismatch), or
    //   - the MATCHER (an install predating a widened tool list — e.g. before
    //     Bash writes were captured).
    // Only entries that actually carry a claudegate command are touched, and
    // only those get their matcher rewritten.
    for (const h of ours) {
      if (!Array.isArray(h.hooks)) continue;
      let mine = false;
      for (const x of h.hooks) {
        if (typeof x.command === "string" && x.command.includes("claudegate")) {
          x.command = hookCommand;
          mine = true;
        }
      }
      if (!mine) continue;
      h.matcher = PRE_TOOL_MATCHER;
      changed = true;
    }
  } else {
    preToolUse.push({
      matcher: PRE_TOOL_MATCHER,
      hooks: [{ type: "command", command: hookCommand }],
    });
    changed = true;
  }

  const content = JSON.stringify(settings, null, 2);
  return { content, changed };
}

/**
 * The `hooks` block of a settings.json blob, normalized to a stable string for
 * comparison. Only this block controls hook loading; everything else in
 * settings.json (model, theme, enabledPlugins, permissions, …) is irrelevant
 * to trust invalidation. Falls back to the raw text when the JSON can't be
 * parsed, so a genuine change we can't inspect is still treated as a change.
 */
function hooksConfigOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { hooks?: unknown };
    return JSON.stringify(parsed?.hooks ?? null);
  } catch {
    return raw;
  }
}

/**
 * How a detected settings.json change relates to the claudegate hook:
 * - `none`         — byte-identical, nothing happened.
 * - `benign`       — the hooks block is unchanged; Claude Code rewrote an
 *                    unrelated field (model, theme, enabledPlugins, session
 *                    state). The loaded PreToolUse hook is untouched, so
 *                    capture keeps working — do not warn, do not clear.
 * - `invalidated`  — the hooks block changed while claudegate is still
 *                    registered. Current Claude Code (measured on 2.1.227)
 *                    watches the settings files and re-reads hook config on
 *                    change, so running sessions keep capturing; older versions
 *                    snapshotted it at session start and needed a restart. Kept
 *                    as a low-alarm heads-up for those, not a stop-the-world
 *                    warning. (The name is historical.)
 * - `unregistered` — the hooks block changed and the claudegate entry is gone.
 *                    That's an uninstall (handled by the not-registered health
 *                    state), not an invalidation — don't warn.
 */
export type SettingsChangeKind = "none" | "benign" | "invalidated" | "unregistered";

export function classifySettingsChange(prevRaw: string, currentRaw: string): SettingsChangeKind {
  if (currentRaw === prevRaw) return "none";
  if (hooksConfigOf(prevRaw) === hooksConfigOf(currentRaw)) return "benign";
  return currentRaw.includes("claudegate") ? "invalidated" : "unregistered";
}

/**
 * Decision for the trust-invalidation health signal. Returns true only when the
 * *hooks* configuration changed while claudegate is still registered.
 *
 * We warn on the *cause* (the hook config changed while claudegate is still
 * registered) rather than the *effect* (edits arriving with no capture),
 * because attributing an uncaptured edit to Claude is exactly the
 * unsolvable problem DocumentTracker exists for. Crucially, we compare only
 * the hooks block: Claude Code rewrites settings.json constantly for unrelated
 * reasons (model/theme/plugin toggles, session persistence), and those must not
 * masquerade as a hook invalidation — that produced a warning that "kept
 * showing without any update".
 */
export function shouldWarnTrustInvalidation(prevRaw: string, currentRaw: string): boolean {
  return classifySettingsChange(prevRaw, currentRaw) === "invalidated";
}

/** How many timestamped settings.json backups we keep before pruning the oldest. */
export const SETTINGS_BACKUP_RETENTION = 5;

/**
 * Which of `names` are stale claudegate backups of `baseName` (newest `keep`
 * retained). Backup names embed a sanitized ISO timestamp, so lexicographic
 * order is chronological order.
 *
 * Pure so retention is testable without a filesystem. Note the legacy single
 * `settings.json.claudegate.bak` (no timestamp) does not match the
 * `<base>.claudegate-` prefix and is deliberately never pruned — it may be the
 * only pre-timestamp copy a user has.
 */
export function backupsToPrune(
  names: string[],
  baseName: string,
  keep: number = SETTINGS_BACKUP_RETENTION
): string[] {
  const prefix = `${baseName}.claudegate-`;
  const mine = names.filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort();
  if (mine.length <= keep) return [];
  return mine.slice(0, mine.length - keep);
}

type PreToolUseEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: unknown }> };

/**
 * Post-write verification. Returns null when the bytes now on disk are an
 * acceptable result of our patch, or a human-readable reason when they are not
 * — in which case the caller restores the backup.
 *
 * Two independent claims are checked, because a write that loses the user's
 * config is far worse than one that fails to install the hook:
 *  1. every top-level key that existed before is still present (nothing of the
 *     user's — model, permissions, enabledPlugins, other tools' hooks — was
 *     dropped), and
 *  2. our own entry actually landed (the write did what it claimed).
 */
export function verifySettingsContent(
  after: string,
  previousRaw: string,
  hookCommand: string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    return "the file on disk is not valid JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "the file on disk is not a JSON object";
  }

  const afterKeys = new Set(Object.keys(parsed as Record<string, unknown>));
  let before: unknown = null;
  try {
    before = JSON.parse(previousRaw);
  } catch {
    before = null; // absent/empty/unparseable before → nothing to preserve
  }
  if (typeof before === "object" && before !== null && !Array.isArray(before)) {
    for (const key of Object.keys(before as Record<string, unknown>)) {
      if (!afterKeys.has(key)) return `top-level key "${key}" was lost`;
    }
  }

  const preToolUse = (parsed as { hooks?: { PreToolUse?: unknown } }).hooks?.PreToolUse;
  const landed =
    Array.isArray(preToolUse) &&
    (preToolUse as PreToolUseEntry[]).some(
      (h) => Array.isArray(h?.hooks) && h.hooks.some((x) => x?.command === hookCommand)
    );
  if (!landed) return "the claudegate hook entry is missing";

  return null;
}

export interface HookStatus {
  scriptInstalled: boolean;
  registered: boolean;
  upToDate: boolean;
}

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

const HOOK_SYNC_NOTIFIED_KEY = "claudegate.hookSyncNotifiedForHash";
const HOOK_SETTINGS_WARNED_KEY = "claudegate.hookSettingsWarned";

export class HookInstaller {
  private readonly isWindows = process.platform === "win32";
  private pythonCmd = "python3";

  // Health-signal state: last settings.json content the extension has seen
  // (baseline + our own writes), and whether we've already warned this session.
  private lastKnownSettingsRaw: string | null = null;
  private trustWarningShown = false;
  private trustInvalidated = false;
  // Bounded attempts: the automatic settings write is tried at most once per
  // extension activation and stays latched off afterwards, so a failure can
  // never be retried on every window focus. setup() bypasses this latch.
  private settingsAutoWriteLatched = false;
  private readonly _onHealthChange = new vscode.EventEmitter<HookHealth>();
  readonly onHealthChange = this._onHealthChange.event;

  private readonly claudegateDir     = path.join(os.homedir(), ".claudegate");
  private readonly hookPyDest        = path.join(os.homedir(), ".claudegate", "hook.py");
  private readonly hookShDest        = path.join(os.homedir(), ".claudegate", "hook.sh");
  private readonly hookBatDest       = path.join(os.homedir(), ".claudegate", "hook.bat");
  private readonly claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  private readonly hookLogSentinel = path.join(this.claudegateDir, "hooklog.enabled");

  private get hookWrapperDest(): string {
    return this.isWindows ? this.hookBatDest : this.hookShDest;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {}

  async setup(): Promise<void> {
    try {
      this.ensurePythonAvailable();
      fs.mkdirSync(this.claudegateDir, { recursive: true });
      persistWorkspaceRoots();

      this.installHookPy();
      this.installHookWrapper();
      const settingsChanged = this.registerHookInSettings();

      this.trustInvalidated = false;
      this.trustWarningShown = false;
      this.fireHealth();

      this.log.appendLine(
        `[INFO] Hook installed successfully.${settingsChanged ? "" : " (settings.json unchanged)"}`
      );
      const message = settingsChanged
        ? "Claude Gate: Hook installed. Current Claude Code picks the registration up immediately, including sessions " +
          "that are already running; on older versions, restart a session if its edits don't appear."
        : "Claude Gate: Hook already registered — no changes made. Running Claude Code sessions keep tracking.";
      const action = await vscode.window.showInformationMessage(message, "Verify Setup");
      if (action === "Verify Setup") this.verify();
    } catch (err) {
      this.log.appendLine(`[ERROR] Setup failed: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `Claude Gate setup failed: ${(err as Error).message}`
      );
    }
  }

  private ensurePythonAvailable(): void {
    // On Windows try 'python' first (typical install), then 'python3'.
    // On macOS/Linux only 'python3' is checked to preserve existing behaviour.
    const candidates = this.isWindows ? ["python", "python3"] : ["python3"];
    for (const cmd of candidates) {
      try {
        child_process.execSync(`${cmd} --version`, { stdio: "ignore" });
        this.pythonCmd = cmd;
        return;
      } catch { /* try next */ }
    }
    throw new Error(
      "Python 3 is required but not found. Install it from https://python.org and try again."
    );
  }

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
      this.log.appendLine(
        `[ERROR] Cannot hash bundled hook: ${(err as Error).message}`
      );
      return "none";
    }

    const installedHash = this.installedHookHash();
    if (installedHash === bundledHash) return "none";

    fs.mkdirSync(this.claudegateDir, { recursive: true });

    try {
      this.ensurePythonAvailable();
      this.installHookPy();
      this.installHookWrapper();
    } catch (err) {
      this.installHookPy();
      this.log.appendLine(`[WARN] Hook sync: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(
        "Claude Gate: Hook script updated but wrapper needs Python. Run 'Setup Hook'."
      );
      return installedHash === null ? "installed" : "updated";
    }

    const action: HookSyncAction =
      installedHash === null ? "installed" : "updated";
    this.log.appendLine(
      `[INFO] Hook sync: ${action} (hash ${bundledHash.slice(0, 12)}…)`
    );

    // A sync moves health (typically stale/not-installed → ok), so subscribers
    // must be told or the status chip keeps showing a warning we already fixed.
    // Every other state transition fires this; this path did not. Harmless today
    // because the hash check and install run synchronously before the first
    // render, but any `await` added above this line would strand the chip.
    this.fireHealth();

    if (action === "updated") {
      const notified = this.context.globalState.get<string>(
        HOOK_SYNC_NOTIFIED_KEY
      );
      if (notified !== bundledHash) {
        const version = this.context.extension.packageJSON.version as string;
        const choice = await vscode.window.showInformationMessage(
          `Claude Gate: Hook script updated to match extension v${version}.`,
          "Verify Setup"
        );
        await this.context.globalState.update(
          HOOK_SYNC_NOTIFIED_KEY,
          bundledHash
        );
        if (choice === "Verify Setup") this.verify();
      }
    }

    return action;
  }

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

  // Snapshot of hook install/registration state for the Settings panel.
  // Fails safe (false) on any read error rather than throwing.
  getStatus(): HookStatus {
    const scriptInstalled = fs.existsSync(this.hookPyDest);

    let registered = false;
    try {
      registered = fs.readFileSync(this.claudeSettingsPath, "utf-8").includes("claudegate");
    } catch {
      registered = false;
    }

    let upToDate = false;
    if (scriptInstalled) {
      try {
        upToDate = this.installedHookHash() === this.bundledHookHash();
      } catch {
        upToDate = false;
      }
    }

    return { scriptInstalled, registered, upToDate };
  }

  getHealth(): HookHealth {
    return hookHealthFrom(this.getStatus(), this.trustInvalidated);
  }

  /**
   * Re-evaluate health and notify subscribers. Health is otherwise only computed
   * at activation and on the specific events that mutate it, so a change made
   * outside this window — hook.py deleted, the settings entry hand-edited away —
   * would leave the status chip asserting a state that is no longer true. Cheap:
   * two file hashes and one read.
   */
  refreshHealth(): void {
    this.fireHealth();
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

  private installHookPy(): void {
    const sourcePath = this.bundledHookSourcePath();
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`hook.py not found at ${sourcePath}. Reinstall the extension.`);
    }
    fs.mkdirSync(this.claudegateDir, { recursive: true });
    fs.copyFileSync(sourcePath, this.hookPyDest);
  }

  private installHookWrapper(): void {
    if (this.isWindows) {
      // .bat wrapper — uses the python executable found during setup and the
      // absolute path to hook.py so the script works regardless of cwd.
      const bat = `@echo off\n"${this.pythonCmd}" "${this.hookPyDest}"\n`;
      fs.writeFileSync(this.hookBatDest, bat, "utf-8");
    } else {
      const sh = `#!/usr/bin/env bash\n${this.pythonCmd} "$HOME/.claudegate/hook.py"\n`;
      fs.writeFileSync(this.hookShDest, sh, "utf-8");
      fs.chmodSync(this.hookShDest, 0o755);
    }
  }

  /**
   * Registers (or repairs) the hook in ~/.claude/settings.json. Returns true
   * only when the file was actually written — a no-op (entry already correct)
   * returns false so callers skip the notice and so we never rewrite the user's
   * config, or churn backups, for nothing.
   *
   * This file holds the user's ENTIRE Claude Code config — model, permissions,
   * enabledPlugins, marketplaces, and other tools' hooks. Every write therefore
   * runs the guarded protocol:
   *
   *   1. Only ENOENT counts as "fresh install". Any other read error (EACCES,
   *      EMFILE, EISDIR, EBUSY/EPERM on Windows while Claude Code writes the
   *      file concurrently) aborts — writing on a failed read would have
   *      replaced the whole config with a bare hook stub.
   *   2. A timestamped backup is taken first, and a backup failure aborts the
   *      write: writing with no recoverable copy is the dangerous case.
   *   3. The write targets the realpath, so a dotfiles-symlinked config keeps
   *      its symlink instead of being replaced by a regular file.
   *   4. The result is re-read and verified; anything wrong restores the backup.
   *
   * Public because it is the seam Phase 2's automatic write reuses. setup() —
   * an explicit user action — calls it directly and stays retryable;
   * `syncSettingsIfNeeded()` wraps it in the once-per-activation latch.
   */
  registerHookInSettings(): boolean {
    const claudeDir = path.dirname(this.claudeSettingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });

    // Only ENOENT means "no config yet". Everything else means "there is a
    // config and we could not read it" — the one case where writing destroys it.
    // Note the post-write verification cannot save us here: with no baseline to
    // compare against, a stub written over a real config verifies clean. Aborting
    // on the read is the only defence.
    let raw: string | null;
    try {
      raw = this.readSettingsFileSync();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        this.log.appendLine(
          `[ERROR] could not read ${this.claudeSettingsPath} (${e.code ?? "unknown"}: ${e.message}); ` +
            "refusing to write — your Claude configuration is untouched."
        );
        vscode.window.showErrorMessage(
          "Claude Gate: ~/.claude/settings.json exists but could not be read, so the hook was NOT " +
            "installed — your configuration was left untouched. Check the file's permissions, then run Setup Hook again."
        );
        return false;
      }
      raw = null; // genuinely absent → safe to create
    }

    const { content, changed, parseError } = computeSettingsPatch(raw ?? "", this.hookWrapperDest);
    if (parseError) {
      this.log.appendLine(
        `[ERROR] ${this.claudeSettingsPath} is not valid JSON; refusing to overwrite it (your config is untouched).`
      );
      vscode.window.showErrorMessage(
        "Claude Gate: your ~/.claude/settings.json is not valid JSON, so the hook was NOT installed — " +
        "your configuration was left untouched. Fix the JSON, then run Setup Hook again."
      );
      return false;
    }
    if (!changed) return false;

    return this.writeSettingsGuarded(raw, content);
  }

  // The single read that decides fresh-install vs abort. Protected so tests can
  // inject the errno cases (EACCES, EMFILE, EBUSY/EPERM on Windows) that cannot
  // be provoked portably — chmod 000 proves nothing when running as root.
  protected readSettingsFileSync(): string {
    return fs.readFileSync(this.claudeSettingsPath, "utf-8");
  }

  /**
   * Bounded automatic variant: at most one settings write attempt per extension
   * activation, latching off afterwards so a focus-driven caller can never turn
   * a transient failure into a loop of rewrites. setup() deliberately does NOT
   * go through here — an explicit user action must always be retryable.
   *
   * REPAIR ONLY. If ~/.claude/settings.json carries no claudegate entry at all,
   * this does nothing: a first-time install stays the explicit Setup Hook
   * action, so we never register ourselves into a configuration the user never
   * opted into. It exists for the case Setup Hook cannot reach — an existing
   * registration whose matcher or wrapper path has since gone stale (the
   * widened matcher is exactly that), which no user action would ever suggest
   * re-running Setup Hook for.
   */
  syncSettingsIfNeeded(): boolean {
    if (this.settingsAutoWriteLatched) return false;
    this.settingsAutoWriteLatched = true;
    if (!this.getStatus().registered) return false;
    return this.registerHookInSettings();
  }

  /**
   * Back up → write → verify → restore-on-failure. `previousRaw` is null when
   * the file was genuinely absent (nothing to back up, nothing to preserve).
   */
  private writeSettingsGuarded(previousRaw: string | null, content: string): boolean {
    // Resolve symlinks so the temp+rename lands on the real file (keeping the
    // symlink intact) and stays on one filesystem. Falls back to the literal
    // path when realpath fails — notably when the file does not exist yet.
    let target = this.claudeSettingsPath;
    try {
      target = fs.realpathSync(this.claudeSettingsPath);
    } catch {
      /* absent or unresolvable → write the literal path */
    }

    let backupPath: string | null = null;
    if (previousRaw !== null) {
      backupPath = this.backupSettings();
      if (!backupPath) {
        this.log.appendLine(
          "[ERROR] could not back up ~/.claude/settings.json; refusing to write without a recoverable copy."
        );
        vscode.window.showErrorMessage(
          "Claude Gate: could not back up ~/.claude/settings.json, so the hook was NOT installed — " +
            "your configuration was left untouched."
        );
        return false;
      }
    }

    try {
      this.writeFileAtomic(target, content);
    } catch (err) {
      this.log.appendLine(`[ERROR] failed to write settings.json: ${(err as Error).message}`);
      if (backupPath) this.restoreSettingsBackup(backupPath, target);
      return false;
    }

    let after = "";
    try {
      after = fs.readFileSync(target, "utf-8");
    } catch (err) {
      after = ""; // unreadable → fails verification below, which restores
      this.log.appendLine(`[WARN] could not re-read settings.json after write: ${(err as Error).message}`);
    }
    const problem = verifySettingsContent(after, previousRaw ?? "", this.hookWrapperDest);
    if (problem) {
      this.log.appendLine(`[ERROR] settings.json failed verification after write: ${problem}.`);
      if (backupPath && this.restoreSettingsBackup(backupPath, target)) {
        this.log.appendLine(`[INFO] restored ~/.claude/settings.json from ${backupPath}.`);
      }
      vscode.window.showErrorMessage(
        "Claude Gate: the update to ~/.claude/settings.json did not verify, so it was rolled back from a backup. " +
          "The hook was not installed."
      );
      return false;
    }

    // Record our own write so the trust-invalidation watcher doesn't flag it
    // (setup() shows its own restart notice when it actually writes).
    this.lastKnownSettingsRaw = content;
    return true;
  }

  /**
   * Copy the current settings.json to a timestamped backup, then prune to the
   * newest SETTINGS_BACKUP_RETENTION. Returns the backup path, or null if the
   * copy failed (the caller must then abort the write).
   *
   * Timestamped rather than a single fixed path: a fixed `.claudegate.bak` is
   * overwritten by the next write, so one bad write followed by another
   * destroys the only good copy. Backups sit beside the *literal* path, in
   * ~/.claude, so a dotfiles-symlinked config doesn't accumulate .bak files
   * inside the user's repo.
   *
   * Protected so tests can inject a backup failure (a full or read-only
   * ~/.claude), which must abort the write rather than proceed unprotected.
   */
  protected backupSettings(): string | null {
    const stamp = new Date().toISOString().replace(/:/g, "-");
    let backupPath = `${this.claudeSettingsPath}.claudegate-${stamp}.bak`;
    // Two writes inside one millisecond would otherwise reuse the name. "_" sorts
    // after "." so the suffixed copy still sorts as the newer one.
    for (let n = 1; fs.existsSync(backupPath); n++) {
      backupPath = `${this.claudeSettingsPath}.claudegate-${stamp}_${n}.bak`;
    }

    try {
      fs.copyFileSync(this.claudeSettingsPath, backupPath);
    } catch (err) {
      this.log.appendLine(`[WARN] could not back up settings.json: ${(err as Error).message}`);
      return null;
    }

    try {
      const dir = path.dirname(this.claudeSettingsPath);
      for (const name of backupsToPrune(fs.readdirSync(dir), path.basename(this.claudeSettingsPath))) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* keep going */ }
      }
    } catch (err) {
      this.log.appendLine(`[WARN] could not prune settings.json backups: ${(err as Error).message}`);
    }

    return backupPath;
  }

  private restoreSettingsBackup(backupPath: string, target: string): boolean {
    try {
      // copyFileSync (not rename) so a symlinked target keeps its inode.
      fs.copyFileSync(backupPath, target);
      return true;
    } catch (err) {
      this.log.appendLine(
        `[ERROR] could not restore settings.json from ${backupPath}: ${(err as Error).message}. ` +
          "Your previous configuration is still in that backup file."
      );
      return false;
    }
  }

  // Write via a temp file + rename so an interrupted write can't leave a
  // truncated/corrupt settings.json. `filePath` must already be realpath-resolved
  // by the caller: renaming onto a symlink replaces the link with a regular file.
  // Protected so tests can simulate a write that lands wrong content.
  protected writeFileAtomic(filePath: string, content: string): void {
    const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, content, "utf-8");
      // Preserve the existing file's mode — rename would otherwise hand the
      // user a fresh 0644 file where they had tightened permissions.
      try { fs.chmodSync(tmp, fs.statSync(filePath).mode & 0o777); } catch { /* new file → default mode */ }
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore cleanup error */ }
      throw err;
    }
  }

  private readSettingsRaw(): string {
    try {
      return fs.readFileSync(this.claudeSettingsPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Health signal: watch ~/.claude/settings.json and note once if the hooks
   * block changes out from under the running extension while the claudegate
   * hook is still registered.
   *
   * Historically this warned that every already-open Claude Code session had
   * gone silent until restarted. That is NOT true of current Claude Code
   * (measured on 2.1.227): it holds an inotify watch on the settings files and
   * re-reads hook config when they change, so a mid-session edit takes effect
   * immediately and existing hooks keep firing. The mechanism is retained
   * because older versions did snapshot hook config at session start — but the
   * message is now a heads-up, not an outage report.
   *
   * Returns a Disposable that stops watching; register it on context.subscriptions.
   */
  watchSettingsForTrustInvalidation(): vscode.Disposable {
    this.lastKnownSettingsRaw = this.readSettingsRaw();

    const onChange = (): void => {
      const current = this.readSettingsRaw();
      // fs.watchFile fires on any stat change, including a byte-identical
      // rewrite (a formatter/tool re-saving the same content bumps mtime). That
      // is NOT a real change: bail before touching state, so it can't falsely
      // clear an active trust-invalidation (which would drop the persistent
      // status-bar warning while running sessions are still untrusted).
      if (current === this.lastKnownSettingsRaw) return;
      const kind = classifySettingsChange(this.lastKnownSettingsRaw ?? "", current);
      this.lastKnownSettingsRaw = current;

      if (kind === "benign") {
        // Claude Code rewrote an unrelated field (model/theme/plugins/session
        // state); the hooks block is untouched and capture keeps working.
        // Leave trust state exactly as-is — don't warn, and don't clear a
        // genuine invalidation that a real hook change set earlier.
        return;
      }

      if (kind === "unregistered") {
        // The hooks block changed and the claudegate entry is gone — an
        // uninstall (handled by the not-registered health state), not a
        // mid-session edit. Clear so a future invalidation re-warns.
        // (Genuine recovery from invalidation is via Setup Hook.)
        this.trustInvalidated = false;
        this.trustWarningShown = false;
        this.fireHealth();
        return;
      }

      this.trustInvalidated = true;
      this.fireHealth();
      if (this.trustWarningShown) return;
      this.trustWarningShown = true;
      this.log.appendLine(
        "[INFO] ~/.claude/settings.json hooks block changed while running; current Claude Code re-reads it, " +
          "older versions may need a session restart."
      );
      void vscode.window
        .showWarningMessage(
          "Claude Gate: the hook configuration in ~/.claude/settings.json changed. Current Claude Code re-reads it " +
            "immediately, so capture should continue; on older versions, restarting a Claude Code session picks up the change.",
          "Verify Setup"
        )
        .then((action) => {
          if (action === "Verify Setup") this.verify();
        });
    };

    try {
      fs.watchFile(this.claudeSettingsPath, { interval: 3000 }, onChange);
    } catch (err) {
      this.log.appendLine(
        `[WARN] Could not watch settings.json for trust invalidation: ${(err as Error).message}`
      );
    }

    return new vscode.Disposable(() => {
      try {
        fs.unwatchFile(this.claudeSettingsPath, onChange);
      } catch {
        /* nothing to detach */
      }
    });
  }

  verify(): void {
    const checks: VerifyCheck[] = [];
    const scriptOk = fs.existsSync(this.hookPyDest);
    checks.push({ label: "hook.py installed", ok: scriptOk,
      detail: scriptOk ? undefined : "run Setup Hook" });
    const wrapperOk = fs.existsSync(this.hookWrapperDest);
    checks.push({ label: `hook.${this.isWindows ? "bat" : "sh"} installed`, ok: wrapperOk,
      detail: wrapperOk ? undefined : "run Setup Hook" });

    if (scriptOk) {
      // Smoke-test the hook against a throwaway cwd that matches no workspace
      // root, then delete the session file it creates so verification doesn't
      // pollute ~/.claudegate/sessions.
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
        // Mirror hook.py's hashing (normcase + abspath, lower-case on Windows).
        const resolved = path.resolve(probeDir);
        const normalized = this.isWindows ? resolved.toLowerCase() : resolved;
        const hash = crypto.createHash("md5").update(normalized).digest("hex");
        try { fs.unlinkSync(path.join(this.claudegateDir, "sessions", `${hash}.json`)); } catch { /* nothing to clean up */ }
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
}
