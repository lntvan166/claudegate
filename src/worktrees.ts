import * as fsp from "fs/promises";
import * as path from "path";
import { pathIsUnder } from "./workspaceScope";

// Read the `gitdir: <target>` line from a `.git` FILE, or null if it isn't one.
async function gitFileTarget(dotGitPath: string): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(dotGitPath, "utf-8")).trim();
    const m = /^gitdir:\s*(.+)$/.exec(raw);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** True if `dir` is the working directory of a git worktree (not a submodule). */
export async function isWorktreeRoot(dir: string): Promise<boolean> {
  const dotGit = path.join(dir, ".git");
  try {
    if (!(await fsp.lstat(dotGit)).isFile()) return false; // main repo has a `.git` DIR
  } catch {
    return false;
  }
  const target = await gitFileTarget(dotGit);
  if (target === null) return false;
  // A worktree's gitdir is structurally `<main-repo>/.git/worktrees/<name>`. Check
  // the two segments above <name> are `worktrees` then `.git`, so a submodule
  // (`.../.git/modules/<name>`) or a repo merely parked under a folder named
  // "worktrees" is NOT misclassified. path.basename/dirname split on the
  // platform's native separator, which is fine here since the same OS both
  // writes and reads the gitdir file.
  const worktreesDir = path.dirname(target);        // <main-repo>/.git/worktrees
  const gitDir = path.dirname(worktreesDir);        // <main-repo>/.git
  return path.basename(worktreesDir) === "worktrees" && path.basename(gitDir) === ".git";
}

// Directory names never worth descending into while hunting for worktree working
// dirs — heavy or generated trees that can never *be* one. `.git` is skipped (a
// worktree wd's `.git` is a file, not a dir we recurse into). `.claude` is
// deliberately NOT skipped: subagent worktrees live at `<root>/.claude/worktrees/*`.
const WORKTREE_SCAN_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  "__pycache__", ".next", ".nuxt", ".venv", "venv",
]);

// Bound the descent so a deep monorepo can't turn a refresh into a full-disk
// crawl. Worktree working dirs in practice sit within a few levels of the root.
const WORKTREE_SCAN_MAX_DEPTH = 6;

// How many directories are probed concurrently. Keeps the walk fast without
// opening thousands of file descriptors at once on a large monorepo, and gives
// the event loop a turn between batches.
const WORKTREE_SCAN_CONCURRENCY = 16;

/**
 * Enumerate git worktree working directories nested under `root`, using only the
 * filesystem (no `git` binary).
 *
 * We scan the directory tree for working dirs whose `.git` is a worktree file
 * (see {@link isWorktreeRoot}) rather than only reading `<root>/.git/worktrees`.
 * The registry-only read found worktrees owned by the ROOT repo but missed
 * worktrees owned by NESTED sub-repos (e.g. a go.work layout where each module
 * is its own repo and its worktree is checked out into a sibling folder under
 * the open workspace). The hook (`worktree_root_for_file`) already routes edits
 * to those worktrees' sessions by walking up to any `.git` worktree file, so a
 * download-symmetric scan here is required or those pending changes surface in
 * no window at all. Descent is bounded and skips heavy dirs; symlinked
 * directories are not followed (cycle-safe).
 *
 * ASYNCHRONOUS BY DESIGN. A real go.work monorepo costs ~2,500 `readdir` plus
 * ~2,700 `lstat` calls per scan; done synchronously that froze the extension
 * host for tens of milliseconds warm and far longer with a cold page cache, on
 * every single window focus. Walking level-by-level in bounded batches keeps the
 * loop turning throughout. Callers must still avoid rescanning needlessly —
 * see WorktreeSessionRegistry's throttle.
 */
export async function nestedWorktreesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  // Breadth-first: `frontier` holds the directories at the current depth, and
  // each pass fills `next` with the ones to descend into.
  let frontier: string[] = [path.resolve(root)];
  for (let depth = 1; depth <= WORKTREE_SCAN_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += WORKTREE_SCAN_CONCURRENCY) {
      const batch = frontier.slice(i, i + WORKTREE_SCAN_CONCURRENCY);
      await Promise.all(batch.map(async (dir) => {
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return; // unreadable dir — skip, never throw during a refresh
        }
        await Promise.all(entries.map(async (entry) => {
          if (!entry.isDirectory()) return; // files AND symlinks skipped (cycle-safe)
          if (WORKTREE_SCAN_SKIP.has(entry.name)) return;
          const child = path.join(dir, entry.name);
          if (await isWorktreeRoot(child)) {
            // A worktree working dir. Record it and do NOT descend — its interior
            // is that worktree's own concern, and an edit inside a
            // nested-within-a-worktree worktree is routed to its own session by
            // the same rule when it happens.
            found.push(path.resolve(child));
            return;
          }
          next.push(child);
        }));
      }));
    }
    frontier = next;
  }
  // Concurrency makes completion order nondeterministic. Sort so the registry's
  // attach cap slices the same tail every refresh instead of dropping a
  // different worktree each time.
  return found.sort();
}

/** The `roots` entry that contains `filePath` (longest match), or null. */
export function worktreeRootForPath(filePath: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (pathIsUnder(filePath, r) && (best === null || r.length > best.length)) best = r;
  }
  return best;
}
