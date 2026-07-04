// Glob exclusion for ClaudeGate. Kept free of `vscode` imports so it can be
// bundled and run under plain Node for unit tests.

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

export class ExcludeMatcher {
  private patterns: RegExp[] = [];
  private root = "";

  // Rebuild the active pattern set. Only entries mapped to `true` are active.
  // An individual glob that fails to compile is skipped (fail open).
  reload(excludeMap: Record<string, boolean> | undefined, workspaceRoot?: string): void {
    this.root = (workspaceRoot ?? "").replace(/\\/g, "/");
    this.patterns = [];
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
