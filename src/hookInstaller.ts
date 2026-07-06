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
 * file when the claudegate entry is already present and byte-identical —
 * doing so kills capture for every already-running session at once.
 * See docs/2026-07-06-hook-not-firing-in-running-session-bug.md.
 */
export function computeSettingsPatch(
  raw: string,
  hookCommand: string
): { content: string; changed: boolean } {
  let settings: Record<string, unknown> = {};
  try {
    settings = raw ? JSON.parse(raw) : {};
  } catch {
    // File absent or malformed — start fresh
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.PreToolUse) hooks.PreToolUse = [];

  const alreadyInstalled = JSON.stringify(hooks.PreToolUse).includes("claudegate");
  if (!alreadyInstalled) {
    hooks.PreToolUse.push({
      matcher: "^(Write|Edit|MultiEdit)$",
      hooks: [{ type: "command", command: hookCommand }],
    });
  }

  const content = JSON.stringify(settings, null, 2);
  return { content, changed: content !== raw };
}

/**
 * Decision for the trust-invalidation health signal. Returns true when a
 * detected change to settings.json should warn the user that running Claude
 * Code sessions have gone silent.
 *
 * We warn on the *cause* (settings.json changed while claudegate is still
 * registered) rather than the *effect* (edits arriving with no capture),
 * because attributing an uncaptured edit to Claude is exactly the
 * unsolvable problem DocumentTracker exists for. A change that removes the
 * claudegate entry is an uninstall, not an invalidation — don't warn.
 */
export function shouldWarnTrustInvalidation(prevRaw: string, currentRaw: string): boolean {
  if (currentRaw === prevRaw) return false;
  return currentRaw.includes("claudegate");
}

export interface HookStatus {
  scriptInstalled: boolean;
  registered: boolean;
  upToDate: boolean;
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

  private readonly claudegateDir     = path.join(os.homedir(), ".claudegate");
  private readonly hookPyDest        = path.join(os.homedir(), ".claudegate", "hook.py");
  private readonly hookShDest        = path.join(os.homedir(), ".claudegate", "hook.sh");
  private readonly hookBatDest       = path.join(os.homedir(), ".claudegate", "hook.bat");
  private readonly claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

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
  // file was actually written — a no-op (entry already present, byte-identical)
  // returns false so callers can avoid the misleading "restart your sessions"
  // notice and, crucially, so running Claude Code sessions keep their hook trust.
  private patchClaudeSettings(): boolean {
    const claudeDir = path.dirname(this.claudeSettingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });

    let raw = "";
    try {
      raw = fs.readFileSync(this.claudeSettingsPath, "utf-8");
    } catch {
      raw = "";
    }

    const { content, changed } = computeSettingsPatch(raw, this.hookWrapperDest);
    if (!changed) return false;

    fs.writeFileSync(this.claudeSettingsPath, content, "utf-8");
    // Record our own write so the trust-invalidation watcher doesn't flag it
    // (setup() shows its own restart notice when it actually writes).
    this.lastKnownSettingsRaw = content;
    return true;
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
      if (this.trustWarningShown) return;
      const current = this.readSettingsRaw();
      if (!shouldWarnTrustInvalidation(this.lastKnownSettingsRaw ?? "", current)) {
        this.lastKnownSettingsRaw = current;
        return;
      }
      this.lastKnownSettingsRaw = current;
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
    const issues: string[] = [];

    if (!fs.existsSync(this.hookPyDest)) {
      issues.push("hook.py not found in ~/.claudegate");
    }
    if (!fs.existsSync(this.hookWrapperDest)) {
      issues.push(`hook.${this.isWindows ? "bat" : "sh"} not found in ~/.claudegate`);
    }

    if (fs.existsSync(this.hookPyDest)) {
      // Smoke-test the hook against a throwaway cwd that matches no workspace
      // root, then delete the session file it creates so verification doesn't
      // pollute ~/.claudegate/sessions.
      const probeDir = path.join(
        os.tmpdir(),
        `claudegate-verify-${crypto.randomBytes(4).toString("hex")}`
      );
      try {
        child_process.execSync(`${this.pythonCmd} "${this.hookPyDest}"`, {
          input: JSON.stringify({
            tool_name: "Write",
            cwd: probeDir,
            tool_input: { file_path: "test.txt" },
          }),
          stdio: ["pipe", "ignore", "pipe"],
        });
      } catch (err) {
        const detail = (err as { stderr?: Buffer }).stderr?.toString().trim();
        issues.push(
          `hook.py crashes under ${this.pythonCmd}${detail ? `: ${detail.split("\n").pop()}` : ""}`
        );
      } finally {
        // Mirror hook.py's hashing (normcase + abspath, lower-case on Windows).
        const resolved = path.resolve(probeDir);
        const normalized = this.isWindows ? resolved.toLowerCase() : resolved;
        const hash = crypto.createHash("md5").update(normalized).digest("hex");
        try {
          fs.unlinkSync(path.join(this.claudegateDir, "sessions", `${hash}.json`));
        } catch { /* nothing to clean up */ }
      }
    }

    try {
      const settings = JSON.parse(fs.readFileSync(this.claudeSettingsPath, "utf-8"));
      if (!JSON.stringify(settings).includes("claudegate")) {
        issues.push("Hook not registered in ~/.claude/settings.json");
      }
    } catch {
      issues.push("Cannot read ~/.claude/settings.json");
    }

    if (issues.length === 0) {
      vscode.window.showInformationMessage("Claude Gate: All checks passed!");
    } else {
      vscode.window.showErrorMessage(`Claude Gate issues: ${issues.join(" · ")}`);
    }
  }
}
