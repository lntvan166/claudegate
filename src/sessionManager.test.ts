import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher } from "./workspaceScope";

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
  assert.ok(readSession(sp).rejected[del], "deleted file still recorded as rejected");
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

// migrateSession must carry newFile through a disk reload (the real hook +
// fs.watch path): a confident-new flag survives → reject deletes; a legacy
// entry with no newFile → reject leaves the file (delete-safety).
{
  const { ws, sp } = newEnv();
  const nf = path.join(ws, "created.ts");
  fs.writeFileSync(nf, "content");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [nf]: { originalContent: null, reviewStatus: "pending", newFile: true, capturedAt: new Date().toISOString() } },
    accepted: [], rejected: {},
  }));
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching(); // loads via migrateSession (the fs.watch reload path)
  sm.rejectFile(nf);
  assert.ok(!fs.existsSync(nf), "newFile:true survives reload → reject deletes");
  sm.stopWatching();

  const { ws: ws2, sp: sp2 } = newEnv();
  const legacy = path.join(ws2, "maybe-real.ts");
  fs.writeFileSync(legacy, "user data");
  fs.mkdirSync(path.dirname(sp2), { recursive: true });
  fs.writeFileSync(sp2, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [legacy]: { originalContent: null, reviewStatus: "pending", capturedAt: new Date().toISOString() } },
    accepted: [], rejected: {},
  }));
  const sm2 = new SessionManager(fakeLog, ws2);
  sm2.startWatching();
  sm2.rejectFile(legacy);
  assert.ok(fs.existsSync(legacy), "legacy null entry (no newFile) → reject leaves file");
  sm2.stopWatching();
  console.log("ok - migrateSession carries newFile through reload (delete-safety)");
}


// ── Manual-test cases as integration tests ────────────────────────────────
// (UI-only cases — native diff "Revert Block", Review-All multi-diff tab reuse,
// group-by-session rendering, explorer badges — are not integration-testable
// and remain in the Extension-Host manual checklist.)

// Accepted panel is a full per-accept log.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "log.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);        // A→B
  fs.writeFileSync(fp, "C");
  sm.trackFileChange(fp, "B"); sm.acceptFile(fp);        // B→C
  const s = sm.getSession()!;
  assert.equal(s.accepted.length, 2, "two accepts logged");
  assert.deepEqual(s.accepted.map((r) => r.after), ["B", "C"]);
  sm.stopWatching();
  console.log("ok - accept keeps a full per-accept log");
}

// Re-editing an accepted file coexists: Accepted keeps history, Pending shows new.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "co.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);
  sm.trackFileChange(fp, "B");                           // hook re-edit
  const s = sm.getSession()!;
  assert.ok(s.files[fp], "re-edit re-appears in pending");
  assert.equal(s.accepted.length, 1, "accepted record preserved");
  sm.stopWatching();
  console.log("ok - re-edit of an accepted file coexists");
}

// Rejected keeps only the latest per file.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "rej.ts");
  fs.writeFileSync(fp, "X");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);     // reject X
  fs.writeFileSync(fp, "Y");
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);     // reject Y
  const s = sm.getSession()!;
  assert.equal(Object.keys(s.rejected).length, 1, "one rejected record per file");
  assert.equal(s.rejected[fp].after, "Y", "latest reject kept");
  sm.stopWatching();
  console.log("ok - reject keeps only the latest per file");
}

// Re-apply a rejected change: rewrites Claude's version, returns to pending.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "reap.ts");
  fs.writeFileSync(fp, "CLAUDE");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "BASE", "reject restored baseline");
  sm.reapplyRejected(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "CLAUDE", "reapply rewrote Claude's version");
  const s = sm.getSession()!;
  assert.ok(s.files[fp], "reapplied file back to pending");
  assert.equal(s.rejected[fp], undefined, "removed from rejected store");
  sm.stopWatching();
  console.log("ok - reapply restores Claude's version and re-pends");
}

// Revert an accepted change: back to pending.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "rev.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);
  const id = sm.getSession()!.accepted[0].id;
  sm.revertAccepted(id);
  const s = sm.getSession()!;
  assert.equal(s.accepted.length, 0, "accepted record removed");
  assert.ok(s.files[fp], "returned to pending");
  sm.stopWatching();
  console.log("ok - revert accepted returns the file to pending");
}

// Clear commands reset the stores.
{
  const { ws } = newEnv();
  const a = path.join(ws, "ca.ts"); const b = path.join(ws, "cb.ts");
  fs.writeFileSync(a, "A2"); fs.writeFileSync(b, "B2");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(a, "A1"); sm.acceptFile(a);
  sm.trackFileChange(b, "B1"); sm.rejectFile(b);
  sm.clearAccepted();
  assert.equal(sm.getSession()!.accepted.length, 0, "clearAccepted empties the log");
  sm.clearRejected();
  assert.equal(Object.keys(sm.getSession()!.rejected).length, 0, "clearRejected empties the store");
  sm.stopWatching();
  console.log("ok - clearAccepted / clearRejected reset the stores");
}

// Excluded files (e.g. lock files) are not counted as pending.
{
  const { ws } = newEnv();
  const lock = path.join(ws, "package-lock.json");
  const src = path.join(ws, "x.ts");
  fs.writeFileSync(lock, "{}"); fs.writeFileSync(src, "S");
  const matcher = new ExcludeMatcher();
  matcher.reload({ "**/package-lock.json": true }, ws);
  setExcludeMatcher(matcher);
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(lock, "{ }"); sm.trackFileChange(src, "S0");
  assert.equal(sm.getPendingCount(), 1, "excluded lock file is not counted");
  setExcludeMatcher(new ExcludeMatcher()); // reset shared state for any later block
  sm.stopWatching();
  console.log("ok - excluded files are not counted as pending");
}

console.log("done");
