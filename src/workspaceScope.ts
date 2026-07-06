import * as path from "path";
import * as vscode from "vscode";
import { ExcludeMatcher } from "./excludeMatcher";

// True if `child` sits strictly inside directory `parent`. On Windows the
// filesystem is case-insensitive, but the hook stores the file_path key with
// whatever case Claude passed while VS Code reports the workspace folder in its
// own case — so a case-sensitive compare here would wrongly declare an in-repo
// file "out of workspace" and pruneOutOfWorkspaceEntries would DELETE its
// pending entry. Fold case on Windows, mirroring the session-hash normcase.
export function pathIsUnder(
  child: string,
  parent: string,
  caseInsensitive: boolean = process.platform === "win32"
): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  return norm(child).startsWith(norm(parent) + path.sep);
}

/** True if filePath is under any open VS Code workspace folder. */
export function isInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => pathIsUnder(filePath, f.uri.fsPath));
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
