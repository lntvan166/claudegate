import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";
import * as crypto from "crypto";
import { persistWorkspaceRoots } from "./workspaceRoots";

type HookSyncAction = "none" | "installed" | "updated";

/**
 * Pure decision logic for the ~/.claude/settings.json registration write.
 *
 * Given the current file contents and the hook wrapper command, returns the
 * settings JSON that *should* be on disk and whether it differs from what is.
 *
 * Idempotency is load-bearing: Claude Code snapshots hook config at session
 * start and treats any later change to settings.json as untrusted, silently
 * disabling those hooks until the session restarts. So we must NOT rewrite the
 * file for a cosmetic (formatting-only) difference when the claudegate entry is
 * already correct — doing so kills capture for every already-running session at
 * once. `changed` therefore reflects a SEMANTIC change (entry added or repaired),
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
  const isOurs = (h: unknown) => JSON.stringify(h).includes("claudegate");
  const ours = preToolUse.filter(isOurs);
  const correct = ours.some(
    (h) => Array.isArray(h.hooks) && h.hooks.some((x) => x.command === hookCommand)
  );

  let changed = false;
  if (correct) {
    // Already registered with the exact command → no semantic change. Return the
    // reformatted content but leave `changed` false so the caller preserves the
    // on-disk bytes (and hook trust for running sessions).
  } else if (ours.length > 0) {
    // Stale claudegate registration (e.g. an old/wrong wrapper path after the
    // home dir moved, or a .sh/.bat mismatch) → repair in place to the correct
    // command rather than leaving capture silently broken.
    for (const h of ours) {
      if (!Array.isArray(h.hooks)) continue;
      for (const x of h.hooks) {
        if (typeof x.command === "string" && x.command.includes("claudegate")) x.command = hookCommand;
      }
    }
    changed = true;
  } else {
    preToolUse.push({
      matcher: "^(Write|Edit|MultiEdit)$",
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
 *                    registered. Claude Code loads hooks once at session start,
 *                    so already-running sessions have gone silent — warn.
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
      const settingsChanged = this.patchClaudeSettings();

      this.trustInvalidated = false;
      this.trustWarningShown = false;
      this.fireHealth();

      this.log.appendLine(
        `[INFO] Hook installed successfully.${settingsChanged ? "" : " (settings.json unchanged)"}`
      );
      const message = settingsChanged
        ? "Claude Gate: Hook installed. Restart any Claude Code sessions that were already running — " +
          "Claude Code loads hooks once at startup, so in-progress sessions won't be tracked until restarted. " +
          "New sessions will appear in the sidebar automatically."
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

  // Registers the hook in ~/.claude/settings.json. Returns true only when the
  // file was actually written — a no-op (entry already correct) returns false so
  // callers avoid the misleading "restart your sessions" notice and, crucially,
  // so running Claude Code sessions keep their hook trust.
  //
  // Data safety: this file holds the user's entire Claude Code config. If it does
  // not parse we REFUSE to write (never clobber it), and before our first write
  // we back it up and write atomically (temp + rename) so an interrupted write
  // can't truncate it.
  private patchClaudeSettings(): boolean {
    const claudeDir = path.dirname(this.claudeSettingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });

    let raw = "";
    try {
      raw = fs.readFileSync(this.claudeSettingsPath, "utf-8");
    } catch {
      raw = "";
    }

    const { content, changed, parseError } = computeSettingsPatch(raw, this.hookWrapperDest);
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

    // Back up the existing config before our first modification.
    if (raw.trim()) {
      try {
        fs.copyFileSync(this.claudeSettingsPath, `${this.claudeSettingsPath}.claudegate.bak`);
      } catch (err) {
        this.log.appendLine(`[WARN] could not back up settings.json: ${(err as Error).message}`);
      }
    }
    this.writeFileAtomic(this.claudeSettingsPath, content);
    // Record our own write so the trust-invalidation watcher doesn't flag it
    // (setup() shows its own restart notice when it actually writes).
    this.lastKnownSettingsRaw = content;
    return true;
  }

  // Write via a temp file + rename so an interrupted write can't leave a
  // truncated/corrupt settings.json.
  private writeFileAtomic(filePath: string, content: string): void {
    const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, content, "utf-8");
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
   * Health signal: watch ~/.claude/settings.json and warn once if it changes
   * out from under the running extension while the claudegate hook is still
   * registered. Such a change silently invalidates the hook for every Claude
   * Code session that was already open (Claude Code trusts hook config as
   * loaded at session start), so capture goes quiet until those sessions
   * restart. This turns that silent failure into a visible, actionable hint.
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
        "[WARN] ~/.claude/settings.json changed while running — hook trust invalidated for open sessions."
      );
      void vscode.window
        .showWarningMessage(
          "Claude Gate: ~/.claude/settings.json changed. Claude Code loads hooks once at session start, so any " +
            "Claude Code sessions already running have stopped tracking edits. Restart them (or run /hooks) to resume capture.",
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
