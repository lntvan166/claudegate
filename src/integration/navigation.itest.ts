import * as assert from "assert";
import * as vscode from "vscode";
import { activateExtension, closeAllEditors, readSession, sessionRoots, waitFor } from "./helpers";

// FILE ORDER MATTERS. index.ts loads *.itest.js in directory order, and
// worktreeScopes.itest.ts ends by accepting EVERY pending file. Any suite that
// needs a populated pending set must sort before it — hence "navigation", which
// precedes "worktreeScopes". Appending to that file instead cost three runs.

// Next / Previous Pending and the auto-advance after a decision walked the
// PRIMARY session's list. On a workspace with nested worktrees that reached a
// small fraction of what was pending — measured on a real one, 27 of 224 files,
// with the other 197 unreachable by keyboard at all, and "all caught up"
// reported while they sat in the panel.
describe("pending navigation reaches worktree files", () => {
  const scopes = () =>
    vscode.commands.executeCommand<{ count: number; pending: string[] }>("claudegate._test.scopes");

  before(async () => {
    await activateExtension();
    await waitFor("the worktree registry to attach", async () => (await scopes()).count > 1);
  });

  after(async () => closeAllEditors());

  it("steps into files that live in a worktree, not just the primary session", async () => {
    // Ownership, not a path substring. The demo's PRIMARY session legitimately
    // contains ws-beta/go.work, so matching on "/ws-" was satisfied without ever
    // leaving the primary session — the first version of this test passed even
    // with navigation pinned to it.
    const [primaryRoot, ...worktreeRoots] = sessionRoots();
    const ownedByWorktree = new Set(
      worktreeRoots.flatMap((r) => Object.keys(readSession(r)?.files ?? {})),
    );
    const ownedByPrimary = new Set(Object.keys(readSession(primaryRoot)?.files ?? {}));

    const all = (await scopes()).pending;
    assert.ok(ownedByWorktree.size > 0, "precondition: some pending files belong to worktree sessions");
    assert.ok(ownedByPrimary.size > 0, "precondition: and some to the primary, so reaching both is the test");

    // Start from no open editors. An editor left behind by an earlier suite
    // would otherwise be counted as somewhere navigation took us — which it did
    // on the first version of this test, making it pass even with navigation
    // pinned to the primary session.
    await closeAllEditors();
    await new Promise((r) => setTimeout(r, 400));
    // Read into a local: asserting on vscode.window.activeTextEditor directly
    // narrows it to `undefined` for the rest of the block, and the loop below
    // then fails to typecheck.
    const editorBefore = vscode.window.activeTextEditor;
    assert.strictEqual(
      editorBefore, undefined,
      "no editor may be open before stepping, or the first reading is not ours",
    );

    // Walk the whole set and record every file navigation actually opens.
    const seen = new Set<string>();
    for (let i = 0; i < all.length + 2; i++) {
      await vscode.commands.executeCommand("claudegate.nextPending");
      await new Promise((r) => setTimeout(r, 300));
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (active) seen.add(active);
    }

    const reached = [...seen].filter((f) => ownedByWorktree.has(f));
    assert.ok(
      reached.length > 0,
      "Next Pending never reached a file owned by a worktree session. " +
        `Visited ${seen.size} of ${all.length}: ${[...seen].join(", ")}`,
    );
  });
});
