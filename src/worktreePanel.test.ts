import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import { FilteredTreeProvider, WorktreeGroupItem } from "./reviewPanel";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher, setProtectedMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

// Integration test for the Pending panel's rendering of a nested git worktree.
// It drives the REAL FilteredTreeProvider + WorktreeSessionRegistry over on-disk
// session files and a synthetic-but-faithful worktree layout (a `.git` DIR main
// repo with `.git/worktrees/<name>/gitdir`, and the worktree's `.git` FILE) — no
// `git` binary, matching the hermetic style of worktrees.test.ts. This covers the
// tree-producing code that only had typecheck coverage before.

const fakeLog = { appendLine() {} } as unknown as import("vscode").OutputChannel;

function md5(s: string): string {
  return crypto.createHash("md5").update(path.resolve(s)).digest("hex");
}

function writeSession(home: string, wsPath: string, files: Record<string, unknown>): void {
  const sp = path.join(home, ".claudegate", "sessions", md5(wsPath) + ".json");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ sessionId: "t", status: "active", files, accepted: [], rejected: {} }));
}

// Build a main repo at <root> with a nested worktree <root>/ws-feature.
function makeFixture(): { home: string; root: string; ws: string; wsFile: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guihome-"));
  process.env.HOME = home; // SessionManager reads os.homedir() → $HOME on POSIX
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guiroot-"));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws-feature"), { recursive: true }); // .git is a DIR (main repo)
  const ws = path.join(root, "ws-feature");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws-feature", "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "ws-feature")}\n`);
  const wsFile = path.join(ws, "x.txt");
  fs.writeFileSync(wsFile, "changed by claude");
  return { home, root, ws, wsFile };
}

// ── Case 1: PRIMARY session null (all edits in the worktree) — the Critical ──
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { home, root, ws, wsFile } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }]; // worktree files are under root → in-workspace
  writeSession(home, ws, {
    [wsFile]: { originalContent: "base", reviewStatus: "pending", newFile: false, sessionId: "s1", capturedAt: new Date().toISOString() },
  });

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  assert.equal(primary.getSession(), null, "precondition: primary session is null (no primary session file)");

  const registry = new WorktreeSessionRegistry(fakeLog, root);
  registry.refresh();
  const provider = new FilteredTreeProvider(primary, "pending", "tree", registry);

  const roots = provider.getChildren();
  const groups = roots.filter((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem[];
  assert.equal(groups.length, 1, "exactly one worktree group renders despite a null primary session");
  const g = groups[0];
  assert.equal(g.worktreeRoot, path.resolve(ws), "group carries the worktree root (used by Open-Worktree-Window)");
  assert.equal(String(g.label), "ws-feature (worktree)", "group label");
  assert.equal(String(g.description), "1 pending", "group shows the pending count");
  assert.equal(g.contextValue, "claudegate.worktreeGroup", "contextValue drives the inline menu (package.json when-clause)");

  const children = provider.getChildren(g) as unknown as Array<{ filePath: string; command: { arguments: unknown[] } }>;
  assert.equal(children.length, 1, "group expands to its one pending file");
  assert.equal(children[0].filePath, wsFile, "child is the worktree's pending file");
  assert.equal(children[0].command.arguments[1], registry.managerFor(wsFile), "row bound to the WORKTREE's SessionManager (openDiff/accept resolve there)");

  assert.equal(registry.totalPending(), 1, "badge count includes the worktree pending file");
  assert.ok(registry.managerFor(wsFile), "managerFor resolves a worktree file");
  assert.equal(registry.managerFor(path.join(root, "src", "z.ts")), null, "managerFor returns null for a non-worktree file");

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktree group + children + badge render when the primary session is null");
}

// ── Case 2: primary has its own pending file too — both render, group appended last ──
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { home, root, ws, wsFile } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  writeSession(home, ws, {
    [wsFile]: { originalContent: "base", reviewStatus: "pending", newFile: false, sessionId: "s1", capturedAt: new Date().toISOString() },
  });
  const primaryFile = path.join(root, "p.txt");
  fs.writeFileSync(primaryFile, "claude edit");
  writeSession(home, root, {
    [primaryFile]: { originalContent: "old", reviewStatus: "pending", newFile: false, sessionId: "s0", capturedAt: new Date().toISOString() },
  });

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  assert.ok(primary.getSession(), "precondition: primary session loaded");

  const registry = new WorktreeSessionRegistry(fakeLog, root);
  registry.refresh();
  const provider = new FilteredTreeProvider(primary, "pending", "tree", registry);

  const roots = provider.getChildren();
  const primaryRows = roots.filter((i) => !(i instanceof WorktreeGroupItem));
  const groups = roots.filter((i) => i instanceof WorktreeGroupItem);
  assert.ok(primaryRows.length >= 1, "primary pending row(s) present");
  assert.equal(groups.length, 1, "worktree group present alongside primary rows");
  assert.equal(roots.indexOf(groups[0]), roots.length - 1, "worktree group is appended after primary items");
  assert.equal(registry.totalPending(), 1, "totalPending counts only worktree files");

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - primary rows and worktree group coexist (group appended last)");
}

// ── Case 3: Accepted/Rejected panels must NOT show worktree groups (pending-only) ──
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const { home, root, ws, wsFile } = makeFixture();
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];
  writeSession(home, ws, {
    [wsFile]: { originalContent: "base", reviewStatus: "pending", newFile: false, sessionId: "s1", capturedAt: new Date().toISOString() },
  });

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  const registry = new WorktreeSessionRegistry(fakeLog, root);
  registry.refresh();

  for (const status of ["accepted", "rejected"] as const) {
    const provider = new FilteredTreeProvider(primary, status, "tree", registry);
    const groups = provider.getChildren().filter((i) => i instanceof WorktreeGroupItem);
    assert.equal(groups.length, 0, `${status} panel shows no worktree group (pending-only)`);
  }

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktree groups are pending-only (absent from Accepted/Rejected)");
}

// Reset shared stub state so later test bundles start clean.
stubWorkspace.workspaceFolders = undefined;
