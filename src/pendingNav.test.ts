import * as assert from "assert";
import * as path from "path";
import { orderedPendingAcross, orderedPendingPaths } from "./pendingPaths";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import type { SessionManager } from "./sessionManager";

// Next / Previous Pending and the auto-advance after a decision all walked the
// PRIMARY session's list. On a workspace with nested worktrees that reached a
// small fraction of what was pending — measured on a real one, 27 of 224 files,
// with the other 197 unreachable by keyboard at all, and "all caught up"
// reported while they sat in the panel.

setExcludeMatcher(new ExcludeMatcher());
setProtectedMatcher(new ExcludeMatcher());

const p = (...parts: string[]) => path.join(path.sep, ...parts);

function mgr(files: string[]): SessionManager {
  return {
    getSession: () => ({
      files: Object.fromEntries(files.map((f) => [f, { reviewStatus: "pending" }])),
    }),
    hasRealPendingChange: () => true,
  } as unknown as SessionManager;
}

const PRIMARY = mgr([p("repo", "b.go"), p("repo", "a.go")]);
const ALPHA = mgr([p("repo", "ws-alpha", "svc", "z.go"), p("repo", "ws-alpha", "svc", "m.go")]);
const BETA = mgr([p("repo", "ws-beta", "svc", "c.go")]);

// ── The union, not one session ──────────────────────────────────────────────
{
  const only = orderedPendingPaths(PRIMARY);
  assert.equal(only.length, 2, "precondition: the primary session has two files");

  const all = orderedPendingAcross([PRIMARY, ALPHA, BETA]);
  assert.equal(all.length, 5, "every pending file across every session is reachable");
  console.log("ok - navigation spans the primary session and every worktree");
}

// ── Each path carries the session that owns it ──────────────────────────────
// Accepting or opening a file has to target its own session; a path alone is
// not enough, which is the same reason pendingAcross() pairs them.
{
  const all = orderedPendingAcross([PRIMARY, ALPHA, BETA]);
  const owner = (f: string) => all.find((x) => x.filePath === f)!.manager;
  assert.strictEqual(owner(p("repo", "a.go")), PRIMARY, "a primary file maps to the primary session");
  assert.strictEqual(owner(p("repo", "ws-alpha", "svc", "m.go")), ALPHA, "a worktree file maps to ITS session");
  assert.strictEqual(owner(p("repo", "ws-beta", "svc", "c.go")), BETA, "and so does the other worktree's");
  console.log("ok - each path is paired with the session that owns it");
}

// ── One sorted list, so stepping crosses worktree boundaries ────────────────
// Per-session runs would make alt+] walk all of ws-alpha before any of ws-beta,
// which is not the order the panel shows.
{
  const all = orderedPendingAcross([PRIMARY, ALPHA, BETA]).map((x) => x.filePath);
  assert.deepEqual(all, [...all].sort((a, b) => a.localeCompare(b)),
    "the union is sorted as one list, not concatenated per session");
  console.log("ok - the union is a single ordering, not per-session runs");
}

// ── Degenerate inputs ───────────────────────────────────────────────────────
{
  assert.deepEqual(orderedPendingAcross([]), [], "no scopes → nothing");
  const empty = { getSession: () => null, hasRealPendingChange: () => true } as unknown as SessionManager;
  assert.deepEqual(orderedPendingAcross([empty]), [], "a session that has not loaded yet contributes nothing");
  assert.equal(orderedPendingAcross([PRIMARY, empty]).length, 2, "and does not disturb the others");
  console.log("ok - empty and unloaded sessions are handled without throwing");
}

// ── A path claimed by two sessions resolves stably ──────────────────────────
// It should not happen, but a stale session file can claim a path that now
// belongs elsewhere; whichever wins must not vary between calls.
{
  const dup = p("repo", "ws-alpha", "svc", "m.go");
  const other = mgr([dup]);
  const a = orderedPendingAcross([ALPHA, other]);
  const b = orderedPendingAcross([ALPHA, other]);
  assert.equal(a.filter((x) => x.filePath === dup).length, 1, "the path appears once, not twice");
  assert.strictEqual(
    a.find((x) => x.filePath === dup)!.manager,
    b.find((x) => x.filePath === dup)!.manager,
    "and the same session wins on every call",
  );
  console.log("ok - a duplicated path appears once, resolved stably");
}
