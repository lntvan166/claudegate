import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import {
  FilteredTreeProvider,
  FolderItem,
  FileReviewItem,
  WorktreeGroupItem,
  SessionItem,
  samePath,
} from "./reviewPanel";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

// FilteredTreeProvider.chainTo() / getParent() back TreeView.reveal(): opening a
// pending file in a normal editor scrolls its Pending row into view. reveal() is
// unusable without getParent(), and getParent() here is DERIVED by walking
// getChildren() from the root rather than reimplementing the tree's shape — so
// the thing worth testing is that the derived chain matches what each rendering
// mode actually produces. Every mode the panel can be in gets a case.

const fakeLog = { appendLine() {} } as unknown as import("vscode").OutputChannel;

function md5(s: string): string {
  const resolved = path.resolve(s);
  return crypto
    .createHash("md5")
    .update(process.platform === "win32" ? resolved.toLowerCase() : resolved)
    .digest("hex");
}

function writeSession(home: string, wsPath: string, files: Record<string, unknown>): void {
  const sp = path.join(home, ".claudegate", "sessions", md5(wsPath) + ".json");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(
    sp,
    JSON.stringify({ sessionId: "t", status: "active", files, accepted: [], rejected: {} })
  );
}

function pendingEntry(sessionId: string): Record<string, unknown> {
  return {
    originalContent: "base",
    reviewStatus: "pending",
    newFile: false,
    sessionId,
    capturedAt: new Date().toISOString(),
  };
}

// Workspace with src/api/handler.ts, src/routes.ts and README.md all pending.
function makeFixture(): { home: string; root: string; handler: string; readme: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revealhome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revealroot-"));
  const handler = path.join(root, "src", "api", "handler.ts");
  const routes = path.join(root, "src", "routes.ts");
  const readme = path.join(root, "README.md");
  for (const f of [handler, routes, readme]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "changed by claude");
  }
  writeSession(home, root, {
    [handler]: pendingEntry("s1"),
    [routes]: pendingEntry("s1"),
    [readme]: pendingEntry("s2"),
  });
  return { home, root, handler, readme };
}

function labels(chain: import("vscode").TreeItem[]): string[] {
  return chain.map((i) => String(i.label));
}

void (async () => {

// ── samePath: exact always; case-folded only where the platform is ────────────
{
  assert.ok(samePath("/a/B.ts", "/a/B.ts", false), "identical paths match");
  assert.ok(!samePath("/a/B.ts", "/a/b.ts", false), "case-sensitive platform: case matters");
  assert.ok(samePath("/a/B.ts", "/a/b.ts", true), "win32: drive/segment case folded (fileEntryFor parity)");
  console.log("ok - samePath folds case only on case-insensitive platforms");
}

// ── Tree mode: chain is root folder → subfolder → file ───────────────────────
// The reveal target is three levels deep; every intermediate FolderItem must be
// on the chain or VS Code cannot expand down to the row.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { root, handler } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  const mgr = new SessionManager(fakeLog, root);
  mgr.startWatching();
  const provider = new FilteredTreeProvider(mgr, "pending", "tree");

  const chain = provider.chainTo(handler);
  assert.deepEqual(labels(chain), ["src", "api", "handler.ts"], "full folder chain down to the leaf");
  assert.ok(chain[0] instanceof FolderItem, "intermediate nodes are FolderItems");
  const leaf = chain[chain.length - 1] as FileReviewItem;
  assert.ok(leaf instanceof FileReviewItem, "leaf is the pending file row");
  assert.equal(leaf.filePath, handler, "leaf carries the target path");

  // getParent must agree with the chain, walking all the way back to the root.
  assert.equal(String(provider.getParent(leaf)?.label), "api", "getParent(leaf) = its folder");
  assert.equal(String(provider.getParent(chain[1])?.label), "src", "getParent(folder) = parent folder");
  assert.equal(provider.getParent(chain[0]), undefined, "top-level node has no parent");
  mgr.stopWatching();
  console.log("ok - tree mode: chainTo/getParent walk the full folder chain");
}

// ── A file with no pending row yields an empty chain, not a throw ────────────
// The caller reveals chain[chain.length-1]; an absent row must degrade to "do
// nothing" rather than reveal the wrong node or blow up the editor listener.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { root } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const mgr = new SessionManager(fakeLog, root);
  mgr.startWatching();
  const provider = new FilteredTreeProvider(mgr, "pending", "tree");

  assert.deepEqual(provider.chainTo(path.join(root, "src", "nope.ts")), [], "unknown file → empty chain");
  mgr.stopWatching();
  console.log("ok - a file with no pending row yields an empty chain");
}

// ── List mode: the row is top-level, so the chain is just the leaf ───────────
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { root, handler } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const mgr = new SessionManager(fakeLog, root);
  mgr.startWatching();
  const provider = new FilteredTreeProvider(mgr, "pending", "list");

  const chain = provider.chainTo(handler);
  assert.equal(chain.length, 1, "flat list → no ancestors");
  assert.equal((chain[0] as FileReviewItem).filePath, handler, "chain is the row itself");
  assert.equal(provider.getParent(chain[0]), undefined, "top-level row has no parent");
  mgr.stopWatching();
  console.log("ok - list mode: chain is the row itself, with no parent");
}

// ── Group-by-session: the session bucket is on the chain ────────────────────
// A session bucket carries no path, so the walk cannot prune by prefix and must
// descend into it. This is the branch a prefix-only getParent would get wrong.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { root, handler } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const realGetConfiguration = stubWorkspace.getConfiguration;
  stubWorkspace.getConfiguration = ((_section?: string) => ({
    get: <T>(key: string, def?: T): T | undefined =>
      (key === "groupBySession" ? (true as unknown as T) : def),
  })) as typeof stubWorkspace.getConfiguration;
  try {
    const mgr = new SessionManager(fakeLog, root);
    mgr.startWatching();
    const provider = new FilteredTreeProvider(mgr, "pending", "tree");

    const chain = provider.chainTo(handler);
    assert.ok(chain[0] instanceof SessionItem, "chain starts at the session bucket");
    assert.deepEqual(labels(chain).slice(1), ["src", "api", "handler.ts"], "folders then the leaf");
    assert.equal(
      provider.getParent(chain[1]),
      chain[0],
      "the top folder's parent is the session bucket, not the root"
    );
    mgr.stopWatching();
    console.log("ok - group-by-session: the session bucket is on the chain");
  } finally {
    stubWorkspace.getConfiguration = realGetConfiguration;
  }
}

// ── Worktree: a file inside a nested worktree chains through its group node ──
// Worktree rows live in the worktree's OWN session, reached via a group node.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revealwthome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-revealwtroot-"));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws-feature"), { recursive: true });
  const ws = path.join(root, "ws-feature");
  fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws-feature", "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "ws-feature")}\n`);
  const wtFile = path.join(ws, "lib", "util.ts");
  fs.writeFileSync(wtFile, "changed by claude");
  writeSession(home, ws, { [wtFile]: pendingEntry("s1") });
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  const registry = new WorktreeSessionRegistry(fakeLog, root);
  await registry.refresh({ force: true });
  const provider = new FilteredTreeProvider(primary, "pending", "tree", registry);

  const chain = provider.chainTo(wtFile);
  const group = chain.find((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem | undefined;
  assert.ok(group, "the worktree group node is on the chain");
  assert.equal(group.worktreeRoot, path.resolve(ws), "group points at the worktree root");
  const leaf = chain[chain.length - 1] as FileReviewItem;
  assert.equal(leaf.filePath, wtFile, "leaf is the worktree's pending file");
  assert.equal(String(leaf.label), "util.ts", "leaf label");
  assert.equal(String(provider.getParent(leaf)?.label), "lib", "leaf's parent is its folder inside the worktree");
  console.log("ok - worktree: chain descends through the worktree group node");

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });

}

stubWorkspace.workspaceFolders = undefined;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
