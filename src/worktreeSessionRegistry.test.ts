import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

const fakeLog = { appendLine() {} } as any;

function sessionPathFor(home: string, ws: string): string {
  const resolved = path.resolve(ws);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("md5").update(normalized).digest("hex");
  return path.join(home, ".claudegate", "sessions", `${hash}.json`);
}

{
  setExcludeMatcher(new ExcludeMatcher()); // nothing excluded
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not $HOME
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  // parent window sees only `root`; worktree files live under it → in-workspace.
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  // Fake main repo + nested worktree "ws".
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws"), { recursive: true });
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws", "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "ws")}\n`);

  // Pre-seed the worktree's session file with one pending file.
  const wsFile = path.join(ws, "a.ts");
  const sp = sessionPathFor(home, ws);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [wsFile]: { originalContent: "OLD", reviewStatus: "pending", newFile: false } },
    accepted: [], rejected: {},
  }));

  const reg = new WorktreeSessionRegistry(fakeLog, root);
  let changes = 0;
  reg.onChange(() => changes++);
  reg.refresh();

  assert.deepEqual([...reg.getManagers().keys()], [path.resolve(ws)], "attached the nested worktree");
  assert.equal(reg.totalPending(), 1, "counts the worktree's pending file");
  assert.ok(reg.managerFor(wsFile), "resolves the owning manager for a worktree file");
  assert.equal(reg.managerFor(path.join(root, "src", "x.ts")), null, "no manager for a non-worktree file");
  assert.ok(changes > 0, "refresh fired onChange");

  reg.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - worktree session registry attaches, counts, and routes");
}
