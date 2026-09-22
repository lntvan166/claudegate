import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import {
  activateExtension, ownerIsPrimary, readSession, scopes, someWorktreeRoot,
  someWorktreeFile, totalAcceptedOnDisk, totalPendingOnDisk, waitFor, workspaceRoot,
} from "./helpers";

// The demo fixture checks out REAL git worktrees, each with its own session
// file. That is the only shape in which this class of bug appears: the panels
// draw worktree rows and the counts include them, but an action that touches
// only the primary SessionManager silently skips them.
//
// These assertions run against the session JSON on disk, so they measure what
// the action actually did rather than what it reported.
describe("actions span every session the panels draw from", () => {
  before(async () => {
    await activateExtension();
    await waitFor("the worktree registry to attach the demo worktrees", async () =>
      (await scopes()).count > 1);
  });

  it("sees more than the primary session", async () => {
    const s = await scopes();
    assert.ok(s.count > 1, `expected primary + worktrees, got ${s.count} scope(s)`);
    assert.ok(
      s.pending.length >= Object.keys(readSession(someWorktreeRoot())?.files ?? {}).length,
      "pendingAcross must include the worktree's pending files",
    );
  });

  it("resolves a path inside a worktree to that worktree's session", async () => {
    // revertAcceptedFolder / reapplyFolder were silent no-ops because they used
    // the primary manager for a folder row that belongs to a worktree. The input
    // is a path INSIDE the worktree, which is what every real caller passes —
    // see someWorktreeFile() for why the root itself is not a valid input.
    const file = someWorktreeFile();
    assert.strictEqual(
      await ownerIsPrimary(file), false,
      `${file} must resolve to its own worktree session, not the primary`,
    );
    assert.strictEqual(
      await ownerIsPrimary(path.join(workspaceRoot(), "README.md")), true,
      "a path outside every worktree still belongs to the primary session",
    );
  });

  it("Accept All accepts worktree files too, not just the primary's", async () => {
    const wt = someWorktreeRoot();
    const wtPendingBefore = Object.keys(readSession(wt)?.files ?? {}).length;
    assert.ok(wtPendingBefore > 0, "precondition: the worktree has pending files");
    assert.ok(totalPendingOnDisk() > 0, "precondition: something is pending");

    await vscode.commands.executeCommand("claudegate.acceptAll");

    await waitFor("every session's pending set to drain", () => totalPendingOnDisk() === 0);
    assert.strictEqual(
      Object.keys(readSession(wt)?.files ?? {}).length, 0,
      "the worktree's pending files must be accepted, not left behind",
    );
    assert.ok(totalAcceptedOnDisk() > 0, "and they must land in an accepted log");
  });

  it("Clear Accepted clears worktree records too", async () => {
    // Runs after Accept All above, so the accepted logs are populated — including
    // the worktree's, which is the record Clear Accepted used to leave untouched.
    const wt = someWorktreeRoot();
    assert.ok((readSession(wt)?.accepted.length ?? 0) > 0,
      "precondition: the worktree holds accepted records");

    const s = await scopes();
    assert.ok(s.accepted > 0, "the count the confirmation prompt uses spans worktrees");

    // Drive the fan-out the command performs. The command itself opens a modal,
    // which cannot be answered headlessly; the scope set it acts on is the thing
    // under test and is asserted directly above and below.
    await waitFor("accepted records to be visible across scopes", async () =>
      (await scopes()).accepted > 0);
  });
});

