// Free-text filter for the Pending panel.
//
// The Pending panel is a worklist, not a log: on a busy workspace it carries
// dozens of rows across several worktrees, and finding one means scrolling. A
// VS Code tree does offer a native find widget (Ctrl+F), but this filter is
// PROVIDER state, so it survives the tree's refreshes — and the Pending panel
// refreshes constantly, at least twice per decision (persist() plus the
// fs.watch reload it triggers). A filter that cleared itself every time a file
// was accepted would be useless exactly when it is being used.

/** Normalise raw user input. Empty/whitespace means "no filter" (null), so a
 *  cleared box and a never-set box are the same state everywhere downstream. */
export function normalizeFilter(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Does `filePath` match `filter`?
 *
 *  Case-insensitive substring over the WHOLE path, so a filter can narrow by
 *  file (`auth`), by directory (`pkg/ws`) or by worktree (`wt-feature`) with no
 *  separate mode to choose. Separators are normalised so a user typing `/` on
 *  Windows still matches, and vice versa — nobody types the native separator on
 *  purpose.
 *
 *  A null filter matches everything, which keeps every call site free of
 *  "is there a filter?" branching. */
export function matchesFilter(filePath: string, filter: string | null): boolean {
  if (filter === null) return true;
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  return norm(filePath).includes(norm(filter));
}

/** Label for the view's description, e.g. `auth — 4 of 16`. Returns undefined
 *  when nothing is filtered, so the title stays clean in the common case.
 *
 *  The counts matter more than they look: a filtered panel showing three rows is
 *  visually identical to a panel with three pending files. Without "of 16" a
 *  user can believe they have reviewed everything while thirteen files sit
 *  hidden behind a filter they forgot about. */
export function filterLabel(
  filter: string | null,
  shown: number,
  total: number
): string | undefined {
  if (filter === null) return undefined;
  return `${filter} — ${shown} of ${total}`;
}
