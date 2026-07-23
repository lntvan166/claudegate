import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import { FilteredTreeProvider, WorktreeGroupItem, FolderItem, FileReviewItem } from "./reviewPanel";
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
  const resolved = path.resolve(s);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return crypto.createHash("md5").update(normalized).digest("hex");
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
  process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not $HOME
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

// Register a git worktree working dir at <root>/<relPath> against the main repo's
// `.git`, and drop a single pending file inside it. `relPath` may be nested
// (e.g. "ws-alpha/service-core"), mirroring the go.work layout where worktrees
// are checked out under per-feature `ws-*` directories.
function addWorktree(home: string, root: string, relPath: string, fileName: string): string {
  const name = relPath.split(path.posix.sep).join("-"); // unique registry entry under .git/worktrees
  fs.mkdirSync(path.join(root, ".git", "worktrees", name), { recursive: true });
  const ws = path.join(root, ...relPath.split(path.posix.sep));
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", name, "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", name)}\n`);
  const wsFile = path.join(ws, fileName);
  fs.writeFileSync(wsFile, "changed by claude");
  writeSession(home, ws, {
    [wsFile]: { originalContent: "base", reviewStatus: "pending", newFile: false, sessionId: "s1", capturedAt: new Date().toISOString() },
  });
  return wsFile;
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
  // accept/rejectWorktree read item.sessionManager + item.worktreeRoot off the row.
  assert.equal(g.sessionManager, registry.managerFor(wsFile), "group exposes the WORKTREE's manager (accept/rejectWorktree target it)");

  const children = provider.getChildren(g) as unknown as Array<{ filePath: string; sessionManager: unknown }>;
  assert.equal(children.length, 1, "group expands to its one pending file");
  assert.equal(children[0].filePath, wsFile, "child is the worktree's pending file");
  // The row carries the WORKTREE's SessionManager; the pending panel's
  // onDidChangeSelection handler passes it straight to openDiff so the diff
  // resolves against the worktree session (not the primary one).
  assert.equal(children[0].sessionManager, registry.managerFor(wsFile), "row bound to the WORKTREE's SessionManager (openDiff resolves there)");

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
  // ws-feature sits directly under root (its parent IS the workspace root), so it
  // stays a top-level row — but ordering is now folders → worktrees → files, so the
  // group renders BEFORE the primary p.txt file, not appended last.
  const pIdx = roots.findIndex((i) => !(i instanceof WorktreeGroupItem));
  assert.ok(roots.indexOf(groups[0]) < pIdx, "worktree group renders before primary file rows");
  assert.equal(registry.totalPending(), 1, "totalPending counts only worktree files");

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - primary rows and worktree group coexist (group before files)");
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

// ── Case 4: worktrees NEST under their owning folder in tree mode (go.work layout) ──
// A worktree checked out at <root>/ws-alpha/service-core must appear UNDER a
// `ws-alpha` folder node — not as a bare top-level "service-core (worktree)" row
// disconnected from ws-alpha. Intermediate folders are created even when no
// primary-session file lives directly under them (ws-beta).
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guihome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guiroot-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true }); // main repo (.git DIR)
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  const coreFile = addWorktree(home, root, "ws-alpha/service-core", "bootstrap.go");
  const apiFile = addWorktree(home, root, "ws-beta/service-api", "es.go");
  // A primary-session file living directly under ws-alpha (like go.work).
  const goWork = path.join(root, "ws-alpha", "go.work");
  fs.writeFileSync(goWork, "go 1.22");
  writeSession(home, root, {
    [goWork]: { originalContent: "old", reviewStatus: "pending", newFile: false, sessionId: "s0", capturedAt: new Date().toISOString() },
  });

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  const registry = new WorktreeSessionRegistry(fakeLog, root);
  registry.refresh();
  const provider = new FilteredTreeProvider(primary, "pending", "tree", registry);

  const roots = provider.getChildren();
  // No worktree group floats at the top level anymore — they nest under folders.
  assert.equal(
    roots.filter((i) => i instanceof WorktreeGroupItem).length, 0,
    "no worktree groups at the top level (they nest under their ws-* folder)"
  );
  const folderOf = (name: string) =>
    roots.find((i) => i instanceof FolderItem && (i as FolderItem).folderPath === path.join(root, name)) as FolderItem | undefined;
  const alpha = folderOf("ws-alpha");
  const beta = folderOf("ws-beta");
  assert.ok(alpha, "ws-alpha folder node present at root");
  assert.ok(beta, "ws-beta folder node present (created for its worktree, no primary file under it)");

  // Expand ws-alpha → its worktree group + go.work, ordered folders → worktrees → files.
  const alphaKids = provider.getChildren(alpha);
  const alphaGroups = alphaKids.filter((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem[];
  assert.equal(alphaGroups.length, 1, "ws-alpha contains exactly its one pending worktree");
  assert.equal(alphaGroups[0].worktreeRoot, path.dirname(coreFile), "nested group is ws-alpha/service-core");
  const alphaFiles = alphaKids.filter((i) => i instanceof FileReviewItem) as FileReviewItem[];
  assert.equal(alphaFiles.length, 1, "ws-alpha shows its primary go.work file too");
  assert.equal(alphaFiles[0].filePath, goWork, "the primary file under ws-alpha is go.work");
  assert.ok(alphaKids.indexOf(alphaGroups[0]) < alphaKids.indexOf(alphaFiles[0]), "worktree row comes before file row");

  // Expand ws-beta → its worktree group, even with no primary file under it.
  const appKids = provider.getChildren(beta);
  const appGroups = appKids.filter((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem[];
  assert.equal(appGroups.length, 1, "ws-beta contains its worktree group");
  assert.equal(appGroups[0].worktreeRoot, path.dirname(apiFile), "nested group is ws-beta/service-api");

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktrees nest under their owning ws-* folder in tree mode");
}

// ── Case 5: a worktree group's OWN files nest as a folder tree (tree mode) ──
// Inside a worktree checked out at ws-alpha/service-core, its pending files must
// group into folders (common/suite/…) in tree view and stay flat in list view —
// same toggle as the primary panel. Folder rows inside the worktree resolve back
// to the WORKTREE's SessionManager so accept/reject/openDiff target the right one.
{
  setExcludeMatcher(new ExcludeMatcher());
  setProtectedMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guihome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-guiroot-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  // Worktree at ws-alpha/service-core with a NESTED file and a top-level file.
  const name = "ws-alpha-service-core";
  fs.mkdirSync(path.join(root, ".git", "worktrees", name), { recursive: true });
  const wt = path.join(root, "ws-alpha", "service-core");
  fs.mkdirSync(path.join(wt, "common", "suite"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", name, "gitdir"), path.join(wt, ".git") + "\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", name)}\n`);
  const nestedFile = path.join(wt, "common", "suite", "bootstrap.go");
  const topFile = path.join(wt, "go.mod");
  fs.writeFileSync(nestedFile, "package suite");
  fs.writeFileSync(topFile, "module x");
  const entry = (): Record<string, unknown> => ({ originalContent: "base", reviewStatus: "pending", newFile: false, sessionId: "s1", capturedAt: new Date().toISOString() });
  writeSession(home, wt, { [nestedFile]: entry(), [topFile]: entry() });

  const primary = new SessionManager(fakeLog, root);
  primary.startWatching();
  const registry = new WorktreeSessionRegistry(fakeLog, root);
  registry.refresh();

  const groupOf = (provider: FilteredTreeProvider): WorktreeGroupItem => {
    // Navigate root → ws-alpha folder → its worktree group (tree mode).
    const alpha = provider.getChildren().find((i) => i instanceof FolderItem) as FolderItem;
    const g = provider.getChildren(alpha).find((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem;
    return g;
  };

  // Tree mode: group children nest into folders.
  {
    const provider = new FilteredTreeProvider(primary, "pending", "tree", registry);
    const kids = provider.getChildren(groupOf(provider));
    const folders = kids.filter((i) => i instanceof FolderItem) as FolderItem[];
    const files = kids.filter((i) => i instanceof FileReviewItem) as FileReviewItem[];
    assert.equal(folders.length, 1, "worktree group nests its subdir as a folder (tree mode)");
    assert.equal(folders[0].folderPath, path.join(wt, "common"), "folder is the worktree's common/ dir");
    assert.equal(files.length, 1, "the worktree's top-level file sits alongside the folder");
    assert.equal(files[0].filePath, topFile, "top-level worktree file is go.mod");
    assert.equal(files[0].description, undefined, "tree-mode file row has no redundant path description");

    // Drill common/ → suite/ → bootstrap.go, bound to the WORKTREE's manager.
    const suite = provider.getChildren(folders[0]).find((i) => i instanceof FolderItem) as FolderItem;
    const leaf = provider.getChildren(suite).find((i) => i instanceof FileReviewItem) as FileReviewItem;
    assert.equal(leaf.filePath, nestedFile, "nested file reached through the folder chain");
    assert.equal(leaf.sessionManager, registry.managerFor(nestedFile), "nested row bound to the WORKTREE's SessionManager");
  }

  // List mode: group children stay flat.
  {
    const provider = new FilteredTreeProvider(primary, "pending", "list", registry);
    const group = provider.getChildren().find((i) => i instanceof WorktreeGroupItem) as WorktreeGroupItem;
    const kids = provider.getChildren(group);
    assert.equal(kids.filter((i) => i instanceof FolderItem).length, 0, "no folders in list mode");
    assert.equal(kids.length, 2, "both worktree files listed flat");
    assert.ok(kids.every((i) => i instanceof FileReviewItem), "all rows are files (flat)");
  }

  registry.dispose();
  primary.stopWatching();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktree group contents nest as a tree (tree mode) and stay flat (list mode)");
}

// Reset shared stub state so later test bundles start clean.
stubWorkspace.workspaceFolders = undefined;
