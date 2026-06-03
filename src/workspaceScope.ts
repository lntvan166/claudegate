import * as path from "path";
import * as vscode from "vscode";

/** True if filePath is under any open VS Code workspace folder. */
export function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
}
