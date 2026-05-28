import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";

const HOOK_SH = `#!/usr/bin/env bash
python3 "$HOME/.claudegate/hook.py"
`;

export class HookInstaller {
  private readonly claudegateDir = path.join(os.homedir(), ".claudegate");
  private readonly hookPyDest = path.join(os.homedir(), ".claudegate", "hook.py");
  private readonly hookShDest = path.join(os.homedir(), ".claudegate", "hook.sh");
  private readonly claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {}

  async setup(): Promise<void> {
    try {
      this.ensurePythonAvailable();
      fs.mkdirSync(this.claudegateDir, { recursive: true });

      this.installHookPy();
      this.installHookSh();
      this.patchClaudeSettings();

      this.log.appendLine("[INFO] Hook installed successfully.");
      const action = await vscode.window.showInformationMessage(
        "ClaudeGate: Hook installed. Run Claude Code normally — changes will appear in the sidebar.",
        "Verify Setup"
      );
      if (action === "Verify Setup") this.verify();
    } catch (err) {
      this.log.appendLine(`[ERROR] Setup failed: ${(err as Error).message}`);
      vscode.window.showErrorMessage(
        `ClaudeGate setup failed: ${(err as Error).message}`
      );
    }
  }

  private ensurePythonAvailable(): void {
    try {
      child_process.execSync("python3 --version", { stdio: "ignore" });
    } catch {
      throw new Error(
        "Python 3 is required but not found. Install it from https://python.org and try again."
      );
    }
  }

  private installHookPy(): void {
    const sourcePath = path.join(this.context.extensionPath, "hooks", "hook.py");
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`hook.py not found at ${sourcePath}. Reinstall the extension.`);
    }
    fs.copyFileSync(sourcePath, this.hookPyDest);
  }

  private installHookSh(): void {
    fs.writeFileSync(this.hookShDest, HOOK_SH, "utf-8");
    fs.chmodSync(this.hookShDest, 0o755);
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
        hooks: [{ type: "command", command: this.hookShDest }],
      });
    }

    fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  verify(): void {
    const issues: string[] = [];

    if (!fs.existsSync(this.hookPyDest)) issues.push("hook.py not found in ~/.claudegate");
    if (!fs.existsSync(this.hookShDest)) issues.push("hook.sh not found in ~/.claudegate");

    try {
      const settings = JSON.parse(fs.readFileSync(this.claudeSettingsPath, "utf-8"));
      if (!JSON.stringify(settings).includes("claudegate")) {
        issues.push("Hook not registered in ~/.claude/settings.json");
      }
    } catch {
      issues.push("Cannot read ~/.claude/settings.json");
    }

    if (issues.length === 0) {
      vscode.window.showInformationMessage("ClaudeGate: All checks passed!");
    } else {
      vscode.window.showErrorMessage(`ClaudeGate issues: ${issues.join(" · ")}`);
    }
  }
}
