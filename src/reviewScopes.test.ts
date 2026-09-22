import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { reviewScopes, countAcceptedAcross, countRejectedAcross, pendingAcross } from "./reviewScopes";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

// The Accepted/Rejected panels render records from the primary session AND from
// every attached worktree session, and their view-gating counts already include
// worktrees (WorktreeSessionRegistry.totalAccepted/totalRejected). The title-bar
// bulk actions — Clear Accepted, Clear Rejected, Revert All, Re-apply All — used
// only the PRIMARY manager, so a record living in a worktree was displayed and
// counted but never acted on: with an empty primary the commands' `count === 0`
// early return fired and the button did nothing at all, silently.

const fakeLog = { appendLine() {} } as unknown as import("vscode").OutputChannel;

function md5(s: string): string {
  const r = path.resolve(s);
  return crypto.createHash("md5")
    .update(process.platform === "win32" ? r.toLowerCase() : r).digest("hex");
}

function writeSession(home: string, wsPath: string, body: Record<string, unknown>): void {
  const sp = path.join(home, ".claudegate", "sessions", md5(wsPath) + ".json");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ sessionId: "t", status: "active", files: {}, accepted: [], rejected: {}, ...body }));
}

function record(filePath: string): Record<string, unknown> {
  return {
    id: "2026-09-21T00:00:00.000Z::" + filePath,
    path: filePath,
    before: "original\n",
    after: "claude\n",
    decidedAt: "2026-09-21T00:00:00.000Z",
    sessionId: "s1",
  };
}

void (async () => {
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-scopehome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-scoperoot-"));

  // A nested worktree holding the only decision records anywhere.
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws-feature"), { recursive: true });
  const ws = path.join(root, "ws-feature");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws-feature", "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "ws-feature")}\n`);
  const acceptedFile = path.join(ws, "accepted.go");
  const rejectedFile = path.join(ws, "rejected.go");
  fs.writeFileSync(acceptedFile, "claude\n");
  fs.writeFileSync(rejectedFile, "original\n");

  writeSession(home, root, {});                       // primary: EMPTY — the trigger
  writeSession(home, ws, {
    accepted: [record(acceptedFile)],
    rejected: { [rejectedFile]: record(rejectedFile) },
  });

  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  const registry = new WorktreeSessionRegistry(fakeLog, root);
  await registry.refresh({ force: true });

  // ── The scope set is primary + every attached worktree ──────────────────────
  {
    const scopes = reviewScopes(primary, registry);
    assert.equal(scopes.length, 2, "primary plus the one attached worktree");
    assert.equal(scopes[0], primary, "primary comes first");
    console.log("ok - reviewScopes spans the primary session and every worktree");
  }

  // ── Counts match what the panel actually shows ──────────────────────────────
  {
    const scopes = reviewScopes(primary, registry);
    assert.equal(primary.getAcceptedCount(), 0, "precondition: primary has no accepted records");
    assert.equal(countAcceptedAcross(scopes), 1, "the worktree's accepted record is counted");
    assert.equal(countRejectedAcross(scopes), 1, "the worktree's rejected record is counted");
    console.log("ok - counts include worktree records (so the button is not a silent no-op)");
  }

  // ── THE BUG: clearing must actually clear the worktree's records ───────────
  {
    const scopes = reviewScopes(primary, registry);
    for (const m of scopes) m.clearAccepted();
    assert.equal(countAcceptedAcross(reviewScopes(primary, registry)), 0,
      "Clear Accepted removes the worktree's record, not just the primary's");

    for (const m of scopes) m.clearRejected();
    assert.equal(countRejectedAcross(reviewScopes(primary, registry)), 0,
      "Clear Rejected removes the worktree's record too");
    console.log("ok - clearing fans out to worktree sessions");
  }

  // ── Pending fans out too: Accept All / Reject All must see worktree files ──
  // The pending badge already sums worktreeRegistry.totalPending(), so a
  // primary-only Accept All accepted a subset of what the panel showed — and with
  // pending only inside a worktree, returned early and did nothing.
  {
    const wtPending = path.join(ws, "pending.go");
    fs.writeFileSync(wtPending, "claude\n");
    writeSession(home, ws, {
      files: { [wtPending]: { originalContent: "original\n", reviewStatus: "pending",
                              newFile: false, sessionId: "s1",
                              capturedAt: new Date().toISOString() } },
    });
    const reg2 = new WorktreeSessionRegistry(fakeLog, root);
    await reg2.refresh({ force: true });
    const scopes = reviewScopes(primary, reg2);

    assert.equal(primary.getPendingCount(), 0, "precondition: primary has no pending files");
    const found = pendingAcross(scopes);
    assert.equal(found.length, 1, "the worktree's pending file is in scope");
    assert.equal(found[0].filePath, wtPending, "and is reported by path");
    assert.notEqual(found[0].manager, primary,
      "paired with the worktree's OWN manager, not the primary (accept/reject need the owner)");
    reg2.dispose();
    console.log("ok - pendingAcross reaches worktree pending files, with their owning manager");
  }

  // ── A missing registry degrades to primary-only, never throws ──────────────
  {
    const scopes = reviewScopes(primary, undefined);
    assert.deepEqual(scopes, [primary], "no registry → just the primary session");
    assert.deepEqual(pendingAcross([primary]), [], "and pendingAcross over it is empty, not a throw");
    console.log("ok - reviewScopes tolerates an absent registry");
  }

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = undefined;
})().catch((err) => { console.error(err); process.exit(1); });
