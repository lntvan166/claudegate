import * as fs from "fs";
import * as path from "path";
import { pathIsUnder } from "./workspaceScope";

// A git worktree's working directory has a `.git` FILE (not a dir) whose content
// is `gitdir: <main-repo>/.git/worktrees/<name>`. A submodule ALSO uses a `.git`
// file, but its gitdir points into `<super>/.git/modules/<name>` — so we key on
// the `worktrees` path segment to avoid classifying a submodule as a worktree.
// Git writes the gitdir path with the platform separator, so accept either.
const WORKTREE_MARKER = /[\\/]worktrees[\\/]/;

// Read the `gitdir: <target>` line from a `.git` FILE, or null if it isn't one.
function gitFileTarget(dotGitPath: string): string | null {
  try {
    const raw = fs.readFileSync(dotGitPath, "utf-8").trim();
    const m = /^gitdir:\s*(.+)$/.exec(raw);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** True if `dir` is the working directory of a git worktree (not a submodule). */
export function isWorktreeRoot(dir: string): boolean {
  const dotGit = path.join(dir, ".git");
  try {
    if (!fs.lstatSync(dotGit).isFile()) return false; // main repo has a `.git` DIR
  } catch {
    return false;
  }
  const target = gitFileTarget(dotGit);
  return target !== null && WORKTREE_MARKER.test(target);
}

/**
 * Enumerate git worktree working directories nested strictly under `root`, using
 * only the filesystem (no `git` binary). A main repo records each worktree at
 * `<root>/.git/worktrees/<name>/gitdir`, whose content is the path to that
 * worktree's `.git` file; the worktree working directory is that file's parent.
 */
export function nestedWorktreesUnder(root: string): string[] {
  const dotGit = path.join(root, ".git");
  try {
    if (!fs.statSync(dotGit).isDirectory()) return []; // only a main repo has worktrees/
  } catch {
    return [];
  }
  const worktreesDir = path.join(dotGit, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir);
  } catch {
    return []; // no worktrees/ subdir
  }
  const found: string[] = [];
  for (const name of names) {
    let target: string;
    try {
      target = fs.readFileSync(path.join(worktreesDir, name, "gitdir"), "utf-8").trim();
    } catch {
      continue;
    }
    const wtRoot = path.resolve(path.dirname(target)); // parent of the `.git` file
    if (pathIsUnder(wtRoot, root)) found.push(wtRoot);
  }
  return found;
}

/** The `roots` entry that contains `filePath` (longest match), or null. */
export function worktreeRootForPath(filePath: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (pathIsUnder(filePath, r) && (best === null || r.length > best.length)) best = r;
  }
  return best;
}
