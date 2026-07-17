import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isOrphanedSession, referencedPaths, gcOrphanedSessions } from "./sessionGc";

// A session file is GC-safe to delete only when EVERY file it references lives
// in a directory that is gone from disk: none of its pending baselines can be
// restored anywhere, so the file is dead weight. If even one referenced file's
// directory still exists, the session is kept. Never age-based — an old session
// whose tree still exists may hold unreviewed work.

// ── isOrphanedSession ────────────────────────────────────────────────────────
{
  const only = (...dirs: string[]) => (d: string) => new Set(dirs).has(d);

  // Deleted workspace: every referenced directory is gone → orphan.
  assert.equal(
    isOrphanedSession(["/home/u/dead/a.ts", "/home/u/dead/b.ts"], () => false),
    true,
    "deleted workspace → orphan"
  );

  // Live workspace: the referenced directory still exists → keep.
  assert.equal(
    isOrphanedSession(["/home/u/proj/a.ts"], only("/home/u/proj")),
    false,
    "live workspace → keep"
  );

  // Removed git worktree: its working dir is gone → orphan.
  assert.equal(
    isOrphanedSession(["/home/u/tms/ws-x/mod/a.go", "/home/u/tms/ws-x/mod/b.go"], () => false),
    true,
    "removed worktree dir → orphan"
  );

  // Test-fixture junk spanning unrelated roots, ALL gone → orphan. (This is the
  // real /fake + /tmp pollution the longest-common-dir rule used to spare.)
  assert.equal(
    isOrphanedSession(["/fake/f0.ts", "/fake/f1.ts", "/tmp/tmpXXXX"], () => false),
    true,
    "multi-root junk with every dir gone → orphan"
  );

  // Multi-root where at least one directory still exists → keep (conservative).
  assert.equal(
    isOrphanedSession(["/gone/a.ts", "/home/u/proj/b.ts"], only("/home/u/proj")),
    false,
    "one surviving directory → keep"
  );

  // New-file capture: the file itself may not exist yet, but its parent dir
  // does (Claude is creating it in a live project) → keep.
  assert.equal(
    isOrphanedSession(["/home/u/proj/brand-new.ts"], only("/home/u/proj")),
    false,
    "new file in a live dir → keep"
  );

  // Empty session (no referenced paths) → can't tell → keep.
  assert.equal(isOrphanedSession([], () => false), false, "no paths → keep");

  console.log("ok - isOrphanedSession deletes only sessions with every dir gone");
}

// ── referencedPaths ──────────────────────────────────────────────────────────
{
  const session = {
    files: { "/w/a.ts": {}, "/w/b.ts": {} },
    accepted: [{ path: "/w/c.ts" }, { path: "/w/d.ts" }],
    rejected: { "/w/e.ts": { path: "/w/e.ts" } },
  };
  const got = referencedPaths(session).sort();
  assert.deepEqual(got, ["/w/a.ts", "/w/b.ts", "/w/c.ts", "/w/d.ts", "/w/e.ts"], "gathers files + accepted + rejected");
  assert.deepEqual(referencedPaths({}), [], "empty session → no paths");
  assert.deepEqual(referencedPaths({ files: {} }), [], "missing sections tolerated");
  console.log("ok - referencedPaths gathers every path a session records");
}

// ── gcOrphanedSessions (real filesystem) ─────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sessions-"));
  const liveTree = fs.mkdtempSync(path.join(os.tmpdir(), "cg-live-"));

  const write = (name: string, obj: unknown) =>
    fs.writeFileSync(path.join(tmp, name), JSON.stringify(obj));

  // Orphan: references only trees that do not exist.
  write("orphan.json", { files: { "/definitely/gone/x.ts": {} }, accepted: [{ path: "/also/gone/y.ts" }] });
  // Live: references a real directory that exists right now.
  write("live.json", { files: { [path.join(liveTree, "x.ts")]: {} } });
  // Unparseable: never deleted (we can't inspect it).
  fs.writeFileSync(path.join(tmp, "broken.json"), "{ not json");
  // Empty session: no paths → kept.
  write("empty.json", { files: {} });
  // Non-JSON file in the dir is ignored entirely.
  fs.writeFileSync(path.join(tmp, "notes.txt"), "hello");

  const deleted = gcOrphanedSessions(tmp).sort();
  assert.deepEqual(deleted, ["orphan.json"], "only the orphan is deleted");
  assert.ok(!fs.existsSync(path.join(tmp, "orphan.json")), "orphan removed from disk");
  assert.ok(fs.existsSync(path.join(tmp, "live.json")), "live session kept");
  assert.ok(fs.existsSync(path.join(tmp, "broken.json")), "unparseable session kept");
  assert.ok(fs.existsSync(path.join(tmp, "empty.json")), "empty session kept");
  assert.ok(fs.existsSync(path.join(tmp, "notes.txt")), "non-json file untouched");

  // Missing directory is a no-op, not a throw.
  assert.deepEqual(gcOrphanedSessions(path.join(tmp, "does-not-exist")), [], "missing dir → no-op");
  console.log("ok - gcOrphanedSessions removes orphans and leaves everything else");
}
