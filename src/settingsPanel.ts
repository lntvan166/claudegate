import * as vscode from "vscode";
import { HookInstaller } from "./hookInstaller";

type SettingsKind =
  | "watcher"
  | "groupBySession"
  | "autoAdvance"
  | "excludeHeader"
  | "excludePattern"
  | "excludeAdd"
  | "protected"
  | "hook"
  | "verify";

export interface SettingsItem {
  kind: SettingsKind;
  pattern?: string; // set only for kind === "excludePattern"
}

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingsItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly hookInstaller: HookInstaller,
    disposables: vscode.Disposable[]
  ) {
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudegate.exclude") ||
          e.affectsConfiguration("claudegate.protected") ||
          e.affectsConfiguration("claudegate.fileWatcher.enabled") ||
          e.affectsConfiguration("claudegate.groupBySession") ||
          e.affectsConfiguration("claudegate.autoAdvance")
        ) {
          this.refresh();
        }
      })
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: SettingsItem): SettingsItem[] {
    if (!element) {
      return [
        { kind: "watcher" },
        { kind: "groupBySession" },
        { kind: "autoAdvance" },
        { kind: "excludeHeader" },
        { kind: "protected" },
        { kind: "hook" },
        { kind: "verify" },
      ];
    }
    if (element.kind === "excludeHeader") {
      const rows: SettingsItem[] = this.activePatterns().map((p) => ({
        kind: "excludePattern" as const,
        pattern: p,
      }));
      rows.push({ kind: "excludeAdd" });
      return rows;
    }
    return [];
  }

  getTreeItem(item: SettingsItem): vscode.TreeItem {
    switch (item.kind) {
      case "watcher": {
        const enabled = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("fileWatcher.enabled", false);
        const ti = new vscode.TreeItem("File Watcher");
        ti.description = enabled ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(enabled ? "eye" : "eye-closed");
        ti.tooltip = `Click to turn the GUI file watcher ${enabled ? "off" : "on"}`;
        ti.command = { command: "claudegate.toggleFileWatcher", title: "Toggle File Watcher" };
        return ti;
      }
      case "groupBySession": {
        const on = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("groupBySession", false);
        const ti = new vscode.TreeItem("Group by Session");
        ti.description = on ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(on ? "list-tree" : "list-flat");
        ti.tooltip = `Click to turn session grouping ${on ? "off" : "on"}`;
        ti.command = { command: "claudegate.toggleGroupBySession", title: "Toggle Group by Session" };
        return ti;
      }
      case "autoAdvance": {
        const on = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("autoAdvance", true);
        const ti = new vscode.TreeItem("Auto-advance");
        ti.description = on ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(on ? "arrow-right" : "primitive-dot");
        ti.tooltip = `After accepting/rejecting a diff with the keyboard, ${on ? "stop" : "open the next pending file"}`;
        ti.command = { command: "claudegate.toggleAutoAdvance", title: "Toggle Auto-advance" };
        return ti;
      }
      case "excludeHeader": {
        const ti = new vscode.TreeItem("Exclude Patterns", vscode.TreeItemCollapsibleState.Collapsed);
        ti.description = String(this.activePatterns().length);
        ti.iconPath = new vscode.ThemeIcon("filter");
        return ti;
      }
      case "protected": {
        const count = this.activePatterns("protected").length;
        const ti = new vscode.TreeItem("Protected Files");
        ti.description = count > 0 ? String(count) : "None";
        ti.iconPath = new vscode.ThemeIcon("shield");
        ti.tooltip = "Files matching these globs are flagged as sensitive in review. Click to edit in Settings.";
        ti.command = { command: "claudegate.openProtectedSettings", title: "Edit Protected Patterns" };
        return ti;
      }
      case "excludePattern": {
        const ti = new vscode.TreeItem(item.pattern ?? "");
        ti.contextValue = "claudegate.excludePattern";
        ti.iconPath = new vscode.ThemeIcon("circle-small-filled");
        ti.tooltip = "Excluded from ClaudeGate review";
        return ti;
      }
      case "excludeAdd": {
        const ti = new vscode.TreeItem("Add pattern…");
        ti.iconPath = new vscode.ThemeIcon("add");
        ti.command = { command: "claudegate.addExcludePattern", title: "Add Exclude Pattern" };
        return ti;
      }
      case "hook": {
        const s = this.hookInstaller.getStatus();
        const ti = new vscode.TreeItem("Hook");
        if (!s.scriptInstalled) {
          ti.description = "Not installed";
          ti.iconPath = new vscode.ThemeIcon("error");
        } else if (!s.registered) {
          ti.description = "Not registered";
          ti.iconPath = new vscode.ThemeIcon("warning");
        } else if (!s.upToDate) {
          ti.description = "Update available";
          ti.iconPath = new vscode.ThemeIcon("warning");
        } else {
          ti.description = "Installed & registered";
          ti.iconPath = new vscode.ThemeIcon("check");
        }
        ti.tooltip = "Click to run Setup Hook";
        ti.command = { command: "claudegate.setupHook", title: "Setup Hook" };
        return ti;
      }
      case "verify": {
        const ti = new vscode.TreeItem("Verify Setup");
        ti.iconPath = new vscode.ThemeIcon("verified");
        ti.tooltip = "Run a health check: confirm the hook is installed, registered, and captures edits.";
        ti.command = { command: "claudegate.verifyHook", title: "Verify Setup" };
        return ti;
      }
    }
  }

  private activePatterns(key: "exclude" | "protected" = "exclude"): string[] {
    const map = vscode.workspace
      .getConfiguration("claudegate")
      .get<Record<string, boolean>>(key, {});
    return Object.entries(map)
      .filter(([, active]) => active)
      .map(([glob]) => glob);
  }
}
