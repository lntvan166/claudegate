import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";
import * as crypto from "crypto";
import { persistWorkspaceRoots } from "./workspaceRoots";

export class HookInstaller {
  private readonly isWindows = process.platform === "win32";
  private pythonCmd = "python3";

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
      this.patchClaudeSettings();

      this.log.appendLine("[INFO] Hook installed successfully.");
      const action = await vscode.window.showInformationMessage(
        "Claude Gate: Hook installed. Run Claude Code normally — changes will appear in the sidebar.",
        "Verify Setup"
      );
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

  private installHookPy(): void {
    const sourcePath = path.join(this.context.extensionPath, "hooks", "hook.py");
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`hook.py not found at ${sourcePath}. Reinstall the extension.`);
    }
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

  private patchClaudeSettings(): void {
    const claudeDir = path.dirname(this.claudeSettingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(this.claudeSettingsPath, "utf-8"));
    } catch {
      // File absent or malformed — start fresh
    }

    if (!settings.hooks) settings.hooks = {};
    const hooks = settings.hooks as Record<string, unknown[]>;
    if (!hooks.PreToolUse) hooks.PreToolUse = [];

    const alreadyInstalled = JSON.stringify(hooks.PreToolUse).includes("claudegate");
    if (!alreadyInstalled) {
      hooks.PreToolUse.push({
        matcher: "^(Write|Edit|MultiEdit)$",
        hooks: [{ type: "command", command: this.hookWrapperDest }],
      });
    }

    fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
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
