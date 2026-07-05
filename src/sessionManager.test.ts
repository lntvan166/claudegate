import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";

const fakeLog = { appendLine() {} } as any;

function sessionPathFor(home: string, ws: string): string {
  const hash = crypto.createHash("md5").update(path.resolve(ws)).digest("hex");
  return path.join(home, ".claudegate", "sessions", `${hash}.json`);
}
function newEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ws-"));
  process.env.HOME = home; // SessionManager reads os.homedir() → $HOME on POSIX
  return { home, ws, sp: sessionPathFor(home, ws) };
}
function readSession(sp: string): any {
  return JSON.parse(fs.readFileSync(sp, "utf-8"));
}

// accept: appends a record, removes the pending entry, leaves the file on disk
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "a.ts");
  fs.writeFileSync(fp, "NEW");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "OLD");
  sm.acceptFile(fp);
  const s = readSession(sp);
  assert.equal(s.files[fp], undefined, "accepted entry removed from files");
  assert.equal(s.accepted.length, 1, "one accepted record");
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["OLD", "NEW"]);
  assert.equal(fs.readFileSync(fp, "utf-8"), "NEW", "working file untouched by accept");
  sm.stopWatching();
  console.log("ok - accept records + leaves file");
}

// reject of an existing file restores the baseline on disk (atomically)
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "b.ts");
  fs.writeFileSync(fp, "CLAUDE");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "BASE");
  sm.rejectFile(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "BASE", "reject restored baseline");
  const s = readSession(sp);
  assert.ok(s.rejected[fp], "rejected record stored");
  assert.equal(s.rejected[fp].after, "CLAUDE", "discarded content saved");
  sm.stopWatching();
  console.log("ok - reject restores baseline on disk");
}

// merge-on-write: a concurrent write to the session file (a fresh hook capture)
// is preserved when the extension persists.
{
  const { ws, sp } = newEnv();
  const a = path.join(ws, "a.ts");
  fs.writeFileSync(a, "A");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(a, "A0"); // persists the session (mtime recorded)
  // Simulate a hook writing a NEW pending entry directly to the session file:
  const disk = readSession(sp);
  const b = path.join(ws, "b.ts");
  disk.files[b] = {
    originalContent: "B0", reviewStatus: "pending",
    capturedAt: new Date(Date.now() + 1000).toISOString(),
  };
  fs.writeFileSync(sp, JSON.stringify(disk));
  // Force a distinctly-later mtime so the dual-writer guard sees the change
  // regardless of filesystem mtime granularity (coarse-mtime FSes could bucket
  // two synchronous writes into the same timestamp → flaky).
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(sp, later, later);
  // Now the extension persists (via accept of A); merge must keep b.
  sm.acceptFile(a);
  const s = readSession(sp);
  assert.ok(s.files[b], "concurrent hook capture merged, not lost");
  assert.equal(s.accepted.length, 1, "the accept was still recorded");
  sm.stopWatching();
  console.log("ok - merge-on-write preserves concurrent hook capture");
}

// reject matrix for null baselines: confident-new deletes; uncertain leaves.
{
  const { ws, sp } = newEnv();
  const del = path.join(ws, "created.ts");
  fs.writeFileSync(del, "hi");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(del, null, true);   // confident new (hook path)
  sm.rejectFile(del);
  assert.ok(!fs.existsSync(del), "confident-new reject deletes the file");
  sm.stopWatching();

  const { ws: ws2, sp: sp2 } = newEnv();
  const keep = path.join(ws2, "maybe-real.ts");
  fs.writeFileSync(keep, "user data");
  const sm2 = new SessionManager(fakeLog, ws2);
  sm2.startWatching();
  sm2.trackFileChange(keep, null);       // uncertain (watcher path, newFile=false)
  sm2.rejectFile(keep);
  assert.ok(fs.existsSync(keep), "uncertain-new reject leaves the file on disk");
  assert.equal(fs.readFileSync(keep, "utf-8"), "user data", "file content untouched");
  assert.ok(readSession(sp2).rejected[keep], "still recorded as rejected");
  sm2.stopWatching();
  console.log("ok - reject deletes only confident-new files");
}

console.log("done");
