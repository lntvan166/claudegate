import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { WorktreeSessionRegistry, orderRootsForAttach } from "./worktreeSessionRegistry";
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

// refresh() is async (the filesystem scan must not block the extension host), so
// the blocks run sequentially inside one IIFE — they share process.env.HOME and
// the workspace-folders stub and must not interleave.
void (async () => {
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
  await reg.refresh({ force: true });

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

{
  // Regression: a `go.work` monorepo checks out ONE worktree per module, so two
  // feature workspaces blow past a small cap. The old cap of 10 sliced the
  // alphabetically-last worktrees away, and their pending files surfaced in no
  // window at all. Attaching is cheap (all managers share one fs.watch dir and
  // only re-parse their OWN file), so the cap must sit far above realistic counts.
  setExcludeMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  // 18 nested worktrees named so the LAST one alphabetically is the one holding
  // pending work — exactly the ws-storedist shape that reproduced the bug.
  const names = Array.from({ length: 18 }, (_, i) => `ws-${String(i).padStart(2, "0")}`);
  for (const name of names) {
    const wt = path.join(root, name);
    const admin = path.join(root, ".git", "worktrees", name);
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${admin}\n`);
  }

  const lastRoot = path.join(root, names[names.length - 1]);
  const lastFile = path.join(lastRoot, "a.ts");
  const sp = sessionPathFor(home, lastRoot);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [lastFile]: { originalContent: "OLD", reviewStatus: "pending", newFile: false } },
    accepted: [], rejected: {},
  }));

  const reg = new WorktreeSessionRegistry(fakeLog, root);
  await reg.refresh({ force: true });

  assert.equal(reg.getManagers().size, 18, "attaches every nested worktree, not just the first 10");
  assert.ok(reg.getManagers().has(path.resolve(lastRoot)), "the alphabetically-last worktree is attached");
  assert.equal(reg.totalPending(), 1, "its pending file is counted");
  assert.ok(reg.managerFor(lastFile), "routes a file in the last worktree to its own manager");

  reg.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - registry attaches well past 10 nested worktrees (go.work monorepo)");
}

{
  // Belt-and-braces for anyone who somehow exceeds even the raised cap: worktrees
  // that already hold captured work must never lose a slot to an idle one.
  const roots = ["/r/zulu", "/r/alpha", "/r/mike"];
  const hasSession = (r: string) => r === "/r/zulu";

  assert.deepEqual(
    orderRootsForAttach(roots, hasSession),
    ["/r/zulu", "/r/alpha", "/r/mike"],
    "worktrees with a session file sort ahead of idle ones"
  );
  assert.deepEqual(
    orderRootsForAttach(roots, () => false),
    ["/r/alpha", "/r/mike", "/r/zulu"],
    "ties fall back to a stable alphabetical order"
  );
  assert.deepEqual(
    orderRootsForAttach(roots, () => true),
    ["/r/alpha", "/r/mike", "/r/zulu"],
    "all-active also sorts alphabetically within the tier"
  );
  console.log("ok - attach ordering puts worktrees with captured work first");
}

{
  // The scan is the extension's most expensive routine and used to run on EVERY
  // window focus. It must be throttled (a plain refresh inside the interval is a
  // no-op) while still being force-able, and concurrent callers must share one
  // walk rather than each starting their own.
  setExcludeMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  // One worktree, present from the start.
  const admin = path.join(root, ".git", "worktrees", "ws");
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  fs.writeFileSync(path.join(root, "ws", ".git"), `gitdir: ${admin}\n`);

  let clock = 1_000_000;
  const reg = new WorktreeSessionRegistry(fakeLog, root, () => clock);

  await reg.refresh({ force: true });
  assert.equal(reg.getManagers().size, 1, "forced refresh scans");

  // A second worktree appears, but no time passes → the throttle suppresses the
  // rescan, so the new worktree is not picked up yet.
  const admin2 = path.join(root, ".git", "worktrees", "ws2");
  fs.mkdirSync(admin2, { recursive: true });
  fs.mkdirSync(path.join(root, "ws2"), { recursive: true });
  fs.writeFileSync(path.join(root, "ws2", ".git"), `gitdir: ${admin2}\n`);

  await reg.refresh();
  assert.equal(reg.getManagers().size, 1, "an unforced refresh inside the interval does not rescan");

  await reg.refresh({ force: true });
  assert.equal(reg.getManagers().size, 2, "force bypasses the throttle");

  // Past the interval, an unforced refresh scans again.
  const admin3 = path.join(root, ".git", "worktrees", "ws3");
  fs.mkdirSync(admin3, { recursive: true });
  fs.mkdirSync(path.join(root, "ws3"), { recursive: true });
  fs.writeFileSync(path.join(root, "ws3", ".git"), `gitdir: ${admin3}\n`);
  clock += 30_001;
  await reg.refresh();
  assert.equal(reg.getManagers().size, 3, "an unforced refresh past the interval rescans");

  // Concurrent callers coalesce onto a single in-flight walk.
  const a = reg.refresh({ force: true });
  const b = reg.refresh({ force: true });
  assert.equal(a, b, "a concurrent refresh returns the in-flight scan, not a second walk");
  await Promise.all([a, b]);

  reg.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - worktree scan is throttled, force-able, and coalesces concurrent calls");
}

{
  // Regression: dispose() runs during extension-host teardown, where the
  // OutputChannel throws "Channel has been closed". That throw used to abort the
  // detach loop, leaking an fs.watch handle + reconcile timer per un-detached
  // worktree on every window reload.
  setExcludeMatcher(new ExcludeMatcher());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  for (const name of ["wa", "wb", "wc"]) {
    const adm = path.join(root, ".git", "worktrees", name);
    fs.mkdirSync(adm, { recursive: true });
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, ".git"), `gitdir: ${adm}\n`);
  }

  // Logs fine while attaching, then starts throwing — exactly what the real
  // OutputChannel does once the host's IPC channel closes.
  let channelClosed = false;
  const log = {
    appendLine() { if (channelClosed) throw new Error("Channel has been closed"); },
  } as any;

  const reg = new WorktreeSessionRegistry(log, root);
  await reg.refresh({ force: true });
  assert.equal(reg.getManagers().size, 3, "three worktrees attached");

  channelClosed = true;
  reg.dispose();
  assert.equal(reg.getManagers().size, 0, "every manager is detached even when logging throws");

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - dispose detaches every worktree even when the output channel is dead");
}
})();
