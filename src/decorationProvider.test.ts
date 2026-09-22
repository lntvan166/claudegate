import * as assert from "assert";
import * as path from "path";
import { ClaudeGateDecorationProvider, isNewFile } from "./decorationProvider";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { Uri } from "./test-stubs/vscode";
import type { SessionManager } from "./sessionManager";

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
