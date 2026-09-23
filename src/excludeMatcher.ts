// Glob exclusion for ClaudeGate. Kept free of `vscode` imports so it can be
// bundled and run under plain Node for unit tests.

// Shipped as the default VALUE of claudegate.exclude (editable by users).
export const DEFAULT_EXCLUDES: string[] = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/npm-shrinkwrap.json",
  "**/bun.lockb", "**/Cargo.lock", "**/poetry.lock", "**/Pipfile.lock", "**/Gemfile.lock",
  "**/composer.lock", "**/go.sum", "**/*.min.js", "**/*.min.css", "**/*.map", "**/node_modules/**",
];

// Shipped as the default VALUE of claudegate.protected (editable by users).
export const DEFAULT_PROTECTED: string[] = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx",
  "**/id_rsa", "**/id_ed25519", "**/.npmrc", "**/credentials",
];

// Translate a glob to an anchored RegExp.
//   **  → any characters, including path separators (matches across segments)
//   *   → any characters except the path separator (within one segment)
//   ?   → exactly one character except the path separator
// A `**` immediately followed by `/` also consumes that slash, so `**/x`
// matches both `x` and `a/b/x`.
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++; // consume the second '*'
        if (g[i + 1] === "/") i++; // consume an optional trailing slash
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// A matched path is cached because the answer only changes when the pattern set
// or the workspace root does, and the question is asked an enormous number of
// times: filteredFiles()/pendingOf() run it over every pending entry, and the
// tree calls those afresh for the root and for EVERY expanded folder — so the
// work is O(nodes x files). isProtected() is the same class and is asked again
// inside every sort comparator. Measured at 15.5 us per uncached call on a real
// monorepo path: ~150 anchored regexes, each with a leading `.*`, against the
// absolute path, the relative path and every ancestor directory, plus a fresh
// array and a string allocation every time.
//
// Bounded because isExcluded() is also called from provideFileDecoration() for
// arbitrary Explorer paths, not just the pending set — an unbounded map would
// grow with everything the user ever scrolls past.
const CACHE_MAX = 20_000;

export class ExcludeMatcher {
  private patterns: RegExp[] = [];
  private root = "";
  private cache = new Map<string, boolean>();

  // Rebuild the active pattern set. Only entries mapped to `true` are active.
  // An individual glob that fails to compile is skipped (fail open).
  reload(excludeMap: Record<string, boolean> | undefined, workspaceRoot?: string): void {
    this.root = (workspaceRoot ?? "").replace(/\\/g, "/");
    this.patterns = [];
    // The cached answers were computed against the OLD pattern set and root, so
    // they are all invalid now. This is the only thing either input depends on.
    this.cache.clear();
    if (!excludeMap) return;
    for (const [glob, active] of Object.entries(excludeMap)) {
      if (!active) continue;
      try {
        this.patterns.push(globToRegExp(glob));
      } catch {
        // Ignore an invalid glob rather than throwing; the file is simply not excluded.
      }
    }
  }

  // True if the file matches any active pattern. Tested against the absolute
  // path, the workspace-relative path, AND each ancestor directory of the
  // relative path — so a pattern naming a folder (e.g. ".superpowers/sdd" or
  // "**/dist") excludes everything inside it, which is what users expect.
  isExcluded(filePath: string): boolean {
    if (this.patterns.length === 0) return false;
    const hit = this.cache.get(filePath);
    if (hit !== undefined) return hit;
    const value = this.compute(filePath);
    // Simplest bound that cannot leak: drop everything and start again. A tree
    // render re-warms in one pass, and the alternative (LRU bookkeeping) costs
    // more per call than the regex test it is protecting.
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(filePath, value);
    return value;
  }

  private compute(filePath: string): boolean {
    const abs = filePath.replace(/\\/g, "/");
    const candidates: string[] = [abs];
    if (this.root && abs.startsWith(this.root + "/")) {
      const rel = abs.slice(this.root.length + 1);
      candidates.push(rel, ...ancestorDirs(rel));
    }
    return this.patterns.some((re) => candidates.some((c) => re.test(c)));
  }
}

// Ancestor directory prefixes of a relative path (the path itself is tested
// separately). "a/b/c.txt" -> ["a", "a/b"].
function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
