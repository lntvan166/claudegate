import * as assert from "assert";
import * as path from "path";
import { ClaudeGateDecorationProvider, isNewFile } from "./decorationProvider";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { Uri } from "./test-stubs/vscode";
import type { SessionManager } from "./sessionManager";
import type { WorktreeSessionRegistry } from "./worktreeSessionRegistry";

// Until this split, every pending file got gitDecoration.modifiedResourceForeground
// — including files Claude had CREATED. That overpainted the untracked-green git
// gives a new file, so "Claude wrote this from scratch" and "Claude edited this"
// looked identical in both the Pending panel and the Explorer. On a real backlog
// that was 264 of 391 rows mislabelled.

const NEW  = path.join(path.sep, "repo", "created.go");
const EDIT = path.join(path.sep, "repo", "edited.go");

function providerWith(files: Record<string, unknown>): ClaudeGateDecorationProvider {
  const mgr = {
    onSessionChange: () => ({ dispose() {} }),
    getSession: () => ({ files }),
  } as unknown as SessionManager;
  return new ClaudeGateDecorationProvider(mgr);
}

const entry = (originalContent: string | null) => ({
  originalContent, reviewStatus: "pending", sessionId: "s", capturedAt: "2026-09-21T00:00:00.000Z",
});

// ── isNewFile is the single predicate both the colour and the tooltip read ────
{
  assert.strictEqual(isNewFile({ originalContent: null }), true, "null baseline → Claude created it");
  assert.strictEqual(isNewFile({ originalContent: "" }), false,
    "an EMPTY baseline is an edited empty file, not a new one — null is the only new-file marker");
  assert.strictEqual(isNewFile({ originalContent: "x" }), false, "a baseline means it existed");
  console.log("ok - isNewFile treats only a null baseline as new (empty string is not null)");
}

// ── A created file gets git's untracked colour, an edited one git's modified ──
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const p = providerWith({ [NEW]: entry(null), [EDIT]: entry("before\n") });

  const dNew  = p.provideFileDecoration(Uri.file(NEW) as never);
  const dEdit = p.provideFileDecoration(Uri.file(EDIT) as never);
  assert.ok(dNew && dEdit, "both pending files are decorated");

  assert.strictEqual(
    (dNew!.color as unknown as { id: string }).id,
    "gitDecoration.untrackedResourceForeground",
    "a Claude-created file uses git's UNTRACKED colour, agreeing with git rather than overriding it",
  );
  assert.strictEqual(
    (dEdit!.color as unknown as { id: string }).id,
    "gitDecoration.modifiedResourceForeground",
    "an edited file keeps git's MODIFIED colour",
  );
  assert.notStrictEqual(
    (dNew!.color as unknown as { id: string }).id,
    (dEdit!.color as unknown as { id: string }).id,
    "the two must differ — that difference is the whole feature",
  );
  console.log("ok - created vs edited files carry git's own untracked/modified colours");
}

// ── The badge stays "!" for both ────────────────────────────────────────────
// CLAUDE.md: only pending files get a badge, and it must not collide with git's
// own A/R letters. A new-file badge of "A" would do exactly that.
{
  const p = providerWith({ [NEW]: entry(null), [EDIT]: entry("before\n") });
  assert.strictEqual(p.provideFileDecoration(Uri.file(NEW) as never)!.badge, "!", "new file badge");
  assert.strictEqual(p.provideFileDecoration(Uri.file(EDIT) as never)!.badge, "!", "edited file badge");
  console.log("ok - the badge stays '!' for both, so it cannot collide with git's A/R");
}

// ── Tooltips distinguish them ───────────────────────────────────────────────
{
  const p = providerWith({ [NEW]: entry(null), [EDIT]: entry("before\n") });
  assert.match(String(p.provideFileDecoration(Uri.file(NEW) as never)!.tooltip), /new file/,
    "the new-file tooltip says so, for anyone who cannot rely on colour");
  assert.doesNotMatch(String(p.provideFileDecoration(Uri.file(EDIT) as never)!.tooltip), /new file/);
  console.log("ok - tooltips name the new-file case, so colour is not the only signal");
}

// ── A file with no pending entry is undecorated ─────────────────────────────
{
  const p = providerWith({ [EDIT]: entry("before\n") });
  assert.strictEqual(
    p.provideFileDecoration(Uri.file(path.join(path.sep, "repo", "untouched.go")) as never),
    undefined,
    "files ClaudeGate knows nothing about must stay undecorated",
  );
  console.log("ok - a file with no pending entry is left undecorated");
}

// ── A pending file inside a WORKTREE is decorated ───────────────────────────
// This provider read the primary session alone, and a worktree's pending files
// are never in there — they live in the worktree's own session file (verified
// against real data: zero path overlap between a worktree session and its
// parent's). Every one of them fell through the `!entry` guard and came back
// undecorated: no badge, no colour, anywhere in the Explorer. Silent for most
// people, because an undecorated file just looks normal; visible only to someone
// whose worktree parent is gitignored, where git's ignored-grey filled the gap.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());

  const WT_ROOT = path.join(path.sep, "repo", "ws-alpha", "service-api");
  const WT_FILE = path.join(WT_ROOT, "handler.go");

  // The primary session knows nothing about the worktree's file — the shape the
  // bug depended on.
  const primary = {
    onSessionChange: () => ({ dispose() {} }),
    getSession: () => ({ files: { [EDIT]: entry("before\n") } }),
  } as unknown as SessionManager;

  const worktreeMgr = {
    onSessionChange: () => ({ dispose() {} }),
    getSession: () => ({ files: { [WT_FILE]: entry(null) } }),
  } as unknown as SessionManager;

  const registry = {
    onChange: () => ({ dispose() {} }),
    managerFor: (fp: string) => (fp.startsWith(WT_ROOT + path.sep) ? worktreeMgr : null),
  } as unknown as WorktreeSessionRegistry;

  const withRegistry = new ClaudeGateDecorationProvider(primary, registry);
  const d = withRegistry.provideFileDecoration(Uri.file(WT_FILE) as never);
  assert.ok(d, "a pending file inside a worktree must be decorated");
  assert.strictEqual(d!.badge, "!", "it gets the pending badge like any other file");
  assert.strictEqual(
    (d!.color as unknown as { id: string }).id,
    "gitDecoration.untrackedResourceForeground",
    "and the right colour for a file Claude created inside that worktree",
  );

  // The primary's own files still resolve through the primary.
  const dPrimary = withRegistry.provideFileDecoration(Uri.file(EDIT) as never);
  assert.strictEqual(
    (dPrimary!.color as unknown as { id: string }).id,
    "gitDecoration.modifiedResourceForeground",
    "a file outside every worktree still resolves against the primary session",
  );

  // And the regression itself: without a registry, that same file is invisible.
  const withoutRegistry = new ClaudeGateDecorationProvider(primary);
  assert.strictEqual(
    withoutRegistry.provideFileDecoration(Uri.file(WT_FILE) as never),
    undefined,
    "no registry → the worktree file is undecorated (this was the bug)",
  );
  console.log("ok - a pending file inside a worktree is decorated via its own session");
}

// ── An unknown path falls back to the primary, never throws ─────────────────
{
  const primary = {
    onSessionChange: () => ({ dispose() {} }),
    getSession: () => ({ files: {} }),
  } as unknown as SessionManager;
  const registry = {
    onChange: () => ({ dispose() {} }),
    managerFor: () => null,
  } as unknown as WorktreeSessionRegistry;
  const p = new ClaudeGateDecorationProvider(primary, registry);
  assert.strictEqual(
    p.provideFileDecoration(Uri.file(path.join(path.sep, "elsewhere", "x.go")) as never),
    undefined,
    "managerFor returning null falls back to the primary, which knows nothing",
  );
  console.log("ok - a path owned by no worktree falls back to the primary session");
}

// ── The full-Explorer invalidation is coalesced ─────────────────────────────
// Firing `undefined` invalidates EVERY decoration in the Explorer, and a session
// change arrives at least twice per decision (persist, then the fs.watch reload
// that write triggers). Uncoalesced, a multi-file accept repainted the whole
// Explorer several times over. Every other consumer of this burst already
// collapses it; this one did not.
void (async () => {
  let fires = 0;
  const listeners: Array<() => void> = [];
  const mgr = {
    onSessionChange: (cb: () => void) => { listeners.push(cb); return { dispose() {} }; },
    getSession: () => ({ files: {} }),
  } as unknown as SessionManager;

  const p = new ClaudeGateDecorationProvider(mgr);
  p.onDidChangeFileDecorations(() => { fires++; });

  // A burst, as one multi-file accept produces.
  for (let i = 0; i < 6; i++) listeners.forEach((l) => l());
  assert.strictEqual(fires, 0, "nothing fires synchronously inside the burst");

  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(fires, 1, `a burst of 6 changes must repaint once, got ${fires}`);

  // A later, separate change still repaints — coalescing must not swallow it.
  listeners.forEach((l) => l());
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(fires, 2, "a later change still repaints");

  p.dispose();
  console.log("ok - a burst of session changes invalidates the Explorer once, not once each");
})().catch((err) => { console.error(err); process.exit(1); });
