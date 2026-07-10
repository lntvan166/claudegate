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
