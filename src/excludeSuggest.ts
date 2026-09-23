import * as path from "path";

// Turning a row the user is looking at into an exclude glob.
//
// `claudegate.exclude` has existed for a long time, but only through the
// Settings panel, which means writing a glob by hand at a moment when you are
// not thinking about globs. The realisation that a whole category does not
// belong in the review happens while looking at a row — so the glob should be
// derivable from that row.
//
// Deliberately only two shapes. Anything cleverer (matching a path segment, a
// name prefix, a sibling set) guesses at intent, and an exclude that is wrong is
// worse than no exclude: it hides changes silently.

/** Glob for "every file with this extension, anywhere". Returns undefined for a
 *  file with no extension — `**` over an extensionless name would match far more
 *  than the user meant. Dotfiles like `.env` have no extension by this rule
 *  (path.extname(".env") === ""), which is the safe reading. */
export function extensionGlob(filePath: string): string | undefined {
  const ext = path.extname(filePath);
  if (!ext || ext === ".") return undefined;
  return `**/*${ext}`;
}

/** Glob for "everything under this file's directory".
 *
 *  Relative to the workspace root when the file is inside it, so the pattern
 *  stays portable and readable (`**\/docs/plans/**` rather than an absolute
 *  path). Falls back to the directory's own name when the file sits outside any
 *  known root. */
export function folderGlob(filePath: string, workspaceRoot?: string): string | undefined {
  const dir = path.dirname(filePath);
  if (!dir || dir === "." || dir === path.sep) return undefined;

  if (workspaceRoot) {
    const rel = path.relative(workspaceRoot, dir);
    // Empty means the file sits directly in the workspace root. Excluding that
    // hides the entire review, so refuse rather than fall through to the
    // basename branch below — which would happily emit `**/<root-name>/**`.
    if (rel === "") return undefined;
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return `**/${rel.split(path.sep).join("/")}/**`;
    }
  }
  const base = path.basename(dir);
  return base ? `**/${base}/**` : undefined;
}

/** What to call the glob in a confirmation prompt. The user is about to hide
 *  files from review, so the prompt has to describe the RULE, not just show a
 *  pattern they would have to parse. */
export function describeGlob(glob: string): string {
  const m = /^\*\*\/\*(\.[^/]+)$/.exec(glob);
  if (m) return `every ${m[1]} file`;
  const f = /^\*\*\/(.+)\/\*\*$/.exec(glob);
  if (f) return `everything under ${f[1]}/`;
  return glob;
}
