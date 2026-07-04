import * as path from "path";
import * as vscode from "vscode";
import { ExcludeMatcher } from "./excludeMatcher";

/** True if filePath is under any open VS Code workspace folder. */
export function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => filePath.startsWith(f.uri.fsPath + path.sep));
}

// Shared exclusion matcher, wired once at activation. Until set, nothing is excluded.
let _excludeMatcher: ExcludeMatcher | null = null;

export function setExcludeMatcher(m: ExcludeMatcher): void {
  _excludeMatcher = m;
}

/** True if filePath matches an active claudegate.exclude glob. */
export function isExcluded(filePath: string): boolean {
  return _excludeMatcher?.isExcluded(filePath) ?? false;
}

let _protectedMatcher: ExcludeMatcher | null = null;

export function setProtectedMatcher(m: ExcludeMatcher): void {
  _protectedMatcher = m;
}

/** True if filePath matches an active claudegate.protected glob (sensitive file). */
export function isProtected(filePath: string): boolean {
  return _protectedMatcher?.isExcluded(filePath) ?? false;
}
