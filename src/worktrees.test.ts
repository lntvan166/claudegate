import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isWorktreeRoot, nestedWorktreesUnder, worktreeRootForPath } from "./worktrees";

// Build a fake main repo at <root> with:
//   <root>/.git/                        (dir  → main repo)
//   <root>/.git/worktrees/ws/gitdir     (file → points at <root>/ws/.git)
//   <root>/ws/.git                       (file → "gitdir: <root>/.git/worktrees/ws")
//   <root>/sub/.git                      (file → submodule, points at .git/modules/sub)
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wt-"));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws"), { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws", "gitdir"),
    path.join(root, "ws", ".git") + "\n");
  fs.writeFileSync(path.join(root, "ws", ".git"),
    `gitdir: ${path.join(root, ".git", "worktrees", "ws")}\n`);
  fs.writeFileSync(path.join(root, "sub", ".git"),
    `gitdir: ${path.join(root, ".git", "modules", "sub")}\n`);
  return root;
}

{
  const root = makeRepo();

  // isWorktreeRoot: worktree wd yes; main repo no; submodule no.
  assert.equal(isWorktreeRoot(path.join(root, "ws")), true, "ws is a worktree root");
  assert.equal(isWorktreeRoot(root), false, "main repo (.git dir) is not a worktree");
  assert.equal(isWorktreeRoot(path.join(root, "sub")), false, "submodule is not a worktree");

  // nestedWorktreesUnder: finds ws, excludes submodule.
  const found = nestedWorktreesUnder(root);
  assert.deepEqual(found, [path.resolve(path.join(root, "ws"))], "enumerates the nested worktree only");

  // worktreeRootForPath: file inside ws → ws; file elsewhere → null; longest match wins.
  const roots = [path.join(root, "ws")];
  assert.equal(worktreeRootForPath(path.join(root, "ws", "a.ts"), roots), path.join(root, "ws"), "file under ws");
  assert.equal(worktreeRootForPath(path.join(root, "src", "a.ts"), roots), null, "file outside any worktree → null");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktree detection (worktree vs main vs submodule)");
}

// Regression: a worktree owned by a NESTED sub-repo (not the primary root's own
// repo) must still be discovered. Mirrors a go.work layout where each module is
// its own git repo and its worktree is checked out into a sibling folder under
// the open workspace — e.g. monorepo/ws-alpha/service-geo is a worktree of
// monorepo/service-geo, NOT of monorepo. The old <root>/.git/worktrees read missed it.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wtn-"));
  // Primary root's own repo (has some unrelated worktree of its own).
  fs.mkdirSync(path.join(root, ".git", "worktrees", "self"), { recursive: true });
  fs.mkdirSync(path.join(root, "self-wt"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "self", "gitdir"),
    path.join(root, "self-wt", ".git") + "\n");
  fs.writeFileSync(path.join(root, "self-wt", ".git"),
    `gitdir: ${path.join(root, ".git", "worktrees", "self")}\n`);
  // Nested sub-repo `mod` (its own .git dir) with a worktree checked out at
  // <root>/ws/mod — the working dir is under root, but the OWNING repo is `mod`.
  fs.mkdirSync(path.join(root, "mod", ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(path.join(root, "ws", "mod"), { recursive: true });
  fs.writeFileSync(path.join(root, "mod", ".git", "worktrees", "wt", "gitdir"),
    path.join(root, "ws", "mod", ".git") + "\n");
  fs.writeFileSync(path.join(root, "ws", "mod", ".git"),
    `gitdir: ${path.join(root, "mod", ".git", "worktrees", "wt")}\n`);

  const found = nestedWorktreesUnder(root).map((p) => path.resolve(p)).sort();
  const expected = [
    path.resolve(path.join(root, "self-wt")),
    path.resolve(path.join(root, "ws", "mod")),
  ].sort();
  assert.deepEqual(found, expected,
    "discovers worktrees of both the root repo AND nested sub-repos");
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - nested sub-repo worktree working dir is discovered");
}

// Regression: a submodule whose gitdir target has a `worktrees`-named ANCESTOR
// (but is structurally `.../.git/modules/<name>`) must NOT be seen as a worktree.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wtx-"));
  const proj = path.join(base, "worktrees", "proj"); // ancestor dir named "worktrees"
  const sub = path.join(proj, "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, ".git"),
    `gitdir: ${path.join(proj, ".git", "modules", "sub")}\n`);
  assert.equal(isWorktreeRoot(sub), false, "submodule under a worktrees-named dir is not a worktree");
  fs.rmSync(base, { recursive: true, force: true });
  console.log("ok - submodule under worktrees-named ancestor is not misclassified");
}
