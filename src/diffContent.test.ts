import * as assert from "assert";
import * as path from "path";
import { ClaudeGateContentProvider, originalUri } from "./diffProvider";
import type { SessionManager } from "./sessionManager";

// The left-hand side of a Claude Gate diff. What this returns IS what the user
// reads, so the new-file case is worth pinning: it used to inject
// "// New file — no original content", which rendered as syntax-highlighted
// content in the file's own language (and `//` is not a comment in YAML, Python
// or shell), showed up as a REMOVED line so a brand-new file looked like it had
// deleted something, and made line 1 of the real content diff as *changed*
// rather than added.

const NEW = path.join(path.sep, "repo", "created.yaml");
const EDIT = path.join(path.sep, "repo", "edited.ts");

function providerWith(files: Record<string, unknown>): ClaudeGateContentProvider {
  const mgr = {
    onSessionChange: () => ({ dispose() {} }),
    getSession: () => ({ files, accepted: [], rejected: {} }),
  } as unknown as SessionManager;
  return new ClaudeGateContentProvider(mgr);
}

const entry = (originalContent: string | null) => ({
  originalContent, reviewStatus: "pending", sessionId: "s", capturedAt: "2026-09-23T00:00:00.000Z",
});

// ── A created file's baseline is the empty document ─────────────────────────
{
  const p = providerWith({ [NEW]: entry(null) });
  const content = p.provideTextDocumentContent(originalUri(NEW) as never);
  assert.strictEqual(content, "",
    "a file with no baseline must diff against nothing, so every line reads as an addition");
  assert.ok(!content.includes("//"),
    "no placeholder comment: `//` is not a comment in YAML, Python or shell, and it rendered as content");
  console.log("ok - a created file's left-hand side is the empty document, not a placeholder line");
}

// ── An edited file still gets its real baseline ─────────────────────────────
{
  const p = providerWith({ [EDIT]: entry("line one\nline two\n") });
  assert.strictEqual(
    p.provideTextDocumentContent(originalUri(EDIT) as never),
    "line one\nline two\n",
    "an edited file diffs against the frozen baseline, unchanged",
  );
  console.log("ok - an edited file still diffs against its frozen baseline");
}

// ── A file the session knows nothing about yields empty, never a throw ──────
// The provider is asked for any claudegate: URI the editor still has open,
// including one whose entry was just accepted out from under it.
{
  const p = providerWith({});
  assert.strictEqual(
    p.provideTextDocumentContent(originalUri(EDIT) as never), "",
    "an unknown path resolves to empty rather than throwing at the user",
  );
  console.log("ok - an unknown path yields the empty document instead of throwing");
}

// ── An empty-string baseline is NOT the same as no baseline ────────────────
// Claude emptying an existing file must still diff as a deletion, not look like
// a creation. Both now return "", but for different reasons — this pins that the
// edited path is reached rather than falling through to the null branch.
{
  const p = providerWith({ [EDIT]: entry("") });
  assert.strictEqual(p.provideTextDocumentContent(originalUri(EDIT) as never), "",
    "an existing-but-empty file also has an empty baseline");
  console.log("ok - an empty baseline and a missing baseline both render empty");
}
