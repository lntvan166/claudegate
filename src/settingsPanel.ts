import * as vscode from "vscode";
import { HookInstaller } from "./hookInstaller";

type SettingsKind =
  | "watcher"
  | "excludeHeader"
  | "excludePattern"
  | "excludeAdd"
  | "hook";

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
          e.affectsConfiguration("claudegate.fileWatcher.enabled")
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
      return [{ kind: "watcher" }, { kind: "excludeHeader" }, { kind: "hook" }];
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
          .get<boolean>("fileWatcher.enabled", true);
        const ti = new vscode.TreeItem("File Watcher");
        ti.description = enabled ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon(enabled ? "eye" : "eye-closed");
        ti.tooltip = `Click to turn the GUI file watcher ${enabled ? "off" : "on"}`;
        ti.command = { command: "claudegate.toggleFileWatcher", title: "Toggle File Watcher" };
        return ti;
      }
      case "excludeHeader": {
        const ti = new vscode.TreeItem(
          "Exclude Patterns",
          vscode.TreeItemCollapsibleState.Expanded
        );
        ti.description = String(this.activePatterns().length);
        ti.iconPath = new vscode.ThemeIcon("filter");
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
    }
  }

  private activePatterns(): string[] {
    const map = vscode.workspace
      .getConfiguration("claudegate")
      .get<Record<string, boolean>>("exclude", {});
    return Object.entries(map)
      .filter(([, active]) => active)
      .map(([glob]) => glob);
  }
}
