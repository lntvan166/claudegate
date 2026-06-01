import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const ROOTS_FILENAME = "workspace-roots.json";

/**
 * Register this window's primary workspace folder so hook.py hashes the same
 * session file the sidebar reads.
 *
 * SessionManager keys the session off workspaceFolders[0], so only that root is
 * registered here — registering additional folders would let the hook write a
 * second-root file into a session the sidebar never watches.
 *
 * The roots file is shared by every open VS Code/Cursor window, so we MERGE
 * (union) instead of overwriting. Overwriting would let the most recently
 * activated window erase every other window's root, and the hook would then
 * route their edits to a cwd-based session file no sidebar is reading — which
 * is exactly how an edited file ends up recorded as a brand-new file.
 */
export function persistWorkspaceRoots(): void {
  const claudegateDir = path.join(os.homedir(), ".claudegate");
  const rootsPath = path.join(claudegateDir, ROOTS_FILENAME);

  let existing: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(rootsPath, "utf-8"));
    if (Array.isArray(parsed)) {
      existing = parsed.filter((r): r is string => typeof r === "string");
    }
  } catch {
    // Missing or malformed — start fresh.
  }

  // Keep roots that still exist on disk so closed/deleted projects don't linger.
  const merged = new Set(
    existing.map((r) => path.resolve(r)).filter((r) => fs.existsSync(r))
  );

  const firstRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (firstRoot) merged.add(path.resolve(firstRoot));

  fs.mkdirSync(claudegateDir, { recursive: true });
  fs.writeFileSync(rootsPath, JSON.stringify([...merged], null, 2), "utf-8");
}
